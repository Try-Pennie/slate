import { parseStampMs } from "@/lib/date/stamp";
import type { AgentBusyRange } from "@/lib/monitor/availability-truth-store";
import { log } from "@/lib/log";

/**
 * The busy drift sampler (#1262, second half): does the cached busy index agree
 * with Google, checked live for a rotating sample of agents?
 *
 * OBSERVE-ONLY, deliberately. It logs what it finds and never pages: a comparison
 * like this has to be calibrated against real samples before it may accuse the
 * cache (L56), and the issue that activates it is filed in the same change so the
 * inactive state cannot become invisible (L65). The coverage alert beside it
 * (calendar-window-coverage.ts) is the guarantee; this is a slow partial
 * detector by construction, a sampler.
 *
 * The one way this comparison can be wrong that would defeat its purpose:
 * freeBusy returns MERGED, anonymous intervals, and Slate deliberately never
 * mirrors its own bookings as gcal events (#166/#586). So the cached side must
 * union EVERY source's blocks, slate included; a google-only union flags every
 * Slate booking as a gap and the sampler cries wolf from its first tick.
 *
 * Fail-safe directions, each pinned by a test:
 *  - a dead live read, or a failed cache read, is `unreadable`, never an empty
 *    finding (comparing live against a cache that failed to load "finds"
 *    everything; an empty live read scored as agreement finds nothing forever);
 *  - a calendar freeBusy flagged `error: true` makes that AGENT unreadable, not
 *    clean;
 *  - an unreadable interval on either side is counted apart, never silently
 *    skipped as covered.
 */

/** One interval, ISO bounds. Named apart from booking/core's BusyInterval
 *  because the two sides here arrive in different shapes and are normalized. */
export interface DriftInterval {
  startIso: string;
  endIso: string;
}

/** Boundary jitter tolerance: a remainder of this length or shorter is not drift. Errs
 *  toward silence, and only by a minute, stated so calibration can revisit it. */
export const DRIFT_EPSILON_MS = 60_000;

/**
 * Live busy the cache does not hold, clipped to the window. Pure interval
 * arithmetic so every branch is pinned offline.
 */
export function uncachedBusy(input: {
  cached: DriftInterval[];
  live: DriftInterval[];
  windowStartIso: string;
  windowEndIso: string;
}): { gaps: DriftInterval[]; unreadable: number } {
  const winStart = parseStampMs(input.windowStartIso);
  const winEnd = parseStampMs(input.windowEndIso);
  if (winStart === null || winEnd === null) {
    // A caller bug: the window is constructed, not stored. Everything is
    // unjudgeable, and saying so beats judging against NaN.
    return { gaps: [], unreadable: input.live.length };
  }

  let unreadable = 0;

  // Merge the cached side into disjoint ascending intervals.
  const cached: { s: number; e: number }[] = [];
  for (const c of input.cached) {
    const s = parseStampMs(c.startIso);
    const e = parseStampMs(c.endIso);
    if (s === null || e === null || e <= s) {
      unreadable++;
      continue;
    }
    cached.push({ s, e });
  }
  cached.sort((a, b) => a.s - b.s);
  const merged: { s: number; e: number }[] = [];
  for (const c of cached) {
    const last = merged[merged.length - 1];
    if (last && c.s <= last.e) last.e = Math.max(last.e, c.e);
    else merged.push({ ...c });
  }

  const gaps: DriftInterval[] = [];
  for (const l of input.live) {
    const ls = parseStampMs(l.startIso);
    const le = parseStampMs(l.endIso);
    if (ls === null || le === null || le <= ls) {
      unreadable++;
      continue;
    }
    // Clip to the window: the cache is only bounded inside it, so live busy
    // beyond it is not the cache's to know.
    let s = Math.max(ls, winStart);
    const e = Math.min(le, winEnd);
    if (e <= s) continue;
    for (const c of merged) {
      if (c.e <= s) continue;
      if (c.s >= e) break;
      if (c.s > s && c.s - s > DRIFT_EPSILON_MS) {
        gaps.push({ startIso: new Date(s).toISOString(), endIso: new Date(c.s).toISOString() });
      }
      s = Math.max(s, c.e);
      if (s >= e) break;
    }
    if (e - s > DRIFT_EPSILON_MS) {
      gaps.push({ startIso: new Date(s).toISOString(), endIso: new Date(e).toISOString() });
    }
  }
  return { gaps, unreadable };
}

/**
 * Which agents this tick samples. Stateless: the tick index walks the roster in
 * fixed batches, so consecutive ticks cover everyone without a stored cursor,
 * and a roster no larger than the batch is sampled whole every tick (which is
 * the entire pre-cutover roster, so the sampler concludes from its first tick
 * rather than shipping blind, #1394).
 */
export function sampleForTick<T>(agents: T[], tickIndex: number, batchSize: number): T[] {
  if (agents.length === 0) return [];
  if (agents.length <= batchSize) return agents;
  const pages = Math.ceil(agents.length / batchSize);
  const page = ((tickIndex % pages) + pages) % pages;
  return agents.slice(page * batchSize, (page + 1) * batchSize);
}

/** One sampled agent that showed live busy the cache does not hold. */
export interface DriftGapAgent {
  email: string;
  gaps: number;
  gapMinutes: number;
}

export interface BusyDriftResult {
  status: "observed" | "unreadable";
  /** Agents whose live AND cached sides were both readable. */
  agentsChecked: number;
  /** Agents skipped because a calendar read errored: held out, never clean. */
  agentsUnreadable: number;
  gapAgents: DriftGapAgent[];
}

/**
 * One observe-only tick. Logs findings; sends nothing, resolves nothing.
 */
export async function runBusyDriftSample(deps: {
  sample: { email: string; userId: string }[];
  fromIso: string;
  toIso: string;
  /** Live freeBusy for the sampled emails (readAgentBusyRange). Null = dead read. */
  readLive: (emails: string[], fromIso: string, toIso: string) => Promise<AgentBusyRange | null>;
  /** Cached blocks per user id over the window, EVERY source unioned. */
  loadCachedBlocks: (
    userIds: string[],
    fromIso: string,
    toIso: string,
  ) => Promise<Map<string, DriftInterval[]>>;
  logTick?: (fields: Record<string, unknown>) => void;
}): Promise<BusyDriftResult> {
  const none: BusyDriftResult = {
    status: "unreadable",
    agentsChecked: 0,
    agentsUnreadable: 0,
    gapAgents: [],
  };
  if (deps.sample.length === 0) {
    deps.logTick?.({ status: "observed", agentsChecked: 0, why: "empty sample" });
    return { ...none, status: "observed" };
  }

  let live: AgentBusyRange | null;
  let cachedByUser: Map<string, DriftInterval[]>;
  try {
    live = await deps.readLive(
      deps.sample.map((s) => s.email),
      deps.fromIso,
      deps.toIso,
    );
    if (live === null) {
      deps.logTick?.({ status: "unreadable", why: "live freeBusy read failed" });
      return none;
    }
    cachedByUser = await deps.loadCachedBlocks(
      deps.sample.map((s) => s.userId),
      deps.fromIso,
      deps.toIso,
    );
  } catch (err) {
    log.error("busy-drift", { msg: "sample read failed" }, err);
    deps.logTick?.({ status: "unreadable", why: "read threw" });
    return none;
  }

  const calendarsByEmail = new Map(live.agents.map((a) => [a.email, a.calendarIds]));
  const gapAgents: DriftGapAgent[] = [];
  let agentsChecked = 0;
  let agentsUnreadable = 0;

  for (const agent of deps.sample) {
    const calendarIds = calendarsByEmail.get(agent.email);
    if (!calendarIds || calendarIds.length === 0) {
      agentsUnreadable++;
      continue;
    }
    const liveBusy: DriftInterval[] = [];
    let errored = false;
    for (const id of calendarIds) {
      const cal = live.busyByCalendar.get(id);
      if (!cal || cal.error) {
        errored = true;
        break;
      }
      for (const b of cal.busy) liveBusy.push({ startIso: b.start, endIso: b.end });
    }
    if (errored) {
      agentsUnreadable++;
      continue;
    }
    const { gaps, unreadable } = uncachedBusy({
      cached: cachedByUser.get(agent.userId) ?? [],
      live: liveBusy,
      windowStartIso: deps.fromIso,
      windowEndIso: deps.toIso,
    });
    if (unreadable > 0) {
      // Some intervals could not be judged: hold the agent out rather than
      // reporting a partial comparison as their whole calendar's verdict.
      agentsUnreadable++;
      continue;
    }
    agentsChecked++;
    if (gaps.length > 0) {
      const gapMinutes = Math.round(
        gaps.reduce((n, g) => {
          const s = parseStampMs(g.startIso);
          const e = parseStampMs(g.endIso);
          return s === null || e === null ? n : n + (e - s) / 60_000;
        }, 0),
      );
      gapAgents.push({ email: agent.email, gaps: gaps.length, gapMinutes });
      // The per-agent detail lives in the logs, which is where a calibration
      // pass will read it back from; nothing here pages.
      deps.logTick?.({
        status: "drift",
        email: agent.email,
        gaps: gaps.length,
        gap_minutes: gapMinutes,
        first_gap: gaps[0]?.startIso,
      });
    }
  }

  deps.logTick?.({
    status: "observed",
    agentsChecked,
    agentsUnreadable,
    driftAgents: gapAgents.length,
  });
  return { status: "observed", agentsChecked, agentsUnreadable, gapAgents };
}

import { parseStampMs } from "@/lib/date/stamp";
import type { AgentBusyRange } from "@/lib/monitor/availability-truth-store";
import { log } from "@/lib/log";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/**
 * The busy drift sampler (#1262, second half): does the cached busy index agree
 * with Google, checked live for a rotating sample of agents?
 *
 * It shipped observe only, because a comparison like this has to be calibrated
 * against real samples before it may accuse the cache (L56). #1591 armed it, REPORT
 * ONLY (Dan, 2026-10-02): `reportBusyDrift` below pages on drift that persists, and
 * nothing here ever writes busy time. Repair stays with the existing sync tools, so
 * the cache keeps one writer. The coverage alert beside it
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
  userId: string;
  gaps: number;
  gapMinutes: number;
  /** Where the first uncached stretch starts: with the user id, it is what makes a
   *  second sighting the SAME gap rather than a new one (#1591). */
  firstGapStartIso: string;
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
 * One sampling tick. Logs findings; sends nothing and resolves nothing itself, so
 * the comparison stays pure. `reportBusyDrift` decides what a result means.
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
      gapAgents.push({
        email: agent.email,
        userId: agent.userId,
        gaps: gaps.length,
        gapMinutes,
        firstGapStartIso: gaps[0]!.startIso,
      });
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

// ---------------------------------------------------------------------------
// Reporting (#1591): armed REPORT ONLY.
// ---------------------------------------------------------------------------

/** The condition key: busy time on a calendar that the cache has not held for long
 *  enough to be a fault rather than sync lag. */
export const BUSY_DRIFT_KEY = "busy_cache_drift";

/**
 * How long one uncached stretch must persist before it pages.
 *
 * Calibrated on 2026-10-03 from seven days of `tag=busy-drift` lines (read only,
 * with the `tag=recompute` control present and fresh to the window's end): 1,998
 * ticks, 1,959 with no drift, 38 with one agent, 1 with two. 40 findings across 26
 * agents, each 10 to 40 minutes of busy time, and NOT ONE was still there when its
 * agent was next sampled, about 30 minutes later on a six page rotation. Whatever
 * produces them (an event created moments before the sample, push lag) clears
 * inside one revisit.
 *
 * So a count per tick cannot separate noise from a fault: a calendar whose sync has
 * stopped also shows up as one agent on one tick. Persistence does (L172), and the
 * measured distribution puts the line at one revisit, 30 minutes. A gap still there
 * after that has outlived every finding the calibration week produced.
 */
export const DRIFT_PERSIST_MS = 30 * 60_000;

/**
 * How many sightings of the same gap make it persistent, and the streak window that
 * holds them, given how often an agent is revisited.
 *
 * Derived rather than fixed at 2, because the revisit interval moves with the
 * roster: on a six page rotation two sightings already span 30 minutes, but a
 * roster sampled whole every tick would page on two sightings five minutes apart,
 * which is ordinary sync lag.
 */
export function persistenceRule(
  rotationTicks: number,
  tickMs: number,
): { hits: number; windowSeconds: number } {
  const revisitMs = Math.max(1, rotationTicks) * tickMs;
  const hits = Math.max(2, Math.ceil(DRIFT_PERSIST_MS / revisitMs) + 1);
  // One revisit of slack past the last sighting, for a late or skipped tick.
  return { hits, windowSeconds: Math.ceil((revisitMs * (hits + 1)) / 1000) };
}

const CLEAN_KEY = `${BUSY_DRIFT_KEY}:clean`;

function utcMinute(iso: string): string {
  const ms = parseStampMs(iso);
  return ms === null ? iso : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The page. Names each agent, how much busy time is missing and where it starts. */
export function formatBusyDriftAlert(agents: DriftGapAgent[]): string {
  const one = agents.length === 1;
  const subject = one ? "1 agent's calendar has" : `${agents.length} agents' calendars have`;
  const lines = agents.map(
    (a) =>
      `${a.email}: ${a.gapMinutes} minutes of busy time not cached, the first from ${utcMinute(a.firstGapStartIso)}.`,
  );
  return (
    `${subject} held busy time that Slate's busy cache has not picked up for at least ` +
    `${Math.round(DRIFT_PERSIST_MS / 60_000)} minutes, so the booker can offer ` +
    `${one ? "that agent" : "those agents"} a time they already have taken. Nothing here ` +
    `writes busy time: the calendar sync is what repairs the cache, so look at ` +
    `${one ? "this agent's" : "these agents'"} sync errors in Admin.\n` +
    lines.join("\n")
  );
}

/** The all clear, hung off a full rotation in which every agent read and none drifted. */
export function formatBusyDriftRecovery(): string {
  return (
    "Every calendar sampled over a full pass of the roster matches the busy cache " +
    "again, so the earlier busy drift page is cleared. No action is needed."
  );
}

export type BusyDriftVerdict = "unmeasured" | "clear" | "transient" | "sustained";

/**
 * What one sampling tick means, and the page or all clear it earns.
 *
 *  - a tick that measured nothing (skipped, unreadable, nobody checked) touches
 *    nothing: no page, no all clear, no streak (#1134, #1152);
 *  - drift counts a sighting of each gap, keyed on the agent and where the gap
 *    starts, and pages the gaps seen often enough to have persisted
 *    `DRIFT_PERSIST_MS`. Any drift breaks the clean run;
 *  - a tick where every sampled agent read and none drifted advances a clean run,
 *    and a run as long as one full rotation (every agent seen clean) resolves.
 *    A clean tick with an unreadable agent advances nothing: the agent it could
 *    not read may be the one that paged.
 *
 * Never throws for a refused post or resolve: monitoring must not take down the lane.
 */
export async function reportBusyDrift(deps: {
  result: BusyDriftResult | null;
  /** Ticks for the rotation to visit every agent once. */
  rotationTicks: number;
  tickMs: number;
  cooldownMs: number;
  /** recordConsecutiveStreak: true once `alertAt` hits land inside the window. */
  hit: (key: string, windowSeconds: number, alertAt: number) => Promise<boolean>;
  clearStreak: (key: string) => Promise<void>;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
}): Promise<{ verdict: BusyDriftVerdict; sustained: DriftGapAgent[]; resolved: boolean }> {
  const r = deps.result;
  if (r === null || r.status !== "observed" || r.agentsChecked === 0) {
    return { verdict: "unmeasured", sustained: [], resolved: false };
  }

  if (r.gapAgents.length > 0) {
    await deps.clearStreak(CLEAN_KEY);
    const rule = persistenceRule(deps.rotationTicks, deps.tickMs);
    const sustained: DriftGapAgent[] = [];
    for (const a of r.gapAgents) {
      const seen = await deps.hit(
        `${BUSY_DRIFT_KEY}:seen:${a.userId}:${a.firstGapStartIso}`,
        rule.windowSeconds,
        rule.hits,
      );
      if (seen) sustained.push(a);
    }
    if (sustained.length === 0) return { verdict: "transient", sustained, resolved: false };
    // alert-key: busy_cache_drift
    await deps
      .notify(BUSY_DRIFT_KEY, deps.cooldownMs, formatBusyDriftAlert(sustained))
      .catch(() => {});
    return { verdict: "sustained", sustained, resolved: false };
  }

  if (r.agentsUnreadable > 0) return { verdict: "clear", sustained: [], resolved: false };

  const rotation = Math.max(1, deps.rotationTicks);
  const fullPass = await deps.hit(CLEAN_KEY, Math.ceil((deps.tickMs * (rotation + 1)) / 1000), rotation);
  if (!fullPass) return { verdict: "clear", sustained: [], resolved: false };
  let resolved = false;
  try {
    // alert-key: busy_cache_drift
    // all-clear-proof: src/lib/monitor/busy-drift-sampler.test.ts - a skipped,
    // unreadable or empty tick never resolves, and neither does a clean tick with
    // an unreadable agent.
    resolved = (await deps.resolve(BUSY_DRIFT_KEY, formatBusyDriftRecovery())) !== false;
  } catch {
    resolved = false;
  }
  await deps.clearStreak(CLEAN_KEY);
  return { verdict: "clear", sustained: [], resolved };
}

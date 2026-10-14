// Reading Cloudflare's own numbers for a booking load run (#2279), kept apart from
// the IO so every outcome is driven offline by scripts/test-loadtest-platform-reading.ts.
//
// The judge's platform bar had produced NO reading on any run, and reported the
// same sentence every time: "the analytics API did not report CPU, outcomes or
// invocations for the window". The issue blamed a lagging analytics pipeline. It
// was not that. Measured against the live GraphQL API on 2026-09-13:
//
//   THE QUERY ASKED FOR A FIELD THAT DOES NOT EXIST. `dimensions { outcome }` is
//   not a dimension of `workersInvocationsAdaptive`; the dimension is `status`.
//   The API answers HTTP 200 with an `errors` array and a NULL `data`, so the old
//   reader found no rows and reported a window it had never actually queried. A
//   200 was treated as a success, so nothing ever looked at `errors` (L11: the two
//   causes shared one sentence, and the one it printed was the wrong one).
//
//   THE HEALTHY SENTINEL WAS WRONG TOO. The judge treated `ok` as the good
//   outcome. The real `status` dimension reports `success`. So the first reading
//   that ever arrived would have turned every healthy invocation into a finding.
//   Both faults were invisible for the same reason: no real value had ever
//   reached this code (L98, and the fixtures in the judge's own suite were written
//   around the same wrong sentinel, so they agreed with it by construction).
//
// The measured pipeline lag was 1.9 minutes, not three hours. The three hour
// figure on the issue belongs to the Workers LOGS query pipeline (#1533), which is
// a different system from the GraphQL analytics read here. Minutes is a lag a
// bounded poll rides out, which is why `shouldPollAgain` exists.

import { tailObjects } from "./confirm-startup.ts";
import { LOADTEST_PLACED_ORIGIN } from "../../worker/lane-run.ts";
import { CRON_CPU_LIMIT_MS } from "../../src/lib/monitor/cron-budget.ts";
import { graphqlAccountRows, graphqlEnvelopeRefusal } from "../../src/lib/cloudflare/graphql-envelope.ts";

/**
 * The `status` value that means the invocation finished normally.
 *
 * Measured, not guessed: a live read of the production Worker returned exactly
 * `{ success: 199 }` over a clean window. The judge's previous `ok` appears
 * nowhere in the API's vocabulary.
 */
export const HEALTHY_INVOCATION_STATUS = "success";

/**
 * Invocations over the window, grouped by status.
 *
 * `subrequests` IS asked for, and it is worth saying why against what this repo
 * previously recorded. The judge's own comment and its printed report both claimed
 * "Cloudflare exposes NO subrequest counter, so one could never be measured". That
 * is false: `sum { subrequests }` exists, and the old query was already asking for
 * it before discarding it in the response type (L425: a decoder that declares only
 * the fields it needs silently drops its siblings). What is genuinely not exposed
 * is a PER INVOCATION maximum, which is what the 1000 subrequest ceiling is
 * actually about. A sum and a mean are what can be had, and a real breach arrives
 * as a `status` other than success, which is judged.
 */
export const INVOCATIONS_QUERY = `query($account:String!,$script:String!,$from:Time!,$to:Time!){
  viewer { accounts(filter:{accountTag:$account}) {
    workersInvocationsAdaptive(limit:10000, filter:{scriptName:$script, datetime_geq:$from, datetime_leq:$to}) {
      sum { requests subrequests }
      quantiles { cpuTimeP99 }
      dimensions { status }
    } } }
}`;

/**
 * The scheduled (cron) invocations over the same window, one row each.
 *
 * This is the dataset that makes a CPU bar judgeable at all.
 * `workersInvocationsAdaptive` counts cron invocations ALONGSIDE fetch ones and
 * carries no dimension separating them (the full dimension list was read from the
 * live schema and has no event type). Slate's cron lanes run under a raised CPU
 * ceiling deliberately (`limits.cpu_ms` is 120000), so on production 2026-09-13 the
 * adaptive p99 was 48.9 SECONDS against a 200ms per request budget: not a
 * regression, just the cron lanes being counted. Judging the mixed percentile against a per request budget
 * would have failed every run for a reason nobody should fix (L36), which is how a
 * bar stops being read.
 *
 * It is a raw dataset rather than an aggregate, so each row carries its own
 * `cpuTimeUs` and the `cron` expression that fired it, which is what lets a finding
 * NAME the lane.
 */
export const SCHEDULED_QUERY = `query($account:String!,$script:String!,$from:Time!,$to:Time!){
  viewer { accounts(filter:{accountTag:$account}) {
    workersInvocationsScheduled(limit:10000, filter:{scriptName:$script, datetime_geq:$from, datetime_leq:$to}) {
      cpuTimeUs cron status
    } } }
}`;

export interface InvocationsReading {
  invocations: number;
  subrequests: number;
  cpuMsP99: number;
  /** The `status` histogram, each name kept rather than summed (L11). */
  statuses: Record<string, number>;
}

export interface ScheduledReading {
  invocations: number;
  worstCpuMs: number;
  byCron: Record<string, { invocations: number; worstCpuMs: number }>;
  /**
   * Ticks that were COUNTED and carried no readable CPU figure (#2352).
   *
   * `worstCpuMs` is a maximum, so a tick with no reading contributes nothing to it
   * and a reader cannot tell that from a cheap tick. That is the permissive side of
   * the cron CPU bar (L50), so the omission is counted rather than left silent: a
   * worst of 4s over nineteen ticks means something different when six of them were
   * never read. Absent on the analytics reading, whose rows always carry the field.
   */
  unreadableCpu?: number;
  /**
   * #3693: lanes the ticks' own `lane timings` lines say ran PLACED (over the Worker's
   * binding to itself), and how many of those placed fetch invocations the archive holds.
   * A placed lane's CPU is spent in its own fetch invocation, never in the scheduled one,
   * so a cron half read without them judges the dispatcher alone. Archive only: the
   * analytics dataset holds scheduled invocations and cannot see a placed lane at all.
   */
  placedLanesReported?: number;
  placedLanesSeen?: number;
}

export type ReadResult<T> = { ok: true; reading: T } | { ok: false; why: string };

// The envelope is read by the shared reader in src/lib/cloudflare/graphql-envelope.ts, which the
// hourly cron CPU check uses too, so the `errors` on a 200 that blinded this judge (above) is
// looked for in one place.
const envelopeRefusal = graphqlEnvelopeRefusal;
const rowsOf = graphqlAccountRows;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read the invocations window. Every failure carries its own sentence. */
export function readInvocationsResponse(
  httpStatus: number,
  body: unknown,
): ReadResult<InvocationsReading> {
  const refused = envelopeRefusal(httpStatus, body, "invocations");
  if (refused) return { ok: false, why: refused };
  const rows = rowsOf(body, "workersInvocationsAdaptive");
  if (rows === null) {
    return {
      ok: false,
      why: "the analytics API answered with something that is not an invocations listing",
    };
  }
  if (rows.length === 0) {
    // Distinct from every refusal above: the query WORKED and the window is empty.
    // That is never a pass, because a run that made requests cannot have an empty
    // window, but it sends somebody somewhere different from a refused query.
    return {
      ok: false,
      why: "the analytics API returned no invocation rows for the window",
    };
  }
  const statuses: Record<string, number> = {};
  let invocations = 0;
  let subrequests = 0;
  let cpuUs = 0;
  for (const r of rows as {
    sum?: { requests?: number; subrequests?: number };
    quantiles?: { cpuTimeP99?: number };
    dimensions?: { status?: string };
  }[]) {
    const n = num(r.sum?.requests);
    const name = r.dimensions?.status ?? "(unnamed)";
    invocations += n;
    subrequests += num(r.sum?.subrequests);
    statuses[name] = (statuses[name] ?? 0) + n;
    // The worst p99 across the grouped rows. The API reports a quantile per group
    // and they cannot be averaged into one.
    cpuUs = Math.max(cpuUs, num(r.quantiles?.cpuTimeP99));
  }
  // MICROSECONDS, not milliseconds. A reading a thousand times too small sits
  // comfortably under every budget (docs/cloudflare-platform-notes.md).
  return { ok: true, reading: { invocations, subrequests, cpuMsP99: cpuUs / 1000, statuses } };
}

/**
 * Read the scheduled window.
 *
 * An EMPTY list is a reading of zero rather than a refusal, and the difference
 * matters: zero crons in the window is what makes the adaptive percentile request
 * only, and therefore the one case where a per request CPU budget can honestly be
 * applied.
 */
export function readScheduledResponse(
  httpStatus: number,
  body: unknown,
): ReadResult<ScheduledReading> {
  const refused = envelopeRefusal(httpStatus, body, "scheduled invocations");
  if (refused) return { ok: false, why: refused };
  const rows = rowsOf(body, "workersInvocationsScheduled");
  if (rows === null) {
    return {
      ok: false,
      why: "the analytics API answered with something that is not a scheduled invocation listing",
    };
  }
  const byCron: Record<string, { invocations: number; worstCpuMs: number }> = {};
  let worstCpuMs = 0;
  for (const r of rows as { cpuTimeUs?: number; cron?: string }[]) {
    const ms = num(r.cpuTimeUs) / 1000;
    const cron = r.cron ?? "(unnamed)";
    const seen = (byCron[cron] ??= { invocations: 0, worstCpuMs: 0 });
    seen.invocations += 1;
    seen.worstCpuMs = Math.max(seen.worstCpuMs, ms);
    worstCpuMs = Math.max(worstCpuMs, ms);
  }
  return { ok: true, reading: { invocations: rows.length, worstCpuMs, byCron } };
}

/** Why a poll stopped or continued. Each is its own outcome, never a bare boolean. */
export const POLL_REASON = {
  /** No reading at all yet. */
  nothingYet: "nothing-yet",
  /** A reading arrived and is still well under what the run itself made. */
  stillClimbing: "still-climbing",
  /** The count reached the run's own request count. */
  caughtUp: "caught-up",
  /** Time ran out. NOT the same as catching up, and must never read as one (L98). */
  deadline: "deadline",
} as const;

export type PollReason = (typeof POLL_REASON)[keyof typeof POLL_REASON];

/**
 * The share of the run's own requests the analytics must report before the window
 * is treated as settled. The judge applies its own, stricter control afterwards;
 * this only decides when to stop waiting.
 */
export const POLL_SETTLED_SHARE = 0.95;

/**
 * Whether to read again.
 *
 * The clock is a PARAMETER. Nothing here sleeps and nothing reads `Date.now`, so
 * every case is driven in a test without waiting for real time (L524, L290).
 */
export function shouldPollAgain(args: {
  invocations: number | null;
  expected: number;
  elapsedMs: number;
  deadlineMs: number;
}): { again: boolean; reason: PollReason } {
  const { invocations, expected, elapsedMs, deadlineMs } = args;
  if (invocations !== null && invocations >= expected * POLL_SETTLED_SHARE) {
    return { again: false, reason: POLL_REASON.caughtUp };
  }
  // The deadline is checked AFTER catching up, so a poll that succeeded on its
  // last attempt reports success rather than expiry.
  if (elapsedMs > deadlineMs) return { again: false, reason: POLL_REASON.deadline };
  return {
    again: true,
    reason: invocations === null ? POLL_REASON.nothingYet : POLL_REASON.stillClimbing,
  };
}

/**
 * The scheduled invocation CPU ceiling, mirroring `limits.cpu_ms` in wrangler.jsonc.
 *
 * The production headroom check judges against the same number (#3141), so it is the one
 * constant in `src/lib/monitor/cron-budget.ts` rather than a second literal, and
 * scripts/test-loadtest-platform-reading.ts still holds it against the real config (L41):
 * a judge carrying a stale ceiling would either pass a lane that is being killed or fail
 * one that is fine.
 */
export const WRANGLER_CRON_CPU_MS = CRON_CPU_LIMIT_MS;

/** How long to keep polling, and how often. */
export interface PollTimings {
  deadlineMs: number;
  intervalMs: number;
}

export const POLL_DEFAULTS: PollTimings = { deadlineMs: 300_000, intervalMs: 20_000 };

/**
 * Read the poll timings from their two raw environment values.
 *
 * Pure and separate from the run so both the defaults and every refusal are driven
 * offline. An UNSET value takes the default; a value that is set takes effect
 * exactly as written, including a deliberate zero, which is why this is not
 * `Number(raw) || default`: falsiness would silently replace a zero somebody meant.
 * Anything unreadable is REFUSED by name rather than becoming a NaN that every
 * comparison reads as false and so lands on the permissive side (L50).
 */
export function pollTimings(
  deadlineRaw: string | undefined,
  intervalRaw: string | undefined,
): { ok: true; timings: PollTimings } | { ok: false; why: string } {
  function read(raw: string | undefined, name: string, fallback: number): number | string {
    const v = (raw ?? "").trim();
    if (v === "") return fallback;
    if (!/^\d+$/.test(v)) return `${name} is not a whole number: ${JSON.stringify(raw)}`;
    return Number(v);
  }
  const d = read(deadlineRaw, "PLATFORM_POLL_DEADLINE_MS", POLL_DEFAULTS.deadlineMs);
  if (typeof d === "string") return { ok: false, why: d };
  const i = read(intervalRaw, "PLATFORM_POLL_INTERVAL_MS", POLL_DEFAULTS.intervalMs);
  if (typeof i === "string") return { ok: false, why: i };
  if (i <= 0) {
    // An interval of zero is a busy loop against somebody else's API, never what
    // anybody means, so it is refused rather than quietly clamped.
    return { ok: false, why: "PLATFORM_POLL_INTERVAL_MS must be greater than zero" };
  }
  return { ok: true, timings: { deadlineMs: d, intervalMs: i } };
}

// --- a second source for the cron half, and the two reconciled (#2352) --------
//
// `workersInvocationsScheduled` filtered on the load test script name has never
// once reported a scheduled invocation. Measured live over 2026-09-15 13:20 to
// 14:05 UTC: 61 rows for `slate` (production) and ZERO for `slate-loadtest`, while
// that Worker's ticks were plainly running (`lane_heartbeats` on the branch
// advanced every minute from 13:58, and run 34889873261's own archived log held 19
// scheduled invocations at about 27 seconds of CPU each). The same ticks DO appear
// in `workersInvocationsAdaptive` when it is filtered on the script name, each
// carrying `scriptName: "__unknown__"` in its own dimensions.
//
// So the cron half of the CPU bar had never measured anything, and the judge wrote
// "with no cron in the window" into a report as a fact about the deployment when it
// was a fact about the read (L98).
//
// The second source is the run's OWN archived `wrangler tail` stream, not the
// adaptive dataset, and that is a choice. The archive is better evidence: one row
// per invocation carrying the runtime's own `cpuTime` and the cron expression that
// fired it, which is exactly what the cron bar judges, where adaptive offers a
// percentile over a group that mixes requests and crons. And the `__unknown__`
// script name is an undocumented platform behaviour seen on two Workers on one
// afternoon; building the bar on it would rest it on something nobody can re-read
// once the Worker is gone.
//
// What the reconciliation exists to prevent is narrower than either source: a
// platform ZERO that the archive contradicts must never read as an empty window,
// because that is the one reading which lets the per request CPU budget be applied
// to a window full of cron lanes.

/**
 * The scheduled invocations inside one archived `wrangler tail --format json`
 * stream.
 *
 * NULL when the archive holds no tail event at all, and a reading of ZERO when it
 * held events and none of them was scheduled. A missing archive and a window with
 * no cron in it are different facts and must not render the same (L98).
 *
 * The objects are scanned out by brace depth through `tailObjects`, shared with the
 * confirm startup reader rather than written twice (L41): the file is PRETTY
 * PRINTED despite its `.jsonl` name, so a line split reads nothing.
 */
export function readScheduledFromArchive(archive: string): ScheduledReading | null {
  const byCron: Record<string, { invocations: number; worstCpuMs: number }> = {};
  let worstCpuMs = 0;
  let invocations = 0;
  let unreadableCpu = 0;
  let placedLanesReported = 0;
  let placedLanesSeen = 0;
  let sawAny = false;
  for (const raw of tailObjects(archive)) {
    sawAny = true;
    let event: {
      event?: { cron?: unknown; request?: { url?: unknown } | null } | null;
      cpuTime?: unknown;
      logs?: unknown;
    };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      // A half written final event (the stream is killed on a timeout) is not a
      // tick. Counting one would put a phantom under a number the judge decides
      // from, and the ticks before it are still read.
      continue;
    }
    const cron = event.event?.cron;
    // #3693: a lane sent over the Worker's binding to itself runs as its own FETCH
    // invocation, addressed to the placed origin only the dispatcher uses, and that is
    // where its CPU is. It is cron work, so it is counted beside the ticks, under its lane.
    const placedPath = placedLanePath(event.event?.request?.url);
    let key: string;
    if (placedPath !== null) {
      key = `placed ${placedPath}`;
      placedLanesSeen += 1;
    } else if (typeof cron === "string" && cron.trim() !== "") {
      // A STRING, because that is what a cron expression is. Anything else is a
      // payload this cannot read, and inventing a tick from it would be worse than
      // missing one: the count is what says whether the window may be called empty.
      key = cron;
      placedLanesReported += lanesPlacedOf(event.logs);
    } else {
      continue;
    }
    // MILLISECONDS already: the tail reports `cpuTime` in ms, unlike the analytics
    // API's `cpuTimeUs`. The two units met in one judge once and a reading a
    // thousand times too small sits comfortably under every budget.
    //
    // A tick with NO readable figure still counts as a tick, because the count is
    // what decides whether the window may be called empty, but it contributes
    // nothing to the maximum and is counted separately: folding it in as a zero
    // would be the permissive side of the CPU bar with nothing saying so (L50).
    const ms = typeof event.cpuTime === "number" && Number.isFinite(event.cpuTime) ? event.cpuTime : null;
    const seen = (byCron[key] ??= { invocations: 0, worstCpuMs: 0 });
    seen.invocations += 1;
    if (ms === null) unreadableCpu += 1;
    else {
      seen.worstCpuMs = Math.max(seen.worstCpuMs, ms);
      worstCpuMs = Math.max(worstCpuMs, ms);
    }
    invocations += 1;
  }
  if (!sawAny) return null;
  // A stream attached mid tick can miss a placed lane its tick then reported. Some
  // seen and a few missing is that, and each missing one is a tick nobody read the CPU
  // of (L50). None seen at all is a different fact, judged in `reconcileScheduled`.
  if (placedLanesSeen > 0 && placedLanesReported > placedLanesSeen) {
    unreadableCpu += placedLanesReported - placedLanesSeen;
  }
  return { invocations, worstCpuMs, byCron, unreadableCpu, placedLanesReported, placedLanesSeen };
}

/** The lane path of a placed lane request (#3693), or null for anything else. */
function placedLanePath(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(LOADTEST_PLACED_ORIGIN).origin) return null;
  return parsed.pathname.startsWith("/api/cron/") ? parsed.pathname : null;
}

/** The `lanes_placed` count on a tick's `lane timings` line, or 0 when it carries none. */
function lanesPlacedOf(logs: unknown): number {
  if (!Array.isArray(logs)) return 0;
  let total = 0;
  for (const entry of logs as { message?: unknown }[]) {
    const m = entry?.message;
    const text = typeof m === "string" ? m : Array.isArray(m) ? m.filter((x) => typeof x === "string").join(" ") : "";
    if (!text.includes('msg="lane timings"')) continue;
    const found = /\blanes_placed=(\d+)\b/.exec(text);
    if (found) total += Number(found[1]);
  }
  return total;
}

/** Which source the cron half was actually read from. */
export const SCHEDULED_SOURCE = {
  /** Cloudflare's `workersInvocationsScheduled` dataset. */
  platform: "platform",
  /** The run's own archived `wrangler tail` stream. */
  archive: "archive",
  /** Both said zero, which is the only way a window may be called empty. */
  agreedEmpty: "agreed-empty",
} as const;

export type ScheduledSource = (typeof SCHEDULED_SOURCE)[keyof typeof SCHEDULED_SOURCE];

export type ScheduledReconciliation =
  | {
      ok: true;
      source: ScheduledSource;
      reading: ScheduledReading;
      /** What the reader should know about how this was arrived at, or null when nothing. */
      why: string | null;
    }
  | { ok: false; why: string };

/**
 * The cron half, from whichever source can actually answer, and refused when
 * neither can.
 *
 * The rule that matters: **an archive reporting zero is never on its own evidence
 * of an empty window.** The stream is attached by hand under a timeout, so it can
 * start after the tick it would have seen. Only the two sources AGREEING on zero
 * may conclude that, and that conclusion is what unlocks the per request CPU
 * budget, so it is the one worth being strict about.
 */
export function reconcileScheduled(args: {
  platform: ReadResult<ScheduledReading>;
  archive: ScheduledReading | null;
}): ScheduledReconciliation {
  const { platform, archive } = args;

  // #3693: placed lanes spend their CPU in fetch invocations, which only the archive
  // carries. Ticks reporting placed lanes with none of them in the archive means the
  // stream did not carry them, and any reading left is the dispatcher's alone.
  const reported = archive?.placedLanesReported ?? 0;
  const seen = archive?.placedLanesSeen ?? 0;
  if (archive !== null && reported > 0 && seen === 0) {
    return {
      ok: false,
      why:
        `the ticks' own timings lines say ${reported} lanes ran placed (over the Worker's binding ` +
        "to itself, #3693) and this run's archived log holds none of those invocations, so their " +
        "CPU was never read. A scheduled invocation holds only the dispatcher once lanes are placed, " +
        "so judging it would pass on the cheap half.",
    };
  }
  if (archive !== null && seen > 0) {
    return {
      ok: true,
      source: SCHEDULED_SOURCE.archive,
      reading: archive,
      why:
        `${seen} lanes ran placed (#3693), so their CPU is in fetch invocations that only this ` +
        "run's archived log carries; the cron half was read from the log, where each placed lane " +
        "is judged under its own name.",
    };
  }

  if (platform.ok && platform.reading.invocations > 0) {
    return { ok: true, source: SCHEDULED_SOURCE.platform, reading: platform.reading, why: null };
  }

  if (platform.ok) {
    // The dataset answered ZERO. Whether that is a measurement or a blind spot is
    // decided entirely by the archive.
    if (archive === null) {
      return {
        ok: false,
        why:
          "the scheduled invocations dataset reported none for this Worker and no archived log " +
          "was read, so nothing can say whether a cron fired. That dataset has never once " +
          "reported a tick for a load test Worker (#2352), so its zero is not a reading.",
      };
    }
    if (archive.invocations > 0) {
      return {
        ok: true,
        source: SCHEDULED_SOURCE.archive,
        reading: archive,
        why:
          `the scheduled invocations dataset reported none for this Worker while this run's own ` +
          `archived log holds ${archive.invocations}, so the cron half was read from the log. ` +
          "That dataset does not carry a load test Worker's ticks (#2352); the log carries one " +
          "row per invocation with its own CPU, which is what this bar judges.",
      };
    }
    return { ok: true, source: SCHEDULED_SOURCE.agreedEmpty, reading: archive, why: null };
  }

  // The dataset REFUSED, so it says nothing either way.
  if (archive !== null && archive.invocations > 0) {
    return {
      ok: true,
      source: SCHEDULED_SOURCE.archive,
      reading: archive,
      why:
        `${platform.why}, so the cron half was read from this run's own archived log, which holds ` +
        `${archive.invocations} scheduled invocations.`,
    };
  }
  if (archive !== null) {
    return {
      ok: false,
      why:
        `${platform.why}, and this run's archived log holds no scheduled invocation either. An ` +
        "archive alone cannot call a window empty: the stream is attached by hand under a " +
        "timeout, so it can begin after the tick it would have seen.",
    };
  }
  return { ok: false, why: platform.why };
}

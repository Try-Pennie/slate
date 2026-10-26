/**
 * What the cron lanes did while the fault leg was injecting failures, JUDGED rather
 * than read by a person (#3104). Pure: no network, no clock, no database.
 * `scripts/test-fault-lanes.ts` drives every finding with a fixture per failure and a
 * passing one.
 *
 * The fault leg faults the WHOLE deployment, so the lanes run under it too, and the
 * runbook has always said what to look for: the failing agents named in a throttled
 * page, once per change (a new agent or a worse band, #3801) rather than once per
 * failing tick, and no lane's heartbeat going stale, because a
 * failing dependency must not stop a lane running. Until this, a person read those
 * out of an archived log tail, which nobody does on a run that otherwise passed.
 *
 * The evidence is a series of samples of `lane_heartbeats` and `alert_state`, taken
 * every few seconds for the whole time the deployment was faulted
 * (`fault-lane-sampler.ts`). SAMPLED rather than read once at the end, for two
 * reasons that are each the whole point of a bar:
 *
 *   a heartbeat table holds only the LATEST stamp per lane, so one read at the end
 *   cannot see a lane that went stale for five minutes and recovered;
 *   `alert_state` holds only the LATEST send per key, so one read at the end cannot
 *   tell one page from one page a minute. Each distinct stamp the samples saw is one
 *   send, which is what lets "throttled" be counted rather than assumed.
 *
 * Under load test nothing reaches Slack, so a page is RECORDED in `alert_state` in
 * place of being sent, with the cooldown applied exactly as production applies it
 * (`sendThrottledAlert`, #3104). That record is what is counted here.
 */

/** The sync lane's calendar failure page. Pinned against the key the sync route
 *  really sends by `scripts/test-fault-lanes.ts`, through the alert key scanner, so a
 *  rename fails the build rather than turning this bar into one that never fires. */
export const SYNC_FAILURE_ALERT_KEY = "sync_failures";

/** The lane watchdog's own stale page, one key per lane. Pinned the same way. */
export const STALE_LANE_ALERT_PREFIX = "cron_lane_stale:";

/** The watchdog's ONE page for the Worker cron lanes (2026-10-26), naming them as its
 *  subjects. Pinned the same way. */
export const CORE_LANES_ALERT_KEY = "cron_lanes_stale";

/** How often the sampler reads. Well inside the one minute cadence of the sync lane,
 *  so a page sent every tick would show as a new stamp at almost every reading. */
export const LANE_SAMPLE_INTERVAL_MS = 15_000;

/** The longest the sampler ever runs, whatever it is told, so it can never hang the
 *  job (L110). It is also the longest window a send is counted over, which is why the
 *  test holds it under the sync page's cooldown, so within one window a repeat naming
 *  nothing new can only be the throttle failing (#3801). */
export const LANE_SAMPLER_MAX_MS = 20 * 60_000;

/** One reading of the two tables, at one instant. */
export interface LaneSample {
  atMs: number;
  /** lane -> `last_ran_at` as stored. */
  heartbeats: Record<string, string>;
  /** key -> `last_sent_at` as stored. */
  alerts: Record<string, string>;
  /**
   * #3801: key -> what the last post named (`alert_state.subjects`, `band`), so the judge
   * can tell a change post, which posts at once by design, from the throttle failing.
   * Absent on a file from before it was recorded; a key missing here is unread.
   */
  alertState?: Record<string, { subjects: string[] | null; band: number | null }>;
}

/**
 * #3801: whether a send is a CHANGE against the one before it, which Dan's rule posts at
 * once: a subject the last post did not name, or a worse band. A subject only leaving is
 * not a change. A send whose state was not read is never excused (L98).
 */
export function isChangePost(
  before: { subjects: string[] | null; band: number | null } | undefined,
  after: { subjects: string[] | null; band: number | null } | undefined,
): boolean {
  if (!before || !after || before.subjects === null || after.subjects === null) return false;
  const had = new Set(before.subjects);
  if (after.subjects.some((x) => !had.has(x))) return true;
  return before.band !== null && after.band !== null && after.band > before.band;
}

/** What the sampler writes. `kind` keeps it apart from the driver files beside it. */
export interface FaultLaneEvidence {
  kind: "fault-lanes";
  runId: string;
  startedAtMs: number;
  finishedAtMs: number;
  /** How often it meant to sample; the gap check is judged against this. */
  intervalMs: number;
  samples: LaneSample[];
  /** Readings that failed and were left out, counted so a sparse series says why. */
  failedReads: number;
}

export interface FaultLaneExpectations {
  /** When the fault driver started, which is after the deployment confirmed it was
   *  faulting. The window runs from here to the sampler's own end, and the
   *  deployment stays faulted until the restore step that follows both. */
  windowStartMs: number;
  /** Every lane this deployment runs, with the stale bound the watchdog holds it to. */
  lanes: Record<string, number>;
  /** Lanes that must have stamped INSIDE the window, because their bound is long
   *  enough that freshness alone would be satisfied by a stamp from before it. */
  mustRunInWindow: readonly string[];
  /** Whether the sync page must fire: only when calendar reads were faulted. */
  syncPageExpected: boolean;
}

export interface LaneFinding {
  bar: string;
  detail: string;
}

/** #3746: one cron tick, the grace after a silence ends for the other lanes of that tick to stamp. */
const CRON_TICK_MS = 60_000;

/** Most samples may be this far apart before the series has a hole in it. */
const GAP_FACTOR = 2;

function inWindow(e: FaultLaneEvidence, x: FaultLaneExpectations): LaneSample[] {
  return e.samples
    .filter((s) => s.atMs >= x.windowStartMs && s.atMs <= e.finishedAtMs)
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Why the evidence cannot be judged, or empty when it can.
 *
 * A series that started late, stopped early or has a hole in it can only ever look
 * HEALTHY: a lane stale inside the hole, or a page sent twice either side of it, is
 * simply not in the data. So a short series is reported as a short series and never
 * as a lane that kept running (L98, L288).
 */
export function faultLaneIncompleteness(e: FaultLaneEvidence, x: FaultLaneExpectations): string[] {
  const why: string[] = [];
  const slack = e.intervalMs * GAP_FACTOR;
  if (!(e.intervalMs > 0)) {
    return ["the lane sampler recorded no sampling interval, so its coverage cannot be judged"];
  }
  if (e.finishedAtMs <= x.windowStartMs) {
    return [
      "the lane sampler finished before the fault driver started, so it saw none of the window " +
        "the deployment was faulted in",
    ];
  }
  const s = inWindow(e, x);
  if (s.length < 2) {
    return [
      `the lane sampler took ${s.length} readings while faults were injected` +
        (e.failedReads > 0 ? ` (${e.failedReads} reads failed)` : "") +
        ", so nothing about the lanes in that window can be said",
    ];
  }
  if (s[0]!.atMs - x.windowStartMs > slack) {
    why.push(
      `the lane sampler's first reading in the window came ${Math.round((s[0]!.atMs - x.windowStartMs) / 1000)}s ` +
        "after the faults began, so the start of the window was never seen",
    );
  }
  if (e.finishedAtMs - s[s.length - 1]!.atMs > slack) {
    why.push("the lane sampler's last reading came well before it stopped, so the end of the window was never seen");
  }
  let worstGap = 0;
  for (let i = 1; i < s.length; i++) worstGap = Math.max(worstGap, s[i]!.atMs - s[i - 1]!.atMs);
  if (worstGap > slack) {
    why.push(
      `the lane sampler has a ${Math.round(worstGap / 1000)}s hole in it against a ` +
        `${Math.round(e.intervalMs / 1000)}s interval` +
        (e.failedReads > 0 ? ` (${e.failedReads} reads failed)` : "") +
        ", and a lane stale inside a hole reads as a lane that kept running",
    );
  }
  return why;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * #3746: the longest stretch of the window in which NO lane stamped, when it is longer
 * than the shortest lane bound, or null.
 *
 * Every lane stopping in the same minutes is what a platform that fired no cron looks
 * like (run 38635866855, during Cloudflare's cron trigger incident), and it is not what
 * a failing dependency looks like: a fault fails a share of calls, so it cannot hold
 * every lane, including those it never touches, still at once. Measured from the
 * stamps themselves, every lane's together, from the last stamp before the window to
 * the last reading, so a stretch still running at the end is counted.
 */
export function cronSilence(e: FaultLaneEvidence, x: FaultLaneExpectations): { fromMs: number; toMs: number } | null {
  const s = inWindow(e, x);
  const bounds = Object.values(x.lanes);
  if (s.length === 0 || bounds.length === 0) return null;
  const stamps = new Set<number>();
  for (const sample of s) {
    for (const lane of Object.keys(x.lanes)) {
      const ms = Date.parse(sample.heartbeats[lane] ?? "");
      if (Number.isFinite(ms)) stamps.add(ms);
    }
  }
  const sorted = [...stamps].sort((a, b) => a - b);
  const before = sorted.filter((ms) => ms <= x.windowStartMs);
  let prev = before.length > 0 ? before[before.length - 1]! : x.windowStartMs;
  let worst: { fromMs: number; toMs: number } | null = null;
  const lastAt = s[s.length - 1]!.atMs;
  for (const ms of [...sorted.filter((v) => v > x.windowStartMs && v <= lastAt), lastAt]) {
    if (worst === null || ms - prev > worst.toMs - worst.fromMs) worst = { fromMs: prev, toMs: ms };
    prev = Math.max(prev, ms);
  }
  return worst !== null && worst.toMs - worst.fromMs > Math.min(...bounds) ? worst : null;
}

/**
 * The findings, or empty when the lanes behaved. Call only on evidence
 * `faultLaneIncompleteness` accepted.
 */
export function judgeFaultLanes(e: FaultLaneEvidence, x: FaultLaneExpectations): LaneFinding[] {
  const findings: LaneFinding[] = [];
  const s = inWindow(e, x);
  const windowMs = e.finishedAtMs - x.windowStartMs;

  // --- the crons did not fire (#3746) -----------------------------------------------
  // Still a failure, since nothing about the lanes under fault was measured, but named
  // as what it is rather than blamed on a dependency (L11).
  const silence = cronSilence(e, x);
  if (silence !== null) {
    findings.push({
      bar: "lane heartbeats under fault",
      detail:
        `no lane stamped a heartbeat for ${minutes(silence.toMs - silence.fromMs)}, every lane at once, ` +
        // The stretch is measured from the last stamp, which can precede the window, so
        // its range is said the same way and adds up to its length.
        (silence.fromMs < x.windowStartMs
          ? `from ${minutes(x.windowStartMs - silence.fromMs)} before the fault window began to ${minutes(silence.toMs - x.windowStartMs)} into it: `
          : `from ${minutes(silence.fromMs - x.windowStartMs)} to ${minutes(silence.toMs - x.windowStartMs)} into the fault window: `) +
        "the crons did not fire on this deployment, which no failing dependency explains, so whether a " +
        "dependency stops a lane was not measured on this run",
    });
  }

  // --- no lane goes stale --------------------------------------------------------
  for (const [lane, boundMs] of Object.entries(x.lanes).sort(([a], [b]) => a.localeCompare(b))) {
    let never = 0;
    let unreadable = 0;
    let stale = 0;
    // #3746: stale readings the silence does NOT explain, so a lane stopped for its own
    // reason, before the silence or after the others came back, is still blamed on it.
    let staleOwn = 0;
    let worstAgeMs = 0;
    let newestMs: number | null = null;
    for (const sample of s) {
      const raw = sample.heartbeats[lane];
      if (raw === undefined) {
        never++;
        continue;
      }
      const ms = Date.parse(raw);
      // Unreadable is NOT fresh. NaN compares false against the bound, so a stamp
      // nobody can read would pass as a lane that just ran (L50).
      if (!Number.isFinite(ms)) {
        unreadable++;
        continue;
      }
      newestMs = newestMs === null ? ms : Math.max(newestMs, ms);
      const age = sample.atMs - ms;
      worstAgeMs = Math.max(worstAgeMs, age);
      if (age > boundMs) {
        stale++;
        // Up to one cron tick past the silence's end: the lanes of a tick stamp one after
        // another, so the others are still stale for a moment after the first resumes.
        const explained = silence !== null && sample.atMs <= silence.toMs + CRON_TICK_MS && ms >= silence.fromMs - boundMs;
        if (!explained) staleOwn++;
      }
    }
    // A lane with no stamp is judged stricter than the watchdog judges it, on
    // purpose. The watchdog stays quiet about a lane that has never stamped, because
    // in production that is a fresh deploy before its first tick; here the deployment
    // has run for the whole load run before this window, so a lane that has never
    // stamped is a lane that never ran.
    if (never === s.length) {
      findings.push({
        bar: "lane heartbeats under fault",
        detail: `the ${lane} lane has no heartbeat at all, so it never ran on this deployment`,
      });
      continue;
    }
    if (unreadable > 0) {
      findings.push({
        bar: "lane heartbeats under fault",
        detail: `the ${lane} lane's heartbeat could not be read at ${unreadable} of ${s.length} readings`,
      });
    }
    if (stale > 0) {
      findings.push({
        bar: "lane heartbeats under fault",
        detail:
          `the ${lane} lane was stale at ${stale} of ${s.length} readings, worst ${minutes(worstAgeMs)} ` +
          `against its ${minutes(boundMs)} bound. ` +
          (staleOwn === 0 ? "Every lane stopped with it, so the crons not firing stopped it (above)" : "A failing dependency stopped the lane running"),
      });
    }
    if (x.mustRunInWindow.includes(lane) && (newestMs === null || newestMs < x.windowStartMs)) {
      findings.push({
        bar: "lane heartbeats under fault",
        detail:
          `the ${lane} lane did not stamp once in the ${minutes(windowMs)} faults were injected. Its ` +
          "bound is long enough that a stamp from before the window still reads as fresh, so it is " +
          "required to have run inside it",
      });
    }
  }

  // --- the watchdog's own verdict -------------------------------------------------
  // A second, independent reading of the bar above: the lane watchdog runs inside the
  // sync lane and pages on its own predicate. A stale page recorded in the window is
  // the deployment itself saying a lane stopped (L721).
  const stalePaged = new Set<string>();
  for (const sample of s) {
    for (const [key, raw] of Object.entries(sample.alerts)) {
      if (!key.startsWith(STALE_LANE_ALERT_PREFIX)) continue;
      const lane = key.slice(STALE_LANE_ALERT_PREFIX.length);
      if (!(lane in x.lanes)) continue;
      const ms = Date.parse(raw);
      if (Number.isFinite(ms) && ms >= x.windowStartMs && ms <= e.finishedAtMs) stalePaged.add(lane);
    }
  }
  // The core lanes share one page (2026-10-26), whose lanes are what it named. A send
  // whose subjects were not read is a finding of its own, never excused (L98).
  let unreadCorePage = false;
  for (const sample of s) {
    const raw = sample.alerts[CORE_LANES_ALERT_KEY];
    if (raw === undefined) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms) || ms < x.windowStartMs || ms > e.finishedAtMs) continue;
    const subjects = sample.alertState?.[CORE_LANES_ALERT_KEY]?.subjects;
    if (!subjects) {
      unreadCorePage = true;
      continue;
    }
    for (const lane of subjects) if (lane in x.lanes) stalePaged.add(lane);
  }
  if (unreadCorePage) {
    findings.push({
      bar: "lane heartbeats under fault",
      detail: "the lane watchdog paged that cron lanes had gone stale while faults were injected; which lanes it named was not read",
    });
  }
  for (const lane of [...stalePaged].sort()) {
    findings.push({
      bar: "lane heartbeats under fault",
      detail: `the lane watchdog paged that the ${lane} lane had gone stale while faults were injected`,
    });
  }

  // --- the sync page: fired, and throttled ----------------------------------------
  // Each DISTINCT stamp inside the window is one recorded send, with what the first
  // sample that saw it read about what it named.
  const sends = new Map<string, { subjects: string[] | null; band: number | null } | undefined>();
  for (const sample of s) {
    const raw = sample.alerts[SYNC_FAILURE_ALERT_KEY];
    if (raw === undefined) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms >= x.windowStartMs && ms <= e.finishedAtMs && !sends.has(raw)) {
      sends.set(raw, sample.alertState?.[SYNC_FAILURE_ALERT_KEY]);
    }
  }
  // #3801: a later send that names a new agent (or a worse band) is the change post the
  // throttle is meant to let through; only a send with nothing new is it failing.
  const ordered = [...sends.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  const repeats = ordered.filter((cur, i) => i > 0 && !isChangePost(ordered[i - 1]![1], cur[1])).length;
  if (x.syncPageExpected && sends.size === 0) {
    findings.push({
      bar: "the calendar failure page under fault",
      detail:
        `no ${SYNC_FAILURE_ALERT_KEY} page was recorded in the ${minutes(windowMs)} calendar reads were ` +
        "failing, so the agents failing to sync were never named to anybody",
    });
  }
  // Once per change, because its cooldown is longer than any window the sampler can
  // produce (pinned by the test), so a second send naming nothing new in one window is
  // the throttle failing, which is the page arriving once a minute for every failing tick.
  if (repeats > 0) {
    findings.push({
      bar: "the calendar failure page under fault",
      detail:
        `the ${SYNC_FAILURE_ALERT_KEY} page was recorded ${sends.size} times in ${minutes(windowMs)}, ` +
        `${repeats} of them naming nothing the post before had not, where its cooldown allows one ` +
        "post per change, so it is not throttled",
    });
  }
  return findings;
}

/**
 * The lanes the load test deployment RUNS, with their bounds, from the deployment's
 * `SLATE_LANES_DISABLED` as the workflow hands it to the judge, or why it cannot say.
 *
 * Handed in as a setting, like the judge's other expectations, rather than read out of
 * wrangler.jsonc by the judge: that read needed wrangler installed and the repo root as
 * the working directory, and when either was missing it threw after every driver had
 * run, so the run got no verdict at all. Every way of not knowing is a REASON here,
 * which the judge reports as incomplete:
 *
 *   unset or blank, which is indistinguishable from a workflow that never wired it,
 *   because GitHub interpolates a missing setting as the empty string; and the load
 *   test environment always holds some lanes back, so blank is never its real value;
 *   a name that is no cron lane, because the lane somebody meant to hold back would
 *   then be judged as a lane that never ran, a failure nobody should chase (L100).
 */
export function lanesRunByDeployment(
  rawDisabled: string | undefined,
  bounds: Readonly<Record<string, number>>,
  knownLanes: readonly string[],
): { lanes: Record<string, number> } | { why: string } {
  const names = (rawDisabled ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) {
    return {
      why:
        "the judge was not told which lanes the load test deployment holds back " +
        "(EXPECT_LANES_DISABLED is unset or empty), so which lanes should have kept running " +
        "under fault cannot be said",
    };
  }
  const known = new Set(knownLanes);
  const unknown = [...new Set(names.filter((n) => !known.has(n)))].sort();
  if (unknown.length > 0) {
    return {
      why:
        `EXPECT_LANES_DISABLED names ${unknown.join(", ")}, which is no cron lane, so the ` +
        "lanes held back cannot be told apart from lanes that never ran",
    };
  }
  const held = new Set(names);
  const lanes: Record<string, number> = {};
  for (const [lane, bound] of Object.entries(bounds)) if (!held.has(lane)) lanes[lane] = bound;
  return { lanes };
}

/**
 * What the lanes are held to on one run, built from the run's OWN inputs.
 *
 * Whether the sync page must fire follows what the run was CONFIGURED to fail, never
 * what the deployment reported failing. Taking the deployment's word would let a
 * deployment that silently dropped calendar reads also drop the requirement that
 * would have caught it; the two disagreeing is already its own incomplete verdict in
 * the run judge, so nothing is lost by holding the lanes to the configuration.
 */
export function faultLaneExpectationsFor(args: {
  configuredTargets: readonly string[];
  rawDisabled: string | undefined;
  bounds: Readonly<Record<string, number>>;
  knownLanes: readonly string[];
  windowStartMs: number;
}): FaultLaneExpectations | { why: string } {
  const run = lanesRunByDeployment(args.rawDisabled, args.bounds, args.knownLanes);
  if ("why" in run) return { why: run.why };
  return {
    windowStartMs: args.windowStartMs,
    lanes: run.lanes,
    mustRunInWindow: shortestBoundLanes(run.lanes),
    syncPageExpected: args.configuredTargets.includes("google-read"),
  };
}

/** The every minute lanes, the ones whose bound a short window cannot vouch for.
 *  Derived from the bounds rather than listed: the four every minute lanes share the
 *  shortest bound (`LANE_STALE_BOUNDS_MS`), so a lane added at that cadence is
 *  covered by construction (L96). */
export function shortestBoundLanes(lanes: Record<string, number>): string[] {
  const bounds = Object.values(lanes);
  if (bounds.length === 0) return [];
  const min = Math.min(...bounds);
  return Object.keys(lanes)
    .filter((l) => lanes[l] === min)
    .sort();
}

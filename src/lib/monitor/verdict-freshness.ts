/**
 * Has this detector ever actually concluded anything? (#1394)
 *
 * Slate's monitoring detectors are deliberately fail safe: a calendar Google
 * refuses is scored `unverified`, a window with too few attempts is
 * `insufficient`, a bucket offering no times is `skipped`. That is the right
 * choice, because guessing turns every upstream blip into a page. The cost is
 * that "nothing to report" and "could not check anything" render identically, in
 * the logs and in the silence.
 *
 * The availability truth probe (#1315) lived in that second state for its whole
 * life and looked exactly like the first. Every tick since deploy skipped with
 * `why="bucket is offering no times to check"`, because the roster is dark
 * before cutover and the rotation excluded the two test buckets that do have
 * slots. Establishing that took a day of log archaeology (#1377).
 *
 * The lane heartbeats cannot see this: they prove the lane EXECUTED, and this
 * lane executed faithfully every five minutes for weeks. What it never did was
 * CONCLUDE. So these detectors get a second, differently shaped stamp, written
 * only on a measured verdict and watched against its own bound.
 *
 * PURE (type only imports, erased at runtime), so
 * scripts/test-verdict-freshness.ts drives every branch node natively.
 */
import type { TruthResult } from "@/lib/monitor/availability-truth";
import type { FailureRateResult } from "@/lib/monitor/booking-failure-rate";
import type { LowVolumeResult } from "@/lib/monitor/booking-volume";
import type { OooProtectionResult } from "@/lib/monitor/ooo-protection";

/**
 * The lane names these detectors stamp, namespaced away from the cron lane
 * heartbeats they sit beside in `lane_heartbeats`.
 *
 * They share the table on purpose. The lane watchdog already reads every row in
 * ONE query every minute, so watching four more costs nothing on the subrequest
 * budget four cron lanes share, and both stamps answer the same shape of
 * question ("when did this last happen"). The `verdict:` prefix is what keeps
 * the two meanings apart: a row under it records the last time the detector
 * reached a MEASURED verdict, never the last time it ran.
 */
export const AVAILABILITY_TRUTH_VERDICT_LANE = "verdict:availability-truth";
export const FAILURE_RATE_VERDICT_LANE = "verdict:booking-failure-rate";
export const LOW_VOLUME_VERDICT_LANE = "verdict:low-booking-volume";
export const OOO_PROTECTION_VERDICT_LANE = "verdict:ooo-protection";

export type DetectorVerdictLane =
  | typeof AVAILABILITY_TRUTH_VERDICT_LANE
  | typeof FAILURE_RATE_VERDICT_LANE
  | typeof LOW_VOLUME_VERDICT_LANE
  | typeof OOO_PROTECTION_VERDICT_LANE;

/**
 * Did this availability truth tick compare real calendars and decide?
 *
 * `checked` alone is not enough. A tick reports `checked` even when the sample
 * was too small to judge (`verdict.status === "unverified"`, which is what
 * `minVerified` exists to produce), and stamping on that would let a probe that
 * can only ever read two calendars look like one that keeps confirming the cache
 * is honest. That is the same substitution the issue is named after, one level in.
 */
export function truthReachedVerdict(result: TruthResult | { status: "errored" }): boolean {
  return result.status === "checked" && result.verdict.status !== "unverified";
}

/**
 * Did this failure rate tick judge a real window?
 *
 * `insufficient` is excluded for the reason it exists: below `minAttempts` there
 * is no honest rate to quote. On a dark roster that is EVERY tick, so counting
 * it would report the detector healthy for exactly as long as it is blind.
 */
export function failureRateReachedVerdict(result: FailureRateResult | { status: "errored" }): boolean {
  return result.status === "checked" && result.verdict.status !== "insufficient";
}

/**
 * Did this low volume tick read the counts and judge them?
 *
 * `outside-hours` is a legitimate non answer twelve hours a day and all weekend,
 * which is why this detector's bound is measured in days rather than hours.
 * `count-unreadable` is the false zero #1158 removed, and must never stamp.
 */
export function lowVolumeReachedVerdict(result: LowVolumeResult): boolean {
  return result.status === "checked";
}

/**
 * Did this time off protection tick actually read the approved requests? (#1467)
 *
 * Unlike its three siblings there is no "measured but not enough to judge" state
 * here: a successful read answers the question outright, including when it finds
 * no approved time off at all, because nothing approved can then be unprotected.
 * The one outcome that must never stamp is `unreadable`, which is precisely the
 * state that would otherwise be indistinguishable from a run of clean ticks.
 */
export function oooProtectionReachedVerdict(result: OooProtectionResult): boolean {
  return result.status !== "unreadable";
}

/**
 * A detector that CANNOT reach a verdict yet, and is deliberately not paging (#1561).
 *
 * The verdict watch above pages a detector that has stopped concluding, which is
 * right, and before cutover two of them have never been able to conclude at all.
 * The page named no action anybody could take this morning (L111) and repeated
 * every 24 hours, which is how a channel gets ignored (L36).
 *
 * Parking is deliberately a hand written registry rather than something derived
 * from a live signal. "The roster is dark" is not a fact any single query returns
 * honestly, and a park that switched itself off on a misread would take a real
 * safety net down silently. An entry here is a person saying, in the repo, that
 * they know this net is off and which issue turns it back on.
 *
 * Three rules make the park safe, all enforced by scripts/test-detector-park.ts:
 * every entry names the issue that arms it again, every entry declares how fresh
 * a verdict has to be to count as concluding (`unparkWithinMs`, and it must be
 * tighter than the lane's blindness bound), and the watchdog PAGES when a parked
 * detector reaches a verdict anyway. The last is what stops the park outliving its
 * reason: cutover looks exactly like a parked detector starting to conclude, and
 * nobody has to remember anything for it to be noticed.
 */
export interface ParkedDetector {
  /** Why it cannot conclude, in the terms a reader of the whisper needs. */
  reason: string;
  /** The issue that takes it back out. Required: a park with no issue is a note to nobody. */
  issue: number;
  /**
   * How fresh a verdict has to be to mean "this detector is concluding NOW" (#1562).
   *
   * Required, and deliberately TIGHTER than the lane's blindness bound. Reusing
   * that bound is the defect this field replaces: for the failure rate check it
   * asked "has it concluded at any point in the last four days", and production
   * answered yes off a two minute coincidence. One full smoke canary pass records
   * exactly 16 booking attempts against a floor of 20 in a rolling hour, so a
   * single pass never concludes, but the canary runs four or five times a day and
   * two landing inside one hour clear the floor between them. That happened once,
   * at 2026-08-29T01:25Z, and then nothing for two and a half days while a daily
   * page asked for a blind detector to be armed.
   *
   * So the question this window asks is the one that actually separates cutover
   * from an accident in the test harness: real traffic keeps the stamp fresh on
   * essentially every tick, where a burst keeps it fresh once and then lets it
   * lapse. It does not make a burst silent, and it is not claimed to: it bounds
   * the page to the span the detector was genuinely concluding in, and the lapse
   * ends it.
   */
  unparkWithinMs: number;
}

export const PARKED_VERDICT_DETECTORS: Partial<Record<DetectorVerdictLane, ParkedDetector>> = {
  [AVAILABILITY_TRUTH_VERDICT_LANE]: {
    reason:
      "the roster is dark before cutover (#1272), so the bucket the probe picks each tick is offering no times to check",
    issue: 1562,
    // One pass of the roughly 60 bucket rotation takes about 5 hours, so a verdict
    // inside 6 hours means the probe concluded on the pass it is currently making.
    // Its blindness bound is 24 hours, nearly five passes, which is the right
    // question for "has it stopped" and the wrong one for "is it going".
    unparkWithinMs: 6 * 60 * 60_000,
  },
  [FAILURE_RATE_VERDICT_LANE]: {
    reason:
      "every booking attempt is still the smoke canary's, and one full canary pass records exactly 16 of them inside about two minutes against a floor of 20 in a rolling hour, so a pass lands four short and only two passes inside one hour ever clear it",
    issue: 1562,
    // The rolling hour the check judges. A verdict older than that was quoted from
    // a window which has since emptied, so it says nothing about whether the check
    // can judge the hour it is in now.
    unparkWithinMs: 60 * 60_000,
  },
};

/** The park entry for a lane, or null when it is armed. */
export function parkedDetector(lane: string): ParkedDetector | null {
  return PARKED_VERDICT_DETECTORS[lane as DetectorVerdictLane] ?? null;
}

/**
 * What the watchdog should do about one verdict lane this tick.
 *
 *  - `armed`  the ordinary path: judge it against its bound and page if blind.
 *  - `parked` known blind, deliberately quiet, and reported as parked so the
 *             missing net is visible rather than merely silent.
 *  - `unpark` parked, and yet it has just concluded, judged against the park's own
 *             `unparkWithinMs` rather than the wider blindness bound. The reason
 *             for the park has stopped being true, so this pages: it is the
 *             arrival of the very traffic the park was waiting for. A detector
 *             that lapses back to `parked` ends that page with its own wording,
 *             because nobody armed it and an all-clear saying otherwise would be
 *             a claim the watchdog never measured.
 *
 * An UNREADABLE stamp (the epoch-0 sentinel, #1172) is not a verdict. Reading it
 * as one would arm a detector off a corrupt record, which is the opposite of what
 * every other reader of that sentinel does.
 */
export type DetectorParkState = "armed" | "parked" | "unpark";

export function detectorParkState(
  lane: string,
  lastVerdictMs: number | null | undefined,
  nowMs: number,
): DetectorParkState {
  const parked = parkedDetector(lane);
  if (!parked) return "armed";
  if (lastVerdictMs === null || lastVerdictMs === undefined) return "parked";
  if (!Number.isFinite(lastVerdictMs) || lastVerdictMs <= 0) return "parked";
  // The park's OWN window, not the blindness bound it sits inside (#1562). The
  // bound answers "has this stopped concluding", which is a far older verdict than
  // "is this concluding", and using it here made a single accidental verdict read
  // as the arrival of real traffic for the next four days.
  return nowMs - lastVerdictMs < parked.unparkWithinMs ? "unpark" : "parked";
}

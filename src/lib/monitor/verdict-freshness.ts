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
 * PURE, so scripts/test-verdict-freshness.ts drives every branch node natively.
 * Every import here is a type except one, `SHIPPED_FAILURE_RATE_THRESHOLDS`, which
 * is a constants module whose own imports are types: a park's un-park window is
 * DERIVED from the window the check judges rather than restated beside it (L63).
 */
import type { LaneWatchdogOutcome } from "@/lib/monitor/health";
import type { TruthResult } from "@/lib/monitor/availability-truth";
import type { FailureRateResult } from "@/lib/monitor/booking-failure-rate";
import type { LowVolumeResult } from "@/lib/monitor/booking-volume";
import type { OooProtectionResult } from "@/lib/monitor/ooo-protection";
import type { BelowLeadTierResult } from "@/lib/monitor/below-lead-tier";
import type { RegalCallResult } from "@/lib/monitor/regal-calls";
import { SHIPPED_FAILURE_RATE_THRESHOLDS } from "@/lib/monitor/failure-rate-thresholds";

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
export const TWILIO_ROSTER_VERDICT_LANE = "verdict:twilio-roster";
export const LANE_WATCHDOG_VERDICT_LANE = "verdict:lane-watchdog";
/**
 * The debt tier staffing alarm (#2505).
 *
 * It needs this stamp more than any of its siblings, because it is SILENT ON A
 * HEALTHY DAY AND SILENT ON A BROKEN ONE. Measured 2026-09-17, every debt tier is
 * staffed and offering times, so the alarm ships having never fired and will very
 * likely never fire, which is exactly the state that reads as a working detector
 * and as a dead one (#1394, L557). The lane heartbeat cannot see it: the tick runs
 * fine, and what it fails to do is CONCLUDE.
 */
export const TIER_STAFFING_VERDICT_LANE = "verdict:tier-staffing";
/**
 * The proof that the burst counter answers (#2392), and the first member of this
 * family stamped from OUTSIDE the Worker.
 *
 * `pnpm verify:burst-counter` (#1564) is the only thing that can see a counter which
 * is bound and does not answer: the monitor lane resolves the namespace as a property
 * read and stops, deliberately, because calling the object would create it and hand
 * the cron lane an alarm to clean up on every tick forever. The command was hand run,
 * and AGENTS.md asked in words for it to be re-run after any change to the burst path
 * or the binding. Nothing enforced that, the path moved five times with no run
 * recorded, and a check that has never once concluded is measuring nothing (L27, L557).
 *
 * So `.github/workflows/burst-counter.yml` runs it daily and stamps this lane through
 * the same key authed heartbeat endpoint the canary and the parity sweep use, only on
 * a run that MEASURED whether the counter answers and counts. Which endings those are
 * is decided in `scripts/lib/burst-counter-run-outcome.ts`, beside the command's own
 * exit table, rather than being re-derived here from a code number.
 */
export const BURST_COUNTER_VERDICT_LANE = "verdict:burst-counter";
/**
 * The nightly proof that public booking can still be stopped (#2493), and the
 * second member of this family stamped from OUTSIDE the Worker.
 *
 * `pnpm verify:kill-switch` (#2365) is the only thing that can see the fault that
 * matters most about the kill switch: the gate fails CLOSED on purpose, so a booker
 * that cannot read its own flag refuses EVERY lead, and nothing else would say so
 * until the booking failure rate window fired after real people had been turned
 * away. The command had run exactly once, in the session that wrote it.
 *
 * It could not simply copy the burst counter's daily morning slot, because running
 * it STOPS public booking for about two seconds, so
 * `.github/workflows/kill-switch.yml` runs it outside the hours the org advertises
 * and stamps this lane through the same key authed heartbeat endpoint the canary and
 * the parity sweep use, only on a run that MEASURED whether the gate refuses and
 * releases. Which endings those are is decided in
 * `scripts/lib/kill-switch-run-outcome.ts`, beside the command's own exit table,
 * rather than being re-derived here from a code number.
 */
export const KILL_SWITCH_VERDICT_LANE = "verdict:kill-switch";
/**
 * The booking below the lead's Salesforce tier check (#2593).
 *
 * Silent on a healthy day AND on a broken one, like the tier staffing alarm: two
 * bookings in twelve hundred is the incident rate, so almost every tick finds
 * nothing, and a Salesforce read that stopped working would find nothing too.
 */
export const BELOW_LEAD_TIER_VERDICT_LANE = "verdict:below-lead-tier";

/**
 * The Regal call detector (#2090): somebody placing calls in Regal while Slate
 * will not route to them.
 *
 * It needs this stamp for the reason the whole family exists: "nobody in that
 * state" and "no calls reached Slate at all" are the same silence. Regal's
 * reporting webhook has pointed at Slate since 2026-09-24 (#2695), so a lapsed
 * stamp now means the feed stopped arriving, and the watch pages on it.
 */
export const REGAL_CALLS_VERDICT_LANE = "verdict:regal-calls";

export type DetectorVerdictLane =
  | typeof TIER_STAFFING_VERDICT_LANE
  | typeof AVAILABILITY_TRUTH_VERDICT_LANE
  | typeof FAILURE_RATE_VERDICT_LANE
  | typeof LOW_VOLUME_VERDICT_LANE
  | typeof OOO_PROTECTION_VERDICT_LANE
  | typeof TWILIO_ROSTER_VERDICT_LANE
  | typeof LANE_WATCHDOG_VERDICT_LANE
  | typeof BURST_COUNTER_VERDICT_LANE
  | typeof KILL_SWITCH_VERDICT_LANE
  | typeof BELOW_LEAD_TIER_VERDICT_LANE
  | typeof REGAL_CALLS_VERDICT_LANE;

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
 * Did the debt tier alarm judge ANY tier this tick? (#2505)
 *
 * `measuredAny` and nothing else. A tick where the roster read or the cached slot
 * rows failed reports every tier `unmeasured`, which is the honest outcome and is
 * NOT a verdict: stamping it would keep the freshness looking healthy for as long
 * as the read stayed broken, which is the blindness this family exists to notice.
 *
 * A null result is a tick that skipped or threw, which concluded nothing either.
 */
export function tierStaffingReachedVerdict(
  result: { measuredAny: boolean } | null,
): boolean {
  return result?.measuredAny === true;
}

/**
 * Did the below-tier check COMPARE at least one booking this tick? (#2593)
 *
 * `compared > 0` and nothing less. A run where either read failed is
 * `unreadable`; a run that read both sides and could judge nobody (no upcoming
 * real bookings, or only bookings whose lead has no readable XBC) measured
 * nothing either, and stamping it would let a detector that has never once held
 * a lead's tier against a pool read as one that keeps finding them in agreement
 * (L98). A null result is a step that skipped or threw.
 */
export function belowLeadTierReachedVerdict(result: BelowLeadTierResult | null): boolean {
  return result?.status === "measured" && result.compared > 0;
}

/**
 * Did the Regal call detector judge a real call this tick? (#2090)
 *
 * Only `checked`, which means every read succeeded AND at least one call from a
 * Slate user arrived in the window. `no-calls` is excluded because a feed nobody
 * posts to produces exactly it, and `unreadable` because it measured nothing. A
 * tick whose only callers were exempt IS a verdict: it read a real call and
 * decided about it.
 */
export function regalCallsReachedVerdict(result: RegalCallResult | null): boolean {
  return result?.status === "checked";
}

/**
 * Did this roster sync actually read Twilio and judge the roster? (#2114)
 *
 * The Twilio half either returns a result or refuses by name, so there is no
 * "measured but not enough to judge" state to exclude here. What this stamp adds
 * is the thing nothing else watches: the hourly roster job has NO lane heartbeat
 * of its own, so a run that stops happening altogether says nothing, and the
 * failure alert only fires when a run happens and fails. A job that is simply not
 * running produces neither, and reads exactly like a healthy quiet roster (#1394).
 *
 * A refused read stamps nothing, deliberately: that is already paged by
 * `twilio_sync_failures`, and stamping there would report the detector as
 * concluding while it is blind, which is the whole substitution this family exists
 * to stop.
 */
export function twilioRosterReachedVerdict(twilio: { ok: boolean }): boolean {
  return twilio.ok;
}

/**
 * Did this tick's lane watchdog actually judge the lanes? (#2382)
 *
 * The sixth member of the family and the one that watches the watchman. The
 * dead man's switch is itself a contained step on the monitor lane, so a
 * watchdog throwing every five minutes was caught, logged into a seven day log
 * nobody is paged from, and left the monitor heartbeat stamped fresh. From that
 * moment no stale lane anywhere could page.
 *
 * Two states stamp nothing, and they arrive by different routes. A step that
 * THREW hands back `LANE_WATCHDOG_UNJUDGED` from the runner. A step that RAN and
 * could not read the heartbeats returns `judged: false` from inside itself, and
 * that one matters more than it looks: it used to return an empty stale list,
 * which is exactly what a healthy fleet returns.
 */
export function laneWatchdogReachedVerdict(outcome: LaneWatchdogOutcome): boolean {
  return outcome.judged;
}

/**
 * A detector that CANNOT reach a verdict yet, and is deliberately not paging (#1561).
 *
 * The verdict watch above pages a detector that has stopped concluding, which is
 * right, and before cutover two of them had never been able to conclude at all
 * (the availability truth probe now can, and was unparked in #1831). The page
 * named no action anybody could take this morning (L111) and repeated every 24
 * hours, which is how a channel gets ignored (L36).
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
  // The availability truth probe's park was REMOVED here on 2026-09-07 (#1831),
  // which is the park working rather than the park being abandoned. Its reason was
  // that the roster was dark, so the bucket the probe picks each tick offered no
  // times to check, and the 2026-09-02 roster flip (#1739) ended that: 57 of the 60
  // non test buckets are offering times, and the probe stamped a verdict on two
  // consecutive monitor ticks. The daily un-park page is what said so, unprompted,
  // for four days. Note this arms the WATCH on the probe concluding, not the drift
  // page itself, which is a separate switch and still off (#1371).
  //
  // The failure rate park was removed on 2026-09-16 (#2484) and PUT BACK on
  // 2026-09-17 (#2499), because the reason #2484 gave for removing it was measured
  // wrong. It said a single canary pass now clears the floor, and no canary pass
  // can ever clear it: `booking-failure-rate-store.ts` passes `p_include_test:
  // false` to the outcome mix RPC and has done since #1637, so a test attempt
  // counts ZERO whatever the floor is. So the detector cannot conclude until real
  // Low leads book, and the un-parked watch would have paged "never concluded"
  // every four days, and daily once the page itself is armed (#1367), naming
  // something nobody could do that morning (L111, L36).
  //
  // The other two options were weighed and this is the reversible one. Letting the
  // canary count toward the floor again would reverse #1637 on purpose and have the
  // detector conclude about the CANARY rather than about leads, which is a verdict
  // on the wrong population. Accepting a page every four days that nobody can act
  // on is how a channel stops being read by the second week.
  [FAILURE_RATE_VERDICT_LANE]: {
    reason:
      "no real lead has booked yet, and the smoke canary cannot stand in for one: the outcome mix read passes p_include_test false (#1637), so every canary attempt counts zero toward the floor of attempts the check needs before it will judge. It can only conclude once the Low pilot page is live and real leads are booking",
    issue: 2513,
    // The window the check itself judges, read from the shipped thresholds rather
    // than restated here. This number means "is the detector concluding NOW", and
    // now for this check is one of its own rolling windows: a verdict from before
    // the window it is in says nothing about whether it can judge today. Restating
    // it is what went stale when #2484 moved the window from one hour to four.
    unparkWithinMs: SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs,
  },
  // #2593. Measured 2026-09-24: no upcoming active booking in a real bucket, and
  // no Slate booking has ever carried a real Salesforce Lead id, so there is
  // nothing to compare and the watch would page "never concluded" every day for
  // a reason nobody can act on (L111, L36). The first real booking unparks it,
  // and the un-park page is what says so. A test booking made in a real bucket
  // from a known test source is not compared (#2737), so it cannot un-park it:
  // on 2026-09-25 a single one from dev.trypennie.com did, then lapsed, and the
  // page flapped. A test from the production site or with no host still counts.
  [BELOW_LEAD_TIER_VERDICT_LANE]: {
    reason:
      "no real lead has an upcoming booking in Slate yet, so there is no booking to hold against the lead's Salesforce tier. It can only conclude once real leads are booking, from the Low pilot page or at cutover",
    issue: 2696,
    // Two monitor ticks. A real roster keeps an upcoming booking in view on every
    // tick, so a verdict this fresh means real bookings are in Slate now.
    unparkWithinMs: 10 * 60_000,
  },
};

/**
 * The park entry for a lane, or null when it is armed.
 *
 * `registry` is injectable for ONE reason and it is not convenience: the shipped
 * registry is currently EMPTY (#2484 armed the last entry), so without a seam the
 * park mechanism has nothing to drive it and its whole suite would have to be
 * deleted rather than kept. A mechanism that ships with no exercised test is one
 * that breaks silently the next time somebody parks a detector (L535).
 */
export function parkedDetector(
  lane: string,
  registry: Partial<Record<string, ParkedDetector>> = PARKED_VERDICT_DETECTORS,
): ParkedDetector | null {
  return registry[lane] ?? null;
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
  registry: Partial<Record<string, ParkedDetector>> = PARKED_VERDICT_DETECTORS,
): DetectorParkState {
  const parked = parkedDetector(lane, registry);
  if (!parked) return "armed";
  if (lastVerdictMs === null || lastVerdictMs === undefined) return "parked";
  if (!Number.isFinite(lastVerdictMs) || lastVerdictMs <= 0) return "parked";
  // The park's OWN window, not the blindness bound it sits inside (#1562). The
  // bound answers "has this stopped concluding", which is a far older verdict than
  // "is this concluding", and using it here made a single accidental verdict read
  // as the arrival of real traffic for the next four days.
  return nowMs - lastVerdictMs < parked.unparkWithinMs ? "unpark" : "parked";
}

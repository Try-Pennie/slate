/**
 * Stamping "this detector reached a measured verdict" (#1394).
 *
 * The IO half of verdict-freshness.ts, kept apart from it so the decision about
 * WHICH outcomes count stays node testable and this file stays a three line
 * write. It reuses `lane_heartbeats` through `recordHeartbeat`, so a stamp is
 * best effort and can never take down the monitor lane, and so the lane
 * watchdog's existing one query read picks these rows up for free.
 *
 * The calls name their lane LITERALLY on purpose. The repo invariant in
 * scripts/test-heartbeat-lane-coverage.ts scans for exactly that shape and then
 * checks, in both directions, that every stamped lane has a bound watching it and
 * every bound watches a lane something really stamps. A computed lane name would
 * be opaque to that scan, and the whole point of this feature is not to ship
 * another marker nobody reads.
 */
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import {
  AVAILABILITY_TRUTH_VERDICT_LANE,
  FAILURE_RATE_VERDICT_LANE,
  LOW_VOLUME_VERDICT_LANE,
  OOO_PROTECTION_VERDICT_LANE,
  TWILIO_ROSTER_VERDICT_LANE,
  LANE_WATCHDOG_VERDICT_LANE,
  TIER_STAFFING_VERDICT_LANE,
  OFFERED_NOBODY_FREE_VERDICT_LANE,
  BUFFER_BREACH_VERDICT_LANE,
  BELOW_LEAD_TIER_VERDICT_LANE,
  CROSS_SYSTEM_BOOKINGS_VERDICT_LANE,
  BURST_COUNTER_VERDICT_LANE,
  KILL_SWITCH_VERDICT_LANE,
  CONFIRM_LINE_VERDICT_LANE,
  REROUTE_DRILL_VERDICT_LANE,
  AVAILABILITY_LATENCY_VERDICT_LANE,
  REGAL_CALLS_VERDICT_LANE,
  ROSTER_COVERAGE_VERDICT_LANE,
  AVAILABILITY_SCAN_VERDICT_LANE,
  CALENDAR_WINDOW_VERDICT_LANE,
  OFFSITE_ORIGIN_VERDICT_LANE,
  AUTH_SIGN_IN_VERDICT_LANE,
  AUTH_UNEXPECTED_SIGN_IN_VERDICT_LANE,
  AWAITING_ACTIVATION_VERDICT_LANE,
  STRANDED_HIRES_VERDICT_LANE,
  AUDIT_CHAIN_VERDICT_LANE,
  REGAL_CALL_FEED_VERDICT_LANE,
  REGAL_CALL_OUTCOMES_VERDICT_LANE,
  ADVISOR_PHOTOS_VERDICT_LANE,
  BUSY_MINUTES_VERDICT_LANE,
  BUSY_DRIFT_VERDICT_LANE,
  CRON_BUDGET_VERDICT_LANE,
  type DetectorVerdictLane,
} from "@/lib/monitor/verdict-freshness";

/**
 * The verdict lanes this Worker stamps for itself.
 *
 * FOUR are deliberately NOT, all for the same reason: the check each records does
 * something the monitor lane must not.
 *
 * `verdict:burst-counter` (#2392) has to CALL the burst counter Durable Object, and
 * calling it creates the object and gives it an alarm to clean up on every tick
 * forever. `verdict:kill-switch` (#2493) has to STOP PUBLIC BOOKING for about two
 * seconds, which is not something a lane running every five minutes may do.
 * `verdict:confirm-line` (#3340) has to drive the confirm path's client against the
 * shared `CONFIRM_LINE` object, taking leads, queueing behind them and reporting
 * verdicts, two dozen calls and a wait out of a whole acknowledgement window per run,
 * which the invocation four cron lanes share has no room for on every tick.
 * `verdict:reroute-drill` (#3615) has to BOOK, MOVE and CANCEL a test call through a minute or
 * two of calendar writes. All four run as GitHub workflows (the last two as steps of the burst
 * counter's) and stamp through the key authed heartbeat endpoint instead.
 *
 * A fifth, `verdict:availability-latency` (#1700), is excluded for its own reason,
 * given beside it below: the smoke canary measures it on a GitHub runner.
 *
 * Excluding them in the TYPE rather than by leaving them out of the table below is
 * what keeps that a decision rather than an omission: a further lane added to the
 * family and forgotten here still fails `tsc`, which is the whole reason this map is
 * a `Record` (L129).
 */
export type WorkerStampedVerdictLane = Exclude<
  DetectorVerdictLane,
  | typeof BURST_COUNTER_VERDICT_LANE
  | typeof KILL_SWITCH_VERDICT_LANE
  | typeof CONFIRM_LINE_VERDICT_LANE
  // #3615: the daily reroute drill, stamped by its own steps of the burst counter's workflow.
  | typeof REROUTE_DRILL_VERDICT_LANE
  // #1700: measured by the smoke canary on a GitHub runner, where the reads it times
  // happen, so there is nothing for the Worker to stamp.
  | typeof AVAILABILITY_LATENCY_VERDICT_LANE
>;

const STAMP: Record<WorkerStampedVerdictLane, () => Promise<void>> = {
  [AVAILABILITY_TRUTH_VERDICT_LANE]: () => recordHeartbeat("verdict:availability-truth"),
  [FAILURE_RATE_VERDICT_LANE]: () => recordHeartbeat("verdict:booking-failure-rate"),
  [LOW_VOLUME_VERDICT_LANE]: () => recordHeartbeat("verdict:low-booking-volume"),
  [OOO_PROTECTION_VERDICT_LANE]: () => recordHeartbeat("verdict:ooo-protection"),
  [TWILIO_ROSTER_VERDICT_LANE]: () => recordHeartbeat("verdict:twilio-roster"),
  [LANE_WATCHDOG_VERDICT_LANE]: () => recordHeartbeat("verdict:lane-watchdog"),
  [TIER_STAFFING_VERDICT_LANE]: () => recordHeartbeat("verdict:tier-staffing"),
  [BELOW_LEAD_TIER_VERDICT_LANE]: () => recordHeartbeat("verdict:below-lead-tier"),
  [CROSS_SYSTEM_BOOKINGS_VERDICT_LANE]: () => recordHeartbeat("verdict:cross-system-bookings"),
  [REGAL_CALLS_VERDICT_LANE]: () => recordHeartbeat("verdict:regal-calls"),
  [ROSTER_COVERAGE_VERDICT_LANE]: () => recordHeartbeat("verdict:roster-coverage"),
  [AVAILABILITY_SCAN_VERDICT_LANE]: () => recordHeartbeat("verdict:availability-scan"),
  [CALENDAR_WINDOW_VERDICT_LANE]: () => recordHeartbeat("verdict:calendar-window"),
  [OFFSITE_ORIGIN_VERDICT_LANE]: () => recordHeartbeat("verdict:offsite-origin"),
  [AUTH_SIGN_IN_VERDICT_LANE]: () => recordHeartbeat("verdict:auth-sign-in"),
  [AUTH_UNEXPECTED_SIGN_IN_VERDICT_LANE]: () => recordHeartbeat("verdict:auth-unexpected-sign-in"),
  [AWAITING_ACTIVATION_VERDICT_LANE]: () => recordHeartbeat("verdict:awaiting-activation"),
  [STRANDED_HIRES_VERDICT_LANE]: () => recordHeartbeat("verdict:stranded-hires"),
  [AUDIT_CHAIN_VERDICT_LANE]: () => recordHeartbeat("verdict:audit-chain"),
  [REGAL_CALL_FEED_VERDICT_LANE]: () => recordHeartbeat("verdict:regal-call-feed"),
  [REGAL_CALL_OUTCOMES_VERDICT_LANE]: () => recordHeartbeat("verdict:regal-call-outcomes"),
  [ADVISOR_PHOTOS_VERDICT_LANE]: () => recordHeartbeat("verdict:advisor-photos"),
  [BUSY_MINUTES_VERDICT_LANE]: () => recordHeartbeat("verdict:busy-minutes"),
  [BUSY_DRIFT_VERDICT_LANE]: () => recordHeartbeat("verdict:busy-drift"),
  [OFFERED_NOBODY_FREE_VERDICT_LANE]: () => recordHeartbeat("verdict:offered-nobody-free"),
  [BUFFER_BREACH_VERDICT_LANE]: () => recordHeartbeat("verdict:buffer-breach"),
  [CRON_BUDGET_VERDICT_LANE]: () => recordHeartbeat("verdict:cron-budget"),
};

/**
 * Record that `lane`'s detector concluded, but ONLY when it really did.
 *
 * `reached` is passed in rather than inferred here so every call site reads as
 * the predicate that decides it, and so a caller cannot stamp by forgetting to
 * ask. A false is a no write, not a write of "nothing": the absence IS the
 * signal this feature watches.
 */
export async function recordDetectorVerdict(
  lane: WorkerStampedVerdictLane,
  reached: boolean,
): Promise<void> {
  if (!reached) return;
  await STAMP[lane]();
}

/**
 * The four heartbeat stamps the two daily time off lanes write (#2543).
 *
 * Named here, in one place, because each one is written by a route and READ by
 * `TIME_OFF_STALE_BOUNDS_MS` in `src/lib/monitor/health.ts`, and a stamp whose
 * name does not match the bound watching it is a lane that looks monitored and is
 * not (#1123). `scripts/test-time-off-lane-bounds.ts` holds the bounds map to
 * exactly these four names, so a rename on either side fails the build rather than
 * silently disabling the switch.
 *
 * Two per lane, because "the cron fired" and "the work happened" are different
 * questions with different remedies (L11):
 *
 *   ATTEMPT   stamped as soon as the route is reached, INCLUDING the daily tick
 *             the time gate no-ops. It means the dispatcher is firing, and nothing
 *             more.
 *   REPORT    stamped only when the run reached a measured outcome: the report
 *             went out, or there was genuinely nothing to report. Finding nothing
 *             is a conclusion; failing to look is not (L98), so a thrown read
 *             stamps neither.
 *
 * `OOO_APPROVALS_REPORT_LANE` is ALSO the catch-up watermark. The approvals run
 * always covers up to the ET midnight of the day it runs on, so that stamp's ET
 * day start is the instant the last report covered through, and a stale stamp and
 * a widening catch-up window are the same fact seen twice.
 */
export const OOO_APPROVALS_ATTEMPT_LANE = "ooo-approvals";
export const OOO_APPROVALS_REPORT_LANE = "ooo-approvals-report";
export const OOO_DIGEST_ATTEMPT_LANE = "ooo-digest";
export const OOO_DIGEST_NUDGE_LANE = "ooo-digest-nudge";

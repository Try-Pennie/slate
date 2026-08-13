/**
 * Stamping "this detector reached a measured verdict" (#1394).
 *
 * The IO half of verdict-freshness.ts, kept apart from it so the decision about
 * WHICH outcomes count stays node testable and this file stays a three line
 * write. It reuses `lane_heartbeats` through `recordHeartbeat`, so a stamp is
 * best effort and can never take down the monitor lane, and so the lane
 * watchdog's existing one query read picks these rows up for free.
 *
 * The four calls name their lane LITERALLY on purpose. The repo invariant in
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
  type DetectorVerdictLane,
} from "@/lib/monitor/verdict-freshness";

const STAMP: Record<DetectorVerdictLane, () => Promise<void>> = {
  [AVAILABILITY_TRUTH_VERDICT_LANE]: () => recordHeartbeat("verdict:availability-truth"),
  [FAILURE_RATE_VERDICT_LANE]: () => recordHeartbeat("verdict:booking-failure-rate"),
  [LOW_VOLUME_VERDICT_LANE]: () => recordHeartbeat("verdict:low-booking-volume"),
  [OOO_PROTECTION_VERDICT_LANE]: () => recordHeartbeat("verdict:ooo-protection"),
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
  lane: DetectorVerdictLane,
  reached: boolean,
): Promise<void> {
  if (!reached) return;
  await STAMP[lane]();
}

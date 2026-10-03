// A healthy lane sampler series for the fault leg (#3104), shared by the lane judge's
// own test and the whole run judge's test so both start from one passing state.
import {
  LANE_SAMPLE_INTERVAL_MS,
  SYNC_FAILURE_ALERT_KEY,
  type FaultLaneEvidence,
  type FaultLaneExpectations,
  type LaneSample,
} from "../loadtest/fault-lanes.ts";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The lanes the fixture runs, with bounds shaped like production's: two every
 *  minute lanes and one every five. */
export const FIXTURE_LANES = { sync: 10 * MIN, outbox: 10 * MIN, complete: 20 * MIN };

/**
 * A five minute window starting at `t0`: every lane stamps on its own cadence, and the
 * sync page is recorded once, two minutes in, then held by its cooldown.
 */
export function healthyFaultLanes(t0: number, runId = "run-1"): FaultLaneEvidence {
  const samples: LaneSample[] = [];
  for (let at = t0 - 30_000; at <= t0 + 5 * MIN; at += LANE_SAMPLE_INTERVAL_MS) {
    const lastMinute = at - (at % MIN);
    const lastFive = at - (at % (5 * MIN));
    const alerts: Record<string, string> = {};
    if (at >= t0 + 2 * MIN) alerts[SYNC_FAILURE_ALERT_KEY] = iso(t0 + 2 * MIN);
    samples.push({
      atMs: at,
      heartbeats: { sync: iso(lastMinute), outbox: iso(lastMinute), complete: iso(lastFive - 5 * MIN) },
      alerts,
    });
  }
  return {
    kind: "fault-lanes",
    runId,
    startedAtMs: t0 - 30_000,
    finishedAtMs: t0 + 5 * MIN,
    intervalMs: LANE_SAMPLE_INTERVAL_MS,
    samples,
    failedReads: 0,
  };
}

/** What the fixture's lanes are held to, with the window opening at `t0`. */
export function fixtureLaneExpectations(t0: number): FaultLaneExpectations {
  return {
    windowStartMs: t0,
    lanes: FIXTURE_LANES,
    mustRunInWindow: ["sync", "outbox"],
    syncPageExpected: true,
  };
}

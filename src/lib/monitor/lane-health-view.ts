import { classifyLaneHealth, type LaneHealthRow } from "./health.ts";

/**
 * Load + classify cron-lane health for the admin strip (#288). Separated from the
 * page so the read-error path is unit-testable without rendering the whole page.
 *
 * The heartbeat read (`readAllHeartbeatMs`) THROWS on a read failure by design: an
 * empty map is indistinguishable from "every lane is dead", so silently reporting a
 * healthy fleet because the DB was unreachable is exactly the false-confidence bug
 * the dead-man's switch exists to avoid. Here we catch that and flag `unavailable`
 * so the UI says so, rather than rendering an empty (falsely all-fine) strip.
 */
export interface LaneHealthView {
  rows: LaneHealthRow[];
  unavailable: boolean;
}

export async function loadLaneHealth(
  read: () => Promise<Record<string, number | null>>,
  nowMs: number,
): Promise<LaneHealthView> {
  try {
    return { rows: classifyLaneHealth(await read(), nowMs), unavailable: false };
  } catch {
    return { rows: [], unavailable: true };
  }
}

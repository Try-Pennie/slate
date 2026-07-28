/**
 * Shared observability for the three retention lanes (#1102).
 *
 * Until now these lanes were watched by nothing: no heartbeat, no bounds entry,
 * no alert. A failure returned 500 into `log.error` and stopped there, and
 * Cloudflare logs are 7-day retention with no alerting on top.
 *
 * Two distinct signals, because they answer different questions and one must not
 * stand in for the other:
 *
 *   - `laneCompleted` stamps the heartbeat whenever the lane finishes WITHOUT
 *     throwing, including a skip. That feeds the dead-man's switch, which asks
 *     "did the cron fire at all". It deliberately does NOT stamp on a throw, so a
 *     lane that fails every night goes stale and pages.
 *   - `alertRetentionSkipped` covers the case the heartbeat cannot see: a lane
 *     that runs fine and skips forever. If the warehouse credential is removed or
 *     the warehouse is suspended, `mirrorReadyForDeletion` returns not-ready and
 *     all three lanes no-op while returning a cheerful 200. PII retention would
 *     stop indefinitely with nothing anywhere saying so, which is a protective
 *     control failing open (L42). A skip is now an alert, throttled long because
 *     these lanes only run daily.
 */

import { NextResponse } from "next/server";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/** Daily lanes, so re-page at most once a day rather than on every run. */
const SKIP_COOLDOWN_MS = 23 * 60 * 60_000;

/**
 * The lanes this helper may stamp. Named here as a literal set for two reasons:
 * the #1123 coverage guard has to be able to read what gets stamped (a stamp whose
 * lane name no bound watches looks like monitoring while nothing is watching), and
 * it lets the helper refuse an unknown lane rather than silently creating an
 * unwatched heartbeat row. Every entry must have a RETENTION_STALE_BOUNDS_MS bound.
 */
export const RETENTION_HEARTBEAT_LANES = new Set([
  "prune-routing",
  "prune-webhook-payloads",
  "prune-bookings-pii",
]);

/**
 * Finish a retention lane: stamp the dead-man's-switch heartbeat, then respond.
 * Best-effort on the stamp (a heartbeat write failure must not turn a successful
 * prune into a 500), and it logs on failure rather than swallowing.
 */
export async function laneCompleted(lane: string, body: Record<string, unknown>): Promise<NextResponse> {
  if (!RETENTION_HEARTBEAT_LANES.has(lane)) {
    // An unknown lane would create a heartbeat row no bound reads, which is the
    // #1123 failure: it looks instrumented and is not watched by anything.
    throw new Error(`laneCompleted: ${lane} is not a known retention lane, so its heartbeat would be unwatched`);
  }
  await recordHeartbeat(lane).catch((err) => {
    log.error(lane, { msg: "heartbeat stamp failed" }, err instanceof Error ? err : undefined);
  });
  return NextResponse.json(body);
}

/**
 * A lane that ran but destroyed nothing because the mirror was not usable. The
 * heartbeat cannot distinguish this from healthy work, so it gets its own alert.
 */
export async function alertRetentionSkipped(lane: string, reason: string): Promise<void> {
  const what =
    lane === "prune-bookings-pii"
      ? "consumer contact data past the 24 month window is not being redacted"
      : lane === "prune-webhook-payloads"
        ? "webhook payloads past the 90 day window are keeping full attendee PII"
        : "routing decisions past the 12 month window are not being pruned";
  await sendThrottledAlert(
    `retention_skipped:${lane}`,
    SKIP_COOLDOWN_MS,
    `Slate: the ${lane} retention lane ran but did nothing because the Snowflake mirror is not usable (${reason}), so ${what}. Retention stays stopped until the mirror is healthy: check /api/admin/snowflake-check and the snowflake-export lane.`,
  ).catch((err) => {
    log.error(lane, { msg: "skip alert failed" }, err instanceof Error ? err : undefined);
  });
}

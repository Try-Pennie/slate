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
 *     the export lane falls behind, `mirrorReadyForDeletion` returns not-ready and
 *     all three lanes no-op while returning a cheerful 200. PII retention would
 *     stop indefinitely with nothing anywhere saying so, which is a protective
 *     control failing open (L42). A skip is now an alert, throttled long because
 *     these lanes only run daily.
 */

import { NextResponse } from "next/server";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";
import { retentionResumedText, retentionSkippedText } from "@/lib/notify/misc-alert-copy";

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
  // #1252. Not mirror-gated like the three above (busy_blocks is a rebuildable
  // cache, not a mirrored table), so it uses only the heartbeat half of this
  // module: it can never sit in the skip-forever state the skip alert covers.
  "prune-busy-blocks",
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
  await sendThrottledAlert(
    `retention_skipped:${lane}`,
    SKIP_COOLDOWN_MS,
    // alert-text-ok: `reason` is our own gate wording (export-lag-core.ts), never a raw error.
    retentionSkippedText(lane, reason),
  ).catch((err) => {
    log.error(lane, { msg: "skip alert failed" }, err instanceof Error ? err : undefined);
  });
}

/**
 * The other half of `alertRetentionSkipped` (#1151): this lane is deleting again.
 *
 * "Retention is stopped" is a CONDITION, not an event: it stays true, silently,
 * for as long as the mirror is unusable, and the only thing that ever observes it
 * ending is a run that gets past the gate. Called from exactly there, so it can
 * never announce a recovery off a run that skipped. `resolveAlert` is a no-op
 * unless a page was delivered, so a lane that never stalled stays silent.
 *
 * Best-effort like its sibling: the deleting already happened, and a Slack
 * problem must not turn a good run into a 500.
 */
export async function alertRetentionResumed(lane: string): Promise<void> {
  // try/catch, not just `.catch`: this runs in the middle of a lane that has
  // already begun deleting, and a notice that threw SYNCHRONOUSLY would abort the
  // run and turn a healthy prune into a 500.
  try {
    const cleared = await resolveAlert(
      `retention_skipped:${lane}`,
      retentionResumedText(lane),
    );
    if (cleared) log.info(lane, { msg: "retention-skipped alert cleared" });
  } catch (err) {
    log.error(lane, { msg: "resume notice failed" }, err instanceof Error ? err : undefined);
  }
}

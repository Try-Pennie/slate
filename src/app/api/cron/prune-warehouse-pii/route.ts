import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { sweepWarehousePii } from "@/lib/snowflake/warehouse-retention";
import { alertRetentionResumed, alertRetentionSkipped, laneCompleted } from "@/lib/snowflake/retention-lane";
import { MIRROR_NOT_CONFIGURED } from "@/lib/notify/misc-alert-copy";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
const LANE = "prune-warehouse-pii";

/**
 * The warehouse half of the 24 month booking PII window (#1180).
 *
 * Its three siblings (`prune-routing`, `prune-webhook-payloads`,
 * `prune-bookings-pii`) delete from Supabase and are gated on the mirror already
 * holding the row. This one is the mirror image: it clears contact data from the
 * WAREHOUSE, so it needs no export gate, because nothing has to be archived
 * before it may run. The reasoning, and why it needs no marker column and no
 * warehouse DDL, is in `warehouse-retention.ts`.
 *
 * SCHEDULED rather than operator-triggered, which was the open decision on the
 * issue. The deletion-request purge stayed a deliberate action so the audit lane
 * remains the thing that notices a missed one; retention has no per-request trail
 * to miss and is purely time driven, so that argument does not carry over, and a
 * window nobody remembers to enforce is not a window. The cost of running
 * unattended is that it needs its own answer to "what if it silently stops", which
 * is the pair below.
 *
 * TWO SIGNALS, because they answer different questions and neither substitutes:
 *
 *   - `laneCompleted` stamps the dead-man's-switch heartbeat on any run that did
 *     not throw, including a skip. Judged against RETENTION_STALE_BOUNDS_MS, so a
 *     lane that fails every night, or stops firing, goes stale and pages.
 *   - `alertRetentionSkipped` covers what the heartbeat cannot see: a lane that
 *     runs fine and clears nothing forever. Without the warehouse credential this
 *     route would no-op behind a cheerful 200 while the committed retention window
 *     quietly stopped being honored on the mirror side, which is a protective
 *     control failing open (L42).
 *
 * Everything else fails LOUD by design: an unreadable select, an unreadable row
 * count, or a verify that still finds contact data all throw out of the sweep,
 * and the catch below turns that into a 500 with the heartbeat withheld. A
 * "cleared 0" response means one thing only, that nothing was past the window.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/prune-warehouse-pii");
  if (claimed) return claimed;
  // lock-overlap: the warehouse redaction nulls contact columns, which is idempotent; a
  // second run nulls the same values again.
  const lock = await acquireLock("cron_prune_warehouse_pii", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const result = await sweepWarehousePii(new Date().toISOString());

    if (result.skipped === "mirror-not-configured") {
      log.info(LANE, { msg: "skipped: mirror not configured" });
      await alertRetentionSkipped(LANE, MIRROR_NOT_CONFIGURED);
      return laneCompleted(LANE, { skipped: result.skipped });
    }

    // Past the only gate, so this lane really is clearing again. Hung off a run
    // that actually reached the sweep, never off "we did not alert this time"
    // (#1134, #1152): a skipped run measured nothing and must clear nothing.
    await alertRetentionResumed(LANE);

    return laneCompleted(LANE, { ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(LANE, { msg: "cron failed", error: message });
    return laneFailure("prune-warehouse-pii", message);
  } finally {
    await releaseLock("cron_prune_warehouse_pii", lock);
  }
}

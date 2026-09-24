import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import { laneCompleted } from "@/lib/snowflake/retention-lane";
import { pruneRegalCalls } from "@/lib/regal/retention";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;

/**
 * PRUNE REGAL CALLS lane (#2090): delete inbound Regal call events received more
 * than `REGAL_CALL_RETENTION_DAYS` ago.
 *
 * One DELETE statement: the database does the work in one subrequest. A day is
 * about 6,000 rows at the volume measured on 2026-09-17, so a night's sweep is one
 * day's worth and never a backlog, except after an outage of this lane, when the
 * statement is still a single range delete on an indexed column.
 *
 * No mirror gate: the table is not mirrored and holds no lead data, so nothing
 * needs archiving first (the same reasoning as prune-busy-blocks). It uses only the
 * heartbeat half of `retention-lane.ts`: a lane that throws every night stops
 * stamping and the watchdog pages.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_regal_calls", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const db = supabaseAdmin();
    const report = await pruneRegalCalls({
      nowMs: Date.now(),
      // unwrapCount, not `count ?? 0` (#1165): a delete that failed reports a null
      // count, and scoring that as zero reads as "nothing needed cleaning".
      deleteReceivedBefore: async (cutoff) =>
        unwrapCount(
          await db.from("regal_call_events").delete({ count: "exact" }).lt("received_at", cutoff),
          "regal_call_events prune delete",
        ),
    });
    log.info("prune-regal-calls", { msg: "cycle", deleted: report.deleted, cutoff: report.cutoff });
    return laneCompleted("prune-regal-calls", report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-regal-calls", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_prune_regal_calls", lock);
  }
}

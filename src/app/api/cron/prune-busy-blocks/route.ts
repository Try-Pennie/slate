import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { withinBudget } from "@/lib/google/sync-pace";
import { laneCompleted } from "@/lib/snowflake/retention-lane";
import { busyPruneCutoffIso, pruneInBatches } from "@/lib/busy/prune-core";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;
/** Under the lock TTL, so a slow run can never outlive its own claim. */
const PRUNE_BUDGET_MS = 40_000;

/**
 * PRUNE BUSY BLOCKS lane (#1252): delete cached gcal busy blocks whose end is far
 * enough in the past that nothing can read them.
 *
 * `busy_blocks` had no retention at all and only ever grew (403k rows / 247 MB on
 * 2026-08-04, of which 3,646 were inside the readable window). Size is not just
 * storage: `purgeVanished` pages EVERY cached block for a calendar on each full
 * resync, so one agent with 9,811 blocks costs ten paged reads per resync.
 *
 * There is deliberately NO mirror/export gate here, unlike the three retention
 * lanes this sits beside. Those delete rows the Snowflake archive is the long-term
 * home for, so they must confirm the warehouse holds a row first. `busy_blocks` is
 * not a mirrored table (nothing in src/lib/snowflake references it): it is a
 * derived cache of Google's calendars, rebuildable by a resync, and no archive
 * depends on it.
 *
 * Scope and safety live in `prune-core.ts`: past rows only, keeping a window wider
 * than the sync's bootstrap lookback so the two lanes cannot churn against each
 * other. Future rows are out of scope on purpose (incremental sync reports only
 * changes, so a deleted far-future block is never re-added).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_busy_blocks", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const cutoff = busyPruneCutoffIso(new Date().toISOString());
    const db = supabaseAdmin();
    const deadlineMs = Date.now() + PRUNE_BUDGET_MS;
    const report = await pruneInBatches({
      // Oldest first, bounded by `limit` (busy_blocks is a growth table, so the
      // read carries its own bound). unwrap, not a bare destructure: a read error
      // returning [] would read as "nothing left to prune" and the backlog would
      // sit there while the lane reported a clean run every night.
      selectIds: async (limit) => {
        const rows =
          unwrap(
            await db
              .from("busy_blocks")
              .select("id")
              .eq("source", "gcal")
              .is("booking_id", null)
              .lt("ends_at", cutoff)
              .order("ends_at", { ascending: true })
              .limit(limit),
            "busy_blocks prune candidates",
          ) ?? [];
        return (rows as { id: string }[]).map((r) => r.id);
      },
      // unwrapCount, not `count ?? 0` (#1165): a delete that failed reports a null
      // count, and scoring that as zero is indistinguishable from having had
      // nothing to clean.
      // Chunked by measured BYTES (#1321), not by the round size above. The ids
      // ride in the request URL, so an oversized `in` filter is REFUSED at the
      // transport rather than merely slow, and a row count only holds while every
      // id is the same length. Chunking here means the round size is free to be a
      // plain row count without the two constraints fighting each other.
      deleteIds: async (ids) => {
        let deleted = 0;
        for (const chunk of chunkIdsByUrlBudget(ids)) {
          deleted += unwrapCount(
            await db.from("busy_blocks").delete({ count: "exact" }).in("id", chunk),
            "busy_blocks prune delete",
          );
        }
        return deleted;
      },
      withinBudget: () => withinBudget(Date.now(), deadlineMs),
    });
    // `capped` is logged, not just returned: a run that stopped on its cap and a
    // run that cleared the backlog both answer 200, and without saying which, a cap
    // set too low is indistinguishable from a table that is finally clean.
    log.info("prune-busy-blocks", {
      msg: "cycle",
      pruned: report.pruned,
      batches: report.batches,
      capped: report.capped,
      cutoff,
    });
    return laneCompleted("prune-busy-blocks", {
      pruned: report.pruned,
      batches: report.batches,
      capped: report.capped,
      cutoff,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-busy-blocks", { msg: "cron failed", error: message });
    return laneFailure("prune-busy-blocks", message);
  } finally {
    await releaseLock("cron_prune_busy_blocks", lock);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { withinBudget } from "@/lib/google/sync-pace";
import { laneCompleted } from "@/lib/snowflake/retention-lane";
import {
  busyPruneCutoffIso,
  busyFuturePruneCutoffIso,
  busyFuturePruneGateIso,
  BUSY_PRUNE_MAX_ROWS_PER_RUN,
  pruneInBatches,
} from "@/lib/busy/prune-core";
import { BUSY_WINDOW_AHEAD_DAYS } from "@/lib/google/sync-coalesce";
import { WRITE_WINDOW_MARGIN_MS } from "@/lib/google/sync-core";
import { HORIZON_MAX } from "@/lib/booking/settings";
import { chunkIdsByUrlBudget } from "@/lib/db/id-batch";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;
/** Under the lock TTL, so a slow run can never outlive its own claim. */
const PRUNE_BUDGET_MS = 40_000;

/**
 * PRUNE BUSY BLOCKS lane: delete cached gcal busy blocks that are out of the window any
 * reader can see, both far in the past (#1252) and far in the future (#1265).
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
 * Two clauses. The cutoff and gate maths are pure in `prune-core.ts`; the selection and
 * delete for each clause live in this handler:
 *
 *  - PAST rows (#1252): anything ended more than the keep-past window ago, kept wider
 *    than the sync's bootstrap lookback so the two lanes cannot churn.
 *  - FUTURE out-of-window rows (#1265): blocks starting past the write filter's keep
 *    boundary, which the #1264 write filter now stops ADDING, so this removes the
 *    backlog without the delta re-adding it. Pruned only for calendars whose
 *    `sync_window_to` is past the hydration gate, so it is provable nothing readable is
 *    deleted (readable needs `starts_at < now + horizon`, far inside the cutoff). Keyed
 *    per calendar on `user_id` (the leading index column); an orphan block whose
 *    `(user_id, calendar_id)` has no `agent_calendars` row is never in the eligible list
 *    and so is left alone, neither reconciled nor covered by any window.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/prune-busy-blocks");
  if (claimed) return claimed;
  // lock-overlap: idempotent deletes of out-of-window Google busy blocks (past and
  // future); a second run re-selects what a first already removed and deletes nothing new.
  const lock = await acquireLock("cron_prune_busy_blocks", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    // One clock for the whole run (#1265 review): the past cutoff, the future gate and
    // the future cutoff are all measured from the SAME instant, so the two clauses cannot
    // disagree about where "now" is.
    const nowIso = new Date().toISOString();
    const cutoff = busyPruneCutoffIso(nowIso);
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

    // Report the PAST prune NOW, before the future phase runs (#1265 review): the future
    // phase can throw (an agent_calendars read error), and the outer catch would then
    // report only the failure. Logging here means the rows the past phase already deleted
    // are recorded whatever the future phase does.
    log.info("prune-busy-blocks", {
      msg: "past cycle",
      pruned: report.pruned,
      batches: report.batches,
      capped: report.capped,
      cutoff,
    });

    // #1265: the FUTURE out-of-window prune, after the past one and sharing the same
    // deadline so the two together stay inside the lane's budget. Only calendars hydrated
    // past the gate are touched, keyed per calendar on user_id. Reuses pruneInBatches so
    // the bound, the URL-safe chunking, unwrap/unwrapCount and the failure paths all carry
    // over.
    const futureGate = busyFuturePruneGateIso(nowIso, HORIZON_MAX);
    const futureCutoff = busyFuturePruneCutoffIso(nowIso, BUSY_WINDOW_AHEAD_DAYS, WRITE_WINDOW_MARGIN_MS);
    // cap-safe: agent_calendars is roster-bounded (~150 against a 200-agent target), so
    // the eligible list can never fill a page. unwrap, so a read error aborts the future
    // prune rather than reading as "no calendars eligible" and silently pruning nothing.
    const eligible = (unwrap(
      await db.from("agent_calendars").select("user_id, calendar_id").gt("sync_window_to", futureGate),
      "future prune eligible calendars",
    ) ?? []) as { user_id: string; calendar_id: string }[];
    let futurePruned = 0;
    let futureBatches = 0;
    // Two distinct reasons the future phase can leave a backlog, kept apart so the log
    // says which (#1265 review, L11): the shared cap/row limit was reached, or the shared
    // deadline ran out (often because the past phase used it). Either means "more to do",
    // but a run starved of budget every night is a different fix from a cap set too low.
    let futureCapped = false;
    let futureBudgetExhausted = false;
    for (const cal of eligible) {
      if (!withinBudget(Date.now(), deadlineMs)) {
        futureBudgetExhausted = true;
        break;
      }
      // ONE row cap across BOTH phases (#1265 review): the past prune's deletes count
      // against it too, so a run can never delete more than BUSY_PRUNE_MAX_ROWS_PER_RUN in
      // total and the shared subrequest budget the cap is sized for is not doubled.
      if (report.pruned + futurePruned >= BUSY_PRUNE_MAX_ROWS_PER_RUN) {
        futureCapped = true;
        break;
      }
      const r = await pruneInBatches({
        selectIds: async (limit) => {
          const rows =
            unwrap(
              await db
                .from("busy_blocks")
                .select("id")
                .eq("user_id", cal.user_id)
                .eq("calendar_id", cal.calendar_id)
                .eq("source", "gcal")
                .is("booking_id", null)
                .gte("starts_at", futureCutoff)
                .order("starts_at", { ascending: true })
                .limit(limit),
              "busy_blocks future prune candidates",
            ) ?? [];
          return (rows as { id: string }[]).map((row) => row.id);
        },
        deleteIds: async (ids) => {
          let deleted = 0;
          for (const chunk of chunkIdsByUrlBudget(ids)) {
            deleted += unwrapCount(
              await db.from("busy_blocks").delete({ count: "exact" }).in("id", chunk),
              "busy_blocks future prune delete",
            );
          }
          return deleted;
        },
        withinBudget: () => withinBudget(Date.now(), deadlineMs),
        // The remaining shared budget: the past phase's deletes and every earlier
        // calendar's both count, so the whole run stays under one cap.
        maxRows: BUSY_PRUNE_MAX_ROWS_PER_RUN - report.pruned - futurePruned,
      });
      futurePruned += r.pruned;
      futureBatches += r.batches;
      // A calendar that stopped early ends the future prune for this run; the rest wait
      // for the next. pruneInBatches reports `capped` for EITHER its row cap OR the shared
      // deadline, so attribute the reason by re-checking the budget here: time only moves
      // forward, so if it stopped on the deadline the budget is spent now too. (A calendar
      // that drained on an exact batch boundary also reports capped; the budget is then
      // still fine, so it is counted as a cap, which over-reports "more to do" harmlessly.)
      if (r.capped) {
        if (!withinBudget(Date.now(), deadlineMs)) futureBudgetExhausted = true;
        else futureCapped = true;
        break;
      }
    }

    // The future side's own line. `capped` vs `budget_exhausted` is logged (not just a
    // single "more to do"): a cap set too low and a phase starved of budget every night
    // both leave a backlog but need different fixes.
    log.info("prune-busy-blocks", {
      msg: "future cycle",
      future_pruned: futurePruned,
      future_batches: futureBatches,
      future_capped: futureCapped,
      future_budget_exhausted: futureBudgetExhausted,
      future_cutoff: futureCutoff,
      future_eligible_calendars: eligible.length,
    });
    return laneCompleted("prune-busy-blocks", {
      pruned: report.pruned,
      batches: report.batches,
      capped: report.capped,
      cutoff,
      futurePruned,
      futureBatches,
      // "more to do" on the future side, whichever bound stopped it.
      futureCapped: futureCapped || futureBudgetExhausted,
      futureBudgetExhausted,
      futureCutoff,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-busy-blocks", { msg: "cron failed", error: message });
    return laneFailure("prune-busy-blocks", message);
  } finally {
    await releaseLock("cron_prune_busy_blocks", lock);
  }
}

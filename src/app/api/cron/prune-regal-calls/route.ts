import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { laneCompleted } from "@/lib/snowflake/retention-lane";
import { pruneRegalCallOutcomes, pruneRegalCalls } from "@/lib/regal/retention";
import { pruneRateLimits } from "@/lib/rate-limit-core";
import { pruneLaneRuns } from "@/lib/monitor/lane-claim";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;

/**
 * PRUNE REGAL CALLS lane (#2090): delete inbound Regal call events received more
 * than `REGAL_CALL_RETENTION_DAYS` ago, and call outcomes (#2944) received more
 * than `REGAL_OUTCOME_RETENTION_DAYS` (120) ago.
 *
 * One DELETE statement per table: the database does the work in one subrequest
 * each. A day is about 6,000 rows at the volume measured on 2026-09-17, so a
 * night's sweep is one day's worth and never a backlog, except after an outage of
 * this lane, when each statement is still a single range delete on an indexed
 * column.
 *
 * No mirror gate: neither table is mirrored and neither holds contact data (the
 * outcome rows carry an external Salesforce Lead id key), so nothing needs
 * archiving first (the same reasoning as prune-busy-blocks). It uses only the
 * heartbeat half of `retention-lane.ts`: a lane that throws every night stops
 * stamping and the watchdog pages.
 *
 * It also prunes `rate_limits` (#3109), as a third sweep with its own failure
 * boundary. That table is not mirrored either, and it was the one table in Slate
 * with no retention of any kind: one row per caller IP, and per lead email and
 * phone, for ever. It rides this lane rather than a new one because it is the
 * same shape of work (one statement, no gate, a heartbeat) and costs this
 * invocation two more subrequests (one statement for the limiter rows, one for
 * the boundary counters, #3176), where a lane of its own would add a lock, a
 * heartbeat bound and two more. Which rows go is decided in
 * `rateLimitPrunePlan`, which keeps every streak counter and every open window
 * out of reach.
 *
 * And `lane_runs` (#4222), the cron lanes' claims on their ticks, as a fourth sweep
 * for the same reasons: not mirrored, no lead or agent data, one range delete on
 * the indexed `claimed_at`, one more subrequest. Two days are kept
 * (`LANE_RUN_RETENTION_DAYS`); a claim only has to outlive its tick's re-send.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/prune-regal-calls");
  if (claimed) return claimed;
  // lock-overlap: idempotent deletes before a fixed cutoff; a second run deletes
  // nothing new.
  const lock = await acquireLock("cron_prune_regal_calls", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const db = supabaseAdmin();
    const nowMs = Date.now();
    // Three sweeps, each one statement (#2944 added the second, #3109 the third),
    // run independently so a failure in one still lets the others do their night's
    // work; any of them failing fails the lane, so it stops stamping and the
    // watchdog pages.
    const [events, outcomes, rateLimits, laneRuns] = await Promise.allSettled([
      pruneRegalCalls({
        nowMs,
        // unwrapCount, not `count ?? 0` (#1165): a delete that failed reports a null
        // count, and scoring that as zero reads as "nothing needed cleaning".
        deleteReceivedBefore: async (cutoff) =>
          unwrapCount(
            await db.from("regal_call_events").delete({ count: "exact" }).lt("received_at", cutoff),
            "regal_call_events prune delete",
          ),
      }),
      pruneRegalCallOutcomes({
        nowMs,
        deleteReceivedBefore: async (cutoff) =>
          unwrapCount(
            await db.from("regal_call_outcomes").delete({ count: "exact" }).lt("received_at", cutoff),
            "regal_call_outcomes prune delete",
          ),
      }),
      pruneRateLimits({
        // A null count with no error is no answer at all from a function that
        // always returns one, so it fails the sweep rather than reading as zero.
        prune: async (prefixes, olderThanSeconds) => {
          const deleted = unwrap(
            await db.rpc("prune_rate_limits", {
              p_prefixes: prefixes,
              p_older_than_seconds: olderThanSeconds,
            }),
            "rate_limits prune",
          );
          if (typeof deleted !== "number") throw new Error("rate_limits prune returned no count");
          return deleted;
        },
      }),
      // #4222: the cron lanes' claims on their ticks, kept two days.
      pruneLaneRuns({
        nowMs,
        deleteClaimedBefore: async (cutoff) =>
          unwrapCount(
            await db.from("lane_runs").delete({ count: "exact" }).lt("claimed_at", cutoff),
            "lane_runs prune delete",
          ),
      }),
    ]);
    if (events.status === "rejected") throw events.reason;
    if (outcomes.status === "rejected") throw outcomes.reason;
    if (rateLimits.status === "rejected") throw rateLimits.reason;
    if (laneRuns.status === "rejected") throw laneRuns.reason;
    const report = {
      deleted: events.value.deleted,
      cutoff: events.value.cutoff,
      outcomesDeleted: outcomes.value.deleted,
      outcomesCutoff: outcomes.value.cutoff,
      rateLimitsDeleted: rateLimits.value.deleted,
      rateLimitsGroups: rateLimits.value.groups,
      laneRunsDeleted: laneRuns.value.deleted,
      laneRunsCutoff: laneRuns.value.cutoff,
    };
    log.info("prune-regal-calls", {
      msg: "cycle",
      deleted: report.deleted,
      cutoff: report.cutoff,
      outcomes_deleted: report.outcomesDeleted,
      outcomes_cutoff: report.outcomesCutoff,
      rate_limits_deleted: report.rateLimitsDeleted,
      lane_runs_deleted: report.laneRunsDeleted,
    });
    return laneCompleted("prune-regal-calls", report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-regal-calls", { msg: "cron failed", error: message });
    return laneFailure("prune-regal-calls", message);
  } finally {
    await releaseLock("cron_prune_regal_calls", lock);
  }
}

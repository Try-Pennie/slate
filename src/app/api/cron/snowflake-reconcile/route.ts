import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { reconcileSnowflakeMirror } from "@/lib/snowflake/reconcile";
import { runSnowflakeHealthcheck } from "@/lib/snowflake/healthcheck";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { shortFailureReason } from "@/lib/notify/error-text";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";
import {
  snowflakeDriftAlert,
  snowflakeDriftRecovery,
  snowflakeHealthcheckAlert,
  snowflakeHealthcheckRecovery,
} from "@/lib/snowflake/alert-copy";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
// Matches the 6h cadence: a persistent drift should re-page at most once per run,
// not spam, but a fault that clears is re-checked next run.
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
const HEALTHCHECK_ALERT_KEY = "snowflake_healthcheck";

/**
 * Run the warehouse self-check on a SCHEDULE (#1144).
 *
 * `runSnowflakeHealthcheck` is the only thing that exercises our real statements
 * against the real warehouse: it resolves the login, confirms every mirror table
 * declares the load stamp, runs the archive-verification question against a
 * known-archived row, and re-MERGEs that same row through the real repair path.
 * Nothing called it on a schedule, so it only ever ran when an admin opened
 * /api/admin/snowflake-check. That is exactly how #1143 shipped: a SQL compilation
 * error (`CURRENT` is a Snowflake reserved word, used as a column alias) that broke
 * every retention verification while all 1,100+ unit tests passed, because they
 * answer with a stand-in rather than parsing the statement.
 *
 * The heartbeat is stamped ONLY on a healthy probe, which is deliberate and is the
 * other half of #1123's both-directions rule: the alert covers "the probe failed",
 * and withholding the stamp covers "the probe has not SUCCEEDED in 8h", which still
 * pages when the thing that is broken is the alerting path itself.
 *
 * An unconfigured mirror is not a failure: it neither alerts nor stamps, and a lane
 * that has never stamped cannot go stale in MIRROR_STALE_BOUNDS_MS, so a non-mirror
 * environment can never page about a warehouse it does not have.
 *
 * Never throws. This is monitoring bolted onto the end of the lane, and it must not
 * cost us the reconciliation that already ran.
 */
async function runScheduledHealthcheck(): Promise<void> {
  try {
    const health = await runSnowflakeHealthcheck();
    if (!health.configured) return;
    if (!health.ok) {
      await sendThrottledAlert(
        HEALTHCHECK_ALERT_KEY,
        ALERT_COOLDOWN_MS,
        snowflakeHealthcheckAlert(shortFailureReason(health.error) ?? "no detail"),
      );
      return;
    }
    await recordHeartbeat("snowflake-check");
    const cleared = await resolveAlert(
      HEALTHCHECK_ALERT_KEY,
      snowflakeHealthcheckRecovery(),
    );
    if (cleared) log.info("snowflake-check", { msg: "healthcheck alert cleared" });
  } catch (err) {
    log.error("snowflake-check", { msg: "scheduled healthcheck failed" }, err);
  }
}

/**
 * Snowflake mirror reconciliation lane (#1101). Counts every mirrored table in
 * Supabase vs Snowflake, runs a positive control, and Slack-alerts on drift or a
 * failed control. Its own cron expression + lock. Fail-loud (log.error + 500).
 * No-op while the mirror is unconfigured.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/snowflake-reconcile");
  if (claimed) return claimed;

  // lock-overlap: COUNT reads, a re-merge of one known row by id, and throttled alerts
  // on a 6 hour cadence; an overlap needs a manual call and costs at most a duplicate
  // Slack message.
  const lock = await acquireLock("cron_snowflake_reconcile", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const result = await reconcileSnowflakeMirror();
    if (!result.skipped && !result.ok) {
      await sendThrottledAlert(
        "snowflake_reconcile_drift",
        ALERT_COOLDOWN_MS,
        snowflakeDriftAlert(result.reasons),
      );
    } else if (!result.skipped) {
      // #1151: drift is a CONDITION, so say when it ends. Hung off the measured
      // in-sync result, never off "we did not alert this run": a SKIPPED run
      // (mirror unconfigured) measured nothing and must not clear a real page.
      // resolveAlert is a no-op unless a page was delivered.
      const cleared = await resolveAlert(
        "snowflake_reconcile_drift",
        snowflakeDriftRecovery(),
      );
      if (cleared) log.info("snowflake-reconcile", { msg: "drift alert cleared" });
    }
    // After the reconciliation, so a warehouse that is too broken to answer the
    // self-check still gets its drift counted and reported first (#1144).
    await runScheduledHealthcheck();
    await recordHeartbeat("snowflake-reconcile").catch(() => {});
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("snowflake-reconcile", { msg: "cron failed", error: message });
    return laneFailure("snowflake-reconcile", message);
  } finally {
    await releaseLock("cron_snowflake_reconcile", lock);
  }
}

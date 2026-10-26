import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { auditSnowflakeErasures } from "@/lib/snowflake/erasure-audit";
import { sendThrottledAlert, sendThrottledInfo, resolveAlert } from "@/lib/notify/dispatch";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";
import {
  erasureClassificationUnreadable,
  erasureResidualAlert,
  erasureResidualRecovery,
  erasureResidualTestNotice,
  purgeSqlBrokenAlert,
  purgeSqlBrokenRecovery,
  credentialSweepAlert,
  CREDENTIAL_SWEEP_RECOVERY,
} from "@/lib/snowflake/alert-copy";
import { runErasurePurgeSqlProbe } from "@/lib/snowflake/purge";
import { runMirrorCredentialSweep } from "@/lib/snowflake/credential-sweep";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;
// One re-page per run at most for a persistent residual, not spam. Matches the
// co-scheduled reconcile lane's 6h cadence.
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Erasure content-audit lane (#1103 Workstream C). The Snowflake half of a DSR
 * erasure is a manual operator step, and the count reconcile can't see whether it
 * happened (a redacted and a full-fidelity row count the same). This lane reads
 * the pii.erasure audit trail and Slack-alerts if the warehouse still holds contact
 * PII for an erased booking. Co-scheduled with snowflake-reconcile on the 6h lane,
 * under its own lock. Fail-loud (log.error + 500). No-op while the mirror is
 * unconfigured.
 *
 * Stamps its OWN heartbeat (#1123), judged against MIRROR_STALE_BOUNDS_MS. This was
 * previously documented as covered by the co-scheduled reconcile lane's dead-man's
 * switch, which was wrong twice over: reconcile's heartbeat was watched by no bound
 * at all, and even working it could not have covered this lane, because reconcile
 * succeeding keeps ITS stamp fresh while this route errors every run. A safety net
 * failing in silence is worse than no safety net. The stamp happens only on a
 * completed run (the error path returns before it), which is exactly what lets the
 * watchdog see a persistently broken audit.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/erasure-audit");
  if (claimed) return claimed;

  // lock-overlap: read only checks plus throttled alerts on a 6 hour cadence; an
  // overlap needs a manual call and costs at most a duplicate Slack message.
  const lock = await acquireLock("cron_erasure_audit", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const result = await auditSnowflakeErasures();
    if (!result.skipped && !result.ok) {
      await sendThrottledAlert(
        "snowflake_erasure_residual",
        ALERT_COOLDOWN_MS,
        // alert-text-ok: every part is our own wording. The reasons come from
        // evaluateErasureAudit, the ids are uuids from our own audit_log rows (not
        // contact data, unlike the deliberately hashed email), and the
        // classification note is a fixed sentence.
        erasureResidualAlert(result.reasons, result.realBookingIds) +
          (result.classificationUnreadable
            ? erasureClassificationUnreadable(result.classificationUnreadable)
            : ""),
      );
    } else if (!result.skipped) {
      // #1151: an incomplete erasure is a CONDITION that ends when the operator
      // runs the purge, and this audit is the only thing that would ever notice.
      // Hung off the MEASURED clean result: a skipped run (mirror unconfigured)
      // checked nothing and must not clear a real page.
      const cleared = await resolveAlert(
        "snowflake_erasure_residual",
        erasureResidualRecovery(),
      );
      if (cleared) log.info("erasure-audit", { msg: "residual alert cleared" });
    }

    // #1196: the same finding on a SMOKE fixture, on its own key and the info
    // channel. Label, do not suppress: the rows are really there and nothing else
    // would report them, but the "PII" is fabricated (#396 isolates the fixtures),
    // so it is a worklist item rather than something to wake for.
    //
    // Deliberately has NO all-clear, and that is not an omission. An info key that
    // resolved would announce the end of an incident there never was, which the
    // catalog classification forbids and test-alert-recovery-coverage.ts enforces.
    // Its absence costs nothing here: the condition is visible on the worklist,
    // and a real residual keeps its own resolve above.
    if (!result.skipped && result.testReasons.length > 0) {
      // alert-key: snowflake_erasure_residual_test
      await sendThrottledInfo(
        "snowflake_erasure_residual_test",
        ALERT_COOLDOWN_MS,
        // alert-text-ok: as above, our own reasons plus our own uuids.
        erasureResidualTestNotice(result.testReasons, result.testBookingIds),
      );
    }

    // #1128: prove the purge SQL still RUNS, on its own key. The audit above can
    // only see that the warehouse still holds data; it cannot see that the
    // statements meant to clear it stopped compiling, which is what #1197 was.
    // Deliberately a second key rather than folded into the result above: a clean
    // residual audit must never clear a broken-SQL page, and vice versa (L53).
    const probe = await runErasurePurgeSqlProbe();
    if (!probe.skipped && !probe.ok) {
      await sendThrottledAlert(
        "snowflake_purge_sql_broken",
        ALERT_COOLDOWN_MS,
        purgeSqlBrokenAlert(probe.reasons),
      );
    } else if (!probe.skipped) {
      // Hung off the MEASURED pass (every statement compiled), never off "this run
      // did not alert": a skipped or unconfigured run proved nothing (#1134/#1152).
      const cleared = await resolveAlert("snowflake_purge_sql_broken", purgeSqlBrokenRecovery());
      if (cleared) log.info("erasure-audit", { msg: "purge sql alert cleared" });
    }

    // #2564: the mirror carried the booking manage token, and the manage URL that
    // embeds it inside every delivery payload. Both are credentials rather than
    // descriptions of the person, so a warehouse reader held booking control. The
    // merge strips them now; this clears what was already exported, which no future
    // export will revisit (the walk is strictly forward over a watermark).
    //
    // Its own key, like the probe above and for the same reason: a clean erasure
    // audit must never clear a credential page (L53).
    const credentials = await runMirrorCredentialSweep();
    if (!credentials.skipped && !credentials.ok) {
      await sendThrottledAlert(
        "snowflake_credential_residual",
        ALERT_COOLDOWN_MS,
        // alert-text-ok: our own field labels and our own counts. No warehouse
        // reply text reaches it, and no credential value ever could: the sweep
        // reads counts, never values.
        credentialSweepAlert(credentials.reasons),
      );
    } else if (!credentials.skipped) {
      // Hung off the MEASURED clean residual, never off "this run did not alert":
      // an unconfigured mirror proved nothing (#1134/#1152).
      const cleared = await resolveAlert("snowflake_credential_residual", CREDENTIAL_SWEEP_RECOVERY);
      if (cleared) log.info("erasure-audit", { msg: "credential residual alert cleared" });
    }
    if (!credentials.skipped) {
      // Logged rather than alerted: the first run legitimately clears thousands,
      // and nothing durable tells this lane which run is its first. What prevents a
      // credential rejoining the mirror is the static guard, not this count.
      log.info("credential-sweep", { msg: "swept", cleared: JSON.stringify(credentials.cleared) });
    }

    await recordHeartbeat("erasure-audit").catch(() => {});
    return NextResponse.json({ ...result, purgeSql: probe, credentials });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("erasure-audit", { msg: "cron failed", error: message });
    return laneFailure("erasure-audit", message);
  } finally {
    await releaseLock("cron_erasure_audit", lock);
  }
}

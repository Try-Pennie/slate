import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { webhookPayloadCutoffIso } from "@/lib/webhooks/retention";
import { WEBHOOK_MAX_ATTEMPTS } from "@/lib/webhooks/retry";
import { exportedThrough, mirrorReadyForDeletion } from "@/lib/snowflake/retention-gate";
import { MAX_VERIFY_BATCH, destroyVerified } from "@/lib/snowflake/verify-archived";
import { repairUnverified } from "@/lib/snowflake/reexport";
import { alertRetentionResumed, alertRetentionSkipped, laneCompleted } from "@/lib/snowflake/retention-lane";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;

/**
 * #1073: blank webhook_deliveries.payload (attendee PII) on deliveries that are
 * terminal (succeeded, or failed past the retry cap) and older than the retention
 * window, and set payload_erased so no send path re-delivers the blanked row.
 * A single UPDATE statement (the DB does the work, one subrequest); mirrors
 * prune-routing (own lock, fail-loud). Never touches a pending/retryable row (it
 * still needs its payload) or a suppressed/already-erased one.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/prune-webhook-payloads");
  if (claimed) return claimed;
  // lock-overlap: erasing a payload by id is idempotent, so a second run erases nothing
  // new.
  const lock = await acquireLock("cron_prune_webhook_payloads", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const cutoff = webhookPayloadCutoffIso(new Date().toISOString());
    // Export-gated (#1118): blanking a payload bumps updated_at and the export
    // freezes it out afterward, so Snowflake must already hold the full-fidelity
    // version. Gate on a passing reconciliation, and only blank rows STRICTLY
    // before the confirmed-export watermark (strict `<`: the export cursor is a
    // composite (updated_at, id) keyset, so an equal-watermark row may be unexported).
    const gate = await mirrorReadyForDeletion();
    if (!gate.ready) {
      log.info("prune-webhook-payloads", { msg: "skipped: mirror not ready", reason: gate.reason });
      await alertRetentionSkipped("prune-webhook-payloads", gate.reason ?? "unknown");
      return laneCompleted("prune-webhook-payloads", { skipped: "mirror-not-ready", reason: gate.reason });
    }
    const exportedTo = await exportedThrough("webhook_deliveries");
    if (!exportedTo) {
      await alertRetentionSkipped("prune-webhook-payloads", "nothing exported yet");
      return laneCompleted("prune-webhook-payloads", { skipped: "nothing-exported-yet" });
    }
    // #1151: past both gates, so this lane really is deleting again.
    await alertRetentionResumed("prune-webhook-payloads");

    // Read a BOUNDED batch of candidates and prove the warehouse holds each one
    // before blanking it (#1102). Blanking is irreversible for the payload, so it
    // needs the same proof a delete does. The bound is not optional: this table is
    // already past PostgREST's 1000-row single-page cap, so an unbounded read
    // would silently see part of the set.
    const db = supabaseAdmin();
    const { data: aged, error: readErr } = await db
      .from("webhook_deliveries")
      .select("id,updated_at")
      .eq("payload_erased", false)
      .eq("suppressed", false)
      // Terminal only: a delivered success, or a failure past the retry cap. A
      // pending/retryable row still needs its payload for the retry sweep.
      .or(`status.eq.success,and(status.eq.failed,attempts.gte.${WEBHOOK_MAX_ATTEMPTS})`)
      .lt("created_at", cutoff)
      .lt("updated_at", exportedTo)
      .order("created_at", { ascending: true })
      .limit(MAX_VERIFY_BATCH);
    if (readErr) throw new Error(readErr.message);
    const candidates = ((aged ?? []) as { id: string; updated_at: string }[]).map((r) => ({
      id: r.id,
      watermark: r.updated_at,
    }));

    const report = await destroyVerified({
      table: "webhook_deliveries",
      watermarkCol: "updated_at",
      candidates,
      repair: repairUnverified,
      destroy: async (ids) => {
        const { error, count } = await db
          .from("webhook_deliveries")
          .update({ payload: {}, payload_erased: true, last_response: null }, { count: "exact" })
          .in("id", ids);
        if (error) throw new Error(error.message);
        return count ?? 0;
      },
    });
    if (report.problems.length > 0) {
      log.warn("prune-webhook-payloads", {
        msg: "left unverified rows in place",
        unverified: report.problems.length,
        first: report.problems[0].id,
        state: report.problems[0].state,
      });
    }
    return laneCompleted("prune-webhook-payloads", { erased: report.destroyed, candidates: report.candidates, cutoff });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-webhook-payloads", { msg: "cron failed", error: message });
    return laneFailure("prune-webhook-payloads", message);
  } finally {
    await releaseLock("cron_prune_webhook_payloads", lock);
  }
}

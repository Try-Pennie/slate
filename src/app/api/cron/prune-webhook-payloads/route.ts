import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { webhookPayloadCutoffIso } from "@/lib/webhooks/retention";
import { WEBHOOK_MAX_ATTEMPTS } from "@/lib/webhooks/retry";
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
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const lock = await acquireLock("cron_prune_webhook_payloads", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const cutoff = webhookPayloadCutoffIso(new Date().toISOString());
    const { error, count } = await supabaseAdmin()
      .from("webhook_deliveries")
      .update({ payload: {}, payload_erased: true, last_response: null }, { count: "exact" })
      .eq("payload_erased", false)
      .eq("suppressed", false)
      // Terminal only: a delivered success, or a failure past the retry cap. A
      // pending/retryable row still needs its payload for the retry sweep.
      .or(`status.eq.success,and(status.eq.failed,attempts.gte.${WEBHOOK_MAX_ATTEMPTS})`)
      .lt("created_at", cutoff);
    if (error) throw new Error(error.message);
    return NextResponse.json({ erased: count ?? 0, cutoff });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-webhook-payloads", { msg: "cron failed", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_prune_webhook_payloads", lock);
  }
}

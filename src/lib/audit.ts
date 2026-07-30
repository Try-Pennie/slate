import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { shortFailureReason, shortErrorReason } from "@/lib/notify/error-text";
import { auditWriteFailedAlert } from "@/lib/notify/misc-alert-copy";
import { log } from "@/lib/log";

export type AuditAction =
  | "role.set"
  | "agent.hours"
  | "agent.use_default_hours"
  | "agent.bookable"
  | "agent.deactivate"
  | "agent.reactivate"
  | "agent.attributes"
  | "agent.manager"
  | "agent.ooo_calendar"
  | "ooo.submit"
  | "ooo.approve"
  | "ooo.reject"
  | "ooo.cancel"
  | "ooo.modify"
  | "ooo.retry"
  | "impersonate.start"
  | "impersonate.stop"
  | "impersonate.ended"
  | "monitor.settings"
  | "reason.options"
  | "booking.settings";

/** One key for the whole trail: if audit writes are broken they are broken for
 *  every action, so a per-action key would page N times for one cause. */
export const AUDIT_WRITE_FAILED_KEY = "audit_write_failed";

/** Long enough that a persistently broken audit_log pages once rather than once
 *  per admin click; short enough that still-broken an hour later is news again. */
export const AUDIT_WRITE_FAILED_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Appends a privileged action to the audit trail. Never throws, so a logging
 * failure can't break the operation it records. Write it AFTER the mutation
 * succeeds so the log reflects what actually happened.
 *
 * Never throwing is NOT the same as never telling anyone (#1049). This used to
 * carry a bare `catch {}`, and the subtle part is that the catch was nearly
 * unreachable: a supabase insert reports a database error by RETURNING `{ error }`,
 * not by raising, and the returned value was discarded. So the failure this guards
 * against (schema drift, an RLS change, a revoked grant) was thrown away without
 * ever reaching the catch, and the privileged-action trail went dark with zero
 * signal anywhere.
 *
 * Both shapes now report. Classified an INCIDENT, not a condition
 * (src/lib/notify/alert-catalog.ts): the row is gone and nothing later restores
 * it, so there is no healthy state to observe and an all-clear would be noise.
 * Same reasoning as a failed booking_events insert.
 */
export async function recordAudit(entry: {
  orgId: string;
  actorId: string;
  action: AuditAction;
  targetId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from("audit_log").insert({
      org_id: entry.orgId,
      actor_id: entry.actorId,
      action: entry.action,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
    });
    // The shape that actually happens: no exception, just an error nobody read.
    if (error) {
      await reportAuditFailure(entry, shortFailureReason(error.message) ?? "no detail");
    }
  } catch (err) {
    // The rarer shape (the client itself blew up: no network, bad config).
    await reportAuditFailure(entry, shortErrorReason(err));
  }
}

/**
 * Log it, then page. Kept separate so both failure shapes report identically.
 *
 * The alert writes to `alert_state` through the same database whose write just
 * failed, so the alert can fail too. That must not turn an audit gap into a
 * failed admin action, and it must not be silent either: its own failure is
 * logged, never swallowed.
 */
async function reportAuditFailure(
  entry: { orgId: string; actorId: string; action: AuditAction; targetId?: string | null },
  reason: string,
): Promise<void> {
  log.error("audit", {
    msg: "audit_log insert failed",
    action: entry.action,
    org_id: entry.orgId,
    actor_id: entry.actorId,
    target_id: entry.targetId ?? null,
    reason,
  });
  // alert-text-ok: `reason` is already shortened to one human line by
  // shortFailureReason / shortErrorReason above; the full text is in the log line.
  await sendThrottledAlert(
    AUDIT_WRITE_FAILED_KEY,
    AUDIT_WRITE_FAILED_COOLDOWN_MS,
    auditWriteFailedAlert(entry.action, reason),
  ).catch((alertErr) => {
    log.error("audit", { msg: "audit-failure alert failed", action: entry.action }, alertErr);
  });
}

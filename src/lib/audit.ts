import { supabaseAdmin } from "@/lib/supabase/admin";

export type AuditAction =
  | "role.set"
  | "agent.hours"
  | "agent.use_default_hours"
  | "agent.bookable"
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
  | "monitor.settings";

/**
 * Appends a privileged action to the audit trail. Best-effort: never throws, so
 * a logging failure can't break the operation it records. Write it AFTER the
 * mutation succeeds so the log reflects what actually happened.
 */
export async function recordAudit(entry: {
  orgId: string;
  actorId: string;
  action: AuditAction;
  targetId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await supabaseAdmin().from("audit_log").insert({
      org_id: entry.orgId,
      actor_id: entry.actorId,
      action: entry.action,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
    });
  } catch {
    // Auditing must not break the underlying operation.
  }
}

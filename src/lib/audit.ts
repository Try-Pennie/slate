import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { shortFailureReason, shortErrorReason } from "@/lib/notify/error-text";
import { auditWriteFailedAlert } from "@/lib/notify/misc-alert-copy";
import { log } from "@/lib/log";

/**
 * Every action the trail can record, as a runtime list so the type is DERIVED from
 * it rather than maintained beside it.
 *
 * A union alone cannot be enumerated at runtime, so the display-label map could only
 * be checked against a second hand-written list, and a new action missing from BOTH
 * was invisible: the label falls back to the raw key and the row renders as
 * "org.business_hours" to whoever reads the trail. Deriving the type from the array
 * lets `scripts/test-audit-display.ts` walk the real vocabulary instead.
 */
export const AUDIT_ACTIONS = [
  "role.set",
  // A staff account created from an email address rather than arriving in the
  // Salesforce agent feed (#160). Distinct from role.set because there was no
  // account before it: the trail's target is null and the address, which is the
  // only thing that identifies the grant until they sign in, is in the details.
  "staff.access_granted",
  "agent.hours",
  "agent.use_default_hours",
  "agent.bookable",
  // #2078: a person deciding NOT to flip somebody the sync was waiting to make
  // bookable. Its own action rather than agent.bookable, because bookable did not
  // move; the details carry the pending stamp before and after.
  "agent.pending_flip_cleared",
  "agent.deactivate",
  "agent.reactivate",
  "agent.attributes",
  "agent.manager",
  "agent.ooo_calendar",
  "ooo.submit",
  "ooo.approve",
  "ooo.reject",
  "ooo.cancel",
  "ooo.modify",
  "ooo.retry",
  "impersonate.start",
  "impersonate.stop",
  "impersonate.ended",
  // Routing (#1932). Editing where leads get SENT is the most consequential
  // privileged action on the admin surface and it was the one action absent from
  // the trail. The membership replace matters most: it is the change with no
  // other trace anywhere.
  "bucket.created",
  "bucket.updated",
  // #1950: an event type sets how long every call in it runs, how far apart the
  // offered times sit and how much notice a lead needs, so creating one changes
  // what every bucket pointed at it offers.
  "event_type.created",
  // The gap kept between two calls on one advisor caps how many calls an hour
  // each advisor can take, so changing it moves capacity across every bucket.
  "event_type.gap",
  // #3003: the notice decides how soon a lead can book, so shortening or
  // lengthening it changes what every bucket offers in the next hours.
  "event_type.notice",
  // #1951: an admin making the server POST at an address they typed. The trail
  // is where a privileged outbound fetch belongs, and it is the only record of
  // one, since a test send deliberately writes no webhook_deliveries row.
  "webhook.test_sent",
  "monitor.settings",
  // #2739: declaring the ramp over changes which floors the low volume alarm
  // judges against, weeks later and with nobody watching, so the trail records the
  // date before and after.
  "monitor.volume_ramp_end",
  // #2875: retiring cal.com stops every cal.com lane and every write to or from
  // cal.com, so the trail records the value before and after.
  "monitor.calcom_retired",
  "reason.options",
  "booking.settings",
  // When Pennie is open (#1297). Distinct from booking.settings because it changes
  // what every lead can book, not how the booker is configured.
  "org.business_hours",
  "org.business_hours_exception",
  "org.business_hours_exception_removed",
  // The warehouse half of a data-subject erasure (#1128). Its Supabase half is
  // audited by the erase_booking_pii function itself, as `pii.erasure`.
  "pii.warehouse_purge",
  // #2090: the Regal call ignore list SUPPRESSES an alert about a named person, so
  // adding or removing somebody is a permission exercised, and the trail is where
  // "who decided this person's calls are not reported, and why" is answered.
  "regal.ignore_added",
  "regal.ignore_removed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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
  /** Null for an action taken by an operator process rather than a signed-in user
   *  (the column is nullable, and erase_booking_pii already writes null). */
  actorId: string | null;
  action: AuditAction;
  /**
   * The USER this action was about, or null when it was about no one.
   *
   * `audit_log.target_id` has a foreign key to `users(id)`, and the admin trail
   * renders it as a person's name, so nothing else may go here. Passing another
   * entity's id (an ooo_requests row, #1220) is rejected by the database and the
   * action goes unrecorded. Put that id in `details` instead.
   */
  targetUserId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from("audit_log").insert({
      org_id: entry.orgId,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      target_id: entry.targetUserId ?? null,
      details: entry.details ?? {},
    });
    // The shape that actually happens: no exception, just an error nobody read.
    if (error) {
      await reportAuditFailure(entry, shortFailureReason(error.message) ?? "no detail", error);
    }
  } catch (err) {
    // The rarer shape (the client itself blew up: no network, bad config).
    await reportAuditFailure(entry, shortErrorReason(err));
  }
}

/** A returned Postgres error, as PostgREST shapes it. */
interface PgError {
  code?: string;
  message?: string;
  details?: string;
}

/**
 * The constraint that rejected the row, when the database rejected it (#1223).
 *
 * Classified on the SQLSTATE, not on the message text: `23503` IS foreign key
 * violation, so the branch cannot drift with Postgres wording (L35). The
 * constraint NAME is then read out of the message, which is the only place it
 * appears, and a null return simply means the alert falls back to the short
 * reason rather than claiming a constraint that may not exist.
 *
 * Measured against the real database (2026-08-03): a rejection answers
 *   code 23503
 *   message  insert or update on table "audit_log" violates foreign key constraint "audit_log_target_id_fkey"
 *   details  Key (target_id)=(...) is not present in table "users".
 */
export function rejectingConstraint(error: unknown): string | null {
  const e = error as PgError | null;
  if (!e || e.code !== "23503") return null;
  return /constraint "([^"]+)"/.exec(e.message ?? "")?.[1] ?? null;
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
  entry: {
    orgId: string;
    actorId: string | null;
    action: AuditAction;
    targetUserId?: string | null;
  },
  reason: string,
  dbError?: unknown,
): Promise<void> {
  const pg = (dbError ?? null) as PgError | null;
  const constraint = rejectingConstraint(dbError);
  log.error("audit", {
    msg: "audit_log insert failed",
    action: entry.action,
    org_id: entry.orgId,
    actor_id: entry.actorId,
    target_id: entry.targetUserId ?? null,
    reason,
    // The alert tells the reader the rejected values are HERE, so they have to be.
    // `details` is where Postgres puts the offending key ("Key (target_id)=(...)
    // is not present in table \"users\""), which is the fact that identifies the
    // bad caller (#1223).
    code: pg?.code ?? null,
    constraint,
    detail: pg?.details ?? null,
  });
  // alert-text-ok: `reason` is already shortened to one human line by
  // shortFailureReason / shortErrorReason above; the full text is in the log line.
  await sendThrottledAlert(
    AUDIT_WRITE_FAILED_KEY,
    AUDIT_WRITE_FAILED_COOLDOWN_MS,
    auditWriteFailedAlert(entry.action, reason, constraint),
  ).catch((alertErr) => {
    log.error("audit", { msg: "audit-failure alert failed", action: entry.action }, alertErr);
  });
}

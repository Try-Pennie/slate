/**
 * How one audit_log row reads in the admin trail: its action as a phrase, who
 * took it, and a one line detail.
 *
 * Pure and separate from the page so it can be tested directly
 * (scripts/test-audit-display.ts). Two things it has to get right, both learned
 * from #1220:
 *
 *  - Every action Slate writes needs a label. The table used to fall back to the
 *    raw key, so a manager's approval read as "ooo.approve".
 *  - A row REBUILT from ooo_requests after the fact must say so. 269 of them were
 *    backfilled once the foreign key bug was found, and an audit row that quietly
 *    claims to have been written at the time is worse than an admitted gap.
 */

export interface AuditDisplayRow {
  action: string;
  actor_id: string | null;
  details: Record<string, unknown>;
}

const ACTION_LABEL: Record<string, string> = {
  "role.set": "changed role",
  "staff.access_granted": "gave a staff member access",
  "agent.hours": "set hours",
  "agent.use_default_hours": "applied default hours",
  "agent.bookable": "set bookable",
  "agent.attributes": "set attributes",
  "agent.deactivate": "deactivated agent",
  "agent.reactivate": "reactivated agent",
  "agent.manager": "set manager",
  "agent.ooo_calendar": "set time off calendar",
  "ooo.submit": "requested time off",
  "ooo.approve": "approved time off",
  "ooo.reject": "declined time off",
  "ooo.cancel": "cancelled time off",
  "ooo.modify": "changed a time off request",
  "ooo.retry": "retried time off updates",
  "impersonate.start": "started viewing as another user",
  "impersonate.stop": "stopped viewing as another user",
  "impersonate.ended": "view as another user expired",
  // #1932: routing. Worded as what a reader of the trail needs to know happened,
  // since "where leads get sent" is the consequence.
  "bucket.created": "created a routing bucket",
  "bucket.updated": "changed a routing bucket",
  "monitor.settings": "changed alert settings",
  "reason.options": "changed reason options",
  "booking.settings": "changed booking settings",
  "pii.erasure": "erased contact data",
  "org.business_hours": "changed when Pennie is open",
  "org.business_hours_exception": "set a specific date Pennie is open or closed",
  "org.business_hours_exception_removed": "removed a specific open or closed date",
  "pii.warehouse_purge": "purged contact data from the warehouse",
};

/** The action as a readable phrase, falling back to the raw key so an
 *  unlabelled action still renders as something rather than blank. */
export function auditActionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/**
 * True when this row was rebuilt from another table rather than written at the
 * time. The flag comes back from jsonb, so a string "true" counts.
 */
export function isReconstructed(row: AuditDisplayRow): boolean {
  const flag = row.details?.reconstructed;
  return flag === true || flag === "true";
}

/**
 * Who took the action. A reconstructed row can carry a null actor because the
 * original action never stored one (cancelOoo never recorded a canceller), which
 * is different from "unassigned": say it was not recorded instead of implying
 * nobody was responsible.
 */
export function auditActorText(
  row: AuditDisplayRow,
  nameOf: (id: string | null) => string,
): string {
  const unrecorded = row.details?.actor_not_recorded;
  if (row.actor_id === null && (unrecorded === true || unrecorded === "true")) {
    return "not recorded";
  }
  return nameOf(row.actor_id);
}

/** The one line detail column: what changed, plus a rebuilt note when the row
 *  was reconstructed after the fact. */
export function auditDetailText(row: AuditDisplayRow): string {
  const parts: string[] = [];
  if (row.action === "role.set" && row.details?.from && row.details?.to) {
    parts.push(`${String(row.details.from)} to ${String(row.details.to)}`);
  }
  if (isReconstructed(row)) {
    parts.push("rebuilt from the request record");
  }
  return parts.join(", ");
}

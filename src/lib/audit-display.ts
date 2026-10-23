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

import { describeDemotionChange } from "@/lib/booking/demotion-copy";
import { readDemotionChange } from "@/lib/booking/demotion-plan";
import { isAuditChannel, type AuditChannel } from "@/lib/audit-channel";

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
  "agent.pending_flip_cleared": "stopped Slate waiting to make an agent bookable",
  "agent.attributes": "set attributes",
  "agent.deactivate": "deactivated agent",
  "agent.reactivate": "reactivated agent",
  "agent.manager": "set manager",
  "agent.ooo_calendar": "set time off calendar",
  "agent.google_relinked": "unlinked an agent's Google account so a new one can sign in",
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
  "event_type.created": "added an event type",
  "event_type.gap": "changed the gap between calls",
  "event_type.notice": "changed how much notice a lead needs to book",
  "webhook.test_sent": "sent a test webhook to a URL they entered",
  "webhook.endpoint_set": "changed where booking events are sent",
  "webhook.resent": "resent a webhook delivery",
  "webhook.replayed": "replayed failed webhook deliveries",
  "monitor.settings": "changed alert settings",
  "monitor.volume_ramp_end": "changed when the booking ramp ended",
  "monitor.calcom_retired": "changed whether cal.com is retired",
  "reason.options": "changed reason options",
  "booking.settings": "changed booking settings",
  "pii.erasure": "erased contact data",
  "org.business_hours": "changed when Pennie is open",
  "org.business_hours_exception": "set a specific date Pennie is open or closed",
  "org.business_hours_exception_removed": "removed a specific open or closed date",
  "pii.warehouse_purge": "purged contact data from the warehouse",
  "regal.ignore_added": "stopped reporting a person's Regal calls",
  "regal.ignore_removed": "started reporting a person's Regal calls again",
  "booking.demotion_reroute": "moved a booked call after a Twilio demotion",
  "booking.demotion_reroute_reverted": "moved an automatically moved call back",
  // #3542: written by a machine channel (Marcia), whose actor text says who.
  "booking.created": "booked a call",
  "booking.rescheduled": "moved a call",
  "booking.cancelled": "cancelled a call",
};

/**
 * Actions Slate takes ON ITS OWN, with no person in the request (#3615). Their null actor is the
 * automation, so it reads as "Slate" rather than "unassigned", which would say nobody was
 * responsible.
 */
const AUTOMATED_ACTIONS = new Set(["booking.demotion_reroute"]);

/**
 * Who a machine channel's null actor is (#3542). A `Record` over the whole channel
 * vocabulary, so a channel declared in `audit-channel.ts` without wording here fails
 * `tsc` rather than rendering its rows as "unassigned".
 */
const CHANNEL_ACTOR: Record<AuditChannel, string> = {
  marcia: "Marcia",
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
  if (row.actor_id === null && AUTOMATED_ACTIONS.has(row.action)) return "Slate";
  // #3542: a machine channel's actor is the bot plus the lead it acted for (plan
  // decision 11). The 00Q id is the only lead identifier the trail may show.
  const channel = row.details?.channel;
  if (row.actor_id === null && isAuditChannel(channel)) {
    const lead = row.details?.salesforce_id;
    const who = CHANNEL_ACTOR[channel];
    return typeof lead === "string" && lead ? `${who}, for lead ${lead}` : `${who}, for an unrecorded lead`;
  }
  return nameOf(row.actor_id);
}

/** The one line detail column: what changed, plus a rebuilt note when the row
 *  was reconstructed after the fact. */
export function auditDetailText(row: AuditDisplayRow, nameOf?: (id: string | null) => string): string {
  const parts: string[] = [];
  if (row.action === "booking.demotion_reroute_reverted") {
    // #3615: who got the call back, and from whom.
    const idOf = (v: unknown) => (typeof v === "string" ? v : null);
    const name = (id: string | null, fallback: string) => (id === null ? fallback : nameOf ? nameOf(id) : id);
    return `Moved back to ${name(idOf(row.details?.to_user_id), "the original advisor")} from ${name(idOf(row.details?.from_user_id), "another advisor")}.`;
  }
  if (row.action === "booking.demotion_reroute") {
    // Who took the call, and what changed in Twilio, in the sentence the Slack line and the undo
    // panel use too. The demoted advisor is already the row's target.
    const to = typeof row.details?.to_user_id === "string" ? row.details.to_user_id : null;
    const change = describeDemotionChange(readDemotionChange(row.details?.change));
    parts.push(`Moved to ${to === null ? "another advisor" : nameOf ? nameOf(to) : to}.`);
    parts.push(change ?? "What changed in Twilio was not recorded.");
    return parts.join(" ");
  }
  if (row.action === "role.set" && row.details?.from && row.details?.to) {
    parts.push(`${String(row.details.from)} to ${String(row.details.to)}`);
  }
  if (isReconstructed(row)) {
    parts.push("rebuilt from the request record");
  }
  // #3542: the test mark a machine write carries, from the booking's bucket. Read
  // only on a row a machine channel wrote, the one writer that sets it with that
  // meaning, so another action's own `test` key is never read as a test booking.
  if (isAuditChannel(row.details?.channel) && row.details?.test === true) {
    parts.push("test booking");
  }
  return parts.join(", ");
}

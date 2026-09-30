import { type ReasonAction, type ReasonOption } from "./core.ts";
import type { BookingEvent, BookingEventAction } from "../db/types.ts";
import { parseStampMs } from "../date/stamp.ts";

/** Resolves a user id to a display name (roster lookup on the server, #561). */
export type NameResolver = (id: string | null) => string;

/** The BookingEventAction -> the ReasonAction whose option list labels it. */
const REASON_ACTION: Record<BookingEventAction, ReasonAction> = {
  rescheduled: "reschedule",
  cancelled: "cancel",
  reassigned: "reassign",
};

const ACTION_LABEL: Record<BookingEventAction, string> = {
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  reassigned: "Reassigned",
};

/** The resolved reason options per action (incl. retired) the history views need
 *  to label a code (#346): passed in so a renamed/custom code shows its exact
 *  current stored label, not a stale coded default or a humanized guess. */
export type ReasonOptionsByAction = Record<ReasonAction, ReasonOption[]>;

/** "api_cancellation" -> "Api cancellation" (fallback for system/historical codes). */
function humanizeCode(code: string): string {
  const spaced = code.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : code;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Signed lead-time minutes -> a human phrase relative to the appointment.
 * Positive = the action happened before the appointment; negative = after it
 * (see BookingEvent.lead_time_minutes). Null in -> null out.
 *
 * `timeMoved` says whether THIS entry moved the call. Required, so every caller
 * has to decide it rather than inherit one wording by default.
 */
export function formatLeadTime(minutes: number | null, timeMoved: boolean): string | null {
  if (minutes == null) return null;
  if (minutes === 0) return timeMoved ? "at the time it was booked for" : "at the time of the call";
  const before = minutes > 0;
  const abs = Math.abs(minutes);
  let magnitude: string;
  if (abs >= 1440) magnitude = plural(Math.round(abs / 1440), "day");
  else if (abs >= 60) magnitude = plural(Math.round(abs / 60), "hour");
  else magnitude = plural(abs, "minute");
  // #1943: IT NAMES WHAT IT IS RELATIVE TO, and which one.
  //
  // It read "4 hours before", a dangling comparative with nothing on screen
  // saying before what, and the reader's only available guess (before the
  // previous entry) is wrong. Worse, three reschedules in a row showed 2, 3 then
  // 4 hours down the page against one unchanging clock time, which reads as a
  // data fault and is not: each one MOVED the appointment later, so the notice
  // period grew while the wall clock did not.
  //
  // `bookingEventFrom` measures this against the PRE ACTION appointment time, so
  // on an entry that moved the call the anchor is not the time now on screen,
  // and it has to be named or the numbers cannot be reconciled (L589). "then" is
  // what carries that. An entry that did NOT move the call (a reassign, a
  // cancel) is measured against the call itself, and "then" there only made the
  // line harder to read (Dan, 2026-09-30).
  if (timeMoved) return `${magnitude} ${before ? "before" : "after"} the time it was booked for then`;
  return before ? `${magnitude} before the call` : `${magnitude} after the call was due`;
}

/** Whether an entry moved the call: both ends recorded and at different instants.
 *  An unreadable bound counts as moved, which keeps the fuller wording. */
function movedTheCall(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const f = parseStampMs(from);
  const t = parseStampMs(to);
  return f == null || t == null || f !== t;
}

/**
 * Human label for a reason code, resolved against the live option set (#346).
 * "other" shows the free-text detail (or "Other" if blank); a code present in
 * `reasonOptions[action]` (active OR retired) resolves to its exact current label;
 * a code with no matching row (a legacy/system code like api_cancellation, or a
 * store the loader couldn't read) falls back to a humanized form of the code.
 */
export function reasonLabel(
  action: ReasonAction,
  code: string,
  detail: string | null,
  reasonOptions: ReasonOptionsByAction,
): string {
  if (code === "other") {
    const d = (detail ?? "").trim();
    return d || "Other";
  }
  const match = reasonOptions[action].find((o) => o.code === code);
  return match ? match.label : humanizeCode(code);
}

/**
 * Who drove the event, with #549 accountability surfaced: an impersonated admin
 * action reads "X, acting as Y"; a direct staff action reads "Name (role)";
 * customer/system events read plainly; a staff event with no recorded actor
 * (historical rows) falls back to the capitalized initiator.
 */
export function attributionLine(e: BookingEvent, nameOf: NameResolver): string {
  if (e.initiator === "customer") return "Customer";
  if (e.initiator === "system") return "System (automated)";
  if (!e.actor_user_id) {
    return e.initiator.charAt(0).toUpperCase() + e.initiator.slice(1);
  }
  if (e.acting_as_user_id) {
    return `${nameOf(e.actor_user_id)}, acting as ${nameOf(e.acting_as_user_id)}`;
  }
  return `${nameOf(e.actor_user_id)} (${e.initiator})`;
}

/** A fully-resolved event ready for the history panel to render (#561). */
export interface BookingEventView {
  id: string;
  /** ISO timestamp the event was recorded. */
  at: string;
  action: BookingEventAction;
  actionLabel: string;
  who: string;
  reason: string;
  /**
   * The start instants either side of a time move; null otherwise.
   *
   * Instants, not a formatted string (#1916): this is built on the server, which
   * cannot know the viewer's zone, so the panel renders each one in the reader's
   * zone, labelled, through `ViewerTime`.
   */
  timeChange: { from: string; to: string } | null;
  /** "Jo Lee → Dan Wright" for an agent change; null otherwise. */
  agentChange: string | null;
  /** "2 days before" / "4 hours after"; null when no lead time recorded. */
  lead: string | null;
}

/** Minimal roster row for resolving a user id to a display name. */
export interface HistoryRosterUser {
  id: string;
  name: string | null;
  email: string;
}

/**
 * A name resolver over a roster: id -> name (else email), "Unknown user" for an
 * id absent from the roster or a null id. Shared by the history and booking
 * search views so both label users identically.
 */
export function rosterNameResolver(roster: HistoryRosterUser[]): NameResolver {
  const byId = new Map(roster.map((u) => [u.id, u.name ?? u.email]));
  return (id) => (id ? byId.get(id) ?? "Unknown user" : "Unknown user");
}

/**
 * Map a booking's append-only events into newest-first view models, resolving
 * user ids to names from the given roster (name, else email, else "Unknown
 * user" for an id not on the roster). Pure: the server pairs it with the
 * fetched events + roster.
 */
export function buildHistoryViews(
  events: BookingEvent[],
  roster: HistoryRosterUser[],
  reasonOptions: ReasonOptionsByAction,
): BookingEventView[] {
  const nameOf = rosterNameResolver(roster);
  return [...events]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((e) => toBookingEventView(e, nameOf, reasonOptions));
}

/**
 * Map one append-only booking_events row into the panel's view model, resolving
 * user ids to names. Times stay instants for the client to render. Pure.
 */
export function toBookingEventView(
  e: BookingEvent,
  nameOf: NameResolver,
  reasonOptions: ReasonOptionsByAction,
): BookingEventView {
  // One judge for "did this entry move the call" feeds both the time line and the
  // lead wording, so an unchanged time neither draws "8:00am -> 8:00am" nor says
  // "then" (Dan, 2026-09-30), and the two can never disagree about one entry.
  const moved = movedTheCall(e.from_starts_at, e.to_starts_at);
  const timeChange =
    moved && e.from_starts_at && e.to_starts_at
      ? { from: e.from_starts_at, to: e.to_starts_at }
      : null;
  const agentChange =
    e.from_agent_user_id &&
    e.to_agent_user_id &&
    e.from_agent_user_id !== e.to_agent_user_id
      ? `${nameOf(e.from_agent_user_id)} → ${nameOf(e.to_agent_user_id)}`
      : null;
  return {
    id: e.id,
    at: e.created_at,
    action: e.action,
    actionLabel: ACTION_LABEL[e.action],
    who: attributionLine(e, nameOf),
    reason: reasonLabel(REASON_ACTION[e.action], e.reason_code, e.reason_detail, reasonOptions),
    timeChange,
    agentChange,
    lead: formatLeadTime(e.lead_time_minutes, moved),
  };
}

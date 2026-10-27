/**
 * Every sentence the coordinator booking page shows (#4205), in one pure module beside
 * the rules that produce them, the way the staff access panel keeps its own
 * (`staff-access.ts`): every outcome and refusal gets its own sentence, because two
 * refusals that read the same are one refusal in practice (L11).
 *
 * Staff facing, read by a scheduling coordinator with the customer on the phone, so each
 * one says what happened and, when something can be done, what to do next. Warm and
 * plain, no dashes, never a raw error. Times are written in the CUSTOMER's zone, which is
 * the clock the coordinator reads them out in. Pure: it takes every value it prints and
 * reads no clock. `scripts/test-coordinator-copy.ts` reads every sentence.
 */
import { DateTime } from "luxon";
import { zoneLabel } from "../booking/timezones.ts";
import { callingWindowLabel } from "../booking/lead-calling-window.ts";
import { formatClockTime, formatLongDate } from "../date/parse.ts";
import type { CustomerRefusal, ExistingCallView } from "./customer.ts";
import type { BookableHours } from "./bookable-hours.ts";
import type { PlacedBookingRefusal, PlacedCallSummary, PlacedOn } from "../booking/placed-booking.ts";

/** Why placing a call was refused, beyond the lookup's and the booking's own refusals. */
export const PLACE_CALL_REFUSALS = [
  "not-authorized",
  "rate-limited",
  "reason-invalid",
  "outside-calling-window",
  "existing-call-unreadable",
  "move-conflict",
  "calendar-unavailable",
  "attendee-email-refused",
  "no-advisor",
  "internal",
] as const;
export type PlaceCallOnlyRefusal = (typeof PLACE_CALL_REFUSALS)[number];
export type CoordinatorRefusal = CustomerRefusal | PlacedBookingRefusal | PlaceCallOnlyRefusal;

/** "Tuesday, June 9 at 10:30am Arizona (Phoenix)": a time as the coordinator reads it out, in Slate's one spelling. */
export function callTimeText(iso: string, zone: string): string {
  const t = DateTime.fromISO(iso, { zone });
  const day = formatLongDate(t);
  const clock = formatClockTime(t);
  if (day === null || clock === null) return "the time asked for";
  return `${day} at ${clock} ${zoneLabel(zone)}`;
}

const who = (on: PlacedOn, advisorName: string | null) =>
  on === "placeholder" ? "the placeholder advisor, Marcia, and goes to the next free advisor when it is due" : advisorName ?? "an advisor";

export function bookedSentence(o: { on: PlacedOn; advisorName: string | null; startsAt: string; zone: string; replayed: boolean }): string {
  const when = callTimeText(o.startsAt, o.zone);
  if (o.replayed) return `This call was already booked, so nothing new was made. It is on ${when}, with ${who(o.on, o.advisorName)}.`;
  return o.on === "placeholder"
    ? `Booked for ${when}. Nobody was free then, so the call is with ${who(o.on, o.advisorName)}.`
    : `Booked. The call is with ${who(o.on, o.advisorName)} on ${when}.`;
}

export function movedSentence(o: { on: PlacedOn; advisorName: string | null; startsAt: string; zone: string }): string {
  return `Moved to ${callTimeText(o.startsAt, o.zone)}. The call is with ${who(o.on, o.advisorName)}, and the customer's booking link still works.`;
}

export function needsConfirmSentence(call: PlacedCallSummary, zone: string): string {
  return `This customer already has a call on ${callTimeText(call.startsAt, zone)}. Confirm and we will move that call to the new time, rather than booking a second one.`;
}

export function possibleMatchSentence(call: PlacedCallSummary, zone: string, matchedOn: "email-and-phone" | "email-or-phone"): string {
  const on = matchedOn === "email-and-phone" ? "the same email and phone" : "the same email or phone";
  return `A call on ${callTimeText(call.startsAt, zone)} has ${on} but a different Salesforce record, so nothing was booked. Check with the customer which record is theirs before booking.`;
}

const REFUSAL_TEXT: Record<Exclude<CoordinatorRefusal, "outside-calling-window">, string> = {
  // The lookup.
  "not-a-lead-id": "That is not a Salesforce Lead link or ID. Paste the link to the customer's Lead, or the ID starting 00Q at the end of it.",
  "no-such-lead": "Salesforce has no Lead with that ID. Check it was copied in full.",
  "salesforce-unreadable": "We could not reach Salesforce just now, so nothing was looked up or booked. Try again in a moment.",
  "no-bucket": "We could not tell which team this customer belongs to, so nothing was booked. Let a Slate admin know.",
  "bucket-unreadable": "We could not look up this customer's team just now, so nothing was booked. Try again in a moment.",
  "zone-unknown": "We could not tell this customer's time zone from their Lead, so nothing was booked. Ask for their zip code and have it added to their Lead, then try again.",
  // The booking's own (`placed-booking.ts`), said for the coordinator.
  "lead-id-missing": "That is not a Salesforce Lead link or ID, so nothing was booked.",
  "submission-id-invalid": "We could not tell this booking apart from another, so nothing was booked. Reload the page and try again.",
  "zone-missing": "We could not tell this customer's time zone from their Lead, so nothing was booked.",
  "start-unreadable": "We could not read that time, so nothing was booked. Pick the time again.",
  "start-in-past": "That time has already passed. Pick a later one.",
  "switch-unreadable": "No advisor is free then, and we could not check whether calls may go to the placeholder advisor, so nothing was booked. Try again in a moment.",
  "switch-off": "No advisor is free then, and calls cannot go to the placeholder advisor yet, so nothing was booked. Offer the customer another time.",
  "horizon-unreadable": "We could not check how far ahead calls can be booked, so nothing was booked. Try again in a moment.",
  "beyond-horizon": "That day is further ahead than calls can be booked. Offer a sooner day.",
  "outside-business-hours": "Pennie is closed at that time. Offer one of the hours shown for that day.",
  "no-placeholder": "No advisor is free then, and there is no placeholder advisor to hold the call, so nothing was booked. Let a Slate admin know.",
  "confirmed-call-changed": "The call you confirmed moving has changed since you looked, so nothing was moved. Look the customer up again.",
  "customer-busy": "Someone else is booking a call for this customer right now, so nothing was booked. Wait a moment, then look the customer up again.",
  "customer-lock-unavailable": "We could not check whether someone else is booking this customer right now, so nothing was booked. Try again in a moment.",
  // The page's own.
  "not-authorized": "Your account cannot book calls here. Sign in with your coordinator account.",
  "rate-limited": "That is a lot of requests in a short time. Wait a minute and try again.",
  "reason-invalid": "Choose why the call is moving before confirming.",
  "existing-call-unreadable": "We could not check whether this customer already has a call, so nothing was booked. Try again in a moment.",
  "move-conflict": "This call is being changed somewhere else right now, so nothing was moved. Look the customer up again.",
  "calendar-unavailable": "We could not confirm the advisor's calendar just now, so nothing was booked. Try again in a moment.",
  "attendee-email-refused": "The calendar would not accept the customer's email address, so nothing was booked. Check the email on their Lead.",
  "no-advisor": "No advisor can take that time, so nothing was booked. Offer the customer another time.",
  "internal": "Something went wrong and nothing was booked. Try again, and let a Slate admin know if it keeps happening.",
};

/** The sentence for a refusal; the calling window one names the customer's zone. */
export function refusalSentence(reason: CoordinatorRefusal, zone?: string): string {
  if (reason === "outside-calling-window") {
    const { from, to } = callingWindowLabel();
    const where = zone ? `, ${zoneLabel(zone)}` : "";
    return `Calls can only start between ${from} and ${to} in the customer's own time${where}. Offer a time inside that.`;
  }
  return REFUSAL_TEXT[reason];
}

/** Refusals worth trying again unchanged: an outage, not a fact about the request. */
export const RETRYABLE_REFUSALS: ReadonlySet<CoordinatorRefusal> = new Set<CoordinatorRefusal>([
  "salesforce-unreadable",
  "bucket-unreadable",
  "switch-unreadable",
  "horizon-unreadable",
  "customer-busy",
  "customer-lock-unavailable",
  "rate-limited",
  "existing-call-unreadable",
  "calendar-unavailable",
  "internal",
]);

/**
 * The hours a call may start that day, as the coordinator reads them out (Sam's
 * playbook, 2026-10-23: when a customer asks for a time outside them).
 */
export function bookableHoursSentence(hours: BookableHours, zone: string): string {
  if (!hours.ok) {
    return hours.reason === "date-unreadable"
      ? "We could not read that day. Pick it again."
      : "We could not load the hours calls can be booked just now. Try again in a moment.";
  }
  const dayText = formatLongDate(DateTime.fromISO(hours.date, { zone })) ?? "that day";
  if (hours.windows.length === 0) return `No calls can be booked on ${dayText}. Offer the customer another day.`;
  const clock = (iso: string) => formatClockTime(DateTime.fromISO(iso, { zone })) ?? "a time we could not read";
  const spans = hours.windows.map((w) => (w.firstStart === w.lastStart ? `at ${clock(w.firstStart)}` : `from ${clock(w.firstStart)} to ${clock(w.lastStart)}`));
  return `On ${dayText}, calls can start ${spans.join(", or ")} ${zoneLabel(zone)}.`;
}

/** What the page says about the customer's existing call, before anything is placed. */
export function existingCallSentence(view: ExistingCallView, zone: string): string {
  switch (view.kind) {
    case "none":
      return "This customer has no call booked.";
    case "unreadable":
      return "We could not check whether this customer already has a call. Booking will check again before it books.";
    case "found":
      return view.happens === "moves-when-confirmed"
        ? `This customer has a call on ${callTimeText(view.call.startsAt, zone)}. Booking a new time moves that call once you confirm.`
        : possibleMatchSentence(view.call, zone, view.matchedOn);
  }
}

import { DateTime } from "luxon";
import { formatClockTime } from "@/lib/date/parse";
import { callComesFrom, placeholderReplyLine } from "./manage-copy.ts";
import { realAdvisorName } from "./advisor-contact-card.ts";

/**
 * The 24 hour reminder email (#2359): the decision and the copy, kept pure so both
 * are driven offline by `scripts/test-booking-reminder.ts` with no database, no
 * Gmail and no real clock.
 *
 * ## Why it exists
 *
 * A lead booked through cal.com gets four messages before their call today, and all
 * four are cal.com features that stop at cutover (measured 2026-09-15, #2311). Three
 * are covered: the confirmation by Google's native invite (#64), and the 1 hour and
 * 15 minute reminders by Regal's SMS journeys once #2308 and #2309 repoint them. The
 * 24 hour reminder is covered by nothing.
 *
 * ## Why not the Google event's own reminders
 *
 * The obvious cheap answer does not work. The Calendar API documents `reminders` as
 * "information about the event's reminders for the AUTHENTICATED user", and Slate
 * writes the event with the advisor's delegated credentials, so an override there
 * reminds the advisor. An attendee's reminders come from their own calendar's
 * defaults, and only if they use a calendar client and accepted the invite; a lead on
 * a provider that makes no reminder from an invitation gets nothing at all.
 *
 * ## Two rules Dan settled, both deliberately uniform
 *
 * A booking made LESS than 24 hours ahead is reminded at once (2026-09-16), so there
 * is no "unless" to explain and no second schedule to maintain. It arrives alongside
 * the Google invite for a same day booking, which is the accepted cost of one rule.
 * "At once" means once the hand-back hold has passed (#2633, `REMINDER_HOLD_MS`), so
 * the reminder comes from the advisor who will actually call.
 *
 * A booking that MOVES earns a fresh reminder for its new time, because the reminder
 * is a property of the appointment rather than of the lead: a call a fortnight out
 * with no reminder, because one went to the time it used to hold, is the failure
 * worth avoiding. That is why the stored record is the START it was sent about rather
 * than a flag, so a move invalidates it by construction (L60).
 */

/** How far ahead of the call the reminder goes out. */
export const REMINDER_LEAD_MS = 24 * 60 * 60_000;

/** The booking statuses a reminder can belong to. A lead with no live call gets none. */
const LIVE_STATUSES = new Set(["confirmed", "rescheduled"]);

export interface ReminderSubject {
  startsAtMs: number;
  /** The start a reminder has already gone out about, or null for none. */
  reminderSentForMs: number | null;
  status: string;
}

/**
 * Whether this booking is due its reminder right now.
 *
 * Every comparison is written so an unreadable number lands on the SILENT side. A
 * NaN start compares false against both bounds, and the checks are phrased as "is it
 * inside the window" rather than "is it outside", so an unreadable value fails toward
 * sending nothing rather than mailing a real person about a time nobody can read
 * (L50, L706). The clock is checked too, because a caller that could not read its own
 * `now` would otherwise make every booking due.
 */
export function reminderDue(b: ReminderSubject, nowMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(b.startsAtMs)) return false;
  if (!LIVE_STATUSES.has(b.status)) return false;
  // Strictly future: a lead told to expect a call they have already had, or missed,
  // is worse than silence.
  if (b.startsAtMs <= nowMs) return false;
  if (b.startsAtMs - nowMs > REMINDER_LEAD_MS) return false;
  // The record is the START it was sent about, so a booking that moved no longer
  // matches and earns its own reminder with nobody clearing anything.
  return b.reminderSentForMs !== b.startsAtMs;
}

/**
 * How long a NEW booking waits before its reminder may go out (#2633), so the owner
 * hand-back lands first and the single reminder comes from the advisor who will call.
 *
 * Why a hold at all: the upstream automation that owns contact stickiness hands a
 * booking to the lead's owner through `POST /api/bookings/reassign` seconds after it
 * is made, and since #2630 a reassign never sends a second reminder. A call booked
 * inside the 24 hour window used to be reminded on the very next tick, so the one
 * reminder the lead kept named the first advisor and its "just reply to this email"
 * sent replies to the wrong mailbox.
 *
 * Why ten minutes, MEASURED on production 2026-09-28 rather than guessed: the time
 * from `bookings.created_at` to the first `booking_events` row with action
 * `reassigned` and initiator `system` (the owner hand-back), per booking.
 *
 *   real buckets:  n = 5,   p50 26s, max 101s (22.6s, 23.8s, 26.0s, 35.4s, 101.4s)
 *   test buckets:  n = 344, p50 4s, p95 8s, max 49s (the canary calling the route
 *                  directly, so it measures Slate's own swap, not the upstream flow)
 *
 * Five real hand-backs is too few to read a p95 from, so this was the issue's ten
 * minutes CHECKED against the data rather than derived from a tail.
 *
 * Re-measured on production 2026-10-18 (#2839), same query, first hand-back per
 * booking, test buckets excluded:
 *
 *   real buckets:  n = 56, p50 13.5s, p90 20.8s, p95 28.4s, p99 122.6s, max 148.5s
 *                  (none negative, none over 300s)
 *
 * Ten minutes stays. It is the p95 with about twenty times headroom and four times
 * the slowest real hand-back, so a slower run or a retry of the upstream automation
 * still lands first. Shortening it toward the p95 buys a lead nothing: the lane's
 * five minute cadence means the reminder lands 10 to 15 minutes after booking, well
 * inside the 120 minute minimum notice every event type carries today, while a hold
 * under the tail sends the slowest few their one reminder from the wrong advisor.
 */
export const REMINDER_HOLD_MS = 10 * 60_000;

/**
 * The hold never runs past this long before the call (#2633).
 *
 * The next message the lead hears is Regal's one hour SMS, and this email is the one
 * that carries the link to move or cancel, so it must land before that hour starts
 * rather than inside it. A reminder from the first advisor is a smaller harm than a
 * reminder that arrives with no time left to act on it. The lane runs every five
 * minutes, so a release at the hour mark reaches the lead at worst 55 minutes out.
 * With today's 120 minute minimum notice the floor only binds for a booking an admin
 * moves close in; it exists because that notice is a setting, not a law.
 */
export const REMINDER_HOLD_FLOOR_MS = 60 * 60_000;

export interface ReminderHoldSubject {
  createdAtMs: number;
  startsAtMs: number;
}

/**
 * Whether a booking that is otherwise due is HELD this tick, waiting for the owner
 * hand-back. Judged separately from `reminderDue` so the lane can count a held
 * booking as its own outcome: it is neither sent nor failed, and it is owed a
 * reminder on a later tick.
 *
 * It releases at the EARLIER of the hold ending and the floor before the call. Every
 * unreadable value releases rather than holds, the opposite direction to
 * `reminderDue`, because the hold is a courtesy about who signs the email while the
 * reminder itself is the promise: a NaN that held would silently cost the lead it.
 * The floor makes that bounded either way, but the courtesy must not be the thing
 * that decides.
 */
export function reminderHeld(b: ReminderHoldSubject, nowMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(b.createdAtMs) || !Number.isFinite(b.startsAtMs)) {
    return false;
  }
  const releaseAtMs = Math.min(b.createdAtMs + REMINDER_HOLD_MS, b.startsAtMs - REMINDER_HOLD_FLOOR_MS);
  return nowMs < releaseAtMs;
}

export interface ReminderCopyInput {
  /**
   * The advisor the lead will speak to, and whose mailbox this is sent from. Null
   * (or blank, or an address) when the booking holds no real name: the copy then
   * speaks for Pennie rather than showing an address as a name.
   */
  agentName: string | null;
  startsAtIso: string;
  /** The LEAD's timezone, which is the only one they can act on. */
  timezone: string;
  /** Where they can move or cancel. */
  manageUrl: string;
  /**
   * The instant this copy is being written AT, which the caller passes rather than
   * the builder reading (#2497). "tomorrow" is a relationship between two times, so
   * a builder that pins one end and reads the other for itself renders a different
   * sentence every day from the same input: it cannot be tested, it cannot be
   * previewed, and it changes at midnight with nobody touching it. It is REQUIRED,
   * not defaulted, so `tsc` names every construction site rather than one caller
   * silently keeping the old behaviour (L168).
   */
  nowMs: number;
  /**
   * The number the call will come FROM, read from Salesforce (#1334), or null when
   * it is not known. REQUIRED rather than optional, so `tsc` names every caller
   * that has to decide (L168). Null says nothing about a number at all.
   */
  callingNumber: string | null;
  /**
   * A call on the placeholder advisor, Marcia (booking kind `staff_placed`, #4206).
   * Its reminder goes out from the placeholder seat, whose inbox nobody reads, so the
   * copy invites no reply to itself, names no number, and sends the customer back to
   * our texts (Dan, 2026-10-26). REQUIRED, so `tsc` names every caller (L168).
   */
  onPlaceholder: boolean;
}

/**
 * "tomorrow" is a claim about the reader's calendar, not about 24 hours, and a
 * booking made inside the window is reminded at once. For a call two hours away
 * "tomorrow" is simply false, so the day is decided in the lead's own zone.
 *
 * A clock the caller could not read falls to "soon", the same wording an unreadable
 * start falls to: a day nobody worked out must not be asserted to a lead, and
 * "Invalid DateTime" must never reach an inbox.
 */
function dayWord(input: ReminderCopyInput): string {
  const at = DateTime.fromISO(input.startsAtIso, { zone: input.timezone });
  const now = DateTime.fromMillis(input.nowMs, { zone: input.timezone });
  if (!at.isValid || !now.isValid) return "soon";
  const days = at.startOf("day").diff(now.startOf("day"), "days").days;
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return at.toFormat("cccc");
}

function timeLabel(input: ReminderCopyInput): string {
  const at = DateTime.fromISO(input.startsAtIso, { zone: input.timezone });
  // THE one spelling of a clock time (#2221), not a format string of this file's
  // own: a lead reads the same shape here as on the booker and the manage page.
  // The zone is appended because an email is read away from the page that set it,
  // so the reader has nothing else to tell them which clock it is in.
  const clock = formatClockTime(at);
  // A time nobody can read must not become the words "Invalid DateTime" in a
  // customer's inbox, so the copy degrades to the instant it was given.
  return clock ? `${clock} ${at.toFormat("ZZZZ")}` : input.startsAtIso;
}

export function reminderSubject(input: ReminderCopyInput): string {
  return `Your Pennie call ${dayWord(input)} at ${timeLabel(input)}`;
}

/**
 * Plain text, and the ONLY copy of these words. The Gmail path sends it as the
 * text part and derives the html part from it (`plainTextToHtml` in
 * `src/lib/notify/email-mime.ts`, #2895): a blank line here is a paragraph there,
 * and the manage URL becomes a link. So keep paragraphs separated by one blank
 * line and write no markup; anything written here is escaped, never rendered.
 *
 * It is sent from the ADVISOR's own mailbox (Dan, 2026-09-15, over a shared or
 * noreply address), so a lead who replies "can we move this" reaches the person they
 * are about to speak to rather than an unwatched inbox. The copy has to earn that:
 * it is written as that person rather than as a system, and it says outright that a
 * reply will be read.
 */
export function reminderBody(input: ReminderCopyInput): string {
  const when = `${dayWord(input)} at ${timeLabel(input)}`;
  if (input.onPlaceholder) return placeholderReminderBody(input, when);
  // #1334: with the calling number known, the lead has one thing worth doing before
  // the call, saving it, so "nothing you need to set up" stops being true. The
  // sentence is the manage page's own (`callComesFrom`), and the card it points at
  // is attached by the lane (`advisorContactCard`) only when this branch is taken.
  // An advisor with no real name is never stood in for by their address (#1334
  // review): the call is "with Pennie" and the email is signed as the lead's Pennie
  // advisor, which is still who will read a reply. The card is named after a real
  // advisor, and the email comes from them, so it is "my" card; with no real name
  // it is named Pennie and stays "our" card (Dan, 2026-10-01).
  const name = realAdvisorName(input.agentName);
  const from = callComesFrom(input.callingNumber);
  const numberLines = from
    ? [`We will call you on the number you gave us. ${from} ${name ? "My" : "Our"} contact card is attached, so one tap adds it.`]
    : ["We will call you on the number you gave us, so there is nothing you need to set up."];
  return [
    `Hi, this is a reminder that your call with ${name ? `${name} at Pennie` : "Pennie"} is ${when}.`,
    "",
    ...numberLines,
    "",
    `If that time no longer works, you can pick another or cancel here: ${input.manageUrl}`,
    "",
    "If it is easier, just reply to this email and it will reach me directly.",
    "",
    ...(name ? [name, "Pennie"] : ["Your Pennie advisor"]),
  ].join("\n");
}

/**
 * The placeholder's reminder (#4206, Dan 2026-10-26). The seat's name is the sender's
 * display name and nothing more: Marcia is who texts the customer, not who calls, so
 * the call is "with Pennie" and the email is signed by the team, as the seat's auto
 * reply is. It names no number, even a known calling number, because a text to it
 * reaches nobody and a card saved under Marcia's name invites exactly that; and it
 * never says a reply will be read, because nobody reads the seat's inbox.
 */
function placeholderReminderBody(input: ReminderCopyInput, when: string): string {
  return [
    `Hi, this is a reminder that your call with Pennie is ${when}.`,
    "",
    "We will call you on the number you gave us, so there is nothing you need to set up.",
    "",
    `If that time no longer works, you can pick another or cancel here: ${input.manageUrl}`,
    "",
    placeholderReplyLine("email"),
    "",
    "The Pennie team",
  ].join("\n");
}

import { DateTime } from "luxon";
import { formatClockTime } from "@/lib/date/parse";

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

export interface ReminderCopyInput {
  /** The advisor the lead will speak to, and whose mailbox this is sent from. */
  agentName: string;
  startsAtIso: string;
  /** The LEAD's timezone, which is the only one they can act on. */
  timezone: string;
  /** Where they can move or cancel. */
  manageUrl: string;
}

/**
 * "tomorrow" is a claim about the reader's calendar, not about 24 hours, and a
 * booking made inside the window is reminded at once. For a call two hours away
 * "tomorrow" is simply false, so the day is decided in the lead's own zone.
 */
function dayWord(input: ReminderCopyInput): string {
  const at = DateTime.fromISO(input.startsAtIso, { zone: input.timezone });
  const now = DateTime.now().setZone(input.timezone);
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
 * Plain text, because that is what the Gmail path sends and because a reminder is
 * four sentences: a lead reading it on a phone gains nothing from markup.
 *
 * It is sent from the ADVISOR's own mailbox (Dan, 2026-09-15, over a shared or
 * noreply address), so a lead who replies "can we move this" reaches the person they
 * are about to speak to rather than an unwatched inbox. The copy has to earn that:
 * it is written as that person rather than as a system, and it says outright that a
 * reply will be read.
 */
export function reminderBody(input: ReminderCopyInput): string {
  const when = `${dayWord(input)} at ${timeLabel(input)}`;
  return [
    `Hi, this is a reminder that your call with ${input.agentName} at Pennie is ${when}.`,
    "",
    "We will call you on the number you gave us, so there is nothing you need to set up.",
    "",
    `If that time no longer works, you can pick another or cancel here: ${input.manageUrl}`,
    "",
    "If it is easier, just reply to this email and it will reach me directly.",
    "",
    input.agentName,
    "Pennie",
  ].join("\n");
}

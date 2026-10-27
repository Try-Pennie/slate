import {
  HOUR_REMINDER_GAP_MS,
  HOUR_REMINDER_MIN_LEAD_MS,
  LIVE_STATUSES,
  REMINDER_HOLD_FLOOR_MS,
  REMINDER_RETRY_MARGIN_MS,
  reminderHeld,
} from "./reminder.ts";
import type { LateBooking } from "./reminder-template.ts";

/**
 * The one judge for every reminder email (#4297): for one booking and one email, send
 * it now, hold it for the hand back, wait, skip it for good, or do nothing.
 *
 * It generalises today's three judges (`reminderDue`, `reminderHeld` and
 * `hourReminderDue` in `reminder.ts`) from two fixed emails to any set an admin
 * configures, and `scripts/test-reminder-decision.ts` proves it agrees with them over a
 * generated grid for today's two emails before the lane is moved onto it. Pure: the
 * caller reads the booking, the emails, the send records and the clock.
 *
 * Every comparison is phrased so an unreadable value lands on the SILENT side, as
 * today's judges are (L50): a NaN start, clock or timing sends nothing. The two
 * courtesies, the hand back hold and the two hour gap, release on an unreadable value
 * instead, because they decide only WHEN the promise is kept, never whether.
 */

/** What the judge needs of a booking. */
export interface DecisionBooking {
  startsAtMs: number;
  /** When it was booked: the late booking rule and the hand back hold read it. */
  createdAtMs: number;
  status: string;
  /** The lead's address, or null when they gave only a phone. */
  leadEmail: string | null;
  /** The advisor's mailbox the email is sent from, or null when none is on record. */
  senderEmail: string | null;
  /** A call on the placeholder advisor (booking kind `staff_placed`, #4206). */
  onPlaceholder: boolean;
}

/** What the judge needs of a reminder email. */
export interface DecisionEmail {
  id: string;
  minutesBefore: number;
  lateBooking: LateBooking;
  /**
   * When the email last took effect: stamped when it is switched on or retimed. Null
   * when unreadable, which sends nothing (an email with no starting line would mail
   * every booking already inside its window at once).
   */
  effectiveFromMs: number | null;
  /** Whether a placeholder call gets this email. */
  placeholderSends: boolean;
}

export type SendStatus = "claimed" | "sent" | "failed" | "released" | "skipped" | "legacy_claimed";

/** One `booking_reminder_sends` row for this booking. */
export interface SendRecord {
  emailId: string;
  /** The start it was about. A record about another start does not count. */
  sentForMs: number;
  status: SendStatus;
  /** When the email was accepted by Gmail, or null when unknown. */
  sentAtMs: number | null;
  /** When the send was claimed, or null when unknown. */
  claimedAtMs: number | null;
}

/** Why an email is skipped for good. Each is recorded, so a gap is never silent. */
export type ReminderSkipReason =
  | "before_effective"
  | "placeholder_off"
  | "late_booking"
  | "superseded"
  | "too_close"
  | "no_sender"
  | "no_email";

export type ReminderDecision =
  | { action: "send" }
  /** Due, but waiting for the owner hand back (`REMINDER_HOLD_MS`); counted, never claimed. */
  | { action: "held" }
  /** Not yet: judged again on the next tick, never stored. */
  | { action: "wait"; reason: "not_yet" | "gap" }
  | { action: "skip"; reason: ReminderSkipReason }
  /**
   * Nothing to do and nothing to record: the call is not live or already started, this
   * email is already resolved for this start, or a value could not be read.
   */
  | { action: "none"; reason: "unreadable" | "not_live" | "past" | "resolved" };

/** A record that settles this email for this start: anything but a released claim. */
const RESOLVED: ReadonlySet<SendStatus> = new Set(["claimed", "sent", "failed", "skipped", "legacy_claimed"]);

/**
 * A record of an email that reached, or may have reached, the lead. A failed send keeps
 * its claim because a send that timed out may still have been delivered, so it counts.
 */
const MAY_HAVE_REACHED: ReadonlySet<SendStatus> = new Set(["claimed", "sent", "failed", "legacy_claimed"]);

/**
 * When a record's email reached the lead, for the two hour gap, or null when unknown. A
 * claim still in flight is measured from when it was claimed; an unknown time holds
 * nothing back, as `hourReminderDue` releases on one.
 */
function gapStampMs(r: SendRecord): number | null {
  const at = r.status === "sent" ? r.sentAtMs : r.status === "claimed" ? r.claimedAtMs : null;
  return at !== null && Number.isFinite(at) ? at : null;
}

/**
 * The decision for `email` on `booking` at `nowMs`. `sends` holds this booking's
 * records; any about another start are ignored, so a call that moved earns its emails
 * afresh. `allEmails` gives every STORED email's lead, switched off ones included, so a
 * record can be told shorter or longer than this one: a shorter email that was sent and
 * later switched off must still supersede a longer one (#4298).
 *
 * The rules, in order (the plan's Phase 3, Dan 2026-10-27):
 *   * inside the window: after its lead opens and while the call is ahead;
 *   * not before the email took effect, judged from when the window opened for THIS
 *     booking (the later of its lead and when it was booked), so switching an email on
 *     or retiming it never sends a burst to calls already inside the window;
 *   * a call booked after the window opened is sent at once or skipped, per email;
 *   * never after a SHORTER email for this start: it would arrive after a closer one;
 *   * never under `HOUR_REMINDER_MIN_LEAD_MS` before the call (#4287);
 *   * a send now email is held for the owner hand back, released by the fixed floor
 *     an hour out (`reminderHeld`), whichever emails exist;
 *   * not within `HOUR_REMINDER_GAP_MS` of another email for this start: a wait;
 *   * and only to a lead with an address, from an advisor with a mailbox.
 */
export function reminderDecision(
  booking: DecisionBooking,
  email: DecisionEmail,
  sends: readonly SendRecord[],
  allEmails: readonly DecisionEmail[],
  nowMs: number,
): ReminderDecision {
  const { startsAtMs, createdAtMs } = booking;
  if (!Number.isFinite(nowMs) || !Number.isFinite(startsAtMs) || !Number.isFinite(email.minutesBefore)) {
    return { action: "none", reason: "unreadable" };
  }
  if (!LIVE_STATUSES.has(booking.status)) return { action: "none", reason: "not_live" };
  if (startsAtMs <= nowMs) return { action: "none", reason: "past" };

  const forThisStart = sends.filter((r) => r.sentForMs === startsAtMs);
  if (forThisStart.some((r) => r.emailId === email.id && RESOLVED.has(r.status))) {
    return { action: "none", reason: "resolved" };
  }

  const leadMs = email.minutesBefore * 60_000;
  const windowOpensMs = startsAtMs - leadMs;
  if (!(nowMs >= windowOpensMs)) return { action: "wait", reason: "not_yet" };

  if (email.effectiveFromMs === null || !Number.isFinite(email.effectiveFromMs)) {
    return { action: "none", reason: "unreadable" };
  }
  // A booking made after its window opened has its window open when it was made.
  const openedForThisBookingMs = Number.isFinite(createdAtMs) ? Math.max(windowOpensMs, createdAtMs) : windowOpensMs;
  if (openedForThisBookingMs < email.effectiveFromMs) return { action: "skip", reason: "before_effective" };

  if (booking.onPlaceholder && !email.placeholderSends) return { action: "skip", reason: "placeholder_off" };

  if (email.lateBooking === "skip") {
    if (!Number.isFinite(createdAtMs)) return { action: "none", reason: "unreadable" };
    if (createdAtMs > windowOpensMs) return { action: "skip", reason: "late_booking" };
  }

  const leadOf = new Map(allEmails.map((e) => [e.id, e.minutesBefore]));
  const superseded = forThisStart.some((r) => {
    const lead = leadOf.get(r.emailId);
    return r.emailId !== email.id && lead !== undefined && lead < email.minutesBefore && MAY_HAVE_REACHED.has(r.status);
  });
  if (superseded) return { action: "skip", reason: "superseded" };

  if (startsAtMs - nowMs < HOUR_REMINDER_MIN_LEAD_MS) return { action: "skip", reason: "too_close" };

  if (email.lateBooking === "send_now" && reminderHeld({ createdAtMs, startsAtMs }, nowMs)) {
    return { action: "held" };
  }

  const inGap = forThisStart.some((r) => {
    if (r.emailId === email.id) return false;
    const at = gapStampMs(r);
    return at !== null && nowMs - at < HOUR_REMINDER_GAP_MS;
  });
  if (inGap) return { action: "wait", reason: "gap" };

  // Last, as today: a held booking with no address is counted held, then skipped.
  if (!booking.leadEmail) return { action: "skip", reason: "no_email" };
  if (!booking.senderEmail) return { action: "skip", reason: "no_sender" };
  return { action: "send" };
}

/**
 * How far from the call a failed send may still be handed back for a retry, by the
 * email's lead (the plan's Phase 3). An email with a lead over an hour must land before
 * Regal's one hour text, so its floor is `REMINDER_HOLD_FLOOR_MS`; a shorter one keeps
 * the half hour minimum. Plus `REMINDER_RETRY_MARGIN_MS` either way, so the retry on the
 * next tick still lands in time. Fixed by the email's own lead, so adding or retiming
 * another email never moves it.
 */
export function reminderRetryFloorMs(email: Pick<DecisionEmail, "minutesBefore">): number {
  const floorMs = email.minutesBefore * 60_000 > REMINDER_HOLD_FLOOR_MS ? REMINDER_HOLD_FLOOR_MS : HOUR_REMINDER_MIN_LEAD_MS;
  return floorMs + REMINDER_RETRY_MARGIN_MS;
}

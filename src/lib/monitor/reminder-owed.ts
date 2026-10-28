/**
 * A reminder email owed to a lead whose call is still ahead, and not recorded (#4300,
 * milestone "Editable reminder emails"; it replaces the interim check filed as #4295).
 *
 * A send that fails pages (`booking_reminder_failed:*`). A booking the reminder lane
 * wrongly skips, never reaches, or claims and then never settles fails nothing and pages
 * nobody: the first run after #4284 emailed 47 leads at once and was caught by hand. So
 * the monitor lane reads, for every switched on email, the live calls in real buckets
 * that are still ahead, and pages per email when one of them is owed the email and the
 * lane has left no resolved record for it.
 *
 * ## Its own reading of the rules (L721)
 *
 * The lane decides with `reminderDecision` (`src/lib/booking/reminder-decision.ts`). This
 * file never calls it, nor the older judges it replaced: a monitor that asks the gate
 * whether the gate was right agrees with it about every blind spot. The rules below are
 * re-read from the plan (Dan, 2026-10-27) and written out here, coarser where coarse is
 * the safe side. What it shares with the lane is only the DATA the rules are stated in
 * (the 30 minute minimum, the two hour gap) and `sendRecordsForBooking`, which says what
 * counts as a record at all, so the two can never disagree about whether a send was made.
 *
 * A call is OWED an enabled email when:
 *   * it is live (confirmed or rescheduled) and still ahead;
 *   * the lead gave an address and the call has an advisor mailbox to send from (with
 *     neither the lane waits, rightly, storing nothing);
 *   * it is not on the placeholder, or the email goes to placeholder calls;
 *   * its window has opened FOR THIS BOOKING: the later of the email's lead before the
 *     call and when the call was booked;
 *   * that moment is at least 30 minutes before the call (under that it is never sent);
 *   * a late booking (made after the lead) is not on an email set to skip late ones;
 *   * the email took effect (switched on or retimed) no later than that moment.
 *
 * It is RESOLVED by a record about this start that says the email went, was skipped
 * with its reason, failed (which pages on its own) or was sent by the code before 0211
 * (`legacy_claimed`). A released claim resolves nothing: it is waiting to be tried again.
 *
 * It PAGES, only while the call is still ahead, when:
 *   * there is no resolved record more than `REMINDER_OWED_GRACE_MS` after it became
 *     owed, the later of: its window opening for this booking, the booking's last change
 *     (a call moved into the window has had no tick yet), and the end of any two hour gap
 *     another email for this start could still be holding it in; or
 *   * a claim about this start is older than `REMINDER_CLAIM_STALE_MS` and never settled.
 *
 * The grace covers the five minute lane cadence and the ten minute owner hand back hold
 * a same day booking is given (`REMINDER_HOLD_MS`), so neither needs reading here.
 *
 * ## A condition per email
 *
 * `reminder_email_owed:<slug>`, naming its bookings as subjects so a newly owed one posts
 * at once (#3801). Endings never share wording (L11): a measured read finding none owed is
 * the recovery; an email switched off or removed while its page is open stands down
 * saying nothing was repaired. A read that fails measures nothing, pages nobody and
 * clears nothing, and the monitor lane throws it so its step's failing streak pages.
 *
 * Pure apart from the injected reads and the dispatcher (scripts/test-reminder-owed.ts).
 */
import { parseStampMs } from "../date/stamp.ts";
import { HOUR_REMINDER_GAP_MS, HOUR_REMINDER_MIN_LEAD_MS, REMINDER_EMAIL_MAX_MINUTES } from "../booking/reminder.ts";
import { sendRecordsForBooking, type BookingSendSource } from "../booking/reminder-legacy.ts";
import { reminderEmailLabel, type LateBooking } from "../booking/reminder-template.ts";
import type { SendRecord } from "../booking/reminder-decision.ts";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";

const MIN = 60_000;

/** The alert_state family: `reminder_email_owed:<email slug>`. */
export const REMINDER_OWED_ALERT_PREFIX = "reminder_email_owed";
export const reminderOwedAlertKey = (slug: string): string => `${REMINDER_OWED_ALERT_PREFIX}:${slug}`;

/** How long after a call became owed an email may go unrecorded before it pages. */
export const REMINDER_OWED_GRACE_MS = 15 * MIN;
/** How old a claim may be, never marked sent or failed, before it pages. */
export const REMINDER_CLAIM_STALE_MS = 15 * MIN;
/** How many bookings a page names before it says how many more. */
export const REMINDER_OWED_NAMED = 10;

/** The live statuses, read here rather than borrowed from the lane. */
const LIVE: ReadonlySet<string> = new Set(["confirmed", "rescheduled"]);

/** One stored reminder email, as this check reads it. */
export interface OwedEmail {
  id: string;
  slug: string;
  name: string;
  minutesBefore: number;
  lateBooking: LateBooking;
  enabled: boolean;
  effectiveFromIso: string;
  placeholderSends: boolean;
}

/** One live call in a real bucket, with what the lane has recorded about it. */
export interface OwedBooking extends BookingSendSource {
  id: string;
  startsAtIso: string;
  createdAtIso: string;
  /** The row's last change: a call moved into the window has had no tick yet. */
  updatedAtIso: string;
  status: string;
  attendeeEmail: string | null;
  agentEmail: string | null;
  /** On the placeholder advisor (booking kind `staff_placed`). */
  onPlaceholder: boolean;
}

export type OwedVerdict =
  /** Owed, nothing resolved, past its grace: pages. */
  | { kind: "owed" }
  /** A claim older than `REMINDER_CLAIM_STALE_MS` that never settled: pages. */
  | { kind: "stale_claim" }
  /** A claim younger than that: the send is in flight. */
  | { kind: "in_flight" }
  /** Resolved by a record about this start. */
  | { kind: "settled" }
  /** Owed, but its grace (or a gap another email may hold) has not run out. */
  | { kind: "not_yet" }
  /** Owed nothing, by the rules. */
  | {
      kind: "not_owed";
      why: "off" | "not_live" | "past" | "no_address" | "no_mailbox" | "placeholder_off" | "too_close" | "late_booking" | "before_effective";
    }
  /** A value that could not be read: said in the log, never judged either way. */
  | { kind: "unreadable" };

const blank = (v: string | null) => v === null || v.trim() === "";

/**
 * Whether `email` is owed to `booking` at `nowMs`, and whether its record is missing or
 * stuck. `records` are this booking's records from `sendRecordsForBooking`, every start.
 */
export function judgeReminderOwed(booking: OwedBooking, email: OwedEmail, records: readonly SendRecord[], nowMs: number): OwedVerdict {
  if (!email.enabled) return { kind: "not_owed", why: "off" };
  const startMs = parseStampMs(booking.startsAtIso);
  if (startMs === null || !Number.isFinite(email.minutesBefore)) return { kind: "unreadable" };
  if (!LIVE.has(booking.status)) return { kind: "not_owed", why: "not_live" };
  if (startMs <= nowMs) return { kind: "not_owed", why: "past" };

  const aboutThisStart = records.filter((r) => r.sentForMs === startMs);
  const own = aboutThisStart.filter((r) => r.emailId === email.id);
  // A stuck claim is a fault whatever else is true of the booking now.
  const claim = own.find((r) => r.status === "claimed");
  if (claim) {
    const at = claim.claimedAtMs;
    return at !== null && Number.isFinite(at) && nowMs - at <= REMINDER_CLAIM_STALE_MS ? { kind: "in_flight" } : { kind: "stale_claim" };
  }
  if (own.some((r) => r.status === "sent" || r.status === "skipped" || r.status === "failed" || r.status === "legacy_claimed")) {
    return { kind: "settled" };
  }

  if (blank(booking.attendeeEmail)) return { kind: "not_owed", why: "no_address" };
  if (blank(booking.agentEmail)) return { kind: "not_owed", why: "no_mailbox" };
  if (booking.onPlaceholder && !email.placeholderSends) return { kind: "not_owed", why: "placeholder_off" };

  const createdMs = parseStampMs(booking.createdAtIso);
  const effectiveMs = parseStampMs(email.effectiveFromIso);
  if (createdMs === null || effectiveMs === null) return { kind: "unreadable" };
  const leadOpensMs = startMs - email.minutesBefore * MIN;
  const openedMs = Math.max(leadOpensMs, createdMs);
  if (startMs - openedMs < HOUR_REMINDER_MIN_LEAD_MS) return { kind: "not_owed", why: "too_close" };
  if (email.lateBooking === "skip" && createdMs > leadOpensMs) return { kind: "not_owed", why: "late_booking" };
  if (effectiveMs > openedMs) return { kind: "not_owed", why: "before_effective" };

  // When it became owed, as late as any reading allows: the window opening, the call's
  // last change, and the end of a gap a sibling email about this start could be holding.
  let owedFromMs = openedMs;
  const updatedMs = parseStampMs(booking.updatedAtIso);
  if (updatedMs !== null) owedFromMs = Math.max(owedFromMs, updatedMs);
  for (const r of aboutThisStart) {
    if (r.emailId === email.id) continue;
    // Coarser than the lane on purpose: any sibling record with a time, failed ones
    // included, may be holding the gap, since a failed send may have reached the lead.
    const at = r.status === "sent" ? (r.sentAtMs ?? r.claimedAtMs) : r.status === "claimed" || r.status === "failed" ? r.claimedAtMs : null;
    if (at !== null && Number.isFinite(at)) owedFromMs = Math.max(owedFromMs, at + HOUR_REMINDER_GAP_MS);
  }
  return nowMs - owedFromMs > REMINDER_OWED_GRACE_MS ? { kind: "owed" } : { kind: "not_yet" };
}

// ------------------------------------------------------------------------- copy

/** The page for one email: how many leads, each kind said apart, every booking named. */
export function reminderOwedAlert(name: string, owed: { unrecorded: string[]; staleClaims: string[] }): string {
  const total = owed.unrecorded.length + owed.staleClaims.length;
  const ids = [...owed.unrecorded, ...owed.staleClaims];
  const shown = ids.slice(0, REMINDER_OWED_NAMED).join(", ");
  const more = ids.length > REMINDER_OWED_NAMED ? `, and ${ids.length - REMINDER_OWED_NAMED} more` : "";
  const parts: string[] = [];
  if (owed.unrecorded.length > 0) {
    parts.push(
      `${owed.unrecorded.length} with nothing recorded more than 15 minutes after it was due (no send, no skip with its reason, no failure), ` +
        `so the reminder lane is not reaching them or is deciding wrongly: its booking-reminder cycle line says what it did with each`,
    );
  }
  if (owed.staleClaims.length > 0) {
    parts.push(
      `${owed.staleClaims.length} claimed over 15 minutes ago and never marked sent or failed, so it may have gone out with its record ` +
        `unwritten: check the advisor's Sent mail before sending one by hand`,
    );
  }
  return (
    `The ${reminderEmailLabel(name)} email is owed to ${total} ${total === 1 ? "lead whose call is" : "leads whose calls are"} still ahead, ` +
    `and has not gone out: ${parts.join("; ")}. Bookings: ${shown}${more}.`
  );
}

/** The recovery, off a measured read that found nobody owed. */
export function reminderOwedAllClear(name: string): string {
  return (
    `No lead is owed the ${reminderEmailLabel(name)} email now: every call still ahead whose time for it came over 15 minutes ago ` +
    `has its send, skip or failure on record. A call named earlier that has since started is no longer judged.`
  );
}

/** The stand down once the email is switched off or removed. */
export function reminderOwedStandDown(name: string | undefined): string {
  return name
    ? `The ${reminderEmailLabel(name)} email is switched off, so no lead is owed it any more. Nothing was repaired.`
    : "A reminder email that was owed to leads no longer exists, so nobody is owed it any more. Nothing was repaired.";
}

// ----------------------------------------------------------------------- runner

export type ReminderOwedResult =
  /** A read failed: nothing measured, nothing paged, nothing cleared. */
  | { status: "unreadable"; error: string }
  | {
      status: "checked";
      /** Calls read (live, real buckets, inside the longest switched on lead). */
      judged: number;
      /** Per email slug: how many owed, missing and stuck. */
      owed: Record<string, { unrecorded: number; staleClaims: number }>;
      /** Booking and email pairs with a value that could not be read. */
      unreadable: number;
      paged: string[];
      cleared: string[];
    };

export interface ReminderOwedDeps {
  /** Every stored email, switched off ones included. THROWS. */
  loadEmails: () => Promise<OwedEmail[]>;
  /** Live calls in real buckets starting after now and at or before `windowEndIso`. THROWS. */
  loadBookings: (windowEndIso: string) => Promise<OwedBooking[]>;
  /** The slugs with an open owed page. THROWS. */
  loadFiringSlugs: () => Promise<string[]>;
  notify: ThrottledNotify<unknown>;
  /** REQUIRED, so the condition cannot be wired with no way to end (#1151). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  nowMs: number;
}

/**
 * The monitor lane step. Every read happens before anything is sent or cleared, so a
 * read that fails leaves the tick unmeasured with nothing half done.
 */
export async function runReminderOwedCheck(deps: ReminderOwedDeps): Promise<ReminderOwedResult> {
  const { nowMs } = deps;
  let emails: OwedEmail[];
  let bookings: OwedBooking[];
  let firing: string[];
  try {
    [emails, firing] = await Promise.all([deps.loadEmails(), deps.loadFiringSlugs()]);
    const enabled = emails.filter((e) => e.enabled && Number.isFinite(e.minutesBefore));
    const longestMin = Math.min(Math.max(0, ...enabled.map((e) => e.minutesBefore)), REMINDER_EMAIL_MAX_MINUTES);
    bookings = enabled.length === 0 ? [] : await deps.loadBookings(new Date(nowMs + longestMin * MIN).toISOString());
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }

  const owed: Record<string, { unrecorded: string[]; staleClaims: string[] }> = {};
  for (const e of emails) if (e.enabled) owed[e.slug] = { unrecorded: [], staleClaims: [] };
  let unreadable = 0;
  for (const b of bookings) {
    const records = sendRecordsForBooking(b, emails);
    for (const e of emails) {
      if (!e.enabled) continue;
      const v = judgeReminderOwed(b, e, records, nowMs);
      if (v.kind === "owed") owed[e.slug]!.unrecorded.push(b.id);
      else if (v.kind === "stale_claim") owed[e.slug]!.staleClaims.push(b.id);
      else if (v.kind === "unreadable") unreadable += 1;
    }
  }

  const paged: string[] = [];
  for (const e of emails) {
    const o = owed[e.slug];
    if (!o || o.unrecorded.length + o.staleClaims.length === 0) continue;
    const key = reminderOwedAlertKey(e.slug);
    paged.push(e.slug);
    await deps
      .notify(key, deps.cooldownMs, reminderOwedAlert(e.name, o), { subjects: [...o.unrecorded, ...o.staleClaims] })
      .catch(logAlertSendFailure(key));
  }

  // Only the open pages, so a healthy tick spends nothing on emails nobody was told about.
  const cleared: string[] = [];
  const bySlug = new Map(emails.map((e) => [e.slug, e]));
  for (const slug of firing) {
    if (paged.includes(slug)) continue;
    const e = bySlug.get(slug);
    const key = reminderOwedAlertKey(slug);
    const text = e && e.enabled ? reminderOwedAllClear(e.name) : reminderOwedStandDown(e?.name);
    cleared.push(slug);
    await deps.resolve(key, text).catch(logResolveFailure(key));
  }

  return {
    status: "checked",
    judged: bookings.length,
    owed: Object.fromEntries(Object.entries(owed).map(([slug, o]) => [slug, { unrecorded: o.unrecorded.length, staleClaims: o.staleClaims.length }])),
    unreadable,
    paged,
    cleared,
  };
}

import { REMINDER_EMAIL_MAX_MINUTES, REMINDER_HOLD_FLOOR_MS } from "./reminder.ts";
import {
  reminderDecision,
  reminderRetryFloorMs,
  type DecisionBooking,
  type DecisionEmail,
  type ReminderSkipReason,
} from "./reminder-decision.ts";
import {
  describeTemplateProblem,
  renderReminder,
  type LateBooking,
  type ReminderTemplate,
  type TemplateProblem,
} from "./reminder-template.ts";
import { isLegacySlug, sendRecordsForBooking, type LegacySlug, type StoredSend } from "./reminder-legacy.ts";
import { classifyReminderSendFailure, type ReminderFailureCode, type ReminderSettlement } from "./reminder-rate.ts";
import type { ReminderCopyInput } from "./reminder.ts";
import type { ReminderClaimOutcome, ReminderEmailRow } from "@/lib/db/types";
import type { MimeMessage } from "@/lib/notify/email-mime";
import { asEmailSendError, type EmailSendOutcome } from "@/lib/notify/email-errors";
import { shortErrorReason } from "@/lib/notify/error-text";
import { parseStampMs } from "@/lib/date/stamp";
import { isLeadId, leadIdKey } from "@/lib/salesforce/lead-xbc";
import { advisorContactCard, realAdvisorName, type CardPhoto } from "./advisor-contact-card.ts";
import { cardPhotoFromStored } from "./advisor-card-photo.ts";
import { PENNIE_CARD_LOGO } from "./pennie-card-logo.ts";
import { withCallingNumberLine } from "./core.ts";
import { readWithinDeadline, type ScheduleTimer } from "@/lib/read-within-deadline";

export type { StoredSend } from "./reminder-legacy.ts";

/**
 * How long the lane waits for the tick's one calling number read (#1334). Longer
 * than the 2.5s a waiting lead gets, because nobody is watching this and the read
 * is a token exchange plus a query; far shorter than the five minute cadence and
 * the shared invocation budget, so a hung Salesforce costs every reminder its
 * number, never the reminder itself.
 */
export const REMINDER_CALLING_NUMBER_DEADLINE_MS = 10_000;

// Defined beside the reminder rules in `reminder.ts`, so the pure judge
// (`reminder-decision.ts`, #4297) reads it without importing this lane.
export { REMINDER_RETRY_MARGIN_MS } from "./reminder.ts";

/**
 * The reminder lane's orchestration (#2359, #4282), for every reminder email an admin
 * has stored (#4298, milestone "Editable reminder emails").
 *
 * Each tick reads every `reminder_emails` row once, and a failed read THROWS: nothing is
 * sent, the heartbeat lapses and the lane watchdog pages. There is no fallback to
 * `DEFAULT_TEMPLATES`, which would mail leads copy an admin had changed or switched off.
 * Then ONE worklist read, and for each booking and each enabled email, longest lead
 * first, the one judge (`reminderDecision`) says send, hold, wait, skip or nothing.
 *
 * Every dependency is injected, so the property that makes this safe (the claim is
 * written BEFORE Gmail is called) is asserted by `scripts/test-booking-reminder-send.ts`
 * rather than assumed. The decision and the copy are pure (`reminder-decision.ts`,
 * `reminder-template.ts`); this file owns only the order of effects.
 *
 * ## Assume it runs twice
 *
 * A scheduled job that sends something a real person reads has to be safe against
 * overlap, retry and a crash in the middle. The claim is `claim_reminder_send`, which
 * decides under a per booking lock in Postgres, so two overlapping ticks cannot both
 * send: only `claimed` sends.
 *
 * The claim comes first, and that choice decides which way a crash between the two
 * is wrong. Claiming first costs a reminder; sending first sends a second copy on the
 * next tick, and an email cannot be taken back.
 *
 * A send that FAILS keeps its claim (recorded `failed` with its code), with one
 * exception. Releasing it retries, and a send that timed out after Gmail accepted the
 * message is indistinguishable from one that never arrived, so a retry is the only path
 * that can deliver twice. The gap is made visible with an alert instead (L12).
 *
 * The exception is a failure that PROVES nothing was delivered and could pass: the
 * send threw an `EmailSendError` whose outcome is `never_sent` or `refused` and which
 * is `transient` (a token mint that timed out, a 429), while the call is still further
 * away than `reminderRetryFloorMs` for that email, so the retry itself lands in time.
 * Then the claim is handed back and the next tick sends it (2026-10-05). Anything less
 * certain, a plain Error included, keeps the claim, so the default stays the direction
 * that cannot send a second copy.
 *
 * ## The legacy columns, until phase 6
 *
 * For the two seeded emails (`day` and `hour`) the lane ALSO writes the bookings columns
 * the old code used, exactly as it did: the 24 hour claim sets `reminder_sent_for` and
 * clears `reminder_sent_at`, a send stamps `reminder_sent_at`, the 1 hour claim sets
 * `hour_reminder_sent_for`, and a release puts back what this tick read. A rollback to
 * the old code then resends nothing. And the lane READS them as send records
 * (`sendRecordsForBooking`), so a send the old code made after migration 0211 is never
 * made again.
 */

/** The sender name a reminder carries when the advisor has no real name on record (#2985). */
export const SENDER_NAME_FALLBACK = "Pennie";

/**
 * How many lost reminders one tick pages about BY NAME, per email (Dan, 2026-10-05). The
 * page is keyed per booking so one lost reminder cannot silence the next, which means an
 * outage that fails every send would otherwise post a page per lead. Past this many,
 * the rest of that email's lost reminders are folded into ONE page that lists them all,
 * so nobody unreminded goes unnamed and the wave is still said once by the share.
 */
export const REMINDER_PAGES_PER_TICK = 3;

/** The longest lead an email may have, which caps the worklist read. */
const MAX_LEAD_MS = REMINDER_EMAIL_MAX_MINUTES * 60_000;

/** One stored reminder email, as the lane uses it (`reminder_emails`, #4296). */
export interface LaneEmail {
  id: string;
  /** Stable; names the email in alert keys. */
  slug: string;
  /** What an admin called it, which every alert about it says. */
  name: string;
  minutesBefore: number;
  lateBooking: LateBooking;
  enabled: boolean;
  /** When it last took effect (switched on or retimed). */
  effectiveFromIso: string;
  subject: string;
  body: string;
  cardBlock: boolean;
  placeholderSends: boolean;
}

/** The lane's view of a stored row. */
export function laneEmailFromRow(
  row: Pick<
    ReminderEmailRow,
    | "id"
    | "slug"
    | "name"
    | "minutes_before"
    | "late_booking"
    | "enabled"
    | "effective_from"
    | "subject"
    | "body"
    | "card_block"
    | "placeholder_sends"
  >,
): LaneEmail {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    minutesBefore: row.minutes_before,
    lateBooking: row.late_booking,
    enabled: row.enabled,
    effectiveFromIso: row.effective_from,
    subject: row.subject,
    body: row.body,
    cardBlock: row.card_block,
    placeholderSends: row.placeholder_sends,
  };
}

export interface DueBooking {
  id: string;
  startsAtIso: string;
  /** When the booking was made, which the hand-back hold and the late booking rule read. */
  createdAtIso: string;
  /** Legacy (until phase 6): the start the 24 hour email went out about. */
  reminderSentForIso: string | null;
  /** Legacy: when the 24 hour email was sent (#4282), or null for unknown. */
  reminderSentAtIso: string | null;
  /** Legacy: the start the 1 hour email has gone out about (#4282), or null for none. */
  hourReminderSentForIso: string | null;
  /** This booking's `booking_reminder_sends` rows, every start, embedded by the read. */
  sends: StoredSend[];
  status: string;
  /** Null when the lead gave a phone and no address, which is legitimate. */
  attendeeEmail: string | null;
  /** The lead's own phone (`attendee_phone`, #4292), named in the email; null for none. */
  attendeePhone: string | null;
  /** The advisor's mailbox, which is also the sender; null records a no_sender skip. */
  agentEmail: string | null;
  /** The advisor's name, or null when the booking holds none (never their address). */
  agentName: string | null;
  /** The LEAD's timezone, so the time reads as they chose it. */
  timezone: string;
  manageUrl: string;
  /** The lead's Salesforce id (`bookingLeadId`), or null for a booking with none. */
  leadId: string | null;
  /** The invite on the advisor's calendar, which the calling number is written into. */
  gcalEventId: string | null;
  /** The assigned advisor's user id, whose photo goes on the card; null for none. */
  agentId: string | null;
  /**
   * The call sits on the placeholder advisor, Marcia (booking kind `staff_placed`,
   * #4206): sent from the placeholder seat with its own copy, no calling number, no card
   * (the lead's own number is still named, #4292) and
   * no calling number written into the invite (Dan, 2026-10-26).
   */
  onPlaceholder: boolean;
}

export interface ReminderDeps {
  now(): number;
  /** Every stored reminder email, switched off ones included. THROWS on a failed read. */
  loadEmails(): Promise<LaneEmail[]>;
  /**
   * Live, non test bookings starting before `windowEndMs`, each with its send rows. The
   * query is a filter, never the judgement: every row is re-judged below (L166).
   */
  loadDue(windowEndMs: number): Promise<DueBooking[]>;
  /** `claim_reminder_send`. Only `claimed` may send. */
  claimSend(bookingId: string, emailId: string, sentForIso: string): Promise<ReminderClaimOutcome>;
  /** `mark_reminder_sent`, once Gmail has accepted it. */
  markSendSent(bookingId: string, emailId: string, sentForIso: string): Promise<boolean>;
  /** `release_reminder_send`, only after a send that provably delivered nothing. */
  releaseSend(bookingId: string, emailId: string, sentForIso: string): Promise<boolean>;
  /** `fail_reminder_send`, with the failure's classified code. */
  failSend(bookingId: string, emailId: string, sentForIso: string, reason: string): Promise<boolean>;
  /** `skip_reminder_send`: this email will never be sent for this start, and why. */
  skipSend(bookingId: string, emailId: string, sentForIso: string, reason: string): Promise<boolean>;
  /**
   * Legacy claim (day and hour, until phase 6): a compare and swap of the email's bookings
   * column from `seen`, the value THIS tick read, to `startsAtIso`. The day claim also
   * clears `reminder_sent_at`. False when the row no longer holds `seen`.
   */
  legacyClaim(bookingId: string, slug: LegacySlug, startsAtIso: string, seen: string | null): Promise<boolean>;
  /**
   * Legacy release: put the column back to `restoreTo` (and, for day, `reminder_sent_at`
   * to `restoreSentAt`) only where it still holds `claimedForIso`.
   */
  legacyRelease(
    bookingId: string,
    slug: LegacySlug,
    claimedForIso: string,
    restoreTo: string | null,
    restoreSentAt: string | null,
  ): Promise<boolean>;
  /** Legacy: stamp `reminder_sent_at` for the 24 hour email, only once Gmail accepted it. */
  legacyMarkSent(bookingId: string, startsAtIso: string): Promise<void>;
  send(msg: MimeMessage): Promise<string>;
  /** Fail loud: a reminder that did not go out is not allowed to be silent. Keyed by
   *  booking and email (`reminderFailedAlertKey`), so one page cannot silence another. */
  alert(bookingId: string, slug: string, text: string): Promise<void>;
  /** An enabled email whose stored words the renderer refuses: once per email per tick. */
  alertUnrenderable(slug: string, text: string): Promise<void>;
  /** The all clear for every email that rendered this tick, or is switched off. */
  resolveRenderable(recovered: { slug: string; text: string }[]): Promise<void>;
  /** Said when no stored email is switched on, so no lead is being reminded at all. */
  notifyNoneEnabled(text: string): Promise<void>;
  /**
   * The calling number per lead (#1334), keyed by `leadIdKey`, from Salesforce
   * `AssignedRegalPhone__c`. Called ONCE per tick with the leads being sent to.
   * THROWS on a refused read, which the lane answers by sending every reminder
   * without a number rather than by sending none.
   */
  readCallingNumbers(leadIds: string[]): Promise<Map<string, string | null>>;
  /**
   * Rewrite the invite's description on the advisor's calendar, without emailing
   * the lead about it (Google syncs the content to the attendee either way).
   */
  refreshInvite(agentEmail: string, eventId: string, description: string): Promise<void>;
  /**
   * The invite's CURRENT description ("" when it has none), or null when the event
   * is gone. Throws when it cannot be read, so nothing is written blind.
   */
  readInviteDescription(agentEmail: string, eventId: string): Promise<string | null>;
  /**
   * The stored directory photo per advisor id (`advisor_photos`, #3027), read ONCE
   * per tick for the advisors whose reminders carry a card. Absent means no photo
   * held. Throws on a refused read, which the lane answers by sending every card
   * with the Pennie logo.
   */
  readAdvisorPhotos(userIds: string[]): Promise<Map<string, { base64: string; mime: string }>>;
  /** The timer the calling number and photo deadlines run on; absent means the real clock. */
  deadlineTimer?: ScheduleTimer;
  /**
   * A line for the log, never a page: a degraded step, and every failed send with
   * its `fields` (code, outcome, whether the claim was released). The Error goes
   * through whole so the log keeps its cause and stack. Never contact data.
   */
  warn(
    msg: string,
    bookingId: string | null,
    err: unknown,
    fields?: Record<string, string | number | boolean | null>,
  ): void;
}

/** One email's share of a tick, for the cycle log line. */
export interface EmailRunCounts {
  sent: number;
  failed: number;
  retrying: number;
  attempted: number;
  held: number;
  waiting: number;
  skipped: number;
  lost: number;
}

export interface ReminderRun {
  sent: number;
  failed: number;
  /** Recorded skips, every reason (`skippedByReason`). Counted, never silent. */
  skipped: number;
  skippedByReason: Partial<Record<ReminderSkipReason, number>>;
  /**
   * Due, and HELD because the booking is too young for the owner hand-back to have
   * landed (#2633). Not sent, not failed, not attempted and not claimed: it is owed
   * a reminder on a later tick, and it is counted so the wait is visible.
   */
  held: number;
  /** Not yet inside the window, or inside the two hour gap after another email: judged again. */
  waiting: number;
  /** Nothing to do: already settled, not live, or past. */
  idle: number;
  /** A value the judge could not read, so nothing was sent. Said in the log. */
  unreadable: number;
  /** Due, and claimed by somebody else this tick. */
  lost: number;
  /**
   * Sends ATTEMPTED, which is `sent + failed` and deliberately not the row count
   * (#2496). It is the denominator of the failure share, and a booking that was
   * skipped or lost was never attempted: counting either would make a real outage
   * look proportionally smaller exactly while it was happening.
   */
  attempted: number;
  /**
   * This tick's failures by `ReminderFailureCode`, so the share can name what is
   * failing. Classified where the error is CAUGHT rather than where the window is
   * stored, because the raw message must not travel any further than this (L131).
   */
  byCode: Record<string, number>;
  /**
   * Failed sends whose claim was RELEASED so the next tick tries again. Inside
   * `failed`, and never paged, since the lead is still going to be reminded.
   */
  retrying: number;
  /** The released sends by share key (`reminderShareKey`), with the code each failed with. */
  retried: Record<string, ReminderFailureCode>;
  /** Every other attempted send by share key: `sent`, or `kept` when it failed and kept its claim. */
  settled: Record<string, ReminderSettlement>;
  /** Reminders sent naming the calling number, with the advisor's card (#1334). */
  withCallingNumber: number;
  /**
   * The tick's calling number read FAILED, so every reminder went without one. Not a
   * page (no reminder was lost), but said out loud (L98).
   */
  callingNumberUnread: boolean;
  /** Invites the calling number could not be written into, after the send. */
  inviteRefreshFailed: number;
  /** Reminders sent with the advisor's photo on the card (Dan, 2026-10-01). */
  withPhoto: number;
  /** Advisors whose photo was wanted for a card and could not be had. */
  photoUnread: number;
  /** Reminders sent with the Pennie logo on the card in place of a photo (#2980). */
  withLogo: number;
  /** Lost reminders past `REMINDER_PAGES_PER_TICK` folded into one page per email. */
  pagesFolded: number;
  /** How many stored emails are switched on. Zero sends nothing, and is said. */
  emailsEnabled: number;
  /** True when no stored email is switched on this tick. */
  noneEnabled: boolean;
  /** The slugs of enabled emails the renderer refused this tick, which sent nothing. */
  unrenderable: string[];
  /** Each judged email's counts, by slug. */
  byEmail: Record<string, EmailRunCounts>;
}

/**
 * Why a failed reminder pages, which decides what the page can truthfully say.
 *
 *   too_late: it did not go out (nothing reached Gmail, or Gmail asked for it to
 *     be sent later), and the call is too close for the next tick to resend it in
 *     time (`reminderRetryFloorMs`).
 *   refused: Google answered and refused it (the address, or the mailbox's
 *     delegation) in a way that will not pass, so it is not resent until that is
 *     repaired.
 *   not_built: Slate could not build the message, so nothing reached Google, and
 *     it would fail the same way again. Never called a Google refusal, which sends
 *     its reader to the wrong system.
 *   unknown: the send failed in a way that cannot say whether Gmail accepted it,
 *     so it is not resent, because that could deliver a second copy.
 *   not_released: it did not go out and a retry was due, but handing the claim
 *     back threw. The update may still have landed with its reply lost, so the
 *     page says it may not be sent, never that it will not.
 */
export type ReminderFailureDisposition = "too_late" | "refused" | "not_built" | "unknown" | "not_released";

/** What an alert needs of an email to name it. */
export type NamedEmail = Pick<LaneEmail, "name" | "minutesBefore">;

/**
 * The email's stored name as a page says it ("the 24 hour reminder email"). A name
 * that already ends in "email" is not given a second one.
 */
function emailLabel(name: string): string {
  const label = name.trim().replace(/\s*emails?$/i, "").trim();
  return label === "" ? "reminder" : label;
}

/** What a send that did not go out can truthfully say about Gmail, by outcome. A
 *  rate limited send reached Gmail and was answered, so it is never "nothing". */
function didNotGoOut(outcome: EmailSendOutcome): string {
  return outcome === "refused"
    ? "Gmail turned it away for now and asked for it to be sent later"
    : "nothing reached Gmail";
}

/**
 * The alert for a reminder that did not go out, or may not have.
 *
 * It names the booking and the email by its stored name, and says what the lead did NOT
 * get and whether anything will change that, which differs by disposition: a page saying
 * "will not be retried" about a send that is in fact being retried, or "did not go out"
 * about one that may have, is a page that teaches its reader to stop trusting it. The
 * reason is the SHORT one (`shortErrorReason`), never the provider's body: that belongs
 * in the log, and an alert is read on a phone (the `// alert-text-ok:` rule).
 */
export function reminderFailedAlert(
  bookingId: string,
  disposition: ReminderFailureDisposition,
  reason: string,
  /** The send's outcome, which decides what too_late and not_released say about
   *  Gmail. Ignored by the dispositions whose sentence does not depend on it. */
  outcome: EmailSendOutcome,
  /** Which email it was, so the page names the one the lead did not get. */
  email: NamedEmail,
): string {
  const label = `The ${emailLabel(email.name)} email`;
  // An email with a lead over an hour must land before the lead's one hour text; a
  // shorter one's own floor is simply the call being close (`reminderRetryFloorMs`).
  const tooLateWhy =
    email.minutesBefore * 60_000 > REMINDER_HOLD_FLOOR_MS ? "before the lead's one hour text reminder" : "while it is still useful";
  const what: Record<ReminderFailureDisposition, string> = {
    too_late:
      `${label} did not go out for booking ${bookingId}: ${didNotGoOut(outcome)}, ` +
      `and it is too close to the call to try again ${tooLateWhy}, so it ` +
      `is not resent.`,
    refused:
      `${label} did not go out for booking ${bookingId}: Google refused it, and it ` +
      `will not be resent until that is repaired, so that lead has not been reminded about their call.`,
    not_built:
      `${label} did not go out for booking ${bookingId}: Slate could not build the ` +
      `message, so nothing reached Google, and it will not be resent until that is repaired.`,
    unknown:
      `${label} for booking ${bookingId} may not have gone out: the send failed in a ` +
      `way that cannot say whether Gmail accepted it, and it is not resent, because that could ` +
      `deliver a second copy.`,
    not_released:
      `${label} did not go out for booking ${bookingId}: ${didNotGoOut(outcome)}, and ` +
      `handing it back for a retry could not be confirmed, so it may not be sent at all. If the next ` +
      `tick does not send it, nothing will.`,
  };
  return `${what[disposition]} Reason: ${reason}. Diagnose via the booking-reminder log lines.`;
}

/**
 * The one page for the lost reminders past `REMINDER_PAGES_PER_TICK` for one email in a
 * tick. It names every one of them, so a lead whose reminder was lost in an outage is
 * still findable from Slack, and sends the reader to the log for each one's reason.
 */
export function reminderFoldedAlert(bookingIds: string[], email: NamedEmail): string {
  return (
    `${bookingIds.length} more ${emailLabel(email.name)} emails in the same run did not go out, or may not have, ` +
    `beyond the ${REMINDER_PAGES_PER_TICK} named separately: bookings ${bookingIds.join(", ")}. Why each one failed, and ` +
    `whether anything will try it again, is in its booking-reminder log line.`
  );
}

/**
 * The page key for one booking's lost email: the 24 hour email keeps
 * `booking_reminder_failed:<id>` and the 1 hour email `booking_reminder_failed:<id>:hour`,
 * as they always have, and any other `booking_reminder_failed:<id>:<slug>`. The id is
 * always the segment after the family, so the per booking prune finds every one.
 */
export function reminderFailedAlertKey(bookingId: string, slug: string): string {
  return slug === "day" ? `booking_reminder_failed:${bookingId}` : `booking_reminder_failed:${bookingId}:${slug}`;
}

/**
 * The key one send carries in the failure share's window: the bare id for the 24 hour
 * email and `hour:<id>` for the 1 hour email, as they always have (#4282), and
 * `<slug>:<id>` for any other, so one booking's emails are separate attempts.
 */
export function reminderShareKey(bookingId: string, slug: string): string {
  return slug === "day" ? bookingId : `${slug}:${bookingId}`;
}

/** The condition key for an enabled email whose stored words cannot be rendered. */
export function reminderEmailUnrenderableKey(slug: string): string {
  return `reminder_email_unrenderable:${slug}`;
}

/** The info key said when no reminder email is switched on. */
export const REMINDER_EMAILS_ALL_OFF_KEY = "reminder_emails_all_off";

/** The page for an enabled email the renderer refuses: what is wrong, and what it costs. */
export function reminderEmailUnrenderableAlert(email: Pick<LaneEmail, "name">, problems: TemplateProblem[]): string {
  const shown = problems.slice(0, 3).map(describeTemplateProblem).join(" ");
  const more = problems.length > 3 ? ` And ${problems.length - 3} more.` : "";
  return (
    `The ${emailLabel(email.name)} email is not being sent to anyone: Slate cannot fill in its words. ${shown}${more} ` +
    `Until its subject or body is fixed, every lead due it goes without it.`
  );
}

/** The all clear once an email renders again, or is switched off. */
export function reminderEmailRenderableText(email: Pick<LaneEmail, "name">, why: "renders" | "off"): string {
  return why === "renders"
    ? `The ${emailLabel(email.name)} email renders again, so leads due it are being sent it again.`
    : `The ${emailLabel(email.name)} email is switched off, so nothing is waiting on its words any more.`;
}

/** The info line when no stored reminder email is switched on. */
export function noReminderEmailEnabledText(): string {
  return (
    "No reminder email is switched on, so no lead is being sent a reminder email before their call. " +
    "If that is not intended, switch one back on."
  );
}

/**
 * A fixed input for asking whether an email renders at all. `renderReminder` refuses on
 * the template alone (an unknown or malformed fill-in, an empty field, no timing), never
 * on the booking, so one render per email per tick answers for every booking and the
 * alert is said once per email rather than once per booking per tick.
 */
const RENDER_PROBE: ReminderCopyInput = {
  agentName: "Sam Rivera",
  startsAtIso: "2026-01-01T15:00:00.000Z",
  timezone: "America/New_York",
  manageUrl: "https://slate.trypennie.app/booking/manage/probe",
  nowMs: Date.parse("2026-01-01T14:00:00.000Z"),
  callingNumber: null,
  leadPhone: null,
  onPlaceholder: false,
};

function templateOf(email: LaneEmail): ReminderTemplate {
  return { minutesBefore: email.minutesBefore, subject: email.subject, body: email.body, cardBlock: email.cardBlock };
}

function decisionEmailOf(email: LaneEmail): DecisionEmail {
  return {
    id: email.id,
    minutesBefore: email.minutesBefore,
    lateBooking: email.lateBooking,
    effectiveFromMs: parseStampMs(email.effectiveFromIso),
    placeholderSends: email.placeholderSends,
  };
}

/** The legacy column value this tick read for one of the two original emails. */
function legacySeen(row: DueBooking, slug: LegacySlug): string | null {
  return slug === "day" ? row.reminderSentForIso : row.hourReminderSentForIso;
}

function emptyRun(): ReminderRun {
  return {
    sent: 0,
    failed: 0,
    skipped: 0,
    skippedByReason: {},
    held: 0,
    waiting: 0,
    idle: 0,
    unreadable: 0,
    lost: 0,
    attempted: 0,
    byCode: {},
    retrying: 0,
    retried: {},
    settled: {},
    withCallingNumber: 0,
    callingNumberUnread: false,
    inviteRefreshFailed: 0,
    withPhoto: 0,
    photoUnread: 0,
    withLogo: 0,
    pagesFolded: 0,
    emailsEnabled: 0,
    noneEnabled: false,
    unrenderable: [],
    byEmail: {},
  };
}

const emptyCounts = (): EmailRunCounts => ({
  sent: 0,
  failed: 0,
  retrying: 0,
  attempted: 0,
  held: 0,
  waiting: 0,
  skipped: 0,
  lost: 0,
});

export async function runBookingReminders(deps: ReminderDeps): Promise<ReminderRun> {
  const nowMs = deps.now();
  // THROWS on a failed read, before anything else: no sends, and the heartbeat lapses.
  const stored = await deps.loadEmails();
  const run = emptyRun();
  const enabled = stored.filter((e) => e.enabled);
  run.emailsEnabled = enabled.length;

  // Which enabled emails render at all, judged once per email for the tick. One that
  // does not sends nothing, claims nothing and records nothing, so once its words are
  // fixed the leads still inside its window are sent it; and it pages once, under its
  // own key, never once per booking per tick.
  const unrenderable = new Set<string>();
  const recovered: { slug: string; text: string }[] = [];
  for (const email of stored) {
    if (!email.enabled) {
      recovered.push({ slug: email.slug, text: reminderEmailRenderableText(email, "off") });
      continue;
    }
    const probe = renderReminder(templateOf(email), RENDER_PROBE);
    if (probe.ok) {
      recovered.push({ slug: email.slug, text: reminderEmailRenderableText(email, "renders") });
      continue;
    }
    unrenderable.add(email.id);
    run.unrenderable.push(email.slug);
    deps.warn("reminder email cannot be rendered, so it is not sent", null, new Error("template refused"), {
      email: email.slug,
      problems: probe.problems.map((p) => p.kind).join(","),
    });
    // alert-text-ok: built by `reminderEmailUnrenderableAlert` from the template
    // problems, which name the admin's own fill-ins, never a provider's error.
    // swallow-ok: a failed page must not cost every other email its sends; the email
    // is still refused above and named in `run.unrenderable`, which the caller logs.
    await deps.alertUnrenderable(email.slug, reminderEmailUnrenderableAlert(email, probe.problems)).catch((err) =>
      deps.warn("reminder email unrenderable alert failed", null, err, { email: email.slug }),
    );
  }
  // swallow-ok: an all clear that could not be sent leaves its marker, and the next
  // tick sends it; it must never stop this tick's reminders.
  await deps.resolveRenderable(recovered).catch((err) => deps.warn("reminder email all clear failed", null, err));

  if (enabled.length === 0) {
    run.noneEnabled = true;
    // swallow-ok: the caller logs `noneEnabled` on every tick whatever this does.
    await deps.notifyNoneEnabled(noReminderEmailEnabledText()).catch((err) =>
      deps.warn("no reminder email switched on, and the notice failed", null, err),
    );
    return run;
  }

  // Longest lead first, as the 24 hour email always went before the 1 hour one (#4282):
  // an email sent this tick is then on record before a shorter one judges its gap.
  const judged = enabled
    .filter((e) => !unrenderable.has(e.id))
    .sort((a, b) => b.minutesBefore - a.minutesBefore || a.slug.localeCompare(b.slug));
  for (const e of judged) run.byEmail[e.slug] = emptyCounts();
  if (judged.length === 0) return run;

  const longestMs = Math.min(Math.max(...judged.map((e) => e.minutesBefore * 60_000)), MAX_LEAD_MS);
  const rows = await deps.loadDue(nowMs + longestMs);
  // Every stored email, switched off ones included, so a record of a shorter email that
  // was later switched off still supersedes a longer one (#4305 review).
  const allDecision = stored.map(decisionEmailOf);
  const decisionOf = new Map(judged.map((e) => [e.id, decisionEmailOf(e)]));

  const recordSkip = async (row: DueBooking, email: LaneEmail, reason: ReminderSkipReason) => {
    run.skipped += 1;
    run.skippedByReason[reason] = (run.skippedByReason[reason] ?? 0) + 1;
    run.byEmail[email.slug]!.skipped += 1;
    try {
      await deps.skipSend(row.id, email.id, row.startsAtIso, reason);
    } catch (err) {
      // The next tick judges the same skip and writes it again, so nothing is lost by
      // carrying on; logged so a skip that never lands is visible.
      deps.warn("reminder skip not recorded", row.id, err, { email: email.slug, reason });
    }
  };

  // Judged first, every booking against every email, so the one Salesforce read below
  // asks only about the sends this tick will actually try.
  const sends: { row: DueBooking; email: LaneEmail; rank: number }[] = [];
  for (const row of rows) {
    // Re-judged here rather than trusted from the query, so the rule has ONE owner
    // and a row that was cancelled or moved since the read is not emailed.
    const records = sendRecordsForBooking(row, stored);
    const booking: DecisionBooking = {
      startsAtMs: parseStampMs(row.startsAtIso) ?? NaN,
      createdAtMs: parseStampMs(row.createdAtIso) ?? NaN,
      status: row.status,
      leadEmail: row.attendeeEmail,
      senderEmail: row.agentEmail,
      onPlaceholder: row.onPlaceholder,
    };
    for (const [rank, email] of judged.entries()) {
      const counts = run.byEmail[email.slug]!;
      const d = reminderDecision(booking, decisionOf.get(email.id)!, records, allDecision, nowMs);
      switch (d.action) {
        case "send":
          sends.push({ row, email, rank });
          // On record for the shorter emails judged after it, exactly as a claim would
          // be: they wait out the two hour gap behind it rather than going in the same
          // tick. Nothing is written for it; the claim below is what is stored.
          records.push({ emailId: email.id, sentForMs: booking.startsAtMs, status: "claimed", sentAtMs: null, claimedAtMs: nowMs });
          break;
        case "held":
          // Never claimed, so the owner hand-back can move the booking first and the
          // next tick reads the advisor who will call (#2633).
          run.held += 1;
          counts.held += 1;
          break;
        case "wait":
          run.waiting += 1;
          counts.waiting += 1;
          break;
        case "skip":
          // Permanent, so recorded with its reason: a gap is never silent.
          await recordSkip(row, email, d.reason);
          break;
        case "none":
          if (d.reason === "unreadable") run.unreadable += 1;
          else run.idle += 1;
          break;
      }
    }
  }
  // Email by email, longest first, each in the worklist's order (soonest call first).
  sends.sort((a, b) => a.rank - b.rank);

  // #1334: the number the call will come FROM, read ONCE for the tick. A failed
  // read sends every reminder without a number rather than holding any back: the
  // number helps the lead, and the reminder itself is the promise.
  let callingNumbers = new Map<string, string | null>();
  const leadIds = [
    // A placeholder call never uses its number (#4206), so it is not asked about.
    ...new Set(
      sends
        .map((s) => s.row)
        .filter((r) => !r.onPlaceholder)
        .map((r) => r.leadId)
        .filter((id): id is string => !!id && isLeadId(id)),
    ),
  ];
  if (leadIds.length > 0) {
    // Under the lane's own deadline, so a hung Salesforce cannot hold every claim
    // and send behind it.
    const read = await readWithinDeadline(
      () => deps.readCallingNumbers(leadIds),
      REMINDER_CALLING_NUMBER_DEADLINE_MS,
      (err) => {
        run.callingNumberUnread = true;
        deps.warn("calling numbers unread, reminders sent without one", null, err);
      },
      deps.deadlineTimer,
    );
    if (read) callingNumbers = read;
  }
  // A placeholder call never carries a number (#4206): no card, no calling line, and
  // its invite is not rewritten with one, so it is null here for every use below.
  const callingNumberOf = (row: DueBooking): string | null =>
    !row.onPlaceholder && row.leadId && isLeadId(row.leadId) ? (callingNumbers.get(leadIdKey(row.leadId)) ?? null) : null;

  // The advisor's photo for the card (Dan, 2026-10-01): one lookup for the tick, only
  // for sends that can carry a card.
  const photos = await loadCardPhotos(
    deps,
    run,
    sends.filter((s) => s.email.cardBlock && callingNumberOf(s.row) !== null).map((s) => s.row),
  );

  // The bookings paged by name this tick, and the ones folded past the cap, per email.
  const pagedByName = new Map<string, number>();
  const folded = new Map<string, string[]>();

  for (const { row, email } of sends) {
    const counts = run.byEmail[email.slug]!;
    const to = row.attendeeEmail;
    const from = row.agentEmail;
    // The judge sends only with both; checked again so the types say so.
    if (!to || !from) continue;
    const callingNumber = callingNumberOf(row);

    // Rendered BEFORE the claim, so an email that cannot be rendered is never claimed.
    const rendered = renderReminder(templateOf(email), {
      agentName: row.agentName,
      startsAtIso: row.startsAtIso,
      timezone: row.timezone,
      manageUrl: row.manageUrl,
      // The lane's own clock, the same one the decision was judged against, so
      // "tomorrow" and "is this due" can never disagree about what day it is.
      nowMs,
      callingNumber,
      leadPhone: row.attendeePhone,
      onPlaceholder: row.onPlaceholder,
    });
    if (!rendered.ok) {
      // The tick's probe rendered it, and a refusal depends on the words alone, so
      // this cannot happen; if it ever does it is the same fault, said the same way.
      if (!unrenderable.has(email.id)) {
        unrenderable.add(email.id);
        run.unrenderable.push(email.slug);
        // alert-text-ok: built from the template problems, as above.
        // swallow-ok: as above, a failed page must not cost other leads their sends.
        await deps.alertUnrenderable(email.slug, reminderEmailUnrenderableAlert(email, rendered.problems)).catch((err) =>
          deps.warn("reminder email unrenderable alert failed", null, err, { email: email.slug }),
        );
      }
      continue;
    }

    const outcome = await deps.claimSend(row.id, email.id, row.startsAtIso);
    if (outcome === "taken") {
      // Another tick got there first. Not a fault, and not worth a word.
      run.lost += 1;
      counts.lost += 1;
      continue;
    }
    if (outcome === "gap") {
      // Another email about this start went out inside the gap since the read. Judged
      // again next tick; the database stored nothing.
      run.waiting += 1;
      counts.waiting += 1;
      continue;
    }
    if (outcome === "superseded") {
      // A shorter email about this start was claimed or sent since the read: this one
      // would arrive after it, for good.
      await recordSkip(row, email, "superseded");
      continue;
    }

    // Legacy (until phase 6): the bookings column the old code reads, claimed from the
    // value this tick read. Losing it means the old code claimed this start in the same
    // minute and is sending it, so this one must not: the send record is handed back.
    const legacy = isLegacySlug(email.slug) ? email.slug : null;
    if (legacy) {
      const won = await deps.legacyClaim(row.id, legacy, row.startsAtIso, legacySeen(row, legacy));
      if (!won) {
        run.lost += 1;
        counts.lost += 1;
        try {
          await deps.releaseSend(row.id, email.id, row.startsAtIso);
        } catch (err) {
          deps.warn("reminder send record not handed back after a lost legacy claim", row.id, err, { email: email.slug });
        }
        continue;
      }
    }

    const shareKey = reminderShareKey(row.id, email.slug);
    const advisorPhoto = row.agentId ? (photos.get(row.agentId) ?? null) : null;
    const card = rendered.cardAttached && callingNumber ? callingNumber : null;
    // Counted BEFORE the call, so a send that threw is in the denominator of its
    // own failure share rather than only in the numerator.
    run.attempted += 1;
    counts.attempted += 1;
    try {
      await deps.send({
        // The advisor's own mailbox, so a lead who replies reaches the person they
        // are about to speak to (Dan, 2026-09-15).
        from,
        // The inbox shows the advisor's NAME as the sender, not the bare address
        // (#2985, Dan 2026-10-01). Pennie when there is no real name on record.
        fromName: realAdvisorName(row.agentName) ?? SENDER_NAME_FALLBACK,
        to: [to],
        subject: rendered.subject,
        body: rendered.body,
        // The card goes only with the copy that names it (`cardAttached`), and carries
        // the calling number alone (#1334). It is named Pennie, never the advisor, and
        // carries the advisor's photo, or the Pennie logo when there is none (#2980).
        ...(card
          ? {
              attachments: [
                advisorContactCard({
                  agentEmail: from,
                  agentName: row.agentName,
                  callingNumber: card,
                  photo: advisorPhoto ?? PENNIE_CARD_LOGO,
                }),
              ],
            }
          : {}),
      });
      run.sent += 1;
      counts.sent += 1;
      run.settled[shareKey] = "sent";
      if (card) {
        run.withCallingNumber += 1;
        if (advisorPhoto) run.withPhoto += 1;
        else run.withLogo += 1;
      }
    } catch (err) {
      await settleFailedSend(deps, run, counts, { row, email, legacy, shareKey, err, pagedByName, folded });
      continue;
    }

    // After the send and outside its try, so a failed write can never turn a sent
    // email into a failed one. A record left claimed still holds the gap and blocks a
    // second send; the owed email check sees a claim that never settled.
    try {
      const marked = await deps.markSendSent(row.id, email.id, row.startsAtIso);
      if (!marked) deps.warn("reminder send record not marked sent: it was no longer claimed", row.id, null, { email: email.slug });
    } catch (err) {
      deps.warn("reminder send record not marked sent", row.id, err, { email: email.slug });
    }
    if (legacy === "day") {
      // Left unwritten, the legacy time reads as unknown, which the old 1 hour rule
      // treated as no gap (#4282).
      try {
        await deps.legacyMarkSent(row.id, row.startsAtIso);
      } catch (err) {
        deps.warn("reminder send time not recorded", row.id, err);
      }
    }

    // #1334: the invite carries the number too, so it sits on the lead's phone next
    // to the appointment. AFTER the send, so a calendar fault can never cost the
    // lead the reminder, and only with a number in hand, so an invite is never
    // rewritten to say less than it did. It reads what the invite says NOW and
    // changes only the calling number line, so text this lane did not compose (the
    // reassign explanation, #969) survives. A gone event is not written to, and one
    // that cannot be read is never overwritten blind.
    if (callingNumber && row.gcalEventId) {
      try {
        const current = await deps.readInviteDescription(from, row.gcalEventId);
        if (current !== null) {
          const next = withCallingNumberLine(current, callingNumber);
          if (next !== current) await deps.refreshInvite(from, row.gcalEventId, next);
        }
      } catch (err) {
        run.inviteRefreshFailed += 1;
        deps.warn("invite not refreshed with the calling number", row.id, err);
      }
    }
  }

  for (const email of judged) {
    const ids = folded.get(email.id);
    if (!ids || ids.length === 0) continue;
    run.pagesFolded += ids.length;
    // alert-text-ok: built from booking ids only; each booking's reason is in its own
    // log line, written whether or not it was paged by name.
    // swallow-ok: the same reasoning as a named page: this is the failure path's
    // reporter, and the failures are still counted in `run.failed` and the share.
    await deps.alert(ids[0]!, email.slug, reminderFoldedAlert(ids, email)).catch(() => {});
  }

  return run;
}

/**
 * What a failed send leaves behind: released for a retry when it provably delivered
 * nothing and there is still time, otherwise recorded `failed` with its code and paged.
 */
async function settleFailedSend(
  deps: ReminderDeps,
  run: ReminderRun,
  counts: EmailRunCounts,
  ctx: {
    row: DueBooking;
    email: LaneEmail;
    legacy: LegacySlug | null;
    shareKey: string;
    err: unknown;
    pagedByName: Map<string, number>;
    folded: Map<string, string[]>;
  },
): Promise<void> {
  const { row, email, legacy, shareKey, err } = ctx;
  // Each lead's reminder is independent work, so one bad address must not cost
  // everybody else theirs (L73).
  run.failed += 1;
  counts.failed += 1;
  // Classified here and nowhere later: the raw error stops at this line (#2496).
  const code = classifyReminderSendFailure(err);
  run.byCode[code] = (run.byCode[code] ?? 0) + 1;
  const typed = asEmailSendError(err);
  const outcome = typed?.outcome ?? "unknown";
  const undelivered = outcome === "never_sent" || outcome === "refused";
  const startsAtMs = parseStampMs(row.startsAtIso);
  // Read when the send FAILED, not at the tick's start: a tick that spent minutes on
  // slow mints before this one is that much closer to the call. An unreadable start
  // is never "far enough away".
  const failedAtMs = deps.now();
  const msToStart = startsAtMs === null ? null : startsAtMs - failedAtMs;
  const farEnough = msToStart !== null && msToStart > reminderRetryFloorMs(email);
  // Ids and codes only, never contact data.
  const fields = (
    disposition: ReminderFailureDisposition | "released" | "release_lost",
    release: "released" | "lost" | "threw" | "not_attempted",
  ) => ({
    code,
    outcome,
    stage: typed?.stage ?? null,
    transient: typed?.transient ?? null,
    disposition,
    claim_released: release === "released",
    release,
    minutes_to_start: msToStart === null ? null : Math.round(msToStart / 60_000),
    email: email.slug,
  });
  const page = async (disposition: ReminderFailureDisposition) => {
    const named = ctx.pagedByName.get(email.id) ?? 0;
    // Past the cap, this booking goes into the one folded page after the loop.
    if (named >= REMINDER_PAGES_PER_TICK) {
      ctx.folded.set(email.id, [...(ctx.folded.get(email.id) ?? []), row.id]);
      return;
    }
    ctx.pagedByName.set(email.id, named + 1);
    // alert-text-ok: the reason is `shortErrorReason`'s one short line, never the
    // provider's body, which goes to the log through `warn`.
    const text = reminderFailedAlert(row.id, disposition, shortErrorReason(err), outcome, email);
    // swallow-ok: this IS the failure path's own reporter, so a throw from it has
    // nowhere left to be reported to, and letting it escape would abandon every
    // remaining lead's reminder to report one that already failed. The failure is
    // still in `run.failed`, which the caller logs and the share judges.
    await deps.alert(row.id, email.slug, text).catch(() => {});
  };
  const notReleased = async (releaseErr: unknown) => {
    // The update may have landed with only its reply lost, so the page says the retry
    // could not be CONFIRMED rather than that it will not happen.
    run.settled[shareKey] = "kept";
    deps.warn("reminder claim not released: the release threw", row.id, releaseErr, fields("not_released", "threw"));
    deps.warn("reminder send failed", row.id, err, fields("not_released", "threw"));
    await page("not_released");
  };

  if (typed && undelivered && typed.transient && farEnough) {
    // The send record first, then the legacy column, so the column is put back only
    // once the record no longer holds the claim. Both must land for the retry: either
    // one still claimed settles the email for the next tick's judge.
    let released: boolean;
    try {
      released = await deps.releaseSend(row.id, email.id, row.startsAtIso);
    } catch (releaseErr) {
      await notReleased(releaseErr);
      return;
    }
    if (released && legacy) {
      try {
        released = await deps.legacyRelease(
          row.id,
          legacy,
          row.startsAtIso,
          legacySeen(row, legacy),
          legacy === "day" ? row.reminderSentAtIso : null,
        );
      } catch (releaseErr) {
        await notReleased(releaseErr);
        return;
      }
    }
    if (released) {
      run.retrying += 1;
      counts.retrying += 1;
      run.retried[shareKey] = code;
      deps.warn("reminder send did not go out; claim released, the next tick tries again", row.id, err, fields("released", "released"));
      return;
    }
    // The row no longer holds the claim this tick wrote, which only a deleted booking
    // produces. Nothing to page about, and nothing to retry.
    run.settled[shareKey] = "kept";
    deps.warn("reminder send failed and its claim was not released: the row had changed", row.id, err, fields("release_lost", "lost"));
    return;
  }

  let disposition: ReminderFailureDisposition;
  if (outcome === "unknown") disposition = "unknown";
  else if (typed?.transient) disposition = "too_late";
  // Google answered with a refusal only when there is a status to show for it.
  else if (typed?.status !== null && typed?.status !== undefined) disposition = "refused";
  else disposition = "not_built";
  run.settled[shareKey] = "kept";
  deps.warn("reminder send failed", row.id, err, fields(disposition, "not_attempted"));
  // The claim is kept as a failed record with its code, which is what the status page
  // and the owed email check read; the legacy column stays claimed as it always did.
  try {
    const recorded = await deps.failSend(row.id, email.id, row.startsAtIso, code);
    if (!recorded) deps.warn("reminder failure not recorded: the send record was no longer claimed", row.id, null, { email: email.slug });
  } catch (failErr) {
    deps.warn("reminder failure not recorded", row.id, failErr, { email: email.slug });
  }
  await page(disposition);
}

/**
 * The card photo per advisor id, for the rows that will carry a card. Absent from
 * the map means no photo: none on file, or one that could not be had, which is
 * counted in `run.photoUnread` and logged with its reason. Never throws.
 */
async function loadCardPhotos(
  deps: ReminderDeps,
  run: ReminderRun,
  withCard: DueBooking[],
): Promise<Map<string, CardPhoto>> {
  const photos = new Map<string, CardPhoto>();
  const ids = [...new Set(withCard.map((r) => r.agentId).filter((id): id is string => !!id))];
  if (ids.length === 0) return photos;

  // The same bound as the calling number read: a database read nobody is watching.
  const stored = await readWithinDeadline(
    () => deps.readAdvisorPhotos(ids),
    REMINDER_CALLING_NUMBER_DEADLINE_MS,
    (err) => {
      run.photoUnread += ids.length;
      deps.warn("advisor photos unread, cards sent with the Pennie logo", null, err);
    },
    deps.deadlineTimer,
  );
  if (!stored) return photos;

  for (const id of ids) {
    const row = stored.get(id);
    if (!row) continue;
    const checked = cardPhotoFromStored(row);
    if (checked.ok) {
      photos.set(id, checked.photo);
    } else {
      run.photoUnread += 1;
      deps.warn("advisor photo unusable, card sent with the Pennie logo", null, new Error(checked.reason));
    }
  }
  return photos;
}

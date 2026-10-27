import {
  reminderDue,
  reminderHeld,
  reminderSubject,
  reminderBody,
  hourReminderDue,
  hourReminderSubject,
  hourReminderBody,
  REMINDER_HOLD_FLOOR_MS,
} from "./reminder.ts";
import { classifyReminderSendFailure, type ReminderFailureCode, type ReminderSettlement } from "./reminder-rate.ts";
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

/**
 * How long the lane waits for the tick's one calling number read (#1334). Longer
 * than the 2.5s a waiting lead gets, because nobody is watching this and the read
 * is a token exchange plus a query; far shorter than the five minute cadence and
 * the shared invocation budget, so a hung Salesforce costs every reminder its
 * number, never the reminder itself.
 */
export const REMINDER_CALLING_NUMBER_DEADLINE_MS = 10_000;

/**
 * How much further than `REMINDER_HOLD_FLOOR_MS` a call must be for a failed send
 * to be handed back (2026-10-05 review). The floor is where a reminder stops being
 * worth sending, because it would land after the lead's one hour text; the RETRY is
 * the next tick, one five minute cadence later, so a hand back made right at the
 * floor would be retried inside it. Ten minutes is that cadence plus another, so a
 * next tick that itself spends minutes on slow mints still sends before the hour.
 * The distance is judged on the clock read when the send FAILED, not the tick's
 * start, for the same reason.
 */
export const REMINDER_RETRY_MARGIN_MS = 10 * 60_000;

/**
 * Which reminder email a run of the lane sends (#4282): the 24 hour one (#2359) or the
 * 1 hour one. The route runs the lane once for each, every tick, the day first.
 */
export type ReminderKind = "day" | "hour";

/**
 * The 1 hour email's counterpart to `REMINDER_HOLD_FLOOR_MS` for a retry (#4282): a
 * failed send is handed back only while the call is more than this plus
 * `REMINDER_RETRY_MARGIN_MS` away. Under half an hour out, an email about a call "in
 * about an hour" is mostly noise beside the lead's 15 minute text, so a send that did
 * not go out by then pages rather than trying again.
 */
export const HOUR_REMINDER_RETRY_FLOOR_MS = 30 * 60_000;

/** The words an alert uses for each kind, so a page always says which email it means. */
const KIND_LABEL: Record<ReminderKind, string> = { day: "24 hour", hour: "1 hour" };

/**
 * The reminder lane's orchestration, for both emails: 24 hours before the call
 * (#2359) and 1 hour before it (#4282), one run per kind.
 *
 * Every dependency is injected, so the property that makes this safe (the claim is
 * written BEFORE Gmail is called) is asserted by
 * `scripts/test-booking-reminder-send.ts` rather than assumed. The decision and the
 * copy live in `reminder.ts`; this file owns only the order of effects.
 *
 * ## Assume it runs twice
 *
 * A scheduled job that sends something a real person reads has to be safe against
 * overlap, retry and a crash in the middle. The claim is a CONDITIONAL write, so two
 * overlapping ticks cannot both send: the loser is told it did not claim and stops.
 *
 * The claim comes first, and that choice decides which way a crash between the two
 * is wrong. Claiming first costs a reminder; sending first sends a second copy on the
 * next tick, and an email cannot be taken back.
 *
 * A send that FAILS keeps its claim, with one exception. Releasing it retries, and a
 * send that timed out after Gmail accepted the message is indistinguishable from one
 * that never arrived, so a retry is the only path that can deliver twice. The gap is
 * made visible with an alert instead of silently recovered (L12).
 *
 * The exception is a failure that PROVES nothing was delivered and could pass: the
 * send threw an `EmailSendError` whose outcome is `never_sent` or `refused` and
 * which is `transient` (a token mint that timed out, a 429), while the call is still
 * more than its kind's floor plus `REMINDER_RETRY_MARGIN_MS` away, so the retry itself
 * still lands in time: `REMINDER_HOLD_FLOOR_MS` for the 24 hour email, which must land
 * before the hour, and `HOUR_REMINDER_RETRY_FLOOR_MS` for the 1 hour one. Then the claim is handed back, by a
 * compare and swap as exact as the claim itself, and the next tick sends it
 * (2026-10-05: a mint timeout cost a lead their reminder under the old rule, though
 * the mint runs before Gmail is ever called). Anything less certain, a plain Error
 * included, keeps the claim, so the default stays the direction that cannot send a
 * second copy.
 */

/** The sender name a reminder carries when the advisor has no real name on record (#2985). */
export const SENDER_NAME_FALLBACK = "Pennie";

/**
 * How many lost reminders one tick pages about BY NAME (Dan, 2026-10-05). The page is
 * keyed per booking so one lost reminder cannot silence the next, which means an
 * outage that fails every send would otherwise post a page per lead. Past this many,
 * the rest of the tick's lost reminders are folded into ONE page that lists them all,
 * so nobody unreminded goes unnamed and the wave is still said once by the share.
 */
export const REMINDER_PAGES_PER_TICK = 3;

export interface DueBooking {
  id: string;
  startsAtIso: string;
  /** When the booking was made, which the hand-back hold is measured from (#2633). */
  createdAtIso: string;
  reminderSentForIso: string | null;
  /** When the 24 hour email was sent (#4282), or null: emails before #4282 carry none. */
  reminderSentAtIso: string | null;
  /** The start the 1 hour email has gone out about (#4282), or null for none. */
  hourReminderSentForIso: string | null;
  status: string;
  /** Null when the lead gave a phone and no address, which is legitimate. */
  attendeeEmail: string | null;
  /** The advisor's mailbox, which is also the sender. */
  agentEmail: string;
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
   * #4206): sent from the placeholder seat with its own copy, no number, no card and
   * no calling number written into the invite (Dan, 2026-10-26).
   */
  onPlaceholder: boolean;
}

export interface ReminderDeps {
  now(): number;
  /**
   * Bookings that MIGHT be due. The query is a filter, never the judgement: a row
   * that stopped being due between the read and the loop is re-checked below, so a
   * SQL WHERE clause cannot send an email on its own (L166).
   */
  loadDue(): Promise<DueBooking[]>;
  /**
   * Record that this booking's CURRENT start has been reminded about, and report
   * whether this caller is the one that claimed it. A conditional write, so an
   * overlapping tick gets false and sends nothing.
   */
  claim(id: string, startsAtIso: string): Promise<boolean>;
  /**
   * Hand a claim back after a send that provably delivered nothing: set the
   * reminder record back to `restoreTo` (what this tick READ) only where the row
   * still holds `claimedForIso`, and report whether a row changed. A conditional
   * write like the claim, so it can only undo this tick's own claim.
   */
  release(id: string, claimedForIso: string, restoreTo: string | null): Promise<boolean>;
  send(msg: MimeMessage): Promise<string>;
  /** Fail loud: a reminder that did not go out is not allowed to be silent. Keyed
   *  by booking, so one booking's page cannot silence another's. */
  alert(bookingId: string, text: string): Promise<void>;
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

export interface ReminderRun {
  sent: number;
  failed: number;
  /** Due, and not sendable: no address to send to. Counted, never silent. */
  skipped: number;
  /**
   * Due, and HELD because the booking is too young for the owner hand-back to have
   * landed (#2633). Not sent, not failed, not attempted and not claimed: it is owed
   * a reminder on a later tick, and it is counted so the wait is visible.
   */
  held: number;
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
   * stored, because the raw message must not travel any further than this: a map
   * keyed on one would hold a key per wording (L131).
   */
  byCode: Record<string, number>;
  /**
   * Failed sends whose claim was RELEASED so the next tick tries again: nothing
   * reached Gmail and the call is still far enough away for the retry to land in time,
   * which depends on the kind (`REMINDER_HOLD_FLOOR_MS` or `HOUR_REMINDER_RETRY_FLOOR_MS`,
   * plus `REMINDER_RETRY_MARGIN_MS`). Inside `failed`, and never
   * paged, since the lead is still going to be reminded.
   */
  retrying: number;
  /** The released bookings by id, with the code each failed with, so the failure
   *  share can count one booking once however many ticks retry it. */
  retried: Record<string, ReminderFailureCode>;
  /**
   * Every other booking this tick attempted, by id: `sent`, or `kept` when it failed
   * and kept its claim. With `retried` it covers every attempt, and it is what lets
   * the share stop counting a booking as retried once it has gone out or been given
   * up (`judgeReminderWindow`).
   */
  settled: Record<string, ReminderSettlement>;
  /** Reminders sent naming the calling number, with the advisor's card (#1334). */
  withCallingNumber: number;
  /**
   * The tick's calling number read FAILED, so every reminder went without one. Not a
   * page (no reminder was lost), but said out loud, because "no lead had a number"
   * and "Salesforce could not be read" are otherwise the same silence (L98).
   */
  callingNumberUnread: boolean;
  /** Invites the calling number could not be written into, after the send. */
  inviteRefreshFailed: number;
  /** Reminders sent with the advisor's photo on the card (Dan, 2026-10-01). */
  withPhoto: number;
  /**
   * Advisors whose photo was wanted for a card and could not be had: the lookup
   * failed, or the fetch was refused, timed out, too large or not an image. Their
   * cards carried the Pennie logo instead. An advisor with no photo on file is NOT
   * counted, since that is a known answer rather than a failed read.
   */
  photoUnread: number;
  /**
   * Reminders sent with the Pennie logo on the card in place of a photo (#2980): no
   * advisor id, no photo on file, or one that could not be had. With `withPhoto`
   * it covers every card, so the two always sum to `withCallingNumber`.
   */
  withLogo: number;
  /**
   * Lost reminders this tick that were past `REMINDER_PAGES_PER_TICK` and so went
   * into the one folded page rather than a page of their own.
   */
  pagesFolded: number;
}

/**
 * Why a failed reminder pages, which decides what the page can truthfully say.
 *
 *   too_late: it did not go out (nothing reached Gmail, or Gmail asked for it to
 *     be sent later), and the call is too close for the next tick to resend it in
 *     time: before the lead's one hour text for the 24 hour email, and past
 *     `HOUR_REMINDER_RETRY_FLOOR_MS` for the 1 hour one.
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
 * It names the booking and says what the lead did NOT get and whether anything will
 * change that, which differs by disposition: a page saying "will not be retried" about
 * a send that is in fact being retried, or "did not go out" about one that may have,
 * is a page that teaches its reader to stop trusting it. The reason is the SHORT
 * one (`shortErrorReason`), never the provider's body: that belongs in the log, and
 * an alert is read on a phone (the `// alert-text-ok:` rule).
 */
export function reminderFailedAlert(
  bookingId: string,
  disposition: ReminderFailureDisposition,
  reason: string,
  /** The send's outcome, which decides what too_late and not_released say about
   *  Gmail. Ignored by the dispositions whose sentence does not depend on it. */
  outcome: EmailSendOutcome,
  /** Which email it was (#4282), so the page names the one the lead did not get. */
  kind: ReminderKind = "day",
): string {
  const label = KIND_LABEL[kind];
  // The 24 hour email must land before the lead's one hour text; the 1 hour email's
  // own floor is simply the call being close.
  const tooLateWhy = kind === "day" ? "before the lead's one hour text reminder" : "while it is still useful";
  const what: Record<ReminderFailureDisposition, string> = {
    too_late:
      `A ${label} reminder email did not go out for booking ${bookingId}: ${didNotGoOut(outcome)}, ` +
      `and it is too close to the call to try again ${tooLateWhy}, so it ` +
      `is not resent.`,
    refused:
      `A ${label} reminder email did not go out for booking ${bookingId}: Google refused it, and it ` +
      `will not be resent until that is repaired, so that lead has not been reminded about their call.`,
    not_built:
      `A ${label} reminder email did not go out for booking ${bookingId}: Slate could not build the ` +
      `message, so nothing reached Google, and it will not be resent until that is repaired.`,
    unknown:
      `A ${label} reminder email for booking ${bookingId} may not have gone out: the send failed in a ` +
      `way that cannot say whether Gmail accepted it, and it is not resent, because that could ` +
      `deliver a second copy.`,
    not_released:
      `A ${label} reminder email did not go out for booking ${bookingId}: ${didNotGoOut(outcome)}, and ` +
      `handing it back for a retry could not be confirmed, so it may not be sent at all. If the next ` +
      `tick does not send it, nothing will.`,
  };
  return `${what[disposition]} Reason: ${reason}. Diagnose via the booking-reminder log lines.`;
}

export async function runBookingReminders(deps: ReminderDeps, kind: ReminderKind = "day"): Promise<ReminderRun> {
  const nowMs = deps.now();
  const rows = await deps.loadDue();
  const run: ReminderRun = {
    sent: 0,
    failed: 0,
    skipped: 0,
    held: 0,
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
  };
  // The bookings paged by name this tick, and the ones folded past the cap.
  let pagedByName = 0;
  const folded: string[] = [];

  // Judged first, so the one Salesforce read below asks only about the bookings
  // this tick will actually try to send.
  const sendable: DueBooking[] = [];
  for (const row of rows) {
    // Re-judged here rather than trusted from the query, so the rule has ONE owner
    // and a row that was cancelled or moved since the read is not emailed.
    const due = kind === "day" ? reminderDue(daySubject(row), nowMs) : hourReminderDue(hourSubject(row), nowMs);
    if (!due) continue;

    // Held BEFORE anything else is decided, and never claimed, so the owner hand-back
    // can move the booking first and the next tick reads the advisor who will call
    // (#2633). The row is re-read every tick, so nothing is carried across the wait.
    // The 1 hour email is never held: it goes only to a call booked at least an hour
    // ahead, long after the ten minute hand-back has landed.
    const held = kind === "day" && reminderHeld(
      {
        createdAtMs: parseStampMs(row.createdAtIso) ?? NaN,
        startsAtMs: parseStampMs(row.startsAtIso) ?? NaN,
      },
      nowMs,
    );
    if (held) {
      run.held += 1;
      continue;
    }

    // No address is not a fault and must not page: a booking can legitimately carry
    // a phone and nothing else. It is COUNTED, because a silent skip is how a gap
    // hides, and it is not claimed, since claiming would mark the row reminded for
    // a message that never existed.
    if (!row.attendeeEmail) {
      run.skipped += 1;
      continue;
    }
    sendable.push(row);
  }

  // #1334: the number the call will come FROM, read ONCE for the tick. A failed
  // read sends every reminder without a number rather than holding any back: the
  // number helps the lead, and the reminder itself is the promise.
  let callingNumbers = new Map<string, string | null>();
  const leadIds = [
    // A placeholder call never uses its number (#4206), so it is not asked about.
    ...new Set(
      sendable
        .filter((r) => !r.onPlaceholder)
        .map((r) => r.leadId)
        .filter((id): id is string => !!id && isLeadId(id)),
    ),
  ];
  if (leadIds.length > 0) {
    // Under the lane's own deadline, so a hung Salesforce cannot hold every claim
    // and send behind it. A refusal and a timeout are the same outcome here, each
    // logged with its own reason; the flag is what tells "nobody had a number"
    // apart from "Salesforce could not be read" in the run the caller logs.
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

  // The advisor's photo for the card (Dan, 2026-10-01): one lookup for the tick and
  // at most ONE fetch per advisor, however many of their leads are reminded, only
  // for reminders that carry a card. The fetches run together under their own
  // deadline, so the most the photos add to a tick is one deadline, and every way of
  // not having one sends the card with the bundled Pennie logo instead (#2980).
  const photos = await loadCardPhotos(
    deps,
    run,
    sendable.filter((r) => callingNumberOf(r) !== null),
  );

  for (const row of sendable) {
    if (!row.attendeeEmail) continue;
    const callingNumber = callingNumberOf(row);
    const advisorPhoto = row.agentId ? (photos.get(row.agentId) ?? null) : null;

    if (!(await deps.claim(row.id, row.startsAtIso))) {
      // Another tick got there first. Not a fault, and not worth a word.
      run.lost += 1;
      continue;
    }

    const copy = {
      agentName: row.agentName,
      startsAtIso: row.startsAtIso,
      timezone: row.timezone,
      manageUrl: row.manageUrl,
      // The lane's own clock, the same one the due check above was judged against,
      // so "tomorrow" and "is this due" can never disagree about what day it is.
      nowMs,
      callingNumber,
      onPlaceholder: row.onPlaceholder,
    };
    // Counted BEFORE the call, so a send that threw is in the denominator of its
    // own failure share rather than only in the numerator.
    run.attempted += 1;
    try {
      await deps.send({
        // The advisor's own mailbox, so a lead who replies reaches the person they
        // are about to speak to (Dan, 2026-09-15).
        from: row.agentEmail,
        // The inbox shows the advisor's NAME as the sender, not the bare address
        // (#2985, Dan 2026-10-01). Pennie when there is no real name on record.
        fromName: realAdvisorName(row.agentName) ?? SENDER_NAME_FALLBACK,
        to: [row.attendeeEmail],
        subject: kind === "day" ? reminderSubject(copy) : hourReminderSubject(copy),
        body: kind === "day" ? reminderBody(copy) : hourReminderBody(copy),
        // The card goes only with the copy that mentions it, and carries the
        // calling number alone, never the texting line (#1334). It is named Pennie,
        // never the advisor, and carries the advisor's photo, or the Pennie logo when
        // there is none (#2980), so a saved contact always has a picture.
        ...(callingNumber
          ? {
              attachments: [
                advisorContactCard({
                  agentEmail: row.agentEmail,
                  agentName: row.agentName,
                  callingNumber,
                  photo: advisorPhoto ?? PENNIE_CARD_LOGO,
                }),
              ],
            }
          : {}),
      });
      run.sent += 1;
      run.settled[row.id] = "sent";
      if (callingNumber) {
        run.withCallingNumber += 1;
        if (advisorPhoto) run.withPhoto += 1;
        else run.withLogo += 1;
      }
    } catch (err) {
      // Each lead's reminder is independent work, so one bad address must not cost
      // everybody else theirs (L73).
      run.failed += 1;
      // Classified here and nowhere later: the raw error stops at this line, and
      // what travels on is one of the `ReminderFailureCode`s the window can be keyed
      // by (#2496).
      const code = classifyReminderSendFailure(err);
      run.byCode[code] = (run.byCode[code] ?? 0) + 1;
      const typed = asEmailSendError(err);
      const outcome = typed?.outcome ?? "unknown";
      const undelivered = outcome === "never_sent" || outcome === "refused";
      const startsAtMs = parseStampMs(row.startsAtIso);
      // Read when the send FAILED, not at the tick's start: a tick that spent minutes
      // on slow mints before this one is that much closer to the call. An unreadable
      // start is never "far enough away".
      const failedAtMs = deps.now();
      const msToStart = startsAtMs === null ? null : startsAtMs - failedAtMs;
      const retryFloorMs = kind === "day" ? REMINDER_HOLD_FLOOR_MS : HOUR_REMINDER_RETRY_FLOOR_MS;
      const farEnough = msToStart !== null && msToStart > retryFloorMs + REMINDER_RETRY_MARGIN_MS;
      // Ids and codes only, never contact data: enough for whoever reads the log to
      // tell which page went out and why it was or was not retried, without
      // re-deriving the floor arithmetic from the booking row.
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
        kind,
      });
      const page = async (disposition: ReminderFailureDisposition) => {
        // Past the cap, this booking goes into the one folded page after the loop.
        if (pagedByName >= REMINDER_PAGES_PER_TICK) {
          folded.push(row.id);
          return;
        }
        pagedByName += 1;
        // alert-text-ok: the reason is `shortErrorReason`'s one short line, never the
        // provider's body, which goes to the log through `warn`.
        // swallow-ok: this IS the failure path's own reporter, so a throw from it has
        // nowhere left to be reported to, and letting it escape would abandon every
        // remaining lead's reminder to report one that already failed. The send
        // failure is still returned in `run.failed`, which the caller logs and the
        // lane's heartbeat is judged against, so the tick is never silent about it.
        await deps.alert(row.id, reminderFailedAlert(row.id, disposition, shortErrorReason(err), outcome, kind)).catch(() => {});
      };

      if (typed && undelivered && typed.transient && farEnough) {
        let released: boolean;
        try {
          // Back to the record of THIS kind that the tick read.
          const restoreTo = kind === "day" ? row.reminderSentForIso : row.hourReminderSentForIso;
          released = await deps.release(row.id, row.startsAtIso, restoreTo);
        } catch (releaseErr) {
          // The update may have landed with only its reply lost, so the page says
          // the retry could not be CONFIRMED rather than that it will not happen.
          run.settled[row.id] = "kept";
          deps.warn("reminder claim not released: the release threw", row.id, releaseErr, fields("not_released", "threw"));
          deps.warn("reminder send failed", row.id, err, fields("not_released", "threw"));
          await page("not_released");
          continue;
        }
        if (released) {
          run.retrying += 1;
          run.retried[row.id] = code;
          deps.warn("reminder send did not go out; claim released, the next tick tries again", row.id, err, fields("released", "released"));
          continue;
        }
        // The row no longer holds the claim this tick wrote, which only a deleted
        // booking produces (nothing else writes the record). Nothing to page about,
        // and nothing to retry.
        run.settled[row.id] = "kept";
        deps.warn("reminder send failed and its claim was not released: the row had changed", row.id, err, fields("release_lost", "lost"));
        continue;
      }

      let disposition: ReminderFailureDisposition;
      if (outcome === "unknown") disposition = "unknown";
      else if (typed?.transient) disposition = "too_late";
      // Google answered with a refusal only when there is a status to show for it.
      else if (typed?.status !== null && typed?.status !== undefined) disposition = "refused";
      else disposition = "not_built";
      run.settled[row.id] = "kept";
      deps.warn("reminder send failed", row.id, err, fields(disposition, "not_attempted"));
      await page(disposition);
      continue;
    }

    // #1334: the invite carries the number too, so it sits on the lead's phone next
    // to the appointment. AFTER the send, so a calendar fault can never cost the
    // lead the reminder, and only with a number in hand, so an invite is never
    // rewritten to say less than it did. Idempotent: a second write of the same
    // description changes nothing, so a retried tick is harmless.
    // It reads what the invite says NOW and changes only the calling number line, so
    // text this lane did not compose (the reassign explanation, #969, on the invite
    // the owner hand-back creates) survives as it was. A gone event is not written
    // to, and one that cannot be read is never overwritten blind.
    if (callingNumber && row.gcalEventId) {
      try {
        const current = await deps.readInviteDescription(row.agentEmail, row.gcalEventId);
        if (current !== null) {
          const next = withCallingNumberLine(current, callingNumber);
          if (next !== current) await deps.refreshInvite(row.agentEmail, row.gcalEventId, next);
        }
      } catch (err) {
        run.inviteRefreshFailed += 1;
        deps.warn("invite not refreshed with the calling number", row.id, err);
      }
    }
  }

  if (folded.length > 0) {
    run.pagesFolded = folded.length;
    // alert-text-ok: built from booking ids only; each booking's reason is in its own
    // log line, written above whether or not it was paged by name.
    // swallow-ok: the same reasoning as `page`: this is the failure path's reporter,
    // and the failures are still counted in `run.failed` and the share.
    await deps.alert(folded[0]!, reminderFoldedAlert(folded, kind)).catch(() => {});
  }

  return run;
}

/** A stamp the lane read, or null when it holds none; unreadable is NaN, never null. */
function stampOrNull(iso: string | null | undefined): number | null {
  return iso ? (parseStampMs(iso) ?? NaN) : null;
}

function daySubject(row: DueBooking) {
  return {
    startsAtMs: parseStampMs(row.startsAtIso) ?? NaN,
    reminderSentForMs: stampOrNull(row.reminderSentForIso),
    hourReminderSentForMs: stampOrNull(row.hourReminderSentForIso),
    status: row.status,
  };
}

function hourSubject(row: DueBooking) {
  return {
    startsAtMs: parseStampMs(row.startsAtIso) ?? NaN,
    createdAtMs: parseStampMs(row.createdAtIso) ?? NaN,
    status: row.status,
    hourReminderSentForMs: stampOrNull(row.hourReminderSentForIso),
    dayReminderSentForMs: stampOrNull(row.reminderSentForIso),
    dayReminderSentAtMs: stampOrNull(row.reminderSentAtIso),
  };
}

/**
 * The one page for the lost reminders past `REMINDER_PAGES_PER_TICK` in a tick. It
 * names every one of them, so a lead whose reminder was lost in an outage is still
 * findable from Slack, and sends the reader to the log for each one's reason rather
 * than repeating five reasons that are usually the same one.
 */
export function reminderFoldedAlert(bookingIds: string[], kind: ReminderKind = "day"): string {
  return (
    `${bookingIds.length} more ${KIND_LABEL[kind]} reminder emails in the same run did not go out, or may not have, ` +
    `beyond the ${REMINDER_PAGES_PER_TICK} named separately: bookings ${bookingIds.join(", ")}. Why each one failed, and ` +
    `whether anything will try it again, is in its booking-reminder log line.`
  );
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

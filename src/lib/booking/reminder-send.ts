import { reminderDue, reminderHeld, reminderSubject, reminderBody } from "./reminder.ts";
import { classifyReminderSendFailure } from "./reminder-rate.ts";
import type { MimeMessage } from "@/lib/notify/email-mime";
import { parseStampMs } from "@/lib/date/stamp";
import { isLeadId, leadIdKey } from "@/lib/salesforce/lead-xbc";
import { advisorContactCard } from "./advisor-contact-card.ts";
import { eventDescription } from "./core.ts";

/**
 * The 24 hour reminder lane's orchestration (#2359).
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
 * A send that FAILS keeps its claim. Releasing it would retry, and a send that timed
 * out after Gmail accepted the message is indistinguishable from one that never
 * arrived, so a retry is the only path that can deliver twice. The gap is made
 * visible with an alert instead of silently recovered (L12).
 */

export interface DueBooking {
  id: string;
  startsAtIso: string;
  /** When the booking was made, which the hand-back hold is measured from (#2633). */
  createdAtIso: string;
  reminderSentForIso: string | null;
  status: string;
  /** Null when the lead gave a phone and no address, which is legitimate. */
  attendeeEmail: string | null;
  /** The advisor's mailbox, which is also the sender. */
  agentEmail: string;
  agentName: string;
  /** The LEAD's timezone, so the time reads as they chose it. */
  timezone: string;
  manageUrl: string;
  /** The lead's Salesforce id (`bookingLeadId`), or null for a booking with none. */
  leadId: string | null;
  /** The invite on the advisor's calendar, which the calling number is written into. */
  gcalEventId: string | null;
  /** The lead's own number, which the invite's first line carries for the advisor. */
  attendeePhone: string | null;
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
  send(msg: MimeMessage): Promise<string>;
  /** Fail loud: a reminder that did not go out is not allowed to be silent. */
  alert(text: string): Promise<void>;
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
  /** A degraded step that is not a lost reminder: logged with its reason, never paged. */
  warn(msg: string, bookingId: string | null, err: unknown): void;
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
}

/**
 * The alert for a reminder that did not go out.
 *
 * It names the booking and says what the lead did NOT get, and deliberately does not
 * paste the provider's error: that belongs in the log, and an alert is read on a
 * phone (the `// alert-text-ok:` rule).
 */
export function reminderFailedAlert(bookingId: string, reason: string): string {
  return (
    `A 24 hour reminder email did not go out for booking ${bookingId}, so that lead has not been ` +
    `reminded about their call and will not be: the send is not retried, because retrying can ` +
    `deliver a second copy. Reason: ${reason}. Diagnose via the booking-reminder log lines.`
  );
}

export async function runBookingReminders(deps: ReminderDeps): Promise<ReminderRun> {
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
    withCallingNumber: 0,
    callingNumberUnread: false,
    inviteRefreshFailed: 0,
  };

  // Judged first, so the one Salesforce read below asks only about the bookings
  // this tick will actually try to send.
  const sendable: DueBooking[] = [];
  for (const row of rows) {
    // Re-judged here rather than trusted from the query, so the rule has ONE owner
    // and a row that was cancelled or moved since the read is not emailed.
    const due = reminderDue(
      {
        startsAtMs: parseStampMs(row.startsAtIso) ?? NaN,
        reminderSentForMs: row.reminderSentForIso ? (parseStampMs(row.reminderSentForIso) ?? NaN) : null,
        status: row.status,
      },
      nowMs,
    );
    if (!due) continue;

    // Held BEFORE anything else is decided, and never claimed, so the owner hand-back
    // can move the booking first and the next tick reads the advisor who will call
    // (#2633). The row is re-read every tick, so nothing is carried across the wait.
    const held = reminderHeld(
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
    ...new Set(sendable.map((r) => r.leadId).filter((id): id is string => !!id && isLeadId(id))),
  ];
  if (leadIds.length > 0) {
    try {
      callingNumbers = await deps.readCallingNumbers(leadIds);
    } catch (err) {
      // This flag is what tells "nobody had a number" apart from "Salesforce could
      // not be read" in the run the caller logs; the reason goes to the log.
      run.callingNumberUnread = true;
      deps.warn("calling numbers unread, reminders sent without one", null, err);
    }
  }

  for (const row of sendable) {
    if (!row.attendeeEmail) continue;
    const callingNumber =
      row.leadId && isLeadId(row.leadId) ? (callingNumbers.get(leadIdKey(row.leadId)) ?? null) : null;

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
    };
    // Counted BEFORE the call, so a send that threw is in the denominator of its
    // own failure share rather than only in the numerator.
    run.attempted += 1;
    try {
      await deps.send({
        // The advisor's own mailbox, so a lead who replies reaches the person they
        // are about to speak to (Dan, 2026-09-15).
        from: row.agentEmail,
        to: [row.attendeeEmail],
        subject: reminderSubject(copy),
        body: reminderBody(copy),
        // The card goes only with the copy that mentions it, and carries the
        // calling number alone, never the texting line (#1334).
        ...(callingNumber
          ? {
              attachments: [
                advisorContactCard({ agentName: row.agentName, agentEmail: row.agentEmail, callingNumber }),
              ],
            }
          : {}),
      });
      run.sent += 1;
      if (callingNumber) run.withCallingNumber += 1;
    } catch (err) {
      // Each lead's reminder is independent work, so one bad address must not cost
      // everybody else theirs (L73).
      run.failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      // Classified here and nowhere later: the raw message stops at this line, and
      // what travels on is one of six codes the window can be keyed by (#2496).
      const code = classifyReminderSendFailure(reason);
      run.byCode[code] = (run.byCode[code] ?? 0) + 1;
      // alert-text-ok: the reason is shortened by the caller's own formatter before
      // it reaches Slack; this builder receives an already short string.
      // swallow-ok: this IS the failure path's own reporter, so a throw from it has
      // nowhere left to be reported to, and letting it escape would abandon every
      // remaining lead's reminder to report one that already failed. The send
      // failure is still returned in `run.failed`, which the caller logs and the
      // lane's heartbeat is judged against, so the tick is never silent about it.
      await deps.alert(reminderFailedAlert(row.id, reason)).catch(() => {});
      continue;
    }

    // #1334: the invite carries the number too, so it sits on the lead's phone next
    // to the appointment. AFTER the send, so a calendar fault can never cost the
    // lead the reminder, and only with a number in hand, so an invite is never
    // rewritten to say less than it did. Idempotent: a second write of the same
    // description changes nothing, so a retried tick is harmless.
    if (callingNumber && row.gcalEventId) {
      try {
        await deps.refreshInvite(
          row.agentEmail,
          row.gcalEventId,
          // The lane excludes test buckets, so a real booking's invite: no test line.
          eventDescription(row.attendeePhone, row.manageUrl, { isTest: false, callingNumber }),
        );
      } catch (err) {
        run.inviteRefreshFailed += 1;
        deps.warn("invite not refreshed with the calling number", row.id, err);
      }
    }
  }

  return run;
}

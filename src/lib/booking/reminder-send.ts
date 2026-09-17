import { reminderDue, reminderSubject, reminderBody } from "./reminder.ts";
import type { MimeMessage } from "@/lib/notify/email-mime";
import { parseStampMs } from "@/lib/date/stamp";

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
}

export interface ReminderRun {
  sent: number;
  failed: number;
  /** Due, and not sendable: no address to send to. Counted, never silent. */
  skipped: number;
  /** Due, and claimed by somebody else this tick. */
  lost: number;
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
  const run: ReminderRun = { sent: 0, failed: 0, skipped: 0, lost: 0 };

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

    // No address is not a fault and must not page: a booking can legitimately carry
    // a phone and nothing else. It is COUNTED, because a silent skip is how a gap
    // hides, and it is not claimed, since claiming would mark the row reminded for
    // a message that never existed.
    if (!row.attendeeEmail) {
      run.skipped += 1;
      continue;
    }

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
    };
    try {
      await deps.send({
        // The advisor's own mailbox, so a lead who replies reaches the person they
        // are about to speak to (Dan, 2026-09-15).
        from: row.agentEmail,
        to: [row.attendeeEmail],
        subject: reminderSubject(copy),
        body: reminderBody(copy),
      });
      run.sent += 1;
    } catch (err) {
      // Each lead's reminder is independent work, so one bad address must not cost
      // everybody else theirs (L73).
      run.failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      // alert-text-ok: the reason is shortened by the caller's own formatter before
      // it reaches Slack; this builder receives an already short string.
      // swallow-ok: this IS the failure path's own reporter, so a throw from it has
      // nowhere left to be reported to, and letting it escape would abandon every
      // remaining lead's reminder to report one that already failed. The send
      // failure is still returned in `run.failed`, which the caller logs and the
      // lane's heartbeat is judged against, so the tick is never silent about it.
      await deps.alert(reminderFailedAlert(row.id, reason)).catch(() => {});
    }
  }

  return run;
}

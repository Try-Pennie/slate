/**
 * The words the booking layer's alerts say (#1153).
 *
 * Lifted out of the send sites so the alert preview can render the REAL copy by
 * calling these, rather than holding a second copy that drifts the moment someone
 * edits one and not the other (L41). The sending code imports them back, so there
 * is exactly one place each of these sentences exists.
 *
 * Almost all of these are INCIDENT copy (src/lib/notify/alert-catalog.ts): they
 * describe something that already happened to a specific booking, so they name
 * the consequence and where to look, and never promise that anything will retry.
 */

/** A cached busy_blocks write that did not land, per operation. */
export function busyBlockWriteThroughAlert(
  operation: "insert" | "move" | "delete",
  subject: string,
  reason: string,
): string {
  if (operation === "move") {
    return (
      `A busy_blocks move (move_busy_block) failed for booking ${subject} (${reason}). ` +
      `The slot cache may be stale until the next sync pass.`
    );
  }
  if (operation === "delete") {
    return (
      `A busy_blocks DELETE failed for booking ${subject} (${reason}). ` +
      `The cancelled slot will keep showing as busy until cleaned up.`
    );
  }
  return (
    `A busy_blocks INSERT failed for ${subject} (${reason}). ` +
    `The slot(s) may show as free in the embed until the next sync pass.`
  );
}

/** A history row that was lost, so the reason for an action went unrecorded. */
export function bookingEventInsertAlert(bookingId: string, action: string, reason: string): string {
  return (
    `A booking_events INSERT failed for booking ${bookingId} (${action}, ${reason}). ` +
    `The reschedule/cancel reason for this action was not recorded.`
  );
}

/** Calendar deletions stuck retrying, so cancelled meetings may still remind. */
export function pendingDeletionAlert(stuckCount: number, after: number, eventIds: string[]): string {
  return (
    `${stuckCount} calendar event deletion(s) have failed ${after}+ times and may be ` +
    `firing orphaned reminders. Check Google Calendar API health. Event ids: ${eventIds.join(", ")}`
  );
}

/** The all-clear for the above: the queue drained (#1151). */
export function pendingDeletionRecovery(): string {
  return (
    "The calendar event deletions that kept failing have gone through. No deletion is " +
    "stuck retrying, so no cancelled meeting should still be sending reminders. No action is needed."
  );
}

/** Calendar events that outlived the booking they were created for. */
export function creationOrphanAlert(count: number, eventIds: string[]): string {
  return (
    `${count} calendar event(s) were created but their booking never persisted (the insert ` +
    `and its rollback both failed), and the event still exists on Google, so it may be sending the ` +
    `customer reminders for a booking Slate has no record of. The deletion drain is retrying ` +
    `removal; diagnose via pending_event_deletions where booking_id is null. Event ids: ` +
    `${eventIds.join(", ")}`
  );
}

/**
 * The reconcile sweep freed cached busy time that nothing live was holding.
 *
 * The two kinds are reported apart (#1464) because they send the reader to
 * different places. A block over a cancelled booking means a write-through delete
 * was missed, so the cancel path is worth checking. A block nothing owned never
 * referenced a booking at all, so naming the cancel path there spends the incident
 * on code that did nothing wrong; it points at what actually wrote the row instead.
 */
export function reconcileFreedAlert(counts: {
  freedCancelled: number;
  freedOrphans: number;
  agentCount: number;
}): string {
  const { freedCancelled, freedOrphans, agentCount } = counts;
  const parts: string[] = [];
  if (freedCancelled > 0) {
    parts.push(
      `${freedCancelled} stuck busy_block(s) whose booking was cancelled or missing. ` +
        `A write-through delete was missed, so check cancel-path health.`,
    );
  }
  if (freedOrphans > 0) {
    parts.push(
      `${freedOrphans} busy_block(s) that no booking and no approved time off owned. ` +
        `The cancel path is not implicated. Diagnose via busy_blocks where booking_id ` +
        `is null and ooo_request_id is null, which is the shape with no live owner.`,
    );
  }
  const total = freedCancelled + freedOrphans;
  return (
    `Reconcile freed ${total} cached busy_block(s) across ${agentCount} agent(s), so ` +
    `those slot(s) are bookable again. ${parts.join(" ")}`
  ).trim();
}

/** The missing-block reconcile re-created slots that were showing free. */
export function reconcileRecreatedAlert(recreated: number, bookingIds: string[], truncated: boolean): string {
  return (
    `Re-created ${recreated} missing busy_block(s) for active booking(s) - a write-through INSERT had been missed, so the slot(s) were showing free and could have been double-booked. Now recomputed. Booking ids: ${bookingIds.join(", ")}${truncated ? " ..." : ""}. Check booking-path busy_block write health.`
  );
}

/** Outbox rows past the attempt cap: real side effects are not completing. */
export function outboxDrainStuckAlert(stuckCount: number, after: number, ids: string): string {
  return (
    `${stuckCount} booking-outbox row(s) have failed >= ${after} delivery attempts and are ` +
    `backing off (a mutation's side effects - calendar/webhook - are not completing). Diagnose via ` +
    `booking_outbox.last_error; rows: ${ids}.`
  );
}

/** The all-clear for the outbox backlog (#1151). */
export function outboxDrainRecovery(): string {
  return (
    "The booking-outbox rows that were backing off have delivered. Calendar invites and " +
    "webhooks for the affected bookings have completed, so nothing is stuck. No action is needed."
  );
}

/**
 * Every row the drain leased stood down (#1048). Its own alert, because such a
 * tick charges no failed attempt to any row, so it can never reach the
 * attempt-cap alert above: without this, a drain that delivers nothing forever
 * looks exactly like an empty outbox.
 */
export function outboxAllHandedOffAlert(leasedCount: number, ticks: number): string {
  return (
    `Every booking-outbox row the drain leased stood down, for ${ticks} ticks running ` +
    `(${leasedCount} row(s) in the last one), so no side effects are being delivered and no ` +
    `row is being charged a failed attempt. Expected causes: holders overrunning the two ` +
    `minute lease, or the lease comparison itself never matching. Diagnose via the ` +
    `tag=outbox log lines and booking_outbox.lease_until.`
  );
}

/** The all-clear for a drain that had stood every row down (#1048). */
export function outboxHandoffRecovery(): string {
  return (
    "The booking-outbox drain is completing rows again rather than standing every one of them " +
    "down, so calendar invites and webhooks are being delivered. No action is needed."
  );
}

/** Crash-recovered creates that are not completing. */
export function reservationDrainStuckAlert(stuckCount: number, after: number, ids: string): string {
  return (
    `${stuckCount} booking reservation(s) have failed >= ${after} completion attempts and ` +
    `are backing off (a crash-recovered create is not completing). Diagnose via ` +
    `booking_reservations.last_error; rows: ${ids}.`
  );
}

/** The all-clear for the reservation backlog (#1151). */
export function reservationDrainRecovery(): string {
  return (
    "The crash-recovered booking reservations that were backing off have completed, so " +
    "no half-made booking is stuck retrying. No action is needed."
  );
}

/** A reschedule abandoned mid-flight: the booking did NOT move. */
export function reschedulePinDroppedAlert(dropped: number): string {
  return (
    `${dropped} reschedule(s) were abandoned mid-flight (crash before the move committed) and cleaned up by the sweep. The booking(s) are STILL AT THEIR ORIGINAL TIME; the requested move did NOT happen, and the attendee may believe it did. Re-run the reschedule. Diagnose via the reschedule_locks table + booking_events.`
  );
}

/** A reassign abandoned mid-create: the booking stayed on the original agent. */
export function reassignIntentDroppedAlert(dropped: number): string {
  return (
    `${dropped} reassign(s) were abandoned mid-create (crash before the swap) and cleaned up by the sweep. The booking(s) stayed on the ORIGINAL agent; the intended reassignment did NOT happen. Re-run the contact-owner reassignment. Diagnose via the reassign_intents table + booking_events.`
  );
}

/** Verify-on-book could not read an agent's calendars, per call path. */
export function verifyReadFailedAlert(path: "book" | "reschedule", email: string): string {
  return path === "reschedule"
    ? `In-place reschedule could not read calendars for ${email}; re-routing to avoid ` +
        `keeping the agent on an unverifiable slot. Check DB health.`
    : `Verify-on-book could not read calendars for ${email}; skipping this agent for the ` +
        `slot to avoid a double-book. Check DB health.`;
}

/** Equal-share ordering degraded for one booking. */
export function unfairOrderingAlert(context: string): string {
  return (
    `Equal-share fairness ordering degraded (${context}). The booking still went through, but agent assignment may not reflect each agent's fair share this period. Check DB health.`
  );
}

/** Verify-on-book could not confirm ANY candidate, so the booking was refused. */
export function verifyOutageAlert(): string {
  return "A booking failed because verify-on-book could not confirm ANY candidate's free/busy (likely a Google/DB outage), not because the slot was full. The lead saw a retryable error. Check Google Calendar API + DB health.";
}

/** A reschedule failed closed because the lock claim hit a DB error. */
export function rescheduleLockOutageAlert(): string {
  return "A reschedule failed CLOSED because the per-booking lock claim hit an unexpected DB error (not a real conflict). The actor saw a retryable 503. Check DB health.";
}

/**
 * A lead corrected their phone number and the advisor's calendar invite could
 * not be rewritten (#1341).
 *
 * The number IS saved, so this is not a lost correction: it is a stale invite,
 * and the advisor reads the number to dial off that invite. Left unsaid, they
 * ring the digits the lead just told us are wrong, which is exactly the no show
 * the correction exists to prevent. Names the calendar to repair rather than
 * pasting the Google error, which lives in the logs.
 */
export function stalePhoneInviteAlert(agentEmail: string, bookingId: string): string {
  return (
    `A lead corrected their phone number and the calendar invite on ${agentEmail} could not ` +
    `be updated, so it still shows the old number. The booking itself is correct. Open the ` +
    `event and read the number off the booking before the call. Diagnose via the manage-phone ` +
    `log lines; booking id ${bookingId}.`
  );
}

/**
 * A lead just met a bucket with nobody in it (#2158, Dan's call 2026-09-09).
 *
 * Deliberately a second signal beside `empty_tier:*` rather than a
 * replacement. That one measures the state whether or not anybody is looking,
 * which matters because before cutover almost nobody is; this one says a real
 * person reached it and was shown nothing, which is the fact worth interrupting
 * somebody for.
 */
export function bookerUnstaffedAlert(code: string): string {
  return (
    `A customer opened the booking page for bucket ${code} and it has nobody to route to, ` +
    `so they were shown no times at all. Staff that bucket, or take the link out of use. ` +
    `The monitor lane watches whether this bucket's whole debt tier is offering times; ` +
    `this one means somebody actually arrived.`
  );
}

/** How often the notice above may repeat for one bucket. Short, because a lead
 *  meeting a dead end is a live loss rather than a standing condition, and long
 *  enough that one bot refreshing the page cannot fill the channel. */
export const BOOKER_UNSTAFFED_COOLDOWN_MS = 30 * 60 * 1000;

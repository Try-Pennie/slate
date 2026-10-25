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
import type { FailureKind } from "@/lib/google/sync-health";
import { deadlineReason, durationText, spentBeforeAsked } from "@/lib/notify/error-text";
import type { TimeSpent } from "./time-spent";
import type { StalledTogether } from "@/lib/dependency-stall";
import { normalizeEmail } from "@/lib/auth/email";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";

/** A cached busy_blocks write that did not land, per operation. */
export function busyBlockWriteThroughAlert(
  operation: "insert" | "move" | "delete",
  subject: string,
  reason: string,
): string {
  // #3263: a move or an insert runs only after the booking change itself has
  // committed, so the page says the booking went through: the miss is in the
  // slot cache, and a reader must not take it for a failed booking. That holds
  // for every caller, each of which writes a block for a booking row already
  // stored: the create's post commit work, the reschedule and reassign outbox
  // steps (which re-read the stored booking), and the reconcile sweep (over
  // loadActiveUpcomingBookings). A caller writing a block for anything else
  // would need its own wording here.
  if (operation === "move") {
    return (
      `A busy_blocks move (move_busy_block) failed for booking ${subject} (${reason}). ` +
      `The booking change itself went through; only the slot cache may be stale until the next sync pass.`
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
    `The booking(s) went through; only the slot(s) may show as free in the embed until the next sync pass.`
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

/** One queued deletion the drain stopped retrying (#2577), as the copy needs it. */
export interface RefusedDeletionForAlert {
  calendarEmail: string;
  eventId: string;
  kind: FailureKind;
  /**
   * #1630: whether the call behind this invite now sits with another advisor.
   * Measured only for a calendar whose owner has left; null or absent where it was
   * not measured or could not be read, so the copy claims nothing about it.
   */
  movedToAnotherAdvisor?: boolean | null;
}

/** How many event ids to name per calendar before summarizing the rest. */
const MAX_NAMED_REFUSED_EVENTS = 3;

/**
 * Calendar deletions the drain has STOPPED retrying because Google refused the
 * calendar for good (#2577). Distinct from `pendingDeletionAlert`, whose reader is
 * told to check Google API health and wait: no amount of health fixes these, so
 * the copy names the person who has to act, per kind. A never provisioned account
 * is a Workspace admin ticking a box; a gone account is a credential or membership
 * repair. An unclassified kind is treated as gone, matching #916's default.
 *
 * Calendar emails are staff addresses, not lead data, so they are named: the
 * reader has to know WHOSE account to fix. Event ids are capped per calendar.
 */
export function pendingDeletionRefusedAlert(refused: RefusedDeletionForAlert[]): string {
  const count = refused.length;
  // Every word about ACCOUNTS counts distinct calendars, never deletions: a departed
  // agent queues one deletion per cancelled meeting, so counting rows would tell the
  // reader to fix "the accounts below" and re-authenticate "each account" over a
  // single named calendar, sending them hunting for a second one that is not there.
  const accounts = distinctCalendars(refused);
  const head =
    `Stopped retrying ${count} calendar event ${count === 1 ? "deletion" : "deletions"} because ` +
    `Google has refused the calendar for good. The cancelled ` +
    `${count === 1 ? "meeting is" : "meetings are"} still on ${accounts === 1 ? "the calendar" : "their calendars"} ` +
    `and may keep sending reminders until a person fixes the ${accounts === 1 ? "account" : "accounts"} below.`;
  const provisioning = refused.filter((r) => r.kind === "not-provisioned");
  const gone = refused.filter((r) => r.kind !== "not-provisioned");
  const parts = [head];
  if (provisioning.length > 0) {
    parts.push(
      `Never given Google Calendar: a Workspace admin has to give ${distinctCalendars(provisioning) === 1 ? "this account" : "these accounts"} ` +
        `Calendar, and retrying can never fix it. ${refusedCalendarLines(provisioning)}`,
    );
  }
  if (gone.length > 0) {
    parts.push(
      `Account gone (removed from the Workspace, or delegation revoked): re-authenticate ` +
        `${distinctCalendars(gone) === 1 ? "the account" : "each account"} or take ${distinctCalendars(gone) === 1 ? "the agent" : "each agent"} out of the pool. ${refusedCalendarLines(gone)}`,
    );
  }
  parts.push(
    `${count === 1 ? "The row stays" : "Each row stays"} in pending_event_deletions at the give-up count ` +
      `as the record of the orphaned event.`,
  );
  return parts.join(" ");
}

/** Who a refused calendar belongs to (#1630), as Slate's users row records it. */
export interface CalendarOwnerForAlert {
  /** The owner's name, or null when the row carries none. */
  name: string | null;
  /** When they were deactivated, or null while they are still active. */
  deactivatedAt: string | null;
}

/** The messages one pass's refusals owe, either of which may be absent. */
export interface RefusedDeletionNotices {
  /** Today's page, for calendars whose owner is active or could not be read. */
  page: string | null;
  /** The info notice, for calendars whose owner has left. */
  departed: string | null;
}

/**
 * Split one pass's refused deletions by whether the calendar's owner has LEFT
 * (#1630), and word each half.
 *
 * Google answers `403 notACalendarUser` for a licence that was REVOKED exactly as
 * it does for one never granted, and offboarding revokes it, so the provisioning
 * remedy was being sent about people who had just left. Slate already knows who
 * has left, so the departure is a fact about the owner rather than a fourth kind
 * of Google answer, and it applies whatever definitive kind ended the row.
 *
 * `owners` is keyed by the normalised address (#1663), and is null when it could
 * not be read. Null, a calendar with no users row, and an owner still active all
 * keep today's page with both its remedies, word for word: departure is claimed
 * only where the deactivation was actually read (L11).
 */
export function refusedDeletionNotices(
  refused: RefusedDeletionForAlert[],
  owners: ReadonlyMap<string, CalendarOwnerForAlert> | null,
): RefusedDeletionNotices {
  const active: RefusedDeletionForAlert[] = [];
  const departed = new Map<string, DepartedCalendarForAlert>();
  for (const r of refused) {
    const owner = owners?.get(normalizeEmail(r.calendarEmail));
    if (!owner?.deactivatedAt) {
      active.push(r);
      continue;
    }
    const entry = departed.get(r.calendarEmail) ?? {
      calendarEmail: r.calendarEmail,
      name: owner.name,
      deactivatedAt: owner.deactivatedAt,
      events: [],
    };
    entry.events.push({ eventId: r.eventId, movedToAnotherAdvisor: r.movedToAnotherAdvisor ?? null });
    departed.set(r.calendarEmail, entry);
  }
  return {
    page: active.length > 0 ? pendingDeletionRefusedAlert(active) : null,
    departed: departed.size > 0 ? pendingDeletionDepartedNotice([...departed.values()]) : null,
  };
}

/** One departed owner's calendar and the invites on it Slate could not remove. */
export interface DepartedCalendarForAlert {
  calendarEmail: string;
  name: string | null;
  deactivatedAt: string;
  events: { eventId: string; movedToAnotherAdvisor: boolean | null }[];
}

/** The zone a departure time is written in, named in the text as ET. */
const DEPARTURE_ZONE = "America/New_York";

/**
 * Invites Slate could not remove from the calendar of somebody who has LEFT
 * (#1630). Info, never a page: no account needs fixing and nobody can act, since
 * the account that would have to be repaired belongs to a person who is gone (L112,
 * L36). So it says who left and when, why the invites stay, where the calls went
 * when that was measured, and that nothing needs doing, and it names neither
 * remedy the page carries.
 */
export function pendingDeletionDepartedNotice(departed: DepartedCalendarForAlert[]): string {
  const total = departed.reduce((n, d) => n + d.events.length, 0);
  const record =
    `${total === 1 ? "The row stays" : "Each row stays"} in pending_event_deletions at the give-up count ` +
    `as the record of an invite Slate could not remove`;
  if (departed.length === 1) {
    const d = departed[0];
    const n = d.events.length;
    const moved = movedClause(d.events);
    return [
      `${departedWho(d)} left on ${departedAt(d.deactivatedAt)}, and Slate cannot remove ` +
        `${n === 1 ? "the old invite" : `the ${n} old invites`} from their calendar because the account no longer ` +
        `has Google Calendar.`,
      ...(moved ? [`${moved.charAt(0).toUpperCase()}${moved.slice(1)}.`] : []),
      `No account needs fixing.`,
      `${record} (${eventIdList(d.events.map((e) => e.eventId))}).`,
    ].join(" ");
  }
  const people = departed.map((d) => {
    const n = d.events.length;
    const moved = movedClause(d.events);
    return (
      `${departedWho(d)} left on ${departedAt(d.deactivatedAt)}: ${n} old ${n === 1 ? "invite" : "invites"} ` +
      `(${eventIdList(d.events.map((e) => e.eventId))})${moved ? `, and ${moved}` : ""}.`
    );
  });
  return [
    `${departed.length} people who have left still have old invites on their calendars that Slate cannot ` +
      `remove, because their accounts no longer have Google Calendar.`,
    ...people,
    `No account needs fixing.`,
    `${record}.`,
  ].join(" ");
}

/** "Jane Doe (jane@x.com)", or the address alone when there is no name. */
function departedWho(d: DepartedCalendarForAlert): string {
  return d.name ? `${d.name} (${d.calendarEmail})` : d.calendarEmail;
}

/** "Mon, Oct 5 at 10:43am ET". */
function departedAt(iso: string): string {
  return `${formatSlotDay(iso, DEPARTURE_ZONE)} at ${formatSlotTime(iso, DEPARTURE_ZONE)} ET`;
}

/**
 * Where the calls went, lower case, or null when there is nothing true to say: no
 * call was moved, or whether any was could not be read. "3 of the 4" claims the
 * fourth was NOT moved, so it is only said when every one was measured.
 */
function movedClause(events: { movedToAnotherAdvisor: boolean | null }[]): string | null {
  if (events.some((e) => e.movedToAnotherAdvisor === null)) return null;
  const n = events.length;
  const moved = events.filter((e) => e.movedToAnotherAdvisor).length;
  if (moved === 0) return null;
  if (moved === n) {
    if (n === 1) return "the call was moved to another advisor";
    if (n === 2) return "both calls were moved to other advisors";
    return `all ${n} calls were moved to other advisors`;
  }
  return `${moved} of the ${n} calls ${moved === 1 ? "was moved to another advisor" : "were moved to other advisors"}`;
}

/** "event ids evt-1, evt-2, evt-3 and 2 more", capped like the page's lines. */
function eventIdList(ids: string[]): string {
  const named = ids.slice(0, MAX_NAMED_REFUSED_EVENTS).join(", ");
  const rest = ids.length - MAX_NAMED_REFUSED_EVENTS;
  return `${ids.length === 1 ? "event id" : "event ids"} ${named}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/** How many distinct calendars (accounts) a set of refused deletions belongs to. */
function distinctCalendars(rows: RefusedDeletionForAlert[]): number {
  return new Set(rows.map((r) => r.calendarEmail)).size;
}

/** "a@x.com (event ids evt-1, evt-2 and 3 more); b@x.com (event id evt-9)". */
function refusedCalendarLines(rows: RefusedDeletionForAlert[]): string {
  const byCalendar = new Map<string, string[]>();
  for (const r of rows) {
    const ids = byCalendar.get(r.calendarEmail) ?? [];
    ids.push(r.eventId);
    byCalendar.set(r.calendarEmail, ids);
  }
  return [...byCalendar.entries()]
    .map(([email, ids]) => `${email} (${eventIdList(ids)})`)
    .join("; ")
    .concat(".");
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
  /** #3585: the booking ids whose block was freed, so a reader can tell a genuine
   *  missed write from the cancel/reconcile race rather than inferring from a snapshot.
   *  Already bounded by the caller; `bookingIdsTruncated` says more exist. */
  bookingIds?: string[];
  bookingIdsTruncated?: boolean;
}): string {
  const { freedCancelled, freedOrphans, agentCount, bookingIds = [], bookingIdsTruncated = false } = counts;
  const parts: string[] = [];
  if (freedCancelled > 0) {
    const ids = bookingIds.length > 0 ? ` Booking ids: ${bookingIds.join(", ")}${bookingIdsTruncated ? " ..." : ""}.` : "";
    parts.push(
      `${freedCancelled} stuck busy_block(s) whose booking was cancelled or missing. ` +
        `A write-through delete was missed, so check cancel-path health.${ids}`,
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

/**
 * Crash-recovered creates that are not completing.
 *
 * #3516: one cause is not a crash at all. A booking that committed while its
 * bucket stopped resolving (deleted, or its event type gone) cannot have its
 * booking.created built, so the reservation is kept and pages here. Its booking
 * EXISTS and Regal has not heard of it, which sends the reader somewhere other
 * than a stalled create, so the page says how to tell the two apart.
 */
export function reservationDrainStuckAlert(stuckCount: number, after: number, ids: string): string {
  return (
    `${stuckCount} booking reservation(s) have failed >= ${after} completion attempts and ` +
    `are backing off (a crash-recovered create is not completing). Diagnose via ` +
    `booking_reservations.last_error; rows: ${ids}. A last_error saying the booked bucket ` +
    `no longer resolves means the booking exists and Regal was never sent booking.created: ` +
    `restore the bucket so the drain sends it, or tell Regal about the booking by hand and ` +
    `then delete the reservation. Retention keeps that reservation until one of those happens.`
  );
}

/**
 * Bookings that committed more than a day ago and whose booking.created is still
 * owed (#3847). The retention sweep keeps their reservations, the only record that
 * Regal was never told, and pages this once a day until somebody acts. Past the
 * drain's give up cap (`DRAIN_GIVE_UP_AT`) the drain no longer retries the row and
 * `reservation_drain_stuck` stops paging, so this is what still speaks, and why the
 * remedy includes setting the attempts back.
 */
export function reservationCreatedOwedAlert(owedCount: number, ids: string): string {
  return (
    `${owedCount} booking(s) committed more than a day ago and Regal has still not been sent ` +
    `booking.created. Retention is keeping their reservations, the only record that the send ` +
    `is owed, instead of deleting them. Rows: ${ids}. Read booking_reservations.last_error for ` +
    `why. If the booked bucket no longer resolves, restore it and set the reservation's attempts ` +
    `to 0 so the drain sends it, or tell Regal about the booking by hand and then delete the reservation.`
  );
}

/** The all-clear for `reservation_created_owed`, sent only off a sweep that read every candidate. */
export function reservationCreatedOwedRecovery(): string {
  return (
    "No committed booking is waiting on its booking.created any more: every reservation " +
    "retention was keeping for one has been sent or removed. No action is needed."
  );
}

/**
 * The all-clear for the reservation backlog (#1151).
 *
 * #3359: sent when the table holds no pending reservation at the threshold, which
 * is all that was measured. A reservation leaves that state by completing OR by
 * being removed (a refused email, a slot taken, the 24 hour retention of a create
 * that never committed, or by hand), so the sentence says both rather than claiming
 * every one completed.
 */
export function reservationDrainRecovery(): string {
  return (
    "No crash-recovered booking reservation is stuck retrying any more: each one that " +
    "was backing off has completed or been removed. No action is needed."
  );
}

/**
 * A reschedule abandoned mid-flight: the booking did NOT move. #3924: `putBack` counts
 * the ones whose lead invite the crashed move had already changed, which the sweep
 * moved back, emailing the lead the original time, so whoever re-runs the move knows
 * the lead has had two emails about it.
 */
export function reschedulePinDroppedAlert(dropped: number, putBack = 0): string {
  const back =
    putBack > 0
      ? ` For ${putBack} of them the lead's invite had already been moved to the new time; the sweep moved it back to the original time and the lead was emailed it.`
      : "";
  return (
    `${dropped} reschedule(s) were abandoned mid-flight (crash before the move committed) and cleaned up by the sweep. The booking(s) are STILL AT THEIR ORIGINAL TIME; the requested move did NOT happen, and the attendee may believe it did.${back} Re-run the reschedule. Diagnose via the reschedule_locks table + booking_events.`
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

/**
 * #3859: a confirm lost the overlap race and the database refused the delete that
 * rolls its reservation back, so it stopped rather than reserving again under the
 * same key (which would have adopted the lost row). Sent under the verify outage's
 * key, because the lead saw the same retryable answer. It claims only what was
 * measured: the delete was refused. The row is still pending, which the drain retries.
 */
export function reservationRollbackAlert(): string {
  return "A booking failed because Supabase refused to delete a reservation the confirm had to roll back after losing the overlap race, not because the slot was full. The lead saw a retryable error. The row is still pending in booking_reservations and the reservation drain retries it; check Supabase health and the booking log line for the database's error.";
}

/** Verify-on-book could not confirm ANY candidate, so the booking was refused. */
export function verifyOutageAlert(): string {
  return "A booking failed because verify-on-book could not confirm ANY candidate's free/busy (likely a Google/DB outage), not because the slot was full. The lead saw a retryable error. Check Google Calendar API + DB health.";
}

/**
 * A dependency on the booking path did not answer inside its deadline (#3102).
 * Sent under the same key as the verify outage, because it is the same incident
 * from the lead's side. The words name the call that was in flight, and the
 * request's budget when that is what cut it short. They claim nothing about what
 * happened to the booking afterwards (L11): whether its reservation had been
 * written is not known at the moment of the page, so it points at where to look.
 * It is never raised for a booking that COMMITTED (#3263): once the row is in,
 * the confirm answers the booking and the work after it is the drain's, so "A
 * booking failed" is true whenever this is sent.
 */
export function dependencyTimeoutAlert(timeout: {
  dependency: string;
  timeoutMs: number;
  budget: { label: string; totalMs: number } | null;
  /** #3338: set when Slate chose not to start the work for want of time. */
  neededMs?: number;
  /** #3511: where the confirm's time went, from its own profile, when one was read. */
  spent?: TimeSpent | null;
  /** #3663: how far the request had got; a booking unless the route knows otherwise. */
  reach?: TimeoutReach;
}): string {
  // #3263: one wording for a missed deadline across every alert. A call refused
  // because the budget was already spent says the budget was used up before
  // Slate asked, never that the dependency "was not started".
  const found = { label: timeout.dependency, timeoutMs: timeout.timeoutMs, budget: timeout.budget, neededMs: timeout.neededMs };
  const what = deadlineReason(found);
  // #3784: Google and Supabase both stalled in this confirm, so the location they were
  // both called from is the first suspect, ahead of whichever call was in flight and
  // ahead of where the time went. One stalling alone keeps the wording below.
  const together = timeout.spent?.stalled ? locationFirstSentence(timeout.spent.stalled, timeout.spent.ranAt ?? null) : null;
  // #3663: a dry run and a request whose body was never read wrote no row and were
  // seen by nobody but the caller, so neither may send the reader to a lead or to
  // booking_reservations. Their advice names the dependency that was in flight.
  const reach = timeout.reach ?? "booking";
  if (reach !== "booking") {
    const opening =
      reach === "dry-run"
        ? `A dry run booking check failed because ${what}, not because the slot was full. The caller saw a retryable error, and a dry run writes nothing, so there is no booking or reservation to look for.`
        : `A booking request failed before Slate had read its body, because ${what}. The caller saw a retryable error and no booking was attempted.`;
    const advice =
      together ??
      (spentBeforeAsked(found)
        ? (timeWentSentence(timeout.spent ?? null) ??
          "The time went inside Slate before that call, so start from that request's confirm answered log line rather than Google Calendar API and Supabase health.")
        : dependencyHealthAdvice(found.label));
    return `${opening} ${advice}`;
  }
  const head = `A booking failed because ${what}, not because the slot was full. The lead saw a retryable error. Check booking_reservations for a pending row before asking them to rebook`;
  if (together) return `${head}. ${together}`;
  // #3313: a budget spent before Slate asked means the dependency was never
  // asked, so pointing at its health is a claim nothing measured (L11): on
  // 2026-10-06 at 13:54 ET Google and Supabase were both healthy and this sent the
  // reader to them. The time went earlier in the request, so the advice points at
  // the request's confirm answered line, which every confirm writes, a time change
  // included (#3401), and which carries where a slow or timed out one spent its
  // time (#3300).
  if (spentBeforeAsked(found)) {
    const where = timeWentSentence(timeout.spent ?? null);
    if (where) return `${head}. ${where}`;
    return `${head}. The time went inside Slate before that call, so start from that request's confirm answered log line rather than Google Calendar API and Supabase health.`;
  }
  return `${head}, and Google Calendar API and Supabase health.`;
}

/** The health page a dependency's calls are judged on, by the label's first word. */
const DEPENDENCY_HEALTH = new Map<string, string>([
  ["google", "Google Calendar API"],
  ["supabase", "Supabase"],
]);

/**
 * #3663: how far a booking request had got when its deadline struck, which decides
 * what its page may say happened. `booking` is a parsed booking that may have written
 * a reservation; `dry-run` is a parsed dry run, which writes nothing; `before-body`
 * is a request whose body Slate never parsed, so no bucket, lead or row exists.
 */
export type TimeoutReach = "booking" | "dry-run" | "before-body";

/**
 * #3784: Google and Supabase both stalled in one confirm. Placement runs every confirm
 * beside Oregon (#3730), so a degraded location there slows both at once, and two
 * unrelated services stalling together points at where they were called from (L774).
 * Names the location when an answer said it (`ranAt`, the line's `supabase_edge_colo`),
 * and otherwise says which field of the line holds it.
 */
function locationFirstSentence(stalled: StalledTogether, ranAt: string | null): string {
  const slow =
    `Google Calendar and Supabase both stalled in this confirm (the slowest Google call took ${durationText(stalled.googleMs)}, ` +
    `the slowest Supabase call ${durationText(stalled.supabaseMs)}). Two unrelated services rarely stall at the same moment, so`;
  const health = "and only then look at either service's health";
  if (ranAt) {
    const where = ranAt.split(",").join(" and ");
    return `${slow} suspect the Cloudflare location it ran at (${where}) before either service. Check Supabase's edge logs, by request.cf.colo, for other slow requests from ${where}, ${health}.`;
  }
  return (
    `${slow} suspect the Cloudflare location it ran at before either service. That request's confirm answered log line names it ` +
    `as supabase_edge_colo; check Supabase's edge logs, by request.cf.colo, for other slow requests from there, ${health}.`
  );
}

/** Look at the named dependency's health, or at the request's own line for one with no health page. */
function dependencyHealthAdvice(label: string): string {
  // A Map, so a first word like `constructor` is an unknown dependency (L738).
  const health = DEPENDENCY_HEALTH.get(label.split(" ")[0]!);
  return health ? `Check ${health} health.` : "Start from that request's confirm answered log line.";
}

/**
 * Where a refused confirm's time went, said from its own profile (#3511), or null
 * with no stage to name. The dearest stage is named; when one outside call took at
 * least half of it, that call is named too and the reader is sent to its health,
 * since that is where the time went (on 2026-10-07 16:55 ET, 6.5 of the 7.6
 * seconds of `assign-and-verify` were one Google call). Otherwise the stage was
 * Slate's own work and the reader is steered off the dependencies, as before.
 */
function timeWentSentence(spent: TimeSpent | null): string | null {
  if (!spent?.stage) return null;
  const stage = `The time went to the ${spent.stage.name} step (${durationText(spent.stage.ms)})`;
  const call = spent.call;
  if (call && call.ms * 2 >= spent.stage.ms) {
    const named = `${stage}, ${durationText(call.ms)} of it in one call to ${call.label}`;
    // A Map, so a first word like `constructor` is an unknown dependency, never
    // an inherited property (L738); and an unknown one keeps the blame it earned.
    const health = DEPENDENCY_HEALTH.get(call.label.split(" ")[0]);
    return health
      ? `${named}, so start from ${health} health and that request's confirm answered log line.`
      : `${named}, so start from that request's confirm answered log line.`;
  }
  return `${stage} inside Slate, so start from that request's confirm answered log line rather than Google Calendar API and Supabase health.`;
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
 * A lead corrected their phone number and the event telling downstream could not
 * be recorded (#1512).
 *
 * The number IS saved on the booking and the advisor's invite, so the advisor
 * dials the right digits. What did not move is Regal's contact profile, which
 * still names the old number as primary, and nothing retries an event whose
 * delivery row was never written. The repair is the one Regal itself documents:
 * set the corrected number primary on the profile. Names the booking, never the
 * numbers, and never the raw error, which lives in the logs.
 */
export function phoneCorrectionUnsentAlert(bookingId: string): string {
  return (
    `A lead corrected their phone number on their manage page and the update for Regal could ` +
    `not be recorded, so nothing will retry it and Regal still has the old number as primary. ` +
    `The booking and the advisor's invite are correct. Read the new number off the booking and ` +
    `set it as the primary phone on the lead's Regal profile. Diagnose via tag=manage-contact ` +
    `in the Worker logs; booking id ${bookingId}.`
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

/**
 * A lead was offered times past the window of open days (#2841): every tier their
 * cascade may use was full for all of them, so a later day was opened.
 *
 * `offeredOpenDays` is the stored setting as the request that served the lead read
 * it (#3922), carried on the routing meta, so the alert names the number that lead
 * was actually given rather than a constant that may no longer be the setting.
 *
 * Dan, 2026-09-28: "Realistically, if this happens, something is probably wrong,
 * so I would set up an alert so that we could look at it." The lead WAS offered
 * times, so this is not the dead end `booker_unstaffed` reports, and it says so.
 */
export function bookingWindowExtendedAlert(code: string, offeredOpenDays: number): string {
  return (
    `A customer on bucket ${code} was offered times past the ${offeredOpenDays} day booking window: every ` +
    `tier their booking may cascade to was full for the next ${offeredOpenDays} open days, so a later day ` +
    `was opened for them. They could still book. This should be rare, and usually means the ` +
    `pools for that tier and the ones below it are short on advisors, or a lot of them are ` +
    `on time off at once. Check /admin/tiers.`
  );
}

/** How often the alert above may repeat for one bucket: once an hour, since the
 *  condition behind it lasts for hours and every visit in that time would repeat it. */
export const BOOKING_WINDOW_EXTENDED_COOLDOWN_MS = 60 * 60 * 1000;

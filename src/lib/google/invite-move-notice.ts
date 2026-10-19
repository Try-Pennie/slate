/**
 * What Slate does when the calendar sync delivers a Slate booking's invite out of
 * step with its booking (#3919). The rules are `decideInviteChange`
 * (`invite-moves.ts`); this is their order of effects, through seams, so
 * `scripts/test-invite-moves.ts` drives every branch with no network or database.
 * The real seams are `realInviteMoveDeps` (`invite-move-deps.ts`).
 *
 * NEVER MISTAKE SLATE'S OWN CHANGE FOR AN ADVISOR'S. An in place reschedule PATCHes
 * the invite BEFORE it commits the booking's new time, so between the two the sync
 * can see an invite at the new time and a booking still at the old one, which is
 * exactly what an advisor's move looks like. Putting it back then would undo a real
 * reschedule and email the lead the wrong time. Two things close it:
 *
 *  1. The handler takes the booking's RESCHEDULE LOCK (`reschedule_locks`, keyed on
 *     the booking) before it judges anything, the lock every reschedule holds from
 *     before its PATCH until after its commit. A held lock means Slate is moving
 *     this booking right now, and the handler leaves it entirely alone. Holding it
 *     ourselves also means no reschedule can START while we put an invite back.
 *  2. Under that lock it reads the booking AGAIN and the invite LIVE. The sync's
 *     own read of the booking came before the lock, so a reschedule that committed
 *     and released in between is invisible to it; the fresh read sees the new time.
 *     A reassign in flight (`reassign_intents`) is Slate's own change too.
 *
 * RUNS TWICE SAFELY. The push sync and the minute lane can deliver the same change
 * at once. The record of each change (`booking_invite_changes`) is unique on the
 * booking and Google's `updated` stamp, and on the booking and its move number, so
 * of two runs exactly one writes it, and only the run that wrote it reverts and
 * sends anything. A retried pass meets its own record and does nothing.
 *
 * FAILURE. A read this needs (the lock, the booking, the live invite, the record)
 * that fails stops that invite being judged, so nothing is judged on a guess; the
 * invite is returned in `failed` and the caller pages about it. It is deliberately
 * NOT thrown into the sync: the sync would then never advance its token, and one
 * unreadable invite would stop every other meeting of that advisor being cached,
 * which offers leads times the advisor is busy. The invite stays mirrored, so both
 * times stay blocked. What happens after the record is written is reported too: a
 * revert Google refuses is posted to the alerts channel, and a DM that cannot be
 * delivered is said in the channel post. Messages are sent at most once: a run
 * that dies between the record and the DM has used the record.
 */
import type { GoogleEvent } from "./calendar.ts";
import { eventWindow } from "./sync-core.ts";
import {
  decideInviteChange,
  type InviteAction,
  type InviteChangeRecord,
  type InviteOutcome,
} from "./invite-moves.ts";
import {
  advisorLeftDm,
  advisorRevertedDm,
  inviteMoveLeftAlert,
  inviteResizedAlert,
  inviteRevertRefusedAlert,
  inviteRevertedAdvisorUntoldAlert,
  type InviteMoveFacts,
  type LeftReach,
  type LeftReason,
  managerLeftDm,
} from "./invite-move-copy.ts";
import { EventGone } from "../booking/core.ts";
import { shortErrorReason } from "../notify/error-text.ts";
import { parseStampMs } from "../date/stamp.ts";

/** The alert families this posts under. Each key carries the booking id first. */
export const INVITE_MOVED_KEY = "booking_invite_moved";
export const INVITE_RESIZED_KEY = "booking_invite_resized";
export const INVITE_CHECK_FAILED_KEY = "booking_invite_check_failed";

/** The booking, read fresh under the lock. */
export interface FreshBooking {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  gcalEventId: string | null;
  assignedUserId: string | null;
  /** The lead's zone, which the revert writes the invite in. */
  timezone: string;
}

/** A change to record. */
export interface NewInviteChange {
  bookingId: string;
  userId: string;
  gcalEventId: string;
  kind: "moved" | "resized";
  moveNumber: number | null;
  action: InviteAction;
  bookedStartsAt: string;
  bookedEndsAt: string;
  eventStartsAt: string;
  eventEndsAt: string;
  eventUpdated: string;
}

export interface InviteMoveDeps {
  nowMs: number;
  /** The advisor whose calendar the sync read, and their address. */
  advisorUserId: string;
  advisorEmail: string;
  appBaseUrl: string;
  /** The sync's zone for an all day event's bounds. */
  timeZone?: string;
  /**
   * Whether anything may be sent from here. Where it may not (a dev server pointed at
   * production, a load run, Slack unconfigured), nothing is read, reverted or recorded
   * either: a revert nobody is told about is the one thing worse than none.
   */
  messagesAvailable(): boolean;
  /** Take the booking's reschedule lock: a token, or null when somebody holds it. Throws on failure. */
  claimLock(bookingId: string, targetStartsAt: string): Promise<string | null>;
  /** Give back the lock this run took. Never throws. */
  releaseLock(bookingId: string, token: string): Promise<void>;
  /** Whether a reassign of the booking is in flight. Throws on failure. */
  reassignInFlight(bookingId: string): Promise<boolean>;
  /** The booking now, or null. Throws on failure. */
  loadBooking(bookingId: string): Promise<FreshBooking | null>;
  /** The invite now, from the advisor's primary calendar, or null when gone. Throws when unreadable. */
  readEvent(email: string, eventId: string): Promise<GoogleEvent | null>;
  /** Every recorded change for the booking, oldest first. Throws on failure. */
  loadChanges(bookingId: string): Promise<InviteChangeRecord[]>;
  /** Record a change: its id, or null when another run recorded it first. Throws on other failures. */
  recordChange(row: NewInviteChange): Promise<string | null>;
  /** Record how a revert went. Never throws: the revert has already happened. */
  setOutcome(id: string, outcome: InviteOutcome, detail: string | null): Promise<void>;
  /** Move the invite back, emailing its guests. Throws `EventGone` or the refusal. */
  revert(email: string, eventId: string, startIso: string, endIso: string, timezone: string): Promise<void>;
  /**
   * The advisor's name and their manager of record: null when they have none,
   * `unread` when the lookup failed, which is never reported as having none. Never throws.
   */
  loadPeople(advisorUserId: string): Promise<{
    advisorName: string | null;
    manager: { name: string | null; email: string } | null | "unread";
  }>;
  /** A Slack DM: false when it could not be delivered. Never throws. */
  dm(email: string, text: string): Promise<boolean>;
  /** A post to the alerts channel. Never throws. */
  post(key: string, text: string): Promise<void>;
}

export interface InviteMoveSummary {
  reverted: number;
  left: number;
  refused: number;
  resized: number;
  /** Slate's own reschedule or reassign was in flight, or the booking moved on. */
  slateOwn: number;
  /** Nothing to do: back in step, already recorded, standing, or past. */
  nothing: number;
  /**
   * Invites that could not be checked (a read failed), each with a short reason.
   * Returned rather than thrown, so the caller reports them and the sync still
   * advances: a sync that failed every pass over one unreadable invite would stop
   * caching ALL the advisor's meetings, which is far worse than one invite not put
   * back. The invite stays mirrored, so both times are still blocked.
   */
  failed: { bookingId: string; reason: string }[];
}

const ACTIVE = new Set(["confirmed", "rescheduled"]);

/** Handle the out of step invites one sync pass delivered for one advisor. */
export async function noticeOutOfStepInvites(
  deps: InviteMoveDeps,
  items: { eventId: string; bookingId: string; bookedStartsAt: string }[],
): Promise<InviteMoveSummary> {
  const summary: InviteMoveSummary = {
    reverted: 0,
    left: 0,
    refused: 0,
    resized: 0,
    slateOwn: 0,
    nothing: 0,
    failed: [],
  };
  if (items.length === 0 || !deps.messagesAvailable()) return summary;
  for (const item of items) {
    // One invite that cannot be checked never stops the others being checked.
    try {
      const token = await deps.claimLock(item.bookingId, item.bookedStartsAt);
      if (token === null) {
        summary.slateOwn++;
        continue;
      }
      let after: (() => Promise<void>) | null = null;
      try {
        after = await judgeUnderLock(deps, item, summary);
      } finally {
        await deps.releaseLock(item.bookingId, token);
      }
      // Messages go out once the lock is given back, so a lead rescheduling this call
      // is never held up behind a Slack round trip.
      if (after) await after();
    } catch (err) {
      summary.failed.push({ bookingId: item.bookingId, reason: shortErrorReason(err) });
    }
  }
  return summary;
}

async function judgeUnderLock(
  deps: InviteMoveDeps,
  item: { eventId: string; bookingId: string },
  summary: InviteMoveSummary,
): Promise<(() => Promise<void>) | null> {
  if (await deps.reassignInFlight(item.bookingId)) {
    summary.slateOwn++;
    return null;
  }
  const booking = await deps.loadBooking(item.bookingId);
  if (
    !booking ||
    !ACTIVE.has(booking.status) ||
    booking.gcalEventId !== item.eventId ||
    booking.assignedUserId !== deps.advisorUserId
  ) {
    summary.slateOwn++;
    return null;
  }
  const event = await deps.readEvent(deps.advisorEmail, item.eventId);
  if (!event) {
    summary.nothing++;
    return null;
  }
  const prior = await deps.loadChanges(item.bookingId);
  const booked = { startsAt: booking.startsAt, endsAt: booking.endsAt };
  const decision = decideInviteChange({ event, booked, prior, nowMs: deps.nowMs, timeZone: deps.timeZone });
  if (decision.kind === "nothing") {
    summary.nothing++;
    return null;
  }
  const win = eventWindow(event, deps.timeZone ?? "UTC")!;
  const rowId = await deps.recordChange({
    bookingId: booking.id,
    userId: deps.advisorUserId,
    gcalEventId: item.eventId,
    ...decision.change,
    bookedStartsAt: booking.startsAt,
    bookedEndsAt: booking.endsAt,
    eventStartsAt: win.start,
    eventEndsAt: win.end,
    // An event with no stamp still needs a key unique to this sighting.
    eventUpdated: event.updated ?? `unstamped:${win.start}:${win.end}`,
  });
  if (rowId === null) {
    summary.nothing++;
    return null;
  }

  const facts = (advisorName: string | null): InviteMoveFacts => ({
    bookingId: booking.id,
    advisorName,
    advisorEmail: deps.advisorEmail,
    bookedStartsAt: booking.startsAt,
    bookedEndsAt: booking.endsAt,
    eventStartsAt: win.start,
    eventEndsAt: win.end,
    bookingUrl: `${deps.appBaseUrl}/admin/bookings/${booking.id}`,
  });
  const movedKey = `${INVITE_MOVED_KEY}:${booking.id}:${decision.change.moveNumber ?? 0}`;
  const action = decision.change.action;

  if (action === "report_resize") {
    summary.resized++;
    const endMs = parseStampMs(win.end) ?? 0;
    return async () => {
      const people = await deps.loadPeople(deps.advisorUserId);
      // alert-key: booking_invite_resized:*
      await deps.post(`${INVITE_RESIZED_KEY}:${booking.id}:${endMs}`, inviteResizedAlert(facts(people.advisorName)));
    };
  }

  if (action === "revert") {
    let refusal: { kind: "gone" } | { kind: "refused"; reason: string } | null = null;
    try {
      await deps.revert(deps.advisorEmail, item.eventId, booking.startsAt, booking.endsAt, booking.timezone);
    } catch (err) {
      refusal = err instanceof EventGone ? { kind: "gone" } : { kind: "refused", reason: shortErrorReason(err) };
    }
    await deps.setOutcome(
      rowId,
      refusal === null ? "reverted" : refusal.kind === "gone" ? "event_gone" : "revert_refused",
      refusal?.kind === "refused" ? refusal.reason : null,
    );
    if (refusal !== null) {
      summary.refused++;
      const r = refusal;
      return async () => {
        const people = await deps.loadPeople(deps.advisorUserId);
        // alert-key: booking_invite_moved:*
        await deps.post(movedKey, inviteRevertRefusedAlert(facts(people.advisorName), r));
      };
    }
    summary.reverted++;
    return async () => {
      const people = await deps.loadPeople(deps.advisorUserId);
      const f = facts(people.advisorName);
      if (!(await deps.dm(deps.advisorEmail, advisorRevertedDm(f)))) {
        // alert-key: booking_invite_moved:*
        await deps.post(movedKey, inviteRevertedAdvisorUntoldAlert(f));
      }
    };
  }

  // Left where the advisor put it (decisions 4 and 5).
  summary.left++;
  const reason: LeftReason = action === "leave_second_move" ? "second-move" : "near-start";
  return async () => {
    const people = await deps.loadPeople(deps.advisorUserId);
    const f = facts(people.advisorName);
    // The manager first, so the advisor's DM says only what was measured about them.
    let manager: LeftReach["manager"];
    if (people.manager === "unread") manager = "unread";
    else if (people.manager === null) manager = "none";
    else manager = (await deps.dm(people.manager.email, managerLeftDm(f, reason))) ? "told" : "unreachable";
    const advisor = await deps.dm(deps.advisorEmail, advisorLeftDm(f, reason, manager === "told"));
    // alert-key: booking_invite_moved:*
    await deps.post(movedKey, inviteMoveLeftAlert(f, reason, { advisor, manager }));
  };
}

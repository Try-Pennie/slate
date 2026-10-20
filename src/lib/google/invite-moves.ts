/**
 * A Slate booking's invite moved by its advisor in Google Calendar (#3919): what
 * counts as a move, and what Slate does about one. Pure, so every rule is pinned by
 * `scripts/test-invite-moves.ts` with no network, database or clock.
 *
 * WHY IT EXISTS. Slate writes each booking's invite on the advisor's own calendar as
 * the advisor, and Google never stops an organizer editing their own event. Until
 * this, the calendar sync received the moved event and discarded it as Slate's own
 * (#166), so the booking, its busy block, the manage page, the reminder and every
 * webhook kept the booked time while Google and the lead's invite could say another.
 *
 * THE DECISIONS ARE DAN'S (2026-10-19, the first comment on #3919):
 *
 *  1. A START more than a minute from the booking's is a move. An END only change is
 *     not reverted; it is posted to the alerts channel so its frequency can be seen.
 *  2. A move is put back with the lead emailed (`sendUpdates=all`).
 *  3. The advisor is told by Slack DM that times change in Slate, not Google.
 *  4. A SECOND move of the same booking is not reverted: the advisor, their manager
 *     of record and the alerts channel are all told.
 *  5. Inside 30 minutes of the call start, nothing is reverted, and all three are told.
 *  6. While a move is left in place the advisor is busy at BOTH times.
 *  7. The busy drift page stays silent for a gap a moved invite explains.
 *  8. Live from the first deploy.
 *  9. A one time launch sweep reports invites already out of step, reverting none.
 *
 * HOW 6 AND 7 ARE MET, WITH NO STATE. The sync used to skip every Slate booking's
 * event. It now skips only those IN STEP with their booking; an out of step one is
 * mirrored like any other event, at the time Google holds it, beside the booking's
 * own block at the booked time. So both times are busy whenever the invite and the
 * booking disagree, for whatever reason, and the cache agrees with Google, which is
 * all the drift sampler compares. When the invite is back in step (put back, or the
 * booking rescheduled to meet it) the next delta deletes the mirror as it always did.
 * The rule is a property of the event and the booking only, so the incremental sync,
 * the full resync and the rotation all reach the same answer without reading anything
 * new, and a revert the handler makes is undone in the cache by Google's own echo.
 */
import type { GoogleEvent } from "./calendar.ts";
import { eventWindow, isBusyEvent } from "./sync-core.ts";
import { parseStampMs } from "../date/stamp.ts";

/** Decision 1: a start this far off or less is not a move; more is. */
export const INVITE_MOVE_TOLERANCE_MS = 60_000;

/** Decision 5: inside this long before the booked start, a move is left in place. */
export const NEAR_START_MS = 30 * 60_000;

/** A Slate booking's invite, as the sync loads it: which booking, and its booked times. */
export interface BookedInvite {
  bookingId: string;
  startsAt: string;
  endsAt: string;
}

/**
 * How an invite stands against its booking.
 *  - `in-step`: the same start and end, within the tolerance.
 *  - `moved`: the start differs (decision 1), whatever the end did.
 *  - `resized`: the start agrees and the end does not.
 *  - `not-held`: the event holds no time (cancelled, declined, marked free, or no
 *    readable window). That is not a move, and the sync treats it as it always did.
 *
 * A booking whose own times cannot be read is `in-step`: nothing can be judged
 * against it, and the answer that moves nothing and emails nobody is the safe one.
 */
export type InviteStep = "in-step" | "moved" | "resized" | "not-held";

export function judgeInvite(
  event: GoogleEvent,
  booked: { startsAt: string; endsAt: string },
  timeZone = "UTC",
): InviteStep {
  if (!isBusyEvent(event)) return "not-held";
  const win = eventWindow(event, timeZone);
  if (!win) return "not-held";
  const es = parseStampMs(win.start);
  const ee = parseStampMs(win.end);
  if (es === null || ee === null) return "not-held";
  const bs = parseStampMs(booked.startsAt);
  const be = parseStampMs(booked.endsAt);
  if (bs === null || be === null) return "in-step";
  if (Math.abs(es - bs) > INVITE_MOVE_TOLERANCE_MS) return "moved";
  if (Math.abs(ee - be) > INVITE_MOVE_TOLERANCE_MS) return "resized";
  return "in-step";
}

/**
 * What an abandoned IN PLACE reschedule left on its booking's invite (#3924). The
 * reschedule PATCHes the invite to its target BEFORE it commits the booking, so a
 * crash between the two leaves the invite at the target, with the lead emailed it,
 * while the booking still holds its own time.
 *  - `nothing`: the invite starts where the booking does (the PATCH never landed, or
 *    the move committed), holds no time, or only its end differs. None of that is
 *    the crash's doing.
 *  - `put-back`: it starts at the pin's target, the time the crashed PATCH wrote.
 *  - `elsewhere`: it starts at neither, so it is not a time Slate wrote, and it is
 *    reported rather than undone.
 */
export function judgeAbandonedInvite(
  event: GoogleEvent,
  booked: { startsAt: string; endsAt: string },
  targetStartsAt: string,
  timeZone = "UTC",
): "nothing" | "put-back" | "elsewhere" {
  if (judgeInvite(event, booked, timeZone) !== "moved") return "nothing";
  const win = eventWindow(event, timeZone)!;
  return near(win.start, targetStartsAt) ? "put-back" : "elsewhere";
}

/** One Slate invite this pass delivered out of step with its booking. */
export interface OutOfStepInvite {
  eventId: string;
  bookingId: string;
  /** The booked start the sync read, which is the target the handler's lock names. */
  bookedStartsAt: string;
  step: "moved" | "resized";
}

/**
 * Split a pass's events into the Slate event ids the sync should SKIP (delete any
 * mirror of, the #166 rule) and the out of step invites it should mirror instead and
 * hand to the handler. `skip` is every Slate booking event id the agent holds, not
 * only those in this pass, because the full resync's reconcile reads it to decide
 * which cached blocks are still seen; an out of step one is left out of it so its
 * mirror counts as seen and is kept.
 */
export function splitSlateInvites(
  events: GoogleEvent[],
  invites: ReadonlyMap<string, BookedInvite>,
  timeZone = "UTC",
): { skip: Set<string>; outOfStep: OutOfStepInvite[] } {
  // A delta naming one event twice is judged by its LAST appearance, the one
  // `partitionBusyWrites` writes.
  const last = new Map<string, GoogleEvent>();
  for (const ev of events) if (ev.id && invites.has(ev.id)) last.set(ev.id, ev);
  const skip = new Set(invites.keys());
  const outOfStep: OutOfStepInvite[] = [];
  for (const [eventId, ev] of last) {
    const booked = invites.get(eventId)!;
    const step = judgeInvite(ev, booked, timeZone);
    if (step !== "moved" && step !== "resized") continue;
    skip.delete(eventId);
    outOfStep.push({ eventId, bookingId: booked.bookingId, bookedStartsAt: booked.startsAt, step });
  }
  return { skip, outOfStep };
}

/**
 * Whether the handler may take over a booking's reschedule lock somebody else holds.
 *
 * Only a lock that is both PAST its lease and carries NO pin: one left by a handler
 * (or a reschedule) that died before its Google call. Nothing else ever removes such
 * a row (the abandoned pin sweep takes only pinned ones), so treating it as held would
 * leave every later move of that booking unjudged, with nothing said. A live lease
 * is a reschedule or handler at work now; an expired PINNED one is a reschedule that
 * crashed after its Google call, which its own resume or the abandoned pin sweep
 * owns, and taking it would strip the pin a resume needs. A lease that cannot be
 * read counts as expired, as the reschedule's own takeover reads it.
 */
export function mayTakeOverLock(
  row: { lease_until: string | null; gcal_client_id: string | null },
  nowMs: number,
): boolean {
  if (row.gcal_client_id !== null) return false;
  const until = parseStampMs(row.lease_until);
  return until === null || until <= nowMs;
}

/**
 * Which of an advisor's synced calendars a booking invite lives on, for writing its
 * moved time where the sync would. The invite is on the advisor's PRIMARY calendar,
 * whose Google id is their address, and that is the only calendar the sync selects
 * (`selectableCalendarIds`). So: the calendar named by the address; failing that, the
 * only one there is; otherwise null, never a guess among several, because a row under
 * a calendar the sync never reads for this event would outlive every later change.
 */
export function primaryCalendarId(calendarIds: string[], advisorEmail: string): string | null {
  const email = advisorEmail.trim().toLowerCase();
  const named = calendarIds.find((id) => id.trim().toLowerCase() === email);
  if (named) return named;
  return calendarIds.length === 1 ? calendarIds[0]! : null;
}

/** What a recorded change says Slate did. */
export type InviteAction =
  | "revert"
  | "leave_second_move"
  | "leave_near_start"
  | "report_resize"
  | "report_launch"
  /** #3925: a first move found on a FULL read of the calendar, which cannot say when it moved. */
  | "report_full_read";

/** How a revert went. Null for every other action, and for a revert not yet finished. */
export type InviteOutcome = "reverted" | "revert_refused" | "event_gone";

/** One row of `booking_invite_changes`, as the decision reads it. */
export interface InviteChangeRecord {
  id: string;
  kind: "moved" | "resized";
  /** 1 for the booking's first move, 2 for its second; null for an end only change. */
  moveNumber: number | null;
  action: InviteAction;
  outcome: InviteOutcome | null;
  eventStartsAt: string;
  eventEndsAt: string;
  /** Google's `updated` stamp on the event when the change was seen. */
  eventUpdated: string;
}

export type InviteDecision =
  | { kind: "nothing"; why: "in-step" | "not-held" | "past" | "already-recorded" | "standing" }
  | {
      kind: "record";
      change: { kind: "moved" | "resized"; moveNumber: number | null; action: InviteAction };
    };

function near(a: string, b: string): boolean {
  const am = parseStampMs(a);
  const bm = parseStampMs(b);
  return am !== null && bm !== null && Math.abs(am - bm) <= INVITE_MOVE_TOLERANCE_MS;
}

/**
 * Whether a recorded move is still STANDING, so the same moved invite seen again
 * (the lead accepting it changes `updated` and nothing else) is not a new move.
 * Every action but a successful revert leaves the move standing. A revert whose
 * outcome was never written counts as done: if it in fact failed, a later sighting
 * is counted as a second move and escalated to people, which is the side that never
 * moves or emails a lead.
 */
function stillStanding(r: InviteChangeRecord): boolean {
  if (r.action !== "revert") return true;
  return r.outcome === "revert_refused" || r.outcome === "event_gone";
}

/**
 * What to do about an invite read LIVE from Google against the booking read fresh,
 * given every change already recorded for the booking (oldest first).
 */
export function decideInviteChange(input: {
  event: GoogleEvent;
  booked: { startsAt: string; endsAt: string };
  prior: InviteChangeRecord[];
  nowMs: number;
  timeZone?: string;
}): InviteDecision {
  const step = judgeInvite(input.event, input.booked, input.timeZone);
  if (step === "in-step" || step === "not-held") return { kind: "nothing", why: step };
  const bookedStart = parseStampMs(input.booked.startsAt);
  const bookedEnd = parseStampMs(input.booked.endsAt);
  // A call that has ended has nothing left to put right.
  if (bookedEnd !== null && bookedEnd <= input.nowMs) return { kind: "nothing", why: "past" };
  const updated = input.event.updated ?? "";
  if (updated !== "" && input.prior.some((r) => r.eventUpdated === updated)) {
    return { kind: "nothing", why: "already-recorded" };
  }
  const win = eventWindow(input.event, input.timeZone ?? "UTC")!;

  if (step === "resized") {
    const lastResize = [...input.prior].reverse().find((r) => r.kind === "resized");
    if (lastResize && near(lastResize.eventEndsAt, win.end)) return { kind: "nothing", why: "standing" };
    return { kind: "record", change: { kind: "resized", moveNumber: null, action: "report_resize" } };
  }

  const moves = input.prior.filter((r) => r.kind === "moved" && r.moveNumber !== null);
  const last = moves.reduce<InviteChangeRecord | null>(
    (best, r) => (best === null || (r.moveNumber ?? 0) > (best.moveNumber ?? 0) ? r : best),
    null,
  );
  if (last && stillStanding(last) && near(last.eventStartsAt, win.start)) {
    return { kind: "nothing", why: "standing" };
  }
  const moveNumber = (last?.moveNumber ?? 0) + 1;
  if (moveNumber >= 2) return { kind: "record", change: { kind: "moved", moveNumber, action: "leave_second_move" } };
  // An unreadable booked start cannot be judged near or far, so it is left: putting
  // an invite back is the one action here that emails a lead.
  if (bookedStart === null || bookedStart - input.nowMs <= NEAR_START_MS) {
    return { kind: "record", change: { kind: "moved", moveNumber, action: "leave_near_start" } };
  }
  return { kind: "record", change: { kind: "moved", moveNumber, action: "revert" } };
}

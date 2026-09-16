import { OWNER_REFUSALS, type OwnerRefusal } from "@/lib/handoffs/kinds";
import { recordHandoff, type HandoffWriter, type RecordHandoffOutcome } from "@/lib/handoffs/record";

/**
 * Whether the lead's owner may take a call the MACHINE contact-owner path is asking
 * Slate to move onto them (#2370, #2307 phase 4).
 *
 * Before this, three different situations all answered one silent 404: an owner
 * Slate has never heard of, an owner who is out of the bookable pool, and a read
 * that FAILED. Nobody heard any of them, and an owner move could undo a coverage
 * move made because that owner was on approved time off. Dan settled it on
 * 2026-09-15: the machine path REFUSES, the booking stays exactly where it is, and
 * the refusal is recorded as a handoff so a person decides what happens next.
 *
 * Three rules hold this together:
 *
 *  - **A failed read is never a refusal.** Every dep here THROWS on a read error
 *    and the guard turns that into `OwnerReassignUnavailableError`, which the route
 *    answers 503 so the caller retries. A null owner from a failed read is
 *    indistinguishable from "no such owner", and an empty time off answer from
 *    "nobody is away" (#277, #1152), which is the whole class this guard would
 *    otherwise join.
 *  - **A refusal is recorded before it is reported.** `recordHandoff` is idempotent
 *    on the database's partial unique index, so a retried caller is told
 *    `already-recorded` rather than opening a second row. A failed WRITE is loud
 *    for the same reason a failed read is: answering "refused, and somebody has
 *    been told" when nobody has is the silence the handoff table exists to end.
 *  - **Only this path runs it.** Admin coverage, bulk redistribute and the
 *    offboarding sweep all reach `orchestration.reassignBooking` directly, which
 *    knows nothing about any of this: a manager moving a call onto somebody out of
 *    the pool is the deliberate act the admin path exists for. The composition
 *    below (`reassignForContactOwner`) is what makes the check inseparable from the
 *    machine path rather than something each call site opts into (L621).
 *
 * Nothing here is a client of Supabase: the live reads are wired in
 * `src/lib/booking/service.ts`, so every outcome is driven by hand written fakes in
 * `scripts/test-owner-reassign-guard.ts`.
 */

/** The booking as this decision needs to see it. */
export interface OwnerReassignBooking {
  id: string;
  status: string;
  startsAt: string;
  endsAt: string;
  assignedUserId: string | null;
}

/** The owner as this decision needs to see them. */
export interface OwnerCandidate {
  id: string;
  email: string | null;
  bookable: boolean;
  deactivatedAt: string | null;
}

/** Which step could not be completed. Each sends a reader somewhere different. */
export const OWNER_GUARD_STAGES = ["booking", "owner", "time-off", "handoff"] as const;
export type OwnerGuardStage = (typeof OWNER_GUARD_STAGES)[number];

const STAGE_SENTENCE: Record<OwnerGuardStage, string> = {
  booking: "the booking could not be read",
  owner: "the requested owner could not be looked up",
  "time-off": "the requested owner's approved time off could not be read",
  handoff: "the refusal could not be recorded",
};

export interface OwnerReassignGuardDeps {
  /** The booking, or null when there is none. THROWS on a read error. */
  loadBooking(bookingId: string): Promise<OwnerReassignBooking | null>;
  /** The owner by the address the caller named, or null when Slate has no user for
   *  it. THROWS on a read error, which is the point: see the note above. */
  findOwner(email: string): Promise<OwnerCandidate | null>;
  /** Whether this user has APPROVED time off overlapping [startsAt, endsAt).
   *  THROWS on a read error. */
  hasApprovedTimeOff(userId: string, startsAt: string, endsAt: string): Promise<boolean>;
  /** Where a refusal is recorded. Throws on a real write failure. */
  handoffWriter: HandoffWriter;
}

/** Why the move was allowed to go ahead. Named, so a log says which (L11). */
export const OWNER_PROCEED_REASONS = [
  /** Slate has no such booking: the move itself answers the existing 404. */
  "booking-unknown",
  /** Cancelled or completed: the move itself answers the existing 409. */
  "booking-not-active",
  /** The owner already holds it, so the move is the existing 200 no-op. */
  "owner-already-assigned",
  /** Measured: the owner is bookable and has no approved time off over the call. */
  "owner-can-take-it",
] as const;
export type OwnerProceedReason = (typeof OWNER_PROCEED_REASONS)[number];

export type OwnerReassignDecision =
  | { decision: "proceed"; reason: OwnerProceedReason }
  | { decision: "refused"; refusal: OwnerRefusal; handoff: RecordHandoffOutcome };

/**
 * What the caller is told, per refusal. The status follows the classification
 * `reassign-http.ts` already publishes: a 404 is bad input (stop, the id or address
 * is wrong), a 409 is a genuine conflict (stop, and retrying changes nothing until
 * a person acts). So an owner Slate has never heard of stays the 404 it is today,
 * and an owner who exists but may not take this call is a 409: the caller sent a
 * valid request and Slate refused it, which is not the same event as a typo.
 */
export const OWNER_REFUSAL_CODE: Record<OwnerRefusal, string> = {
  "owner-not-found": "OWNER_NOT_FOUND",
  "owner-not-bookable": "OWNER_NOT_BOOKABLE",
  "owner-on-time-off": "OWNER_ON_TIME_OFF",
};

export const OWNER_REFUSAL_STATUS: Record<OwnerRefusal, number> = {
  "owner-not-found": 404,
  "owner-not-bookable": 409,
  "owner-on-time-off": 409,
};

export const OWNER_REFUSAL_MESSAGE: Record<OwnerRefusal, string> = {
  "owner-not-found": "Slate has no advisor with that address, so the booking was not moved.",
  "owner-not-bookable": "That advisor cannot take bookings, so the booking was not moved.",
  "owner-on-time-off":
    "That advisor has approved time off covering this appointment, so the booking was not moved.",
};

/** A step of the check could not be completed, so nothing was decided. Retriable. */
export class OwnerReassignUnavailableError extends Error {
  readonly stage: OwnerGuardStage;
  constructor(stage: OwnerGuardStage, cause: unknown) {
    super(`owner reassign check incomplete: ${STAGE_SENTENCE[stage]}`, { cause });
    this.name = "OwnerReassignUnavailableError";
    this.stage = stage;
  }
}

/** Slate measured the owner and refused. The booking is where it was. */
export class OwnerReassignRefusedError extends Error {
  readonly refusal: OwnerRefusal;
  readonly handoff: RecordHandoffOutcome;
  constructor(refusal: OwnerRefusal, handoff: RecordHandoffOutcome) {
    super(OWNER_REFUSAL_MESSAGE[refusal]);
    this.name = "OwnerReassignRefusedError";
    this.refusal = refusal;
    this.handoff = handoff;
  }
}

/** Run one step of the check, keeping WHICH step failed rather than the fact one did. */
async function step<T>(stage: OwnerGuardStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new OwnerReassignUnavailableError(stage, err);
  }
}

export interface OwnerReassignInput {
  bookingId: string;
  /** The owner as the caller named them: an advisor's work address. */
  ownerEmail: string;
}

/**
 * Decide, and record the refusal when there is one.
 *
 * The order is load bearing. The booking is read first, because a handoff is a row
 * ABOUT a booking and there is nothing to record against one that does not exist,
 * and because a booking nobody can move is not a refusal to hear about. The
 * assignee comparison then comes before the owner's own state, so the existing
 * "they already hold it" no-op cannot be turned into a refusal by that same owner
 * being away today.
 */
export async function decideOwnerReassign(
  input: OwnerReassignInput,
  deps: OwnerReassignGuardDeps,
): Promise<OwnerReassignDecision> {
  const booking = await step("booking", () => deps.loadBooking(input.bookingId));
  if (!booking) return { decision: "proceed", reason: "booking-unknown" };
  // The same pair `orchestration.reassignBooking` refuses on, so a terminal booking
  // keeps answering 409 through its one owner rather than two conditions drifting.
  if (booking.status === "cancelled" || booking.status === "completed") {
    return { decision: "proceed", reason: "booking-not-active" };
  }

  const owner = await step("owner", () => deps.findOwner(input.ownerEmail));
  if (!owner) {
    return refuse(input, deps, "owner-not-found", null);
  }
  if (owner.id === booking.assignedUserId) {
    return { decision: "proceed", reason: "owner-already-assigned" };
  }
  // `deactivated_at` is the orthogonal axis (#265): somebody who has left is never
  // routable whatever `bookable` says, and an owner row carrying no address cannot
  // be put on a calendar at all. All three are one thing to the reader: this
  // advisor cannot take bookings.
  if (!owner.email || !owner.bookable || owner.deactivatedAt !== null) {
    return refuse(input, deps, "owner-not-bookable", owner.id);
  }

  const away = await step("time-off", () =>
    deps.hasApprovedTimeOff(owner.id, booking.startsAt, booking.endsAt),
  );
  if (away) return refuse(input, deps, "owner-on-time-off", owner.id);

  return { decision: "proceed", reason: "owner-can-take-it" };
}

async function refuse(
  input: OwnerReassignInput,
  deps: OwnerReassignGuardDeps,
  refusal: OwnerRefusal,
  ownerUserId: string | null,
): Promise<OwnerReassignDecision> {
  const handoff = await step("handoff", () =>
    recordHandoff(deps.handoffWriter, {
      bookingId: input.bookingId,
      kind: "owner-reassign-refused",
      detail: {
        refusal,
        requestedOwnerUserId: ownerUserId,
        // The address the CALLER used. When Slate has no user for it that is the
        // only handle anybody has; when it does, it is still what the automation
        // will be looked up by.
        requestedOwnerEmail: input.ownerEmail,
      },
    }),
  );
  return { decision: "refused", refusal, handoff };
}

/** Throw on a refusal rather than returning it, for a caller that only moves on. */
export async function assertOwnerMayTakeBooking(
  input: OwnerReassignInput,
  deps: OwnerReassignGuardDeps,
): Promise<void> {
  const decision = await decideOwnerReassign(input, deps);
  if (decision.decision === "refused") {
    throw new OwnerReassignRefusedError(decision.refusal, decision.handoff);
  }
}

/**
 * The machine contact-owner reassign: check, then move, and move ONLY on a proceed.
 *
 * This composition is the guarantee, not a convenience. Keeping the two steps in
 * one tested function is what stops "did it actually stay put" resting on the
 * ordering of two lines in an untested service wrapper (L3).
 */
export async function reassignForContactOwner<T>(
  input: OwnerReassignInput,
  deps: OwnerReassignGuardDeps,
  move: () => Promise<T>,
): Promise<T> {
  await assertOwnerMayTakeBooking(input, deps);
  return move();
}

/** Every refusal, for a caller enumerating them. Re-exported so the HTTP layer and
 *  the docs take the vocabulary from one place. */
export { OWNER_REFUSALS };
export type { OwnerRefusal };

// #3582 Phase 3 (pure core): the demotion debounce lifecycle.
//
// A Twilio tier/backend narrowing makes an agent unable to serve SOME of the bookings they
// hold, unlike a Redistribute pool exit which makes them unable to serve ANY. So this mirrors
// the #3599 redistribute sweep (mark on first sight, debounce, sweep on a later sync, clear on a
// flap) but the sweep is PARTIAL: it moves only the bookings the agent lost (the filtered
// snapshot in `demotion-snapshot.ts`), and the agent is never taken out of the pool.
//
// The eligibility verdicts are the shipped pure functions `bookingsToReroute` (a CONFIRMED
// narrowing: served before, not after) and `unservedBookingIds` (the agent cannot currently
// serve a held booking), so this can never judge eligibility differently from the booker (L263,
// L342). The stamp is stable and read back, never minted per run, so a retried sync converges on
// one sweep under the `(out_user_id, demotion_marked_at)` unique index (#3614).
import type { Attributes } from "@/lib/db/types";
import {
  bookingsToReroute,
  unservedBookingIds,
  type RerouteCandidate,
} from "@/lib/booking/reroute-eligibility";

/** The agent attribute holding the moment a demotion was recorded (migration 0178 keys the
 *  coverage sweep's unique index on it). The window start and the idempotency key both. */
export const DEMOTION_MARK_KEY = "demotion_marked_at";

/** The agent attribute recording that the demotion sweep has run for the current mark, so
 *  `sweep-overdue` fires ONCE (mirrors `redistribute_swept_at`, #3599). */
export const DEMOTION_SWEPT_KEY = "demotion_swept_at";

/**
 * How long the demotion mark must have been stored before the sweep moves the agent's lost-pool
 * calls (#3599's reasoning, for the partial case). Moving a customer's call is disruptive and
 * not cheap to undo, so it waits a sync: a tag that flaps back within the window is cleared by
 * `clear` before any call moves. Equal to the redistribute debounce: comfortably under the
 * hourly cadence (the next scheduled sync still confirms) and over a rapid manual re-run.
 */
export const DEMOTION_SWEEP_DEBOUNCE_MS = 30 * 60_000;

/**
 * How long after the mark a demoted agent may legitimately still be holding their lost-pool
 * calls before `inactive_agent_bookings` should treat them as abandoned rather than mid-sweep
 * (#3599's grace, for the partial case). The debounce plus a few dropped scheduled runs; past
 * this, an unswept mark is a sweep that genuinely is not running and the backstop pages.
 */
export const DEMOTION_SWEEP_PENDING_GRACE_MS = 4 * 60 * 60_000;

/**
 * The attributes with the demotion mark on, stamped `markedAtIso`. A stale swept marker from a
 * PREVIOUS demotion is dropped, so a new cycle starts its own debounce and sweep rather than
 * reading as already done (#3599).
 */
export function withDemotionMark(attributes: Attributes | null, markedAtIso: string): Attributes {
  const next: Attributes = { ...(attributes ?? {}), [DEMOTION_MARK_KEY]: markedAtIso };
  delete next[DEMOTION_SWEPT_KEY];
  return next;
}

/** The attributes with the demotion mark and its swept marker removed, so a flapped or resolved
 *  demotion leaves no trace and a later one starts clean. */
export function withoutDemotionMark(attributes: Attributes | null): Attributes {
  const next: Attributes = { ...(attributes ?? {}) };
  delete next[DEMOTION_MARK_KEY];
  delete next[DEMOTION_SWEPT_KEY];
  return next;
}

/** The attributes with the sweep recorded as done, stamped `sweptAtIso`. KEEPS the mark, so the
 *  enqueue key `(out_user_id, demotion_marked_at)` stays stable for convergence on a retry. */
export function withDemotionSwept(attributes: Attributes | null, sweptAtIso: string): Attributes {
  return { ...(attributes ?? {}), [DEMOTION_SWEPT_KEY]: sweptAtIso };
}

/**
 * The demotion stamp stored for this row, or null when there is nothing usable. A value that is
 * not a readable instant cannot key anything, so it reads as null rather than being carried into
 * the database as a corrupt key (`Date.parse` answers NaN for an unreadable string, L50).
 */
export function storedDemotionStamp(attributes: Attributes | null | undefined): string | null {
  const raw = attributes?.[DEMOTION_MARK_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

/** Whether the sweep has already run for the mark this row carries. */
export function isDemotionSwept(attributes: Attributes | null | undefined): boolean {
  const raw = attributes?.[DEMOTION_SWEPT_KEY];
  return typeof raw === "string" && raw.trim() !== "";
}

/**
 * Whether the mark has been stored long enough for the sweep to move the agent's calls. An
 * unreadable instant answers NaN and every comparison with NaN is false, so it reads as NOT
 * aged and the sweep holds off rather than moving a call on a corrupt key (L50).
 */
export function demotionMarkAgedPastDebounce(markedAtIso: string, nowIso: string): boolean {
  return Date.parse(nowIso) - Date.parse(markedAtIso) >= DEMOTION_SWEEP_DEBOUNCE_MS;
}

/**
 * Whether this agent's lost-pool calls are being handled by a debounced demotion sweep that has
 * not yet run: marked, not yet swept, and the mark young enough that the sweep is still
 * legitimately pending. Such an agent is deliberately holding their calls for the automatic
 * sweep, not abandoned, so `inactive_agent_bookings` leaves them to it. Once swept, or once the
 * mark ages past the grace, a sweep that never ran is a real stuck pipeline the backstop catches.
 */
export function demotionSweepPending(attributes: Attributes | null | undefined, nowIso: string): boolean {
  if (isDemotionSwept(attributes)) return false;
  const markedAtIso = storedDemotionStamp(attributes);
  if (markedAtIso === null) return false;
  return Date.parse(nowIso) - Date.parse(markedAtIso) < DEMOTION_SWEEP_PENDING_GRACE_MS;
}

/**
 * What the demotion lifecycle does for one agent this sync:
 *  - `stamp`: a confirmed narrowing with no mark yet; stamp `demotion_marked_at` with the write.
 *  - `sweep-overdue`: the mark aged past the debounce, the agent still cannot serve a held
 *    booking, and it has not swept yet; enqueue the filtered move and record it swept.
 *  - `clear`: a mark exists but the agent now serves everything they hold (re-widened, or the
 *    booking moved); drop the mark, move nobody.
 *  - `none`: nothing to do (within the debounce, already swept, no narrowing, or an unknown read).
 */
export type DemotionAction =
  | { kind: "none" }
  | { kind: "stamp"; markedAtIso: string }
  | { kind: "sweep-overdue"; markedAtIso: string }
  | { kind: "clear" };

/**
 * Decide the demotion action for one agent (#3582, Phase 3). Pure, so every branch is driven by
 * `scripts/test-demotion-plan.ts`.
 *
 * `before` is the agent's stored attributes (carrying any mark), `after` is the attributes about
 * to be written this sync (the narrowed tiers), and `candidates` are the agent's upcoming
 * bookings. `nowIso` is injected, so the stamp is a value a test can assert on.
 *
 * Fail-safe: a null/undefined `after` (a failed or partial read) does NOTHING, so a bad read can
 * neither stamp, sweep, nor (crucially) CLEAR an existing mark and lose a pending demotion (L214,
 * L50). An existing mark is never cleared on an unknown read.
 */
export function planDemotionAction(
  before: Attributes | null | undefined,
  after: Attributes | null | undefined,
  candidates: RerouteCandidate[],
  nowIso: string,
): DemotionAction {
  // An unknown current read: judge nothing, and above all never clear a pending mark.
  if (after == null) return { kind: "none" };

  const stamp = storedDemotionStamp(before);
  if (stamp !== null) {
    // Does the agent still fail to serve a booking they hold? (one-sided, current attributes)
    const stillUnserved = unservedBookingIds(after, candidates).length > 0;
    if (!stillUnserved) return { kind: "clear" };
    if (isDemotionSwept(before)) return { kind: "none" };
    if (demotionMarkAgedPastDebounce(stamp, nowIso)) return { kind: "sweep-overdue", markedAtIso: stamp };
    return { kind: "none" };
  }

  // No mark yet: stamp only on a CONFIRMED narrowing (served before, not after), never on a
  // pre-existing mis-assignment nothing changed.
  const narrowed = bookingsToReroute(before, after, candidates).length > 0;
  return narrowed ? { kind: "stamp", markedAtIso: nowIso } : { kind: "none" };
}

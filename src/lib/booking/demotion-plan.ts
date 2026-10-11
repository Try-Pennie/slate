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
 * The agent attributes holding the debt tiers and backend the agent carried BEFORE the demotion
 * (#3615). By the time the sweep moves a call (a sync at least the debounce after the stamp) the
 * stored attributes already hold the NARROWED values, so the change that moved the call is
 * recorded nowhere unless the stamp saves it. They are written in the SAME write as the mark and
 * dropped with it. Two flat keys rather than one object, because an attribute value is a scalar
 * or a list of strings.
 */
export const DEMOTION_FROM_DEBT_KEY = "demotion_from_debt_team";
export const DEMOTION_FROM_BACKEND_KEY = "demotion_from_backend_service";

/**
 * The reason a demotion sweep's moves carry (#3615). The move runs the standard reassign, which
 * sends `booking.reassigned` to Regal with this as `reassignReason`, so it is the code every
 * coverage sweep already sends: settled with Dan, a demotion move is no new lead message, and a
 * new code would reach a Regal journey branch nobody built.
 */
export const DEMOTION_SWEEP_REASON = { code: "coverage", detail: null } as const;

/** The two routing facts a demotion can narrow (legal eligibility is retired as a trigger). */
export interface DemotionTiers {
  debtTeam: string[];
  backendService: string[];
}

/** What a demotion changed: the tiers saved at the stamp, and the tiers the sweep acted on. */
export interface DemotionChange {
  from: DemotionTiers;
  to: DemotionTiers;
}

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

/** The debt tiers and backend an attribute set carries, as lists. */
export function demotionTiersOf(attributes: Attributes | null | undefined): DemotionTiers {
  return { debtTeam: asList(attributes?.debt_team), backendService: asList(attributes?.backend_service) };
}

/**
 * The attributes with the demotion mark on, stamped `markedAtIso`, carrying `from`, the tiers the
 * agent held before this narrowing (#3615). A stale swept marker from a PREVIOUS demotion is
 * dropped, so a new cycle starts its own debounce and sweep rather than reading as already done
 * (#3599), and `from` replaces any earlier cycle's, so the audit names THIS cycle's change.
 */
export function withDemotionMark(attributes: Attributes | null, markedAtIso: string, from: DemotionTiers): Attributes {
  const next: Attributes = {
    ...(attributes ?? {}),
    [DEMOTION_MARK_KEY]: markedAtIso,
    [DEMOTION_FROM_DEBT_KEY]: [...from.debtTeam],
    [DEMOTION_FROM_BACKEND_KEY]: [...from.backendService],
  };
  delete next[DEMOTION_SWEPT_KEY];
  return next;
}

/** The attributes with the demotion mark, its swept marker and its saved tiers removed, so a
 *  flapped or resolved demotion leaves no trace and a later one starts clean. */
export function withoutDemotionMark(attributes: Attributes | null): Attributes {
  const next: Attributes = { ...(attributes ?? {}) };
  delete next[DEMOTION_MARK_KEY];
  delete next[DEMOTION_SWEPT_KEY];
  delete next[DEMOTION_FROM_DEBT_KEY];
  delete next[DEMOTION_FROM_BACKEND_KEY];
  return next;
}

/**
 * The tiers saved at the stamp, or null when this row carries none. A mark stamped before #3615
 * saved nothing, and that must read as UNKNOWN rather than as "held no tiers", which would state
 * a change that never happened. Both keys are required: an empty list is a real answer, an
 * absent key is not.
 */
export function storedDemotionFrom(attributes: Attributes | null | undefined): DemotionTiers | null {
  const debt = attributes?.[DEMOTION_FROM_DEBT_KEY];
  const backend = attributes?.[DEMOTION_FROM_BACKEND_KEY];
  if (debt === undefined || backend === undefined) return null;
  return { debtTeam: asList(debt), backendService: asList(backend) };
}

/**
 * The change a demotion sweep acts on, for its job record (#3615): the tiers saved at the stamp
 * and the tiers on the attributes the sweep is moving calls under. Null when nothing was saved,
 * so the record says "not recorded" instead of inventing a before.
 */
export function demotionChangeOf(attributes: Attributes | null | undefined): DemotionChange | null {
  const from = storedDemotionFrom(attributes);
  if (from === null) return null;
  return { from, to: demotionTiersOf(attributes) };
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

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null) return [];
  return [String(v)];
}

/**
 * A CHEAP, attribute-only check for whether a change COULD narrow eligibility: a debt_team value
 * was lost, or the backend_service set changed at all (a positive bucket loses it, a negated bucket
 * gains an exclusion). A pure widening (only tiers gained, backend unchanged) returns false.
 *
 * This is deliberately an over-approximation of `bookingsToReroute`, used ONLY when the precise
 * candidate read failed, to decide whether to stamp DEFENSIVELY so a real narrowing is not written
 * away unexamined. A false positive costs a stamp the next sync's sweep pass clears; a false
 * negative would strand a customer, so it errs toward stamping (L648). Unknown (null) either side
 * returns false, since nothing can be said.
 */
export function mayNarrowEligibility(
  before: Attributes | null | undefined,
  after: Attributes | null | undefined,
): boolean {
  if (before == null || after == null) return false;
  const afterDebt = new Set(asList(after.debt_team));
  const lostTier = asList(before.debt_team).some((v) => !afterDebt.has(v));
  const backendChanged =
    asList(before.backend_service).sort().join("\u0000") !==
    asList(after.backend_service).sort().join("\u0000");
  return lostTier || backendChanged;
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
  | { kind: "stamp"; markedAtIso: string; from: DemotionTiers }
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

  // A CONFIRMED narrowing THIS sync (served before, not after). A fresh narrowing starts a new
  // cycle even over an already-swept mark, so a second demotion of the same agent is not swallowed.
  const narrowedThisSync = bookingsToReroute(before, after, candidates).length > 0;

  const stamp = storedDemotionStamp(before);
  if (stamp !== null) {
    if (isDemotionSwept(before)) {
      // The previous cycle's calls were already moved. A fresh narrowing this sync is a NEW
      // demotion: re-stamp (dated now), which drops the stale swept marker and starts its own
      // debounce and sweep, so the newly-lost bookings are not left behind (#3599, the redistribute
      // "new cycle after a completed one" rule).
      if (narrowedThisSync) return { kind: "stamp", markedAtIso: nowIso, from: demotionTiersOf(before) };
      // No new narrowing: once the agent serves everything they hold again (the swept calls moved,
      // or they re-widened), clear the spent mark; otherwise leave it (do not re-sweep).
      if (unservedBookingIds(after, candidates).length === 0) return { kind: "clear" };
      return { kind: "none" };
    }
    // A pending (unswept) cycle. Clear if the agent serves everything again; sweep once aged;
    // otherwise hold through the debounce.
    if (unservedBookingIds(after, candidates).length === 0) return { kind: "clear" };
    if (demotionMarkAgedPastDebounce(stamp, nowIso)) return { kind: "sweep-overdue", markedAtIso: stamp };
    return { kind: "none" };
  }

  // No mark yet: stamp only on a CONFIRMED narrowing, never on a pre-existing mis-assignment
  // nothing changed.
  return narrowedThisSync ? { kind: "stamp", markedAtIso: nowIso, from: demotionTiersOf(before) } : { kind: "none" };
}

/**
 * Turn a `DemotionAction` into the write it needs: the attributes to store this sync (the
 * narrowed-tier attributes `after` with the mark folded in, swept, or cleared) and, for a
 * sweep, the stamp to key the enqueue on. Returns null for `none`, so the caller writes
 * nothing for a row the lifecycle leaves alone.
 *
 * Pure, and the stamp travels WITH the tier attributes in one write (the migration's rule),
 * so a run that dies between the two leaves one consistent row rather than a stamp without its
 * tiers or the reverse.
 */
export function applyDemotionAction(
  after: Attributes,
  action: DemotionAction,
  nowIso: string,
): { attributes: Attributes; sweepMarkedAtIso: string | null } | null {
  switch (action.kind) {
    case "none":
      return null;
    case "stamp":
      return { attributes: withDemotionMark(after, action.markedAtIso, action.from), sweepMarkedAtIso: null };
    case "sweep-overdue":
      return { attributes: withDemotionSwept(after, nowIso), sweepMarkedAtIso: action.markedAtIso };
    case "clear":
      return { attributes: withoutDemotionMark(after), sweepMarkedAtIso: null };
  }
}

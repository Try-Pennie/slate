// #3582 Phase 3 (pure core): the demotion debounce lifecycle, mirroring the #3599 redistribute
// sweep but for a PARTIAL eligibility narrowing rather than a pool exit. All pure, driven here.
//
// The lifecycle: a confirmed narrowing STAMPS demotion_marked_at in the same write as the
// narrowed tiers; a LATER sync, once the stamp has aged past the debounce and the agent still
// cannot serve a held booking, SWEEPS (enqueues the filtered move) and records it done; a tag
// that flaps back before the sweep CLEARS the stamp and moves nobody. The stamp is stable and
// read back, never minted per run, so a retried sync converges on one sweep (#3614).
import {
  applyDemotionAction,
  DEMOTION_FROM_BACKEND_KEY,
  DEMOTION_FROM_DEBT_KEY,
  DEMOTION_MARK_KEY,
  DEMOTION_SWEEP_REASON,
  demotionChangeOf,
  storedDemotionFrom,
  type DemotionTiers,
  DEMOTION_SWEEP_DEBOUNCE_MS,
  DEMOTION_SWEEP_PENDING_GRACE_MS,
  DEMOTION_SWEPT_KEY,
  demotionMarkAgedPastDebounce,
  demotionSweepPending,
  isDemotionSwept,
  mayNarrowEligibility,
  planDemotionAction,
  storedDemotionStamp,
  withDemotionMark,
  withDemotionSwept,
  withoutDemotionMark,
} from "../src/lib/booking/demotion-plan.ts";
import type { RerouteCandidate } from "../src/lib/booking/reroute-eligibility.ts";
import { REASSIGN_REASONS } from "../src/lib/booking/core.ts";
import type { Attributes } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T0 = "2026-10-01T12:00:00.000Z";
const AGED = "2026-10-01T12:40:00.000Z"; // 40 min later, past the 30 min debounce
const YOUNG = "2026-10-01T12:10:00.000Z"; // 10 min later, inside the debounce

// before: serves ultra_high and high. after: demoted to high only.
const before: Attributes = { debt_team: ["ultra_high", "high"] };
const afterDemoted: Attributes = { debt_team: ["high"] };
const UH: RerouteCandidate = {
  bookingId: "uh1",
  kind: "round_robin",
  criteria: { debt_team: "ultra_high" },
  isManualMember: false,
};
const HI: RerouteCandidate = {
  bookingId: "hi1",
  kind: "round_robin",
  criteria: { debt_team: "high" },
  isManualMember: false,
};

// --- attribute mark helpers (mirror of withMark/withoutMark/withSwept) ------

{
  const marked = withDemotionMark({ debt_team: ["high"], [DEMOTION_SWEPT_KEY]: "stale" }, T0, { debtTeam: ["high"], backendService: [] });
  eq(marked[DEMOTION_MARK_KEY], T0, "withDemotionMark stamps the mark");
  eq(marked[DEMOTION_SWEPT_KEY], undefined, "withDemotionMark drops a stale swept marker so a new cycle sweeps afresh");
  eq((marked.debt_team as string[]).join(","), "high", "withDemotionMark preserves the other attributes");
}

{
  const cleared = withoutDemotionMark({ debt_team: ["high"], [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED });
  eq(cleared[DEMOTION_MARK_KEY], undefined, "withoutDemotionMark drops the mark");
  eq(cleared[DEMOTION_SWEPT_KEY], undefined, "withoutDemotionMark drops the swept marker too, so a later demotion starts clean");
}

{
  const swept = withDemotionSwept({ [DEMOTION_MARK_KEY]: T0 }, AGED);
  eq(swept[DEMOTION_SWEPT_KEY], AGED, "withDemotionSwept records the sweep");
  eq(swept[DEMOTION_MARK_KEY], T0, "withDemotionSwept KEEPS the mark, so the enqueue key stays stable for convergence");
}

{
  eq(storedDemotionStamp({ [DEMOTION_MARK_KEY]: T0 }), T0, "storedDemotionStamp reads a readable instant");
  eq(storedDemotionStamp({ [DEMOTION_MARK_KEY]: "not-a-date" }), null, "an unreadable stamp reads as null, never a corrupt key");
  eq(storedDemotionStamp({}), null, "no stamp reads as null");
  assert(!isDemotionSwept({ [DEMOTION_MARK_KEY]: T0 }), "a marked, unswept row is not swept");
  assert(isDemotionSwept({ [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED }), "a swept row reads as swept");
}

{
  assert(!demotionMarkAgedPastDebounce(T0, YOUNG), "a young mark has not aged past the debounce");
  assert(demotionMarkAgedPastDebounce(T0, AGED), "a mark older than the debounce has aged");
  assert(!demotionMarkAgedPastDebounce("not-a-date", AGED), "an unreadable mark reads as NOT aged (NaN), so the sweep holds off");
  eq(DEMOTION_SWEEP_DEBOUNCE_MS, 30 * 60_000, "the debounce matches the redistribute sweep window");
}

// --- demotionSweepPending (inactive-agent backstop tolerance) ---------------

{
  const markedYoung: Attributes = { [DEMOTION_MARK_KEY]: T0 };
  assert(demotionSweepPending(markedYoung, YOUNG), "a young unswept demotion mark is pending, so the backstop leaves it to the sweep");
  assert(!demotionSweepPending({ [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED }, YOUNG), "a swept mark is no longer pending");
  assert(!demotionSweepPending({}, YOUNG), "an unmarked row is not pending");
  const wayPast = new Date(Date.parse(T0) + DEMOTION_SWEEP_PENDING_GRACE_MS + 60_000).toISOString();
  assert(!demotionSweepPending(markedYoung, wayPast), "a mark older than the grace is a stuck sweep the backstop must still catch");
}

// --- planDemotionAction (the decision) -------------------------------------

{
  // A confirmed narrowing with no stamp yet STAMPS, dated now. The agent served uh1 before and
  // cannot after, so this is a real narrowing (not a pre-existing mis-assignment).
  const a = planDemotionAction(before, afterDemoted, [UH, HI], T0);
  eq(a.kind, "stamp", "a confirmed narrowing with no stamp stamps");
  if (a.kind === "stamp") eq(a.markedAtIso, T0, "the stamp is dated now");
}

{
  // A tier UPGRADE (widening) stamps nothing.
  eq(planDemotionAction(afterDemoted, before, [UH, HI], T0).kind, "none", "a widening stamps nothing");
}

{
  // No change at all, no stamp: nothing.
  eq(planDemotionAction(before, before, [UH, HI], T0).kind, "none", "no change and no stamp does nothing");
}

{
  // THE FAIL-SAFE: a null AFTER (a failed/partial read) with no stamp stamps nobody, and with a
  // stamp NEVER clears it (a bad read must not destroy a pending demotion) (L214, L50).
  eq(planDemotionAction(before, null, [UH], T0).kind, "none", "a null after with no stamp does nothing");
  const markedBefore: Attributes = { debt_team: ["high"], [DEMOTION_MARK_KEY]: T0 };
  eq(planDemotionAction(markedBefore, null, [UH], AGED).kind, "none", "a null after NEVER clears an existing stamp");
}

{
  // Stamp exists, agent still cannot serve a held booking, within the debounce: hold.
  const markedBefore: Attributes = { debt_team: ["high"], [DEMOTION_MARK_KEY]: T0 };
  eq(planDemotionAction(markedBefore, afterDemoted, [UH], YOUNG).kind, "none", "a young stamp holds (debounce)");
}

{
  // Stamp exists, still unserved, aged past debounce, not swept: SWEEP, keyed on the STORED
  // stamp (not now), so the enqueue converges on the one job.
  const markedBefore: Attributes = { debt_team: ["high"], [DEMOTION_MARK_KEY]: T0 };
  const a = planDemotionAction(markedBefore, afterDemoted, [UH], AGED);
  eq(a.kind, "sweep-overdue", "an aged, still-unserved, unswept demotion sweeps");
  if (a.kind === "sweep-overdue") eq(a.markedAtIso, T0, "the sweep keys on the STORED stamp, never now");
}

{
  // Already swept and still unserved (calls not yet drained, or unplaceable): nothing, so the
  // sweep fires ONCE.
  const sweptBefore: Attributes = { debt_team: ["high"], [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED };
  eq(planDemotionAction(sweptBefore, afterDemoted, [UH], AGED).kind, "none", "a swept demotion does not sweep again");
}

{
  // A SECOND, distinct narrowing of an already-swept agent starts a NEW cycle (re-stamp dated now),
  // so the newly-lost bookings are not swallowed by the old swept marker. Here the agent, already
  // demoted to high and swept, now loses high too; the high booking is a fresh narrowing.
  const sweptThenNarrowed: Attributes = { debt_team: ["high"], [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED };
  const a = planDemotionAction(sweptThenNarrowed, { debt_team: ["low"] }, [HI], AGED);
  eq(a.kind, "stamp", "a fresh narrowing over a swept mark re-stamps a new cycle");
  if (a.kind === "stamp") eq(a.markedAtIso, AGED, "dated now, so withDemotionMark drops the stale swept marker");
}

{
  // A swept agent who now serves everything they hold again (calls moved, or re-widened) clears the
  // spent mark.
  const sweptBefore: Attributes = { debt_team: ["ultra_high", "high"], [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED };
  eq(planDemotionAction(sweptBefore, before, [UH], AGED).kind, "clear", "a swept agent serving everything clears the spent mark");
}

{
  // Stamp exists but the agent now serves everything they hold (re-widened, or the booking was
  // moved/rescheduled): CLEAR the stamp, move nobody.
  const markedBefore: Attributes = { debt_team: ["ultra_high", "high"], [DEMOTION_MARK_KEY]: T0 };
  eq(planDemotionAction(markedBefore, before, [UH], AGED).kind, "clear", "a re-widened agent clears the stamp");
  // And once the held bookings are gone (moved by the sweep), there is nothing unserved either.
  eq(planDemotionAction(markedBefore, afterDemoted, [], AGED).kind, "clear", "no held bookings left clears the stamp");
}

// --- mayNarrowEligibility (cheap attribute check for the defensive stamp) --

{
  assert(mayNarrowEligibility(before, afterDemoted), "losing a debt tier may narrow");
  assert(!mayNarrowEligibility(afterDemoted, before), "gaining a debt tier (a widening) does not");
  assert(!mayNarrowEligibility(before, before), "no change does not narrow");
  assert(
    mayNarrowEligibility({ backend_service: ["achieve"] }, { backend_service: ["beyond"] }),
    "any backend_service change may narrow (a positive bucket loses it, a negated one gains an exclusion)",
  );
  assert(
    mayNarrowEligibility({}, { backend_service: ["achieve"] }),
    "gaining a backend value may narrow a negated bucket",
  );
  assert(!mayNarrowEligibility(null, afterDemoted), "an unknown before cannot be judged to narrow");
  assert(!mayNarrowEligibility(before, null), "an unknown after cannot be judged to narrow");
}

// --- applyDemotionAction (action -> the attribute overlay + sweep) ---------

const afterAttrs: Attributes = { debt_team: ["high"] };

{
  // none produces no write at all.
  eq(applyDemotionAction(afterAttrs, { kind: "none" }, AGED), null, "a none action produces no write");
}

{
  // stamp folds demotion_marked_at into the write; no sweep.
  const o = applyDemotionAction(afterAttrs, { kind: "stamp", markedAtIso: T0, from: { debtTeam: ["ultra_high", "high"], backendService: [] } }, AGED);
  assert(o !== null, "a stamp action produces a write");
  eq(o!.attributes[DEMOTION_MARK_KEY], T0, "the stamp is folded into the write attributes");
  eq((o!.attributes.debt_team as string[]).join(","), "high", "the write keeps the narrowed tiers");
  eq(o!.sweepMarkedAtIso, null, "a stamp enqueues no sweep");
}

{
  // sweep-overdue records swept=now AND asks for the enqueue keyed on the STORED stamp.
  const base: Attributes = { debt_team: ["high"], [DEMOTION_MARK_KEY]: T0 };
  const o = applyDemotionAction(base, { kind: "sweep-overdue", markedAtIso: T0 }, AGED);
  assert(o !== null, "a sweep-overdue action produces a write");
  eq(o!.attributes[DEMOTION_SWEPT_KEY], AGED, "the sweep records swept=now");
  eq(o!.attributes[DEMOTION_MARK_KEY], T0, "the sweep keeps the mark for convergence");
  eq(o!.sweepMarkedAtIso, T0, "the sweep enqueues keyed on the stored stamp");
}

{
  // clear drops the mark, no sweep.
  const base: Attributes = { debt_team: ["ultra_high", "high"], [DEMOTION_MARK_KEY]: T0, [DEMOTION_SWEPT_KEY]: AGED };
  const o = applyDemotionAction(base, { kind: "clear" }, AGED);
  assert(o !== null, "a clear action produces a write");
  eq(o!.attributes[DEMOTION_MARK_KEY], undefined, "clear drops the mark from the write");
  eq(o!.attributes[DEMOTION_SWEPT_KEY], undefined, "clear drops the swept marker too");
  eq(o!.sweepMarkedAtIso, null, "clear enqueues no sweep");
}

// --- the tiers held BEFORE the demotion (#3615) ------------------------------
//
// The audit row for a reroute names what changed in Twilio. By the time the sweep moves a call
// (a sync at least 30 minutes after the stamp) the stored attributes already hold the NARROWED
// tiers, so the pre-demotion ones exist nowhere unless the stamp saves them. They ride in the
// SAME write as the mark, so a stamp can never land without them.

const FROM: DemotionTiers = { debtTeam: ["ultra_high", "high"], backendService: ["achieve"] };

{
  const marked = withDemotionMark({ debt_team: ["high"] }, T0, FROM);
  eq(
    JSON.stringify(storedDemotionFrom(marked)),
    JSON.stringify(FROM),
    "withDemotionMark saves the pre-demotion tiers, and storedDemotionFrom reads them back",
  );
  const swept = withDemotionSwept(marked, AGED);
  eq(JSON.stringify(storedDemotionFrom(swept)), JSON.stringify(FROM), "the sweep keeps the pre-demotion tiers");
  const cleared = withoutDemotionMark(marked);
  eq(storedDemotionFrom(cleared), null, "a clear drops the pre-demotion tiers with the mark");
  eq(cleared[DEMOTION_FROM_DEBT_KEY], undefined, "no debt tier key is left behind by a clear");
  eq(cleared[DEMOTION_FROM_BACKEND_KEY], undefined, "no backend key is left behind by a clear");
}

{
  // An agent who held NO backend before is a real answer (an empty list), distinct from a mark
  // stamped before this change, which recorded nothing and must read as unknown, never as empty.
  const none = withDemotionMark({}, T0, { debtTeam: ["high"], backendService: [] });
  eq(JSON.stringify(storedDemotionFrom(none)?.backendService), "[]", "an empty backend list is kept as empty");
  eq(storedDemotionFrom({ [DEMOTION_MARK_KEY]: T0 }), null, "a mark with no saved tiers reads as unknown");
}

{
  // The decision carries the tiers of BEFORE on a stamp, so the write can save them.
  const beforeWithBackend: Attributes = { debt_team: ["ultra_high", "high"], backend_service: ["achieve"] };
  const a = planDemotionAction(beforeWithBackend, { debt_team: ["high"], backend_service: ["achieve"] }, [UH, HI], T0);
  eq(a.kind, "stamp", "the narrowing stamps");
  if (a.kind === "stamp") eq(JSON.stringify(a.from), JSON.stringify(FROM), "the stamp carries the tiers held before");
  const o = applyDemotionAction({ debt_team: ["high"] }, a, T0);
  eq(JSON.stringify(storedDemotionFrom(o!.attributes)), JSON.stringify(FROM), "the stamp write saves them");
}

{
  // A second narrowing over a swept mark records the tiers held before THAT narrowing, not the
  // first cycle's: the audit names the change that moved this cycle's calls.
  const sweptThenNarrowed: Attributes = {
    debt_team: ["high"],
    [DEMOTION_MARK_KEY]: T0,
    [DEMOTION_SWEPT_KEY]: AGED,
    ...withDemotionMark({}, T0, FROM),
  };
  const a = planDemotionAction(sweptThenNarrowed, { debt_team: ["low"] }, [HI], AGED);
  eq(a.kind, "stamp", "the second narrowing re-stamps");
  if (a.kind === "stamp") eq(JSON.stringify(a.from.debtTeam), JSON.stringify(["high"]), "it saves the tiers before THIS narrowing");
}

{
  // What the sweep copies onto its job: the saved tiers before, and the tiers it is acting on.
  const atSweep = withDemotionSwept(withDemotionMark({ debt_team: ["high"], backend_service: ["achieve"] }, T0, FROM), AGED);
  const change = demotionChangeOf(atSweep);
  eq(JSON.stringify(change?.from), JSON.stringify(FROM), "the change's from is the saved tiers");
  eq(JSON.stringify(change?.to), JSON.stringify({ debtTeam: ["high"], backendService: ["achieve"] }), "the change's to is the current tiers");
  eq(demotionChangeOf({ debt_team: ["high"], [DEMOTION_MARK_KEY]: T0 }), null, "no saved tiers means no change can be stated");
}

// --- the lead hears about a demotion move the way they hear about any coverage move (#3615) ---
//
// Settled with Dan 2026-10-11: no new lead message. The move runs the standard reassign, which
// sends booking.reassigned to Regal with the job's reason as reassignReason, so the reason must be
// the one every coverage sweep already sends: a new code would land in a Regal journey branch
// nobody built.
{
  eq(DEMOTION_SWEEP_REASON.code, "coverage", "a demotion move is reported to Regal as the coverage move it is");
  eq(DEMOTION_SWEEP_REASON.detail, null, "with no detail, like the redistribute sweep");
  assert(
    REASSIGN_REASONS.some((r) => r.code === DEMOTION_SWEEP_REASON.code && !r.systemOnly),
    "a reason Regal already receives from every other coverage move",
  );
}

finish();

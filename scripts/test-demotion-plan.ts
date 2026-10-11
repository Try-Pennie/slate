// #3582 Phase 3 (pure core): the demotion debounce lifecycle, mirroring the #3599 redistribute
// sweep but for a PARTIAL eligibility narrowing rather than a pool exit. All pure, driven here.
//
// The lifecycle: a confirmed narrowing STAMPS demotion_marked_at in the same write as the
// narrowed tiers; a LATER sync, once the stamp has aged past the debounce and the agent still
// cannot serve a held booking, SWEEPS (enqueues the filtered move) and records it done; a tag
// that flaps back before the sweep CLEARS the stamp and moves nobody. The stamp is stable and
// read back, never minted per run, so a retried sync converges on one sweep (#3614).
import {
  DEMOTION_MARK_KEY,
  DEMOTION_SWEEP_DEBOUNCE_MS,
  DEMOTION_SWEEP_PENDING_GRACE_MS,
  DEMOTION_SWEPT_KEY,
  demotionMarkAgedPastDebounce,
  demotionSweepPending,
  isDemotionSwept,
  planDemotionAction,
  storedDemotionStamp,
  withDemotionMark,
  withDemotionSwept,
  withoutDemotionMark,
} from "../src/lib/booking/demotion-plan.ts";
import type { RerouteCandidate } from "../src/lib/booking/reroute-eligibility.ts";
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
  const marked = withDemotionMark({ debt_team: ["high"], [DEMOTION_SWEPT_KEY]: "stale" }, T0);
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
  // Stamp exists but the agent now serves everything they hold (re-widened, or the booking was
  // moved/rescheduled): CLEAR the stamp, move nobody.
  const markedBefore: Attributes = { debt_team: ["ultra_high", "high"], [DEMOTION_MARK_KEY]: T0 };
  eq(planDemotionAction(markedBefore, before, [UH], AGED).kind, "clear", "a re-widened agent clears the stamp");
  // And once the held bookings are gone (moved by the sweep), there is nothing unserved either.
  eq(planDemotionAction(markedBefore, afterDemoted, [], AGED).kind, "clear", "no held bookings left clears the stamp");
}

finish();

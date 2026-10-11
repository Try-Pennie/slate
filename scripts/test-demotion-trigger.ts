// #3582 Phase 3: which agents the demotion trigger evaluates, and the resolution over fakes.
// Pure selection (demotionEvalList) plus resolveDemotionWrites with an injected candidate
// reader, so the branches the sync integration test does not reach (a flipped row excluded, a
// deactivated row skipped, a stamped-but-unchanged row swept) are driven here.
import { demotionEvalList, resolveDemotionWrites } from "../src/lib/twilio/demotion-trigger.ts";
import { DEMOTION_MARK_KEY } from "../src/lib/booking/demotion-plan.ts";
import type { RerouteCandidate } from "../src/lib/booking/reroute-eligibility.ts";
import type {
  AttributeWrite,
  PlannedRedistribute,
  RedistributePlan,
  TwilioChanges,
  TwilioRosterRow,
} from "../src/lib/twilio/roster-plan.ts";
import type { Attributes } from "../src/lib/db/types.ts";
import { eq, finish } from "./lib/harness.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const AGED = "2026-10-01T11:00:00.000Z"; // past the 30-min debounce

function changes(over: Partial<{ debt: boolean; backend: boolean }> = {}): TwilioChanges {
  return {
    debtTeams: { value: [], changed: over.debt ?? false },
    backendServices: { value: [], changed: over.backend ?? false },
    redistributeTagged: { value: false, changed: false, wasTagged: false },
    twilioWorkerMissingSince: { value: null, changed: false },
  };
}

function row(over: Partial<TwilioRosterRow> = {}): TwilioRosterRow {
  return { id: "u1", email: "a@x.com", bookable: true, deactivated: false, pending: false, isTest: false, attributes: {}, ...over };
}

function plan(over: Partial<RedistributePlan> = {}): RedistributePlan {
  return { flips: [], attributeWrites: [], markedWithNoWorker: [], withoutWorker: [], ...over };
}

const write = (userId: string, email: string, attributes: Attributes, ch: TwilioChanges): AttributeWrite => ({
  userId,
  email,
  attributes,
  changes: ch,
});

const flip = (userId: string): PlannedRedistribute => ({
  userId,
  email: "f@x.com",
  action: "turn-off",
  attributes: {},
  heldAttributes: null,
  changes: changes(),
  markedAtIso: NOW,
});

// --- demotionEvalList (selection) -----------------------------------------

{
  // A tier-changed attribute write is evaluated; a backend-only change too.
  const evals = demotionEvalList(
    [row({ id: "u1" }), row({ id: "u2", email: "b@x.com" })],
    plan({
      attributeWrites: [
        write("u1", "a@x.com", { debt_team: ["high"] }, changes({ debt: true })),
        write("u2", "b@x.com", { backend_service: ["beyond"] }, changes({ backend: true })),
      ],
    }),
  );
  eq(evals.map((e) => e.userId).sort().join(","), "u1,u2", "a tier or backend change is evaluated");
}

{
  // An attribute write that changed only the redistribute tag (not tiers) is NOT evaluated.
  const evals = demotionEvalList(
    [row({ id: "u1" })],
    plan({ attributeWrites: [write("u1", "a@x.com", {}, changes())] }),
  );
  eq(evals.length, 0, "a write with no tier or backend change is not evaluated");
}

{
  // A stamped row with no change this sync is evaluated (to sweep or clear).
  const evals = demotionEvalList(
    [row({ id: "u1", attributes: { debt_team: ["high"], [DEMOTION_MARK_KEY]: AGED } })],
    plan(),
  );
  eq(evals.length, 1, "a stamped unchanged row is evaluated");
  eq(evals[0].before, evals[0].after, "its before and after are the same stored attributes");
}

{
  // A FLIPPED stamped row is excluded: the redistribute full sweep covers it.
  const evals = demotionEvalList(
    [row({ id: "u1", attributes: { [DEMOTION_MARK_KEY]: AGED } })],
    plan({ flips: [flip("u1")] }),
  );
  eq(evals.length, 0, "a row being redistribute-flipped is not also demotion-evaluated");
}

{
  // A deactivated or test stamped row is skipped.
  const evals = demotionEvalList(
    [
      row({ id: "u1", deactivated: true, attributes: { [DEMOTION_MARK_KEY]: AGED } }),
      row({ id: "u2", isTest: true, attributes: { [DEMOTION_MARK_KEY]: AGED } }),
    ],
    plan(),
  );
  eq(evals.length, 0, "deactivated and test rows are never demotion-evaluated");
}

{
  // A stamped row that is ALSO an attribute write this sync is evaluated ONCE (via the write
  // branch, with the real before/after), not twice.
  const evals = demotionEvalList(
    [row({ id: "u1", attributes: { debt_team: ["ultra_high", "high"], [DEMOTION_MARK_KEY]: AGED } })],
    plan({ attributeWrites: [write("u1", "a@x.com", { debt_team: ["high"] }, changes({ debt: true }))] }),
  );
  eq(evals.length, 1, "a stamped row that also has a write this sync is evaluated once");
  eq((evals[0].after as Attributes).debt_team?.toString(), "high", "with the write's new attributes as after");
}

{
  // A stamped row whose write changed only a NON-tier fact (the redistribute tag) is still
  // evaluated (to sweep or clear), with the write's attributes as `after` so the decision judges
  // what is about to be stored. The first loop skips it (no tier change); the second must not.
  const evals = demotionEvalList(
    [row({ id: "u1", attributes: { debt_team: ["high"], [DEMOTION_MARK_KEY]: AGED } })],
    plan({
      attributeWrites: [
        write("u1", "a@x.com", { debt_team: ["high"], redistribute_tagged: "Y", [DEMOTION_MARK_KEY]: AGED }, changes()),
      ],
    }),
  );
  eq(evals.length, 1, "a stamped row with a non-tier write is still evaluated");
  eq((evals[0].after as Attributes).redistribute_tagged, "Y", "with the write's attributes as after");
  eq(evals[0].changes, null, "and no base changes (the base loop counts the write)");
}

// --- resolveDemotionWrites (over fakes) -----------------------------------

const uh: RerouteCandidate = {
  bookingId: "uh1",
  kind: "round_robin",
  criteria: { debt_team: "ultra_high" },
  isManualMember: false,
};

{
  // A confirmed narrowing (tier change this sync) becomes a STAMP OVERLAY on the core tier write,
  // not a separate write, so the stamp lands in the same write as the tiers.
  const res = await resolveDemotionWrites(
    [row({ id: "u1", attributes: { debt_team: ["ultra_high", "high"] } })],
    plan({ attributeWrites: [write("u1", "a@x.com", { debt_team: ["high"] }, changes({ debt: true }))] }),
    async () => [uh],
    NOW,
  );
  eq(res.stampOverlays.size, 1, "a narrowing produces a stamp overlay");
  eq((res.stampOverlays.get("u1") as Attributes)[DEMOTION_MARK_KEY], NOW, "the overlay carries the mark dated now");
  eq((res.stampOverlays.get("u1") as Attributes).debt_team?.toString(), "high", "and the narrowed tiers");
  eq(res.sweepClearWrites.length, 0, "a fresh stamp is not a sweep");
}

{
  // A stamped, aged, still-unserved row produces a SWEEP write keyed on the stored stamp.
  const res = await resolveDemotionWrites(
    [row({ id: "u1", attributes: { debt_team: ["high"], [DEMOTION_MARK_KEY]: AGED } })],
    plan(),
    async () => [uh],
    NOW,
  );
  eq(res.sweepClearWrites.length, 1, "one sweep/clear write");
  eq(res.sweepClearWrites[0].kind, "sweep-overdue", "it is a sweep");
  eq(res.sweepClearWrites[0].sweepMarkedAtIso, AGED, "keyed on the stored stamp, not now");
  eq(res.evalFailures, 0, "no evaluation failures");
}

{
  // A widening attribute write produces nothing: no stamp, no sweep/clear.
  const res = await resolveDemotionWrites(
    [row({ id: "u1", attributes: { debt_team: ["high"] } })],
    plan({ attributeWrites: [write("u1", "a@x.com", { debt_team: ["ultra_high", "high"] }, changes({ debt: true }))] }),
    async () => [uh],
    NOW,
  );
  eq(res.stampOverlays.size, 0, "a widening stamps nothing");
  eq(res.sweepClearWrites.length, 0, "and sweeps nothing");
}

{
  // THE FAILURE BOUNDARY: one agent's candidate read throwing is counted and skipped, and the
  // OTHER agents are still resolved. The demotion pass is auxiliary and must never abort the core
  // roster sync (L73).
  const res = await resolveDemotionWrites(
    [
      row({ id: "u1", attributes: { debt_team: ["high"], [DEMOTION_MARK_KEY]: AGED } }),
      row({ id: "u2", email: "b@x.com", attributes: { debt_team: ["high"], [DEMOTION_MARK_KEY]: AGED } }),
    ],
    plan(),
    async (userId) => {
      if (userId === "u1") throw new Error("candidate read blew up");
      return [uh];
    },
    NOW,
  );
  eq(res.evalFailures, 1, "the failing agent is counted");
  eq(res.sweepClearWrites.map((w) => w.userId).join(","), "u2", "and the other agent is still resolved");
  eq(res.stampOverlays.size, 0, "a stamped-unchanged row's failure adds no defensive stamp (it already has one)");
}

{
  // A TIER-CHANGED row whose read throws is stamped DEFENSIVELY (the attributes narrowed), so the
  // narrowing is kept while the core tier write still lands. The next sync's sweep pass reads the
  // bookings and sweeps or clears. The tier write is NEVER withheld (a persistent read fault must
  // not block the agent's routing facts).
  const res = await resolveDemotionWrites(
    [row({ id: "u1", attributes: { debt_team: ["ultra_high", "high"] } })],
    plan({ attributeWrites: [write("u1", "a@x.com", { debt_team: ["high"] }, changes({ debt: true }))] }),
    async () => {
      throw new Error("candidate read blew up");
    },
    NOW,
  );
  eq(res.evalFailures, 1, "the failing tier-changed agent is counted");
  eq(res.stampOverlays.size, 1, "a possible narrowing is stamped defensively");
  eq((res.stampOverlays.get("u1") as Attributes)[DEMOTION_MARK_KEY], NOW, "the defensive stamp carries the mark");
  eq((res.stampOverlays.get("u1") as Attributes).debt_team?.toString(), "high", "folded into the narrowed tier write");
}

{
  // A pure WIDENING whose read throws is NOT stamped defensively: the attributes did not narrow,
  // so there is nothing to keep, and the tier write lands plainly.
  const res = await resolveDemotionWrites(
    [row({ id: "u1", attributes: { debt_team: ["high"] } })],
    plan({ attributeWrites: [write("u1", "a@x.com", { debt_team: ["ultra_high", "high"] }, changes({ debt: true }))] }),
    async () => {
      throw new Error("candidate read blew up");
    },
    NOW,
  );
  eq(res.evalFailures, 1, "the failing agent is counted");
  eq(res.stampOverlays.size, 0, "a widening is not stamped defensively");
}

finish();

// #3582 Phases 1-2: the per-booking eligibility predicate and the reroute-decision
// layer, both pure. agentStillServes mirrors the shipped pool resolver for ONE agent
// (manual member OR matchesCriteria), and bookingsToReroute reroutes a booking only on a
// CONFIRMED narrowing (served before, not after), never on an unknown read, and never an
// agent_link booking. The agreement test against agentIdsFromPool is what keeps the new
// predicate from drifting from the booker's own eligibility definition (L263).
import { agentStillServes, bookingsToReroute } from "../src/lib/booking/reroute-eligibility.ts";
import { agentIdsFromPool } from "../src/lib/availability/pool.ts";
import type { Attributes, Criteria } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- agentStillServes (Phase 1) -------------------------------------------

{
  // A manual member of the bucket serves it regardless of attributes or criteria,
  // exactly as agentIdsFromPool short-circuits on manual membership (F4): a demotion
  // must never reroute a manual member's booking.
  assert(agentStillServes({}, { debt_team: "ultra_high" }, true), "manual member serves regardless of criteria");
  assert(agentStillServes(null, null, true), "manual member serves even with no attributes and no criteria");
}

{
  // Criteria match / no match.
  assert(
    agentStillServes({ debt_team: ["ultra_high", "high"] }, { debt_team: "ultra_high" }, false),
    "an agent carrying the tier the bucket wants serves it",
  );
  assert(
    !agentStillServes({ debt_team: ["high"] }, { debt_team: "ultra_high" }, false),
    "an agent demoted off the tier no longer serves that bucket",
  );
}

{
  // Negated criteria: an UNSET attribute passes (cal.com "does not equal" semantics).
  assert(
    agentStillServes({}, { "backend_service!": "achieve" }, false),
    "a negated criterion passes an agent with the attribute unset",
  );
  assert(
    !agentStillServes({ backend_service: "achieve" }, { "backend_service!": "achieve" }, false),
    "a negated criterion excludes an agent explicitly marked",
  );
}

// The agreement control (L263): agentStillServes must answer the same question as
// "agent is in agentIdsFromPool for this one bucket", or the two definitions drift.
{
  const shapes: { attrs: Attributes; criteria: Criteria; manual: boolean }[] = [
    { attrs: { debt_team: ["ultra_high", "high"] }, criteria: { debt_team: "ultra_high" }, manual: false },
    { attrs: { debt_team: ["high"] }, criteria: { debt_team: "ultra_high" }, manual: false },
    { attrs: { role: "Sales" }, criteria: { debt_team: "low" }, manual: false },
    { attrs: {}, criteria: {}, manual: false },
    { attrs: {}, criteria: { debt_team: "low" }, manual: true },
    { attrs: { backend_service: ["achieve"] }, criteria: { "backend_service!": "achieve" }, manual: false },
    { attrs: {}, criteria: { "backend_service!": "achieve" }, manual: false },
  ];
  for (const s of shapes) {
    const viaPredicate = agentStillServes(s.attrs, s.criteria, s.manual);
    const viaPool = agentIdsFromPool(
      [{ id: "x", attributes: s.attrs }],
      s.manual ? new Set(["x"]) : new Set<string>(),
      s.criteria,
    ).includes("x");
    eq(viaPredicate, viaPool, `agentStillServes agrees with agentIdsFromPool for ${JSON.stringify(s)}`);
  }
}

// --- bookingsToReroute (Phase 2) ------------------------------------------

const UH = { criteria: { debt_team: "ultra_high" } as Criteria, isManualMember: false };
const HI = { criteria: { debt_team: "high" } as Criteria, isManualMember: false };
const before: Attributes = { debt_team: ["ultra_high", "high"] };
const afterDemoted: Attributes = { debt_team: ["high"] };

{
  // The core case: an ultra-high booking the agent served before and cannot after a
  // demotion to high reroutes; a high booking they still serve does not.
  const out = bookingsToReroute(before, afterDemoted, [
    { bookingId: "uh1", kind: "round_robin", ...UH },
    { bookingId: "hi1", kind: "round_robin", ...HI },
  ]);
  eq(out.join(","), "uh1", "demotion reroutes the ultra-high booking only, not the still-served high one");
}

{
  // An upgrade (the after set is a superset) reroutes nothing.
  const out = bookingsToReroute({ debt_team: ["high"] }, { debt_team: ["ultra_high", "high"] }, [
    { bookingId: "uh1", kind: "round_robin", ...UH },
    { bookingId: "hi1", kind: "round_robin", ...HI },
  ]);
  eq(out.length, 0, "a tier upgrade reroutes nothing");
}

{
  // THE FAIL-SAFE: an unknown read (null) on either side reroutes nobody, so a failed or
  // partial Twilio/Salesforce sync never permanently moves a customer (L214, L50).
  eq(bookingsToReroute(null, afterDemoted, [{ bookingId: "uh1", kind: "round_robin", ...UH }]).length, 0,
    "a null BEFORE snapshot (unknown) reroutes nobody");
  eq(bookingsToReroute(before, null, [{ bookingId: "uh1", kind: "round_robin", ...UH }]).length, 0,
    "a null AFTER snapshot (failed read) reroutes nobody");
}

{
  // An empty AFTER ({} = a real read with no tags) IS a confirmed narrowing and reroutes.
  const out = bookingsToReroute(before, {}, [{ bookingId: "uh1", kind: "round_robin", ...UH }]);
  eq(out.join(","), "uh1", "an empty-but-real AFTER attribute set is a confirmed narrowing");
}

{
  // agent_link bookings (the lead chose the advisor by name) never reroute on a demotion.
  const out = bookingsToReroute(before, afterDemoted, [{ bookingId: "al1", kind: "agent_link", ...UH }]);
  eq(out.length, 0, "an agent_link booking is never rerouted on a demotion");
}

{
  // A manual member's booking never reroutes: they serve it by membership, not attributes.
  const out = bookingsToReroute(before, afterDemoted, [
    { bookingId: "m1", kind: "round_robin", criteria: { debt_team: "ultra_high" }, isManualMember: true },
  ]);
  eq(out.length, 0, "a manual member's booking is never rerouted on a demotion");
}

finish();

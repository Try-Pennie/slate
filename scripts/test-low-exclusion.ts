// The "skip advisors who also carry Low" rule for a top tier lead's cascade (#2842).
//
// Sales ops, 2026-09-28 (Slack #C091G6LEQ80, p1790609176877419). Sam: cascading an
// Ultra lead is fine "as long as the person who is on Medium isn't also on Low".
import { carriesLow, lowCarrierIds, withoutLowCarriers } from "../src/lib/availability/low-exclusion.ts";
import { assert, finish } from "./lib/harness.ts";

// --- who carries Low: the debt_team attribute, array or scalar ---
assert(carriesLow({ debt_team: ["high", "medium", "low"] }), "an array holding low carries Low");
assert(carriesLow({ debt_team: "low" }), "a scalar low carries Low");
assert(!carriesLow({ debt_team: ["very_high", "high", "medium"] }), "no low, no Low");
assert(!carriesLow({ debt_team: [] }), "an empty team list carries nothing");
assert(!carriesLow({}), "no debt_team at all carries nothing");
assert(!carriesLow(null), "no attributes at all carries nothing");
// A near miss must not count: matching is on the exact key the Twilio sync writes.
assert(!carriesLow({ debt_team: ["lowish", "Low "] }), "only the exact key counts");

// --- the ids that carry it, from a real shaped roster (measured 2026-09-28) ---
const roster = [
  { id: "ultra", attributes: { debt_team: ["ultra_high", "very_high", "high", "medium"] } },
  { id: "vh-no-low", attributes: { debt_team: ["very_high", "high", "medium"] } },
  { id: "vh-low", attributes: { debt_team: ["very_high", "high", "medium", "low"] } },
  { id: "mid-low", attributes: { debt_team: ["medium", "low"] } },
];
assert(
  lowCarrierIds(roster).join(",") === "vh-low,mid-low",
  `the Low carriers are picked out (got ${lowCarrierIds(roster).join(",")})`,
);

// --- filtering a pool ---
const pool = ["ultra", "vh-no-low", "vh-low", "mid-low"];
assert(
  withoutLowCarriers(pool, ["vh-low", "mid-low"]).join(",") === "ultra,vh-no-low",
  "Low carriers are removed and everyone else keeps their order",
);
assert(withoutLowCarriers(pool, []).join(",") === pool.join(","), "nobody carries Low, nobody is removed");
// FAIL CLOSED. An unknown Low list (an eligibility result from before this field
// existed, or a resolver that never supplies it) must never read as "nobody carries
// Low", which would hand an Ultra lead to exactly the advisors the rule excludes.
// Offering nobody on that rung is recoverable: the lead is offered the rung above,
// or the next one down.
assert(withoutLowCarriers(pool, undefined).length === 0, "an unknown Low list offers nobody");

finish();

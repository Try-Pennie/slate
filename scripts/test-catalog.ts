// Sanity test for the routing-attribute catalog derivation.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-catalog.ts
import { deriveAttributeCatalog } from "../src/lib/availability/catalog.ts";
import type { Attributes } from "../src/lib/db/types.ts";
import { withDemotionMark, withDemotionSwept } from "../src/lib/booking/demotion-plan.ts";
import { TWILIO_WORKER_MISSING_KEY, withMark } from "../src/lib/twilio/roster-plan.ts";
import { assert, finish } from "./lib/harness.ts";

const agents: (Attributes | null)[] = [
  { debt_team: ["ultra_high", "high"], role: "sales_agent", trades_access: true },
  { debt_team: "high", role: "manager", backend_service: "achieve" },
  { debt_team: ["low"], role: "sales_agent", trades_access: false },
  null,
  { debt_team: "" }, // empty value ignored
];

const cat = deriveAttributeCatalog(agents);

assert(JSON.stringify(cat.debt_team) === JSON.stringify(["high", "low", "ultra_high"]), "unions + sorts array and scalar values across agents");
assert(JSON.stringify(cat.role) === JSON.stringify(["manager", "sales_agent"]), "dedups scalar values");
assert(JSON.stringify(cat.trades_access) === JSON.stringify(["false", "true"]), "booleans become string options");
assert(JSON.stringify(cat.backend_service) === JSON.stringify(["achieve"]), "keys present on only some agents are included");
// The PROPERTY, not a hand written order. The literal here read
// ["backend_service", "debt_team", "trades_access", "role"], which is not sorted:
// it was written when the third key sorted before `role` and nothing ever
// re-checked it against the claim in its own message (L63).
{
  const keys = Object.keys(cat);
  assert(JSON.stringify(keys) === JSON.stringify([...keys].sort()), `keys are sorted (${keys.join(", ")})`);
  assert(
    JSON.stringify([...keys].sort()) ===
      JSON.stringify(["backend_service", "debt_team", "role", "trades_access"]),
    `and every key the agents carry is present (${keys.join(", ")})`,
  );
}
assert(!cat.debt_team.includes(""), "empty values are dropped");
assert(JSON.stringify(deriveAttributeCatalog([])) === "{}", "no agents yields an empty catalog");
assert(JSON.stringify(deriveAttributeCatalog([null, undefined])) === "{}", "null/undefined attributes are skipped");

// #3615: the roster sync keeps its own lifecycle bookkeeping on `attributes` (the Redistribute
// and demotion marks, their swept markers, the tiers held before a demotion). Those are not
// routing facts, and the picker offering them would let an admin route a bucket on a timestamp,
// or on `demotion_from_debt_team = ultra_high`, which reads exactly like a real tier. The keys are
// taken from what the REAL mark helpers write, so a new bookkeeping key cannot slip into the
// picker by being missing from a hand written list (L96).
{
  const T = "2026-10-01T12:00:00.000Z";
  const written = [
    withMark({}, T),
    withDemotionSwept(withDemotionMark({}, T, { debtTeam: ["ultra_high"], backendService: ["achieve"] }), T),
    { [TWILIO_WORKER_MISSING_KEY]: T },
  ];
  const bookkeeping = written.flatMap((a) => Object.keys(a)).filter((k) => k !== "redistribute");
  const withLifecycle = deriveAttributeCatalog([{ debt_team: ["high"] }, ...written.map((a) => ({ ...a, debt_team: ["low"] }))]);
  for (const key of bookkeeping) {
    assert(!(key in withLifecycle), `the picker leaves out the sync's bookkeeping key ${key}`);
  }
  assert(bookkeeping.length >= 6, `the control found the bookkeeping keys it should (${bookkeeping.join(", ")})`);
  assert(JSON.stringify(withLifecycle.debt_team) === JSON.stringify(["high", "low"]), "routing facts on the same rows still appear");
}

finish();

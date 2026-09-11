// The pool key (#2245): the identity of "who this bucket routes to, and how its
// slots are shaped". Two buckets sharing one is a guarantee that computing
// availability for either produces the SAME answer, which is what lets the
// recompute lane run the compute once and write both rows.
//
// So this file's job is the two directions of that guarantee, and the second is
// the one that matters: a key that collapsed two buckets which do NOT route
// alike would serve one pool's times under the other's code. Every input that
// can move the computed slots therefore has a test that CHANGING it splits the
// key (L1: a guard is only real once it has been seen to fail).
//
// Run: node --experimental-strip-types scripts/test-pool-key.ts
import { poolKeyFor, groupByPool, type PoolInput } from "../src/lib/availability/pool-key.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG = "org-1";
const EVENT = "event-1";

function input(over: Partial<PoolInput> = {}): PoolInput {
  return {
    orgId: ORG,
    eventTypeId: EVENT,
    criteria: { debt_team: "low" },
    fallbackUserId: null,
    memberIds: [],
    ...over,
  };
}

// --- The collapse direction: things that must NOT split a pool ---

assert(
  poolKeyFor(input()) === poolKeyFor(input()),
  "the same inputs give the same key",
);

// PostgREST hands jsonb back in stored order, so two buckets holding the same
// criteria can present their keys in different orders. Every key must match for
// an agent to match (matchesCriteria), so order carries no meaning and must not
// split the pool.
assert(
  poolKeyFor(input({ criteria: { debt_team: "low", backend_service: "beyond" } })) ===
    poolKeyFor(input({ criteria: { backend_service: "beyond", debt_team: "low" } })),
  "criteria key order does not split a pool",
);

// `agentIdsFromPool` reads `criteria ?? {}`, so a null criteria and an empty one
// select the same agents and must be one pool.
assert(
  poolKeyFor(input({ criteria: null })) === poolKeyFor(input({ criteria: {} })),
  "null criteria and empty criteria are one pool",
);

// Manual membership is a SET: the read that produces it declares no order.
assert(
  poolKeyFor(input({ memberIds: ["b", "a"] })) === poolKeyFor(input({ memberIds: ["a", "b"] })),
  "manual member order does not split a pool",
);

// --- The separation direction: every input that moves the slots must split ---

assert(
  poolKeyFor(input({ criteria: { debt_team: "low" } })) !==
    poolKeyFor(input({ criteria: { debt_team: "high" } })),
  "a different criteria VALUE splits the pool",
);

assert(
  poolKeyFor(input({ criteria: { debt_team: "low" } })) !==
    poolKeyFor(input({ criteria: { debt_team: "low", backend_service: "beyond" } })),
  "an EXTRA criterion splits the pool",
);

// The event type sets duration, buffers, notice, interval and daily cap, so it
// shapes every slot even when the pool of agents is identical.
assert(
  poolKeyFor(input({ eventTypeId: "event-1" })) !== poolKeyFor(input({ eventTypeId: "event-2" })),
  "a different event type splits the pool",
);

// The org decides which agents are even considered, and its own week gates them.
assert(
  poolKeyFor(input({ orgId: "org-1" })) !== poolKeyFor(input({ orgId: "org-2" })),
  "a different org splits the pool",
);

// The fallback agent is who serves the bucket when the criteria match nobody, so
// two buckets with identical criteria and different fallbacks can offer
// different times.
assert(
  poolKeyFor(input({ fallbackUserId: null })) !== poolKeyFor(input({ fallbackUserId: "u1" })),
  "a different fallback agent splits the pool",
);

assert(
  poolKeyFor(input({ memberIds: [] })) !== poolKeyFor(input({ memberIds: ["u1"] })),
  "a different manual member set splits the pool",
);

// A criteria value can be a string ARRAY (Criteria allows one). Order within it
// is NOT canonicalised on purpose: sorting would be right only if matching
// ignores order, and being wrong in that direction merges two pools that route
// differently. Being wrong the safe way merely computes one pool twice.
assert(
  poolKeyFor(input({ criteria: { tier: ["a", "b"] } })) !==
    poolKeyFor(input({ criteria: { tier: ["b", "a"] } })),
  "an array criteria value is not reordered, so two orderings stay separate pools",
);

// A key built by joining parts must not let one part's content impersonate a
// separator and produce a collision.
assert(
  poolKeyFor(input({ criteria: { a: "x" }, fallbackUserId: null })) !==
    poolKeyFor(input({ criteria: {}, fallbackUserId: 'x"}' })),
  "content inside one field cannot forge the boundary between fields",
);

// --- Grouping the real matrix ---

// Derived from `bucketSpecForXbc`, which is what `scripts/seed-buckets.ts`
// writes, rather than hand-typed beside it (L41). Measured against production on
// 2026-09-11: all 60 live rows carry exactly these criteria, one shared event
// type, one org, no fallback and no manual members.
const matrix: (PoolInput & { code: string })[] = allXbcCodes().map((code) => ({
  code,
  orgId: ORG,
  eventTypeId: EVENT,
  criteria: bucketSpecForXbc(code)!.criteria,
  fallbackUserId: null,
  memberIds: [],
}));

const groups = groupByPool(matrix);
eq(groups.size, 15, "the 60 live codes group into 15 pools");

const membership = [...groups.values()]
  .map((g) => g.map((b) => b.code).sort().join(" "))
  .sort();
eq(
  membership,
  [
    "100 101 102 110 111 112",
    "120 121 122",
    "130 131 132",
    "200 201 202 210 211 212",
    "220 221 222",
    "230 231 232",
    "300 301 302 310 311 312",
    "320 321 322",
    "330 331 332",
    "400 401 402 410 411 412",
    "420 421 422",
    "430 431 432",
    "500 501 502 510 511 512",
    "520 521 522",
    "530 531 532",
  ],
  "each pool holds exactly the codes production measured together",
);

eq(
  matrix.length,
  [...groups.values()].reduce((n, g) => n + g.length, 0),
  "every code lands in exactly one pool",
);

// Positive control (L1): the grouping has to be capable of SEPARATING. Without
// this, a `groupByPool` that returned one group per input, or one group for
// everything, could not be told from a correct one by the count alone.
const perturbed = matrix.map((b) =>
  b.code === "111" ? { ...b, criteria: { debt_team: "low", nudged: "yes" } } : b,
);
const perturbedGroups = groupByPool(perturbed);
eq(perturbedGroups.size, 16, "changing one bucket's criteria makes it its own pool");
eq(
  [...perturbedGroups.values()].find((g) => g.some((b) => b.code === "111"))!.map((b) => b.code),
  ["111"],
  "and that pool holds only the changed code",
);

eq(groupByPool([]).size, 0, "no buckets means no pools");

finish();

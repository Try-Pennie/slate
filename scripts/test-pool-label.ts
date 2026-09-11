// Naming a POOL in words (#2237).
//
// Sixty bucket codes route through fifteen pools, so a surface that reports one
// pool needs to say WHICH, and a code cannot say it: six codes share the Low
// pool and none of them is its name. The name comes from the criteria, through
// the same DEBT_TIER and BACKEND vocabulary the bucket names and the roster
// already use, so one meaning never gets two spellings (L41, L118).
//
// The guard that matters is the collision one. Two distinct pools rendering the
// same label would merge them in the reader's eye on every surface at once,
// while every test about a single label still passed.
//
// Run: node --experimental-strip-types scripts/test-pool-label.ts
import { poolLabel, collidingPoolLabels } from "../src/lib/availability/pool-label.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";
import { groupByPool } from "../src/lib/availability/pool-key.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- The vocabulary ---

eq(poolLabel({ debt_team: "low" }), "Low", "a tier with no backend constraint is the tier");
eq(
  poolLabel({ debt_team: "low", backend_service: "beyond" }),
  "Low with Beyond",
  "a backend constraint is named with it",
);
eq(
  poolLabel({ debt_team: "ultra_high", backend_service: "achieve" }),
  "Ultra High with Achieve",
  "and the tier is spelled the way the bucket names spell it, never the stored key",
);
eq(
  poolLabel({ backend_service: "beyond", debt_team: "low" }),
  "Low with Beyond",
  "the order the criteria are stored in does not change the name",
);

// --- What it refuses to name ---

eq(poolLabel(null), null, "criteria that do not exist cannot be named");
eq(poolLabel({}), null, "nor can empty criteria");
eq(
  poolLabel({ debt_team: "credit" }),
  null,
  "a debt team outside the routing vocabulary is not named, because a guessed name is worse than none",
);
eq(
  poolLabel({ debt_team: "low", backend_service: "something" }),
  null,
  "nor is an unknown backend service",
);
eq(
  poolLabel({ debt_team: "low", region: "CO" }),
  null,
  "a criterion this cannot name means the label would claim less than the pool does (L11)",
);
eq(
  poolLabel({ debt_team: ["low", "medium"] }),
  null,
  "a list valued criterion is several pools' worth of meaning and is not named",
);

// --- The real matrix ---

const pools = [...groupByPool(
  allXbcCodes().map((code) => ({
    code,
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria: bucketSpecForXbc(code)!.criteria,
    fallbackUserId: null,
    memberIds: [],
  })),
).values()];

eq(pools.length, 15, "the live matrix is fifteen pools");

const labelled = pools.map((members) => ({
  label: poolLabel(members[0]!.criteria),
  codes: members.map((m) => m.code),
}));
assert(
  labelled.every((p) => p.label !== null),
  "every pool in the live matrix has a name",
);
eq(
  labelled.map((p) => p.label).sort(),
  [
    "High",
    "High with Achieve",
    "High with Beyond",
    "Low",
    "Low with Achieve",
    "Low with Beyond",
    "Medium",
    "Medium with Achieve",
    "Medium with Beyond",
    "Ultra High",
    "Ultra High with Achieve",
    "Ultra High with Beyond",
    "Very High",
    "Very High with Achieve",
    "Very High with Beyond",
  ],
  "and the fifteen names are the fifteen the matrix describes",
);

// --- The collision guard ---

eq(
  collidingPoolLabels(labelled).length,
  0,
  "no two pools in the live matrix share a name",
);

// Positive control (L1). Without it, a `collidingPoolLabels` that always returned
// nothing would be indistinguishable from a healthy vocabulary.
const collided = collidingPoolLabels([
  { label: "Low", codes: ["100"] },
  { label: "Low", codes: ["200"] },
  { label: "High", codes: ["300"] },
]);
eq(collided.length, 1, "two pools sharing a name are reported");
eq(collided[0]!.label, "Low", "the collision names the label");
eq(
  collided[0]!.codes.sort(),
  ["100", "200"],
  "and every code caught up in it, so the reader can see which pools merged",
);

eq(
  collidingPoolLabels([{ label: null, codes: ["X1"] }, { label: null, codes: ["X2"] }]).length,
  0,
  "two pools that could not be named have not collided: neither has a name to share",
);

finish();

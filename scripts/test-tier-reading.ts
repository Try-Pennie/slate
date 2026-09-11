// Whether two staffing depth rows carry the SAME reading (#2237).
//
// It decides whether the codes of a pool may share one row on the tiers page and
// one line in the staffing notice. Everything a surface shows is compared, so a
// difference a reader could see always splits them; the pool key already
// guarantees they agree, which is exactly why this has to be able to say no.
//
// Run: node --experimental-strip-types scripts/test-tier-reading.ts
import { sameTierReading } from "../src/lib/routing/staffing-depth.ts";
import type { TierDepth } from "../src/lib/routing/staffing-depth.ts";
import { assert, finish } from "./lib/harness.ts";

function depth(over: Partial<TierDepth> = {}): TierDepth {
  return {
    code: "100",
    name: "Low",
    depth: 3,
    effectiveDepth: 2,
    outCount: 1,
    soleAgentName: null,
    hasWorkingFallback: false,
    flag: "ok",
    effectiveFlag: "thin",
    agents: [
      { id: "u1", name: "Sam", out: false },
      { id: "u2", name: "Priya", out: true },
    ],
    poolKey: "low",
    poolLabel: "Low",
    ...over,
  };
}

assert(sameTierReading(depth(), depth()), "two identical readings agree");
assert(
  sameTierReading(depth({ code: "100" }), depth({ code: "111" })),
  "the CODE is not part of the reading: that is what pooling exists to fold",
);
assert(
  sameTierReading(depth({ name: "Low | Both | Legal" }), depth({ name: "Low | Both | Non-Legal" })),
  "nor is the bucket's own name, which carries a digit that stopped routing (#2218)",
);

// Every field a surface renders splits the reading. Each is listed, rather than
// checked by a loop over the object, so adding a field to TierDepth does not
// quietly join this set without somebody deciding it should.
assert(!sameTierReading(depth(), depth({ depth: 4 })), "roster depth splits");
assert(!sameTierReading(depth(), depth({ effectiveDepth: 3 })), "available today splits");
assert(!sameTierReading(depth(), depth({ outCount: 2 })), "how many are out splits");
assert(!sameTierReading(depth(), depth({ flag: "thin" })), "the roster flag splits");
assert(!sameTierReading(depth(), depth({ effectiveFlag: "spof" })), "the effective flag splits");
assert(
  !sameTierReading(depth(), depth({ soleAgentName: "Tyler" })),
  "the sole agent's name splits",
);
assert(
  !sameTierReading(depth(), depth({ hasWorkingFallback: true })),
  "having a working fallback splits",
);
assert(
  !sameTierReading(depth(), depth({ agents: [{ id: "u1", name: "Sam", out: false }] })),
  "a different set of agents splits, because the tiers page lists them",
);
assert(
  !sameTierReading(
    depth(),
    depth({
      agents: [
        { id: "u1", name: "Sam", out: false },
        { id: "u2", name: "Priya", out: false },
      ],
    }),
  ),
  "and so does the same agent being out in one reading and not the other",
);

// Order within the agent list is produced deterministically by
// `bucketStaffingDepths`, so two readings that differ only by it are a fault
// rather than a presentation difference, and splitting on it shows the fault.
assert(
  !sameTierReading(
    depth(),
    depth({
      agents: [
        { id: "u2", name: "Priya", out: true },
        { id: "u1", name: "Sam", out: false },
      ],
    }),
  ),
  "a differently ordered agent list is not the same reading",
);

finish();

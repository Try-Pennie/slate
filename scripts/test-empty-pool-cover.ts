// What catches an empty pool's leads, today and on the roster (2026-10-02).
//
// `emptyPoolCover` is the rule for TODAY: it reads who is out today. The bucket
// availability page also judges days ahead, where nobody's time off is known to
// staffing depth, so it needs the same rule over the ROSTER. Both are pinned here
// side by side, because two rules that drift apart would have the page call the
// same pool covered on one day and stranded on the next for no reason a reader
// could see.
//
// Run: node --experimental-strip-types scripts/test-empty-pool-cover.ts
import { emptyPoolCover, emptyPoolCoverOnRoster } from "../src/lib/routing/staffing-depth.ts";
import type { TierDepth } from "../src/lib/routing/staffing-depth.ts";
import { eq, finish } from "./lib/harness.ts";

const ACHIEVE = { code: "130", poolKey: "low-achieve", label: "Low with Achieve" };

function depth(over: Partial<TierDepth> = {}): TierDepth {
  return {
    code: "120",
    name: "Low | Beyond | No Legal Param",
    depth: 0,
    effectiveDepth: 0,
    outCount: 0,
    soleAgentName: null,
    hasWorkingFallback: false,
    flag: "none",
    effectiveFlag: "none",
    agents: [],
    poolKey: "low-beyond",
    poolLabel: "Low with Beyond",
    overflowToday: null,
    overflowOnRoster: null,
    ...over,
  };
}

// The roster rule.
eq(emptyPoolCoverOnRoster(depth({ depth: 2, effectiveDepth: 0 })), null, "a pool with people on its roster needs no catching on the roster");
eq(emptyPoolCoverOnRoster(depth({ hasWorkingFallback: true, overflowOnRoster: ACHIEVE })), "fallback", "the fallback agent comes first, as routing tries it");
eq(emptyPoolCoverOnRoster(depth({ overflowOnRoster: ACHIEVE })), "overflow", "then the ladder");
eq(emptyPoolCoverOnRoster(depth({ overflowToday: ACHIEVE })), "none", "today's overflow says nothing about the roster");
eq(emptyPoolCoverOnRoster(depth()), "none", "nothing catches an empty pool with no fallback and no staffed rung");

// The two disagree exactly where today and the roster differ: everybody out today.
const allOut = depth({ depth: 2, effectiveDepth: 0, outCount: 2, overflowToday: ACHIEVE });
eq(emptyPoolCover(allOut), "overflow", "with everyone out today, today's leads overflow");
eq(emptyPoolCoverOnRoster(allOut), null, "while on the roster the pool is staffed");

finish();

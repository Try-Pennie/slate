// Pure-logic tests for the availability canary verdict (#749). The route does the
// IO (per-bucket present-agent depth + the 4-day slot cache); this decides 200 vs
// 503 from those numbers. Run: node --experimental-strip-types scripts/test-availability-canary.ts
import { computeAvailabilityCanary } from "../src/lib/monitor/availability-canary.ts";
import { assert, finish } from "./lib/harness.ts";

const slots = (pairs: [string, number][]) => new Map<string, number>(pairs);

// 1. Every staffed bucket has times: healthy.
{
  const v = computeAvailabilityCanary(
    [
      { code: "100", effectiveDepth: 69 },
      { code: "205", effectiveDepth: 4 },
    ],
    slots([
      ["100", 142],
      ["205", 12],
    ]),
  );
  assert(v.healthy && v.httpStatus === 200, "all staffed buckets with slots -> 200");
  assert(v.reason === "ok", "healthy reason is ok");
  assert(v.brokenBuckets.length === 0, "no broken buckets when all have slots");
}

// 2. One well-staffed bucket empty (>= strong floor): pages as a confident single-tier break.
{
  const v = computeAvailabilityCanary(
    [
      { code: "100", effectiveDepth: 8 },
      { code: "205", effectiveDepth: 4 },
    ],
    slots([
      ["100", 0],
      ["205", 12],
    ]),
  );
  assert(!v.healthy && v.httpStatus === 503, "8 present agents, 0 slots -> 503");
  assert(v.reason === "tier_broken", "strong single-tier break reason");
  assert(
    v.brokenBuckets.some((b) => b.code === "100" && b.slots === 0 && b.effectiveDepth === 8),
    "the broken bucket is named with its numbers",
  );
}

// 3. A single tiny bucket empty (below strong floor, not systemic): stays healthy.
{
  const v = computeAvailabilityCanary(
    [
      { code: "100", effectiveDepth: 69 },
      { code: "900", effectiveDepth: 1 },
    ],
    slots([
      ["100", 142],
      ["900", 0],
    ]),
  );
  assert(v.healthy && v.httpStatus === 200, "one tiny empty bucket does not page");
}

// 4. Half or more of staffed buckets empty at once: systemic, pages even if each is small.
{
  const v = computeAvailabilityCanary(
    [
      { code: "a", effectiveDepth: 2 },
      { code: "b", effectiveDepth: 2 },
      { code: "c", effectiveDepth: 2 },
      { code: "d", effectiveDepth: 2 },
    ],
    slots([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["d", 5],
    ]),
  );
  assert(!v.healthy && v.httpStatus === 503, "3 of 4 staffed buckets empty -> 503");
  assert(v.reason === "systemic_empty", "systemic reason when the fraction is breached");
}

// 5. A bucket whose agents are ALL out (effectiveDepth 0) and empty is expected, not broken.
{
  const v = computeAvailabilityCanary(
    [
      { code: "100", effectiveDepth: 69 },
      { code: "900", effectiveDepth: 0 },
    ],
    slots([
      ["100", 142],
      ["900", 0],
    ]),
  );
  assert(v.healthy && v.httpStatus === 200, "all-agents-off empty bucket never pages");
  assert(v.brokenBuckets.length === 0, "an unstaffed empty bucket is not counted broken");
}

// 6. A bucket present in the roster but missing from the slot cache is unknown, not broken.
{
  const v = computeAvailabilityCanary(
    [
      { code: "100", effectiveDepth: 69 },
      { code: "new", effectiveDepth: 3 },
    ],
    slots([["100", 142]]),
  );
  assert(v.healthy && v.httpStatus === 200, "a missing cache row does not page");
  assert(v.unknownCount === 1, "the missing-row bucket is reported as unknown");
}

// 7. Staffed buckets exist but the slot cache is entirely absent: the cache is gone, page.
{
  const v = computeAvailabilityCanary(
    [
      { code: "100", effectiveDepth: 69 },
      { code: "205", effectiveDepth: 4 },
    ],
    slots([]),
  );
  assert(!v.healthy && v.httpStatus === 503, "no cache rows at all while staffed -> 503");
  assert(v.reason === "cache_absent", "absent-cache reason");
}

// 8. No staffed buckets at all (nothing to judge): healthy, we cannot conclude a break.
{
  const v = computeAvailabilityCanary(
    [{ code: "900", effectiveDepth: 0 }],
    slots([["900", 0]]),
  );
  assert(v.healthy && v.httpStatus === 200, "nothing staffed -> cannot conclude broken -> 200");
}

finish();

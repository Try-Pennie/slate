// Which POOLS the recompute lane owes work to this tick (#2245).
//
// The saving is real only if a pool comes due once per freshness window. Asking
// the question per CODE and recomputing the pool whenever ANY member is due
// looks right and is not: the jitter (#1247) gives each code its own phase
// inside the window on purpose, so a six code pool has six deadlines, and
// writing all six rows at the first of them resets the clock into the next
// deadline moments later. The lane would then recompute a pool roughly every
// quarter window rather than every window, which is MORE work than before
// pooling, not less. The simulation below is what tells the two apart.
//
// Run: node --experimental-strip-types scripts/test-pool-due.ts
import { poolsDueForRecompute } from "../src/lib/availability/pool-recompute.ts";
import type { PooledBucket } from "../src/lib/availability/pool-recompute.ts";
import { groupByPool } from "../src/lib/availability/pool-key.ts";
import { RECOMPUTE_FRESH_MS } from "../src/lib/availability/precompute-cron.ts";
import type { Bucket } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG = "org-1";
const EVENT = "event-1";

function pooled(code: string, criteria: Record<string, string>): PooledBucket {
  return {
    code,
    bucket: { id: `id-${code}`, code, criteria } as unknown as Bucket,
    orgId: ORG,
    eventTypeId: EVENT,
    criteria,
    fallbackUserId: null,
    memberIds: [],
  };
}

const LOW = ["100", "101", "102", "110", "111", "112"].map((c) =>
  pooled(c, { debt_team: "low" }),
);
const HIGH = ["300", "301", "302", "310", "311", "312"].map((c) =>
  pooled(c, { debt_team: "high" }),
);
const LOW_BEYOND = ["120", "121", "122"].map((c) =>
  pooled(c, { debt_team: "low", backend_service: "beyond" }),
);

const T0 = 1_757_600_000_000;

// --- A pool the lane has never computed ---

{
  const pools = groupByPool(LOW);
  const due = poolsDueForRecompute([], pools, T0, RECOMPUTE_FRESH_MS);
  eq(due.length, 1, "a pool with no rows at all is due");
  eq(due[0]!.length, 6, "and the whole pool comes back, not the one code that was missing");
}

{
  // One member missing a row is the same finding: that code is showing no
  // availability until something builds it, and the pool is what builds it.
  const pools = groupByPool(LOW);
  const known = LOW.slice(1).map((b) => ({ code: b.code, computedAtMs: T0 }));
  const due = poolsDueForRecompute(known, pools, T0, RECOMPUTE_FRESH_MS);
  eq(due.length, 1, "a pool with one member missing a row is due at once");
}

// --- A pool that is fresh ---

{
  const pools = groupByPool(LOW);
  const known = LOW.map((b) => ({ code: b.code, computedAtMs: T0 }));
  const due = poolsDueForRecompute(known, pools, T0 + 1_000, RECOMPUTE_FRESH_MS);
  eq(due.length, 0, "a pool computed a second ago is not due");
}

// --- The headline: once per window, not once per member ---

{
  // Drive a clock a minute at a time across three freshness windows, recomputing
  // whenever the pool reports due, exactly as the lane does. A correct answer
  // refreshes the pool about once per window. Counting members instead of the
  // pool refreshes it about once per quarter window, because the jitter's floor
  // sits at a quarter of the window and six phases nearly always put one member
  // just past it.
  const pools = groupByPool(LOW);
  const windowMs = RECOMPUTE_FRESH_MS;
  const spanMs = windowMs * 3;
  let known = LOW.map((b) => ({ code: b.code, computedAtMs: T0 }));
  let refreshes = 0;
  for (let t = T0; t <= T0 + spanMs; t += 60_000) {
    const due = poolsDueForRecompute(known, pools, t, windowMs);
    if (due.length > 0) {
      refreshes++;
      known = LOW.map((b) => ({ code: b.code, computedAtMs: t }));
    }
  }
  assert(
    refreshes <= 4,
    `a pool is refreshed about once per window over three windows (got ${refreshes})`,
  );
  assert(refreshes >= 3, `and it really is refreshed, not held forever (got ${refreshes})`);
}

// --- Order and shape across several pools ---

{
  const pools = groupByPool([...LOW, ...HIGH, ...LOW_BEYOND]);
  eq(pools.size, 3, "three distinct criteria make three pools");

  const known = [
    ...LOW.map((b) => ({ code: b.code, computedAtMs: T0 - 20 * 60_000 })),
    ...HIGH.map((b) => ({ code: b.code, computedAtMs: T0 - 40 * 60_000 })),
    ...LOW_BEYOND.map((b) => ({ code: b.code, computedAtMs: T0 - 30 * 60_000 })),
  ];
  const due = poolsDueForRecompute(known, pools, T0, RECOMPUTE_FRESH_MS);
  eq(due.length, 3, "all three are past the window");
  eq(
    due.map((p) => p[0]!.code),
    ["300", "120", "100"],
    "and they come back least recently computed first",
  );
}

{
  // A pool is only as fresh as its OLDEST member. Anything else would let one
  // lagging code sit behind five fresh siblings forever.
  const pools = groupByPool(LOW);
  const known = LOW.map((b, i) => ({
    code: b.code,
    computedAtMs: i === 3 ? T0 - 30 * 60_000 : T0,
  }));
  const due = poolsDueForRecompute(known, pools, T0, RECOMPUTE_FRESH_MS);
  eq(due.length, 1, "one stale member makes the pool due");
}

{
  const known = LOW.map((b) => ({ code: b.code, computedAtMs: T0 }));
  eq(
    poolsDueForRecompute(known, groupByPool([]), T0, RECOMPUTE_FRESH_MS).length,
    0,
    "no pools means nothing due",
  );
}

// --- A code nothing knows about ---

{
  // `known` carries rows for codes no bucket has any more (a retired code's row
  // outliving it). They must not create a pool: the lane would recompute a
  // bucket it cannot resolve, every tick, forever.
  const pools = groupByPool(LOW);
  const known = [
    ...LOW.map((b) => ({ code: b.code, computedAtMs: T0 })),
    { code: "999", computedAtMs: 0 },
  ];
  const due = poolsDueForRecompute(known, pools, T0 + 1_000, RECOMPUTE_FRESH_MS);
  eq(due.length, 0, "a stored row for a code no bucket has does not make anything due");
}

finish();

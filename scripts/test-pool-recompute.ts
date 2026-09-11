// Computing one pool once and writing every code in it (#2245).
//
// The dangerous half is not the saving, it is the IDENTITY. The stored payload
// carries the bucket's own row, and the read path reads it back for the routing
// trace's effective code, the test bucket gate and the empty bucket alert key.
// So a pooled write that left the representative's identity on its five siblings
// would have five codes reporting a sixth code's bucket, silently, on every
// surface downstream. That guard is the first assertion here and the reason this
// module exists as a pure seam rather than inline in the lane.
//
// Run: node --experimental-strip-types scripts/test-pool-recompute.ts
import {
  recomputePool,
  type PooledBucket,
  type PoolRecomputeDeps,
} from "../src/lib/availability/pool-recompute.ts";
import type { Bucket } from "../src/lib/db/types.ts";
import type { BucketSlots } from "../src/lib/availability/service.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ORG = "org-1";
const EVENT = "event-1";

function bucket(code: string): Bucket {
  return {
    id: `id-${code}`,
    org_id: ORG,
    code,
    name: `Bucket ${code}`,
    event_type_id: EVENT,
    assignment: "round_robin",
    criteria: { debt_team: "low" },
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function pooled(code: string): PooledBucket {
  return {
    code,
    bucket: bucket(code),
    orgId: ORG,
    eventTypeId: EVENT,
    criteria: { debt_team: "low" },
    fallbackUserId: null,
    memberIds: [],
  };
}

const LOW_POOL = ["100", "101", "102", "110", "111", "112"].map(pooled);

/** The answer a compute returns, carrying the REPRESENTATIVE's identity. */
function computedFor(code: string): BucketSlots {
  return {
    bucket: bucket(code),
    eventType: { id: EVENT, duration_min: 30 } as unknown as BucketSlots["eventType"],
    orgName: "Pennie",
    slots: ["2026-09-11T14:00:00.000Z", "2026-09-11T14:30:00.000Z"],
  };
}

interface Recorded {
  computeCalls: string[];
  writes: { code: string; val: BucketSlots; computedAtMs: number }[];
  invalidated: string[];
}

/**
 * Every seam is set here, and the clock is one of them (L284/L290): a recompute
 * stamps its rows from when the compute BEGAN, and a test reading the real clock
 * could not tell one stamp from another closely enough to assert they are the
 * same instant.
 */
function harness(
  over: Partial<PoolRecomputeDeps> = {},
): { deps: PoolRecomputeDeps; rec: Recorded } {
  const rec: Recorded = { computeCalls: [], writes: [], invalidated: [] };
  const deps: PoolRecomputeDeps = {
    nowMs: () => 1_757_600_000_000,
    compute: async (code) => {
      rec.computeCalls.push(code);
      return computedFor(code);
    },
    writeRow: async (code, val, computedAtMs) => {
      rec.writes.push({ code, val, computedAtMs });
    },
    invalidate: async (code) => {
      rec.invalidated.push(code);
    },
    ...over,
  };
  return { deps, rec };
}

// --- The headline guard: each code keeps its OWN identity ---

{
  const { deps, rec } = harness();
  await recomputePool(LOW_POOL, deps);

  eq(
    rec.writes.map((w) => w.code),
    ["100", "101", "102", "110", "111", "112"],
    "every code in the pool gets a row",
  );
  assert(
    rec.writes.every((w) => w.val.bucket.code === w.code),
    "each row carries its OWN bucket code, never the representative's",
  );
  assert(
    rec.writes.every((w) => w.val.bucket.id === `id-${w.code}`),
    "and its own bucket id, which is what the booking path resolves against",
  );
  assert(
    rec.writes.every((w) => w.val.bucket.name === `Bucket ${w.code}`),
    "and its own name, which the admin list shows",
  );
}

// --- The saving ---

{
  const { deps, rec } = harness();
  await recomputePool(LOW_POOL, deps);
  eq(rec.computeCalls.length, 1, "a six code pool runs the compute exactly ONCE");
  eq(rec.computeCalls, ["100"], "and runs it for the pool's first code");
}

// --- What is shared is shared exactly ---

{
  const { deps, rec } = harness();
  await recomputePool(LOW_POOL, deps);
  const slotSets = new Set(rec.writes.map((w) => JSON.stringify(w.val.slots)));
  eq(slotSets.size, 1, "every code in the pool is written the same slots");
  const shared = new Set(
    rec.writes.map((w) => JSON.stringify({ e: w.val.eventType, o: w.val.orgName })),
  );
  eq(shared.size, 1, "and the same event type and org name");
}

// --- One stamp for one compute (#1048) ---

{
  const { deps, rec } = harness();
  await recomputePool(LOW_POOL, deps);
  const stamps = new Set(rec.writes.map((w) => w.computedAtMs));
  eq(stamps.size, 1, "one compute stamps every row it produced with one instant");
  eq([...stamps][0], 1_757_600_000_000, "and that instant is when the compute began");
}

{
  // The stamp has to be read BEFORE the compute, not after: a slow compute
  // stamped on completion describes the moment the write landed rather than the
  // state the slots were computed from, which is the #1048 defect.
  const clock = { t: 1_000 };
  const { deps, rec } = harness({
    nowMs: () => clock.t,
    compute: async (code) => {
      clock.t = 9_999;
      return computedFor(code);
    },
  });
  await recomputePool(LOW_POOL, deps);
  eq(rec.writes[0]!.computedAtMs, 1_000, "the stamp is taken before the compute runs");
}

// --- Invalidation reaches every code, not just the one computed ---

{
  const { deps, rec } = harness();
  await recomputePool(LOW_POOL, deps);
  eq(
    rec.invalidated.sort(),
    ["100", "101", "102", "110", "111", "112"],
    "every code's L1 entry is dropped, or five of them serve the old answer",
  );
}

// --- Failure paths ---

{
  // A compute that could not answer must leave EVERY row in the pool standing.
  // Writing an empty payload is the silent "no availability" degrade (#277), and
  // a pooled write would now commit it six times instead of once.
  const { deps, rec } = harness({ compute: async () => null });
  const outcome = await recomputePool(LOW_POOL, deps);
  eq(rec.writes.length, 0, "a compute that returns nothing writes NO rows");
  eq(rec.invalidated.length, 0, "and drops no cache entries, so the last good answer stands");
  eq(outcome.computedFor, null, "and reports that it computed nothing");
}

{
  // One bad write must not cost the other five. The lane's own freshness sweep
  // picks the failed code up next tick.
  const { deps, rec } = harness({
    writeRow: async (code, val, computedAtMs) => {
      if (code === "102") throw new Error("write failed");
      rec.writes.push({ code, val, computedAtMs });
    },
  });
  const outcome = await recomputePool(LOW_POOL, deps);
  eq(rec.writes.map((w) => w.code), ["100", "101", "110", "111", "112"], "the other five are still written");
  eq(outcome.failed, ["102"], "and the failed code is named");
  eq(outcome.written.length, 5, "the outcome counts what actually landed");
}

{
  // A compute that THROWS is the same finding as one returning null: the caller
  // (the lane) must not be taken down by one pool, and no row may be written
  // from a compute that did not finish.
  const { deps, rec } = harness({
    compute: async () => {
      throw new Error("availability read failed");
    },
  });
  const outcome = await recomputePool(LOW_POOL, deps);
  eq(rec.writes.length, 0, "a compute that throws writes no rows");
  eq(outcome.computedFor, null, "and is reported as having computed nothing");
  eq(outcome.failed, [], "without blaming any individual code for it");
}

{
  // Dropping an L1 entry happens after that member's row is written, so a cache
  // that refuses must not abandon the codes still to be written. The entry it
  // could not drop expires on its own within the slot TTL.
  const { deps, rec } = harness({
    invalidate: async (code) => {
      if (code === "101") throw new Error("cache unavailable");
      rec.invalidated.push(code);
    },
  });
  const outcome = await recomputePool(LOW_POOL, deps);
  eq(rec.writes.length, 6, "a failed cache drop does not stop the remaining writes");
  eq(outcome.failed, [], "and is not reported as a write failure, because the row did land");
}

// --- Degenerate shapes ---

{
  const { deps, rec } = harness();
  const outcome = await recomputePool([], deps);
  eq(rec.computeCalls.length, 0, "an empty pool computes nothing");
  eq(outcome.written, [], "and writes nothing");
}

{
  const { deps, rec } = harness();
  await recomputePool([pooled("SMOKE")], deps);
  eq(rec.writes.map((w) => w.code), ["SMOKE"], "a pool of one behaves exactly as before");
  eq(rec.computeCalls, ["SMOKE"], "computing for itself");
}

finish();

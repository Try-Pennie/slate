// #3388: a recompute that used a CACHED eligibility list is stamped from when that
// list was read, not from when the compute began (L751).
//
// The every minute recompute lane is the one slot writer that reads eligibility
// through the 60 second Cloudflare cache (`readEligibleCached`), and the cache used
// to keep no record of when its answer was read. `recomputePool` stamped
// `computedAtMs` at its own start, so a lane compute built on a list read 50
// seconds earlier carried a fresh stamp, and the #1048 compare and swap on
// `bucket_slots` let it overwrite a row the push, booking or time off refresh had
// written 20 seconds earlier from LIVE eligibility. The newer row lost to the older
// list because the stamp recorded when this copy was used, not when it was true.
//
// This drives the real pieces end to end, with only the edges faked: the real
// cache reader over an in memory `caches.default`, the real `recomputePool`, and the
// real `writeSlotRow` against the shared `bucket_slots` fake that evaluates the
// compare and swap's filters.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-recompute-eligibility-stamp.ts
import { readEligibleCached, trackEligibleReads } from "../src/lib/availability/eligible-cache.ts";
import { recomputePool, type PooledBucket } from "../src/lib/availability/pool-recompute.ts";
import { writeSlotRow } from "../src/lib/availability/slot-row-write.ts";
import {
  readKnownSlotRows,
  resetStartedColumnProbe,
  startedColumnAbsent,
  COMPUTE_STARTED_COLUMN,
} from "../src/lib/availability/slot-row-times.ts";
import { ELIGIBLE_TTL_SECONDS } from "../src/lib/availability/eligible-cache-key.ts";
import type { Bucket } from "../src/lib/db/types.ts";
import type { BucketSlots, EligibleAgents } from "../src/lib/availability/service.ts";
import { fakeBucketSlotsTable, type SlotRow } from "./lib/fake-bucket-slots-table.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const T0 = Date.parse("2026-10-23T14:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function bucket(code: string): Bucket {
  return {
    id: `id-${code}`,
    org_id: "org-1",
    code,
    name: `Bucket ${code}`,
    event_type_id: "event-1",
    assignment: "round_robin",
    criteria: { debt_team: "low" },
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const POOL: PooledBucket[] = ["100"].map((code) => ({
  code,
  bucket: bucket(code),
  orgId: "org-1",
  eventTypeId: "event-1",
  criteria: { debt_team: "low" },
  fallbackUserId: null,
  memberIds: [],
}));

/** An in memory `caches.default`, installed for the length of one case. */
function installCache(): { entries: Map<string, string>; restore(): void } {
  const entries = new Map<string, string>();
  const g = globalThis as unknown as { caches?: unknown };
  const before = g.caches;
  g.caches = {
    default: {
      async match(req: Request) {
        const body = entries.get(req.url);
        return body === undefined ? undefined : new Response(body);
      },
      async put(req: Request, res: Response) {
        entries.set(req.url, await res.text());
      },
    },
  };
  return {
    entries,
    restore() {
      g.caches = before;
    },
  };
}

/** A compute that resolves eligibility through `resolve` the way the real one does,
 *  and offers one slot per eligible agent so the payload says which list it saw. */
function computeWith(resolve: (b: Bucket) => Promise<EligibleAgents>) {
  return async (code: string): Promise<BucketSlots> => {
    const { ids } = await resolve(bucket(code));
    return {
      bucket: bucket(code),
      eventType: { id: "event-1", duration_min: 30 } as unknown as BucketSlots["eventType"],
      orgName: "Pennie",
      slots: ids.map((id) => `slot-for-${id}`),
    };
  };
}

/**
 * The scenario the issue names. A cached list is read at `cachedReadAtMs`, a live
 * path writes the row at `liveWriteAtMs`, and the lane recomputes at T0 through the
 * cache. Returns the row left standing and what the lane's write reported.
 */
async function laneAfterLiveWrite(
  cachedReadAtMs: number,
  liveWriteAtMs: number,
  /** Columns the table lacks: the database before migration 0202 is applied. */
  withoutColumns: string[] = [],
) {
  resetStartedColumnProbe();
  const cache = installCache();
  try {
    const clock = { t: cachedReadAtMs };
    const nowMs = () => clock.t;
    // 1. Somebody (the monitor lane, say) reads the pool through the cache while
    //    agent a2 is still in it. The cache stores that answer.
    const stale: EligibleAgents = { ids: ["a1", "a2"], fallbackApplied: false };
    await readEligibleCached(bucket("100"), { resolver: async () => stale, nowMs });

    // 2. a2 leaves the pool, and a live path refreshes the row from live eligibility.
    const { db, rows } = fakeBucketSlotsTable([] as SlotRow[], { withoutColumns });
    const live = { slots: ["slot-for-a1"] };
    eq(await writeSlotRow(db, "100", live, liveWriteAtMs, "push"), "written", "the live refresh stores its row");

    // 3. The lane recomputes at T0, reading eligibility through the cache. The live
    //    resolver would now say only a1, so a hit is the only way a2 comes back.
    clock.t = T0;
    let liveReads = 0;
    const reads = trackEligibleReads((b) =>
      readEligibleCached(b, {
        resolver: async () => {
          liveReads++;
          return { ids: ["a1"], fallbackApplied: false };
        },
        nowMs,
      }),
    );
    let outcome: string | undefined;
    const pooled = await recomputePool(POOL, {
      nowMs,
      compute: computeWith(reads.resolve),
      eligibilityReadAtMs: reads.oldestReadAtMs,
      writeRow: async (code, val, computedAtMs, startedAtMs) => {
        outcome = await writeSlotRow(db, code, val, computedAtMs, "lane", startedAtMs);
        return outcome as "written";
      },
      invalidate: async () => {},
    });
    return { row: rows[0]!, outcome, liveReads, stampLagMs: pooled.stampLagMs, db };
  } finally {
    cache.restore();
  }
}

// --- The defect: a list read 50s ago must not beat a live row written 20s ago ---

{
  const { row, outcome, liveReads, stampLagMs } = await laneAfterLiveWrite(T0 - 50_000, T0 - 20_000);
  eq(liveReads, 0, "the lane's eligibility came from the cache, not a live read");
  eq(stampLagMs, 50_000, "and the pool reports its stamp moved back 50s, for the lane's log line");
  eq(outcome, "kept-newer", "the lane's write reports that a fresher row already stands");
  eq(
    (row.payload as { slots: string[] }).slots,
    ["slot-for-a1"],
    "the live row built without a2 is NOT overwritten by the cached list that still has a2",
  );
  eq(row.computed_at, iso(T0 - 20_000), "and keeps the live refresh's own stamp");
  eq(row.compute_started_at, iso(T0 - 20_000), "and its own start, which for a live path is the stamp");
}

// --- The control: a cached list read AFTER the live write still wins ---

{
  const { row, outcome, stampLagMs } = await laneAfterLiveWrite(T0 - 10_000, T0 - 20_000);
  eq(stampLagMs, 10_000, "a 10s old list moves the stamp back 10s");
  eq(outcome, "written", "a list read after the live write is newer, so the lane's row lands");
  eq(
    (row.payload as { slots: string[] }).slots,
    ["slot-for-a1", "slot-for-a2"],
    "carrying what that list said",
  );
  eq(row.computed_at, iso(T0 - 10_000), "stamped from when its list was read, not from the compute's start");
  eq(row.compute_started_at, iso(T0), "and records when the compute started, which the lane schedules from");
}

// --- Before migration 0202: the same writes land, with the stamp alone ---

{
  const { row, outcome } = await laneAfterLiveWrite(T0 - 50_000, T0 - 20_000, [COMPUTE_STARTED_COLUMN]);
  eq(outcome, "kept-newer", "with no start column the gate still keeps the newer live row");
  eq((row.payload as { slots: string[] }).slots, ["slot-for-a1"], "untouched");
  eq(row.compute_started_at, undefined, "and nothing tried to store a start");
}

{
  const { row, outcome, db } = await laneAfterLiveWrite(T0 - 10_000, T0 - 20_000, [COMPUTE_STARTED_COLUMN]);
  eq(outcome, "written", "with no start column a newer lane row still lands, rather than every write failing");
  eq(row.computed_at, iso(T0 - 10_000), "stamped from its read");
  assert(startedColumnAbsent(), "and the isolate remembers the column is missing");
  const known = await readKnownSlotRows(db);
  eq(known, [{ code: "100", computedAtMs: T0 - 10_000, startedAtMs: null }], "a read of the rows falls back to the stamp alone");
}

{
  // The read on its own, in an isolate that has not met the missing column yet.
  resetStartedColumnProbe();
  const { db } = fakeBucketSlotsTable(
    [{ bucket_code: "100", payload: {}, computed_at: iso(T0 - 10_000), invalidated_at: null }],
    { withoutColumns: [COMPUTE_STARTED_COLUMN] },
  );
  eq(
    await readKnownSlotRows(db),
    [{ code: "100", computedAtMs: T0 - 10_000, startedAtMs: null }],
    "the first read to meet the missing column retries for the stamp alone",
  );
}

{
  resetStartedColumnProbe();
  const { db } = fakeBucketSlotsTable([
    { bucket_code: "100", payload: {}, computed_at: iso(T0 - 10_000), invalidated_at: null, compute_started_at: iso(T0) },
    { bucket_code: "101", payload: {}, computed_at: "not a time", invalidated_at: null, compute_started_at: "nor this" },
  ]);
  eq(
    await readKnownSlotRows(db),
    [
      { code: "100", computedAtMs: T0 - 10_000, startedAtMs: T0 },
      { code: "101", computedAtMs: 0, startedAtMs: null },
    ],
    "with the column, both times are read; unreadable ones fail closed (#1169)",
  );
  assert(!startedColumnAbsent(), "and a table that has the column is never marked as missing it");
}

{
  // An unrelated error must not be mistaken for the missing column and retried.
  resetStartedColumnProbe();
  const db = {
    from: () => ({ select: async () => ({ data: null, error: { code: "42703", message: "column bucket_slots.other does not exist" } }) }),
  } as never;
  let threw = false;
  try {
    await readKnownSlotRows(db);
  } catch {
    threw = true;
  }
  assert(threw, "a different undefined column is a failed read, never an empty one");
  assert(!startedColumnAbsent(), "and does not mark the start column missing");
}

// --- A cached list past the cache's lifetime is never used ---

{
  const cache = installCache();
  try {
    const clock = { t: T0 };
    const nowMs = () => clock.t;
    await readEligibleCached(bucket("100"), { resolver: async () => ({ ids: ["old"], fallbackApplied: false }), nowMs });
    clock.t = T0 + ELIGIBLE_TTL_SECONDS * 1000;
    const atLimit = await readEligibleCached(bucket("100"), {
      resolver: async () => ({ ids: ["fresh"], fallbackApplied: false }),
      nowMs,
    });
    eq(atLimit.agents.ids, ["old"], "an entry exactly one lifetime old is still served");
    clock.t += 1;
    const past = await readEligibleCached(bucket("100"), {
      resolver: async () => ({ ids: ["fresh"], fallbackApplied: false }),
      nowMs,
    });
    eq(past.agents.ids, ["fresh"], "one older than its lifetime is a miss, even when the platform served it");
    eq(past.readAtMs, clock.t, "and is read live");
  } finally {
    cache.restore();
  }
}

// --- A cache miss reads live during the compute, so the stamp is the start, as today ---

{
  const cache = installCache();
  try {
    const clock = { t: T0 };
    const nowMs = () => clock.t;
    const reads = trackEligibleReads((b) =>
      readEligibleCached(b, {
        resolver: async () => {
          clock.t = T0 + 3_000; // the live read takes three seconds
          return { ids: ["a1"], fallbackApplied: false };
        },
        nowMs,
      }),
    );
    const stamps: number[] = [];
    const pooled = await recomputePool(POOL, {
      nowMs,
      compute: computeWith(reads.resolve),
      eligibilityReadAtMs: reads.oldestReadAtMs,
      writeRow: async (_code, _val, at) => {
        stamps.push(at);
        return "written";
      },
      invalidate: async () => {},
    });
    eq(stamps, [T0], "a miss read during the compute leaves the stamp at the compute's start");
    eq(pooled.stampLagMs, null, "and reports no lag");
    // The entry it stored records when that read BEGAN, the earlier and so the safe
    // end of a read that took three seconds.
    const stored = JSON.parse([...cache.entries.values()][0]!) as { readAtMs: number };
    eq(stored.readAtMs, T0, "the cache records when the live read began");
  } finally {
    cache.restore();
  }
}

// --- No cache at all (any path that is not the lane): stamped at the start ---

{
  const stamps: number[] = [];
  await recomputePool(POOL, {
    nowMs: () => T0,
    compute: computeWith(async () => ({ ids: ["a1"], fallbackApplied: false })),
    writeRow: async (_code, _val, at) => {
      stamps.push(at);
      return "written";
    },
    invalidate: async () => {},
  });
  eq(stamps, [T0], "a compute with no read time to report is stamped at its start, exactly as before");
}

// --- Several reads in one compute: the OLDEST decides ---

{
  const answers = [T0 - 5_000, T0 - 40_000, T0 - 15_000];
  const reads = trackEligibleReads(async () => ({
    agents: { ids: ["a1"], fallbackApplied: false },
    readAtMs: answers.shift()!,
  }));
  for (let i = 0; i < 3; i++) await reads.resolve(bucket("100"));
  eq(reads.oldestReadAtMs(), T0 - 40_000, "a compute is only as fresh as the oldest list it used");
}

{
  const reads = trackEligibleReads(async () => ({
    agents: { ids: [], fallbackApplied: false },
    readAtMs: T0,
  }));
  eq(reads.oldestReadAtMs(), null, "nothing read yet reports no read time, never a made up one");
}

// --- An unreadable cache entry is a miss, never an answer with no read time ---

{
  const cache = installCache();
  try {
    // One stored before the read time existed, and one that is not even JSON.
    for (const body of [JSON.stringify({ ids: ["old"], fallbackApplied: false }), "{not json"]) {
      cache.entries.clear();
      let liveReads = 0;
      const nowMs = () => T0;
      // Prime the key, then overwrite what it holds with the unreadable body.
      await readEligibleCached(bucket("100"), { resolver: async () => ({ ids: [], fallbackApplied: false }), nowMs });
      const key = [...cache.entries.keys()][0]!;
      cache.entries.set(key, body);
      const read = await readEligibleCached(bucket("100"), {
        resolver: async () => {
          liveReads++;
          return { ids: ["fresh"], fallbackApplied: false };
        },
        nowMs,
      });
      eq(liveReads, 1, `an entry it cannot date (${body.slice(0, 12)}) is read live instead`);
      eq(read.agents.ids, ["fresh"], "and the live answer is what is used");
      eq(read.readAtMs, T0, "dated from that live read");
    }
  } finally {
    cache.restore();
  }
}

{
  // A non finite stored stamp must not reach the comparison (L50).
  const cache = installCache();
  try {
    const nowMs = () => T0;
    await readEligibleCached(bucket("100"), { resolver: async () => ({ ids: [], fallbackApplied: false }), nowMs });
    const key = [...cache.entries.keys()][0]!;
    cache.entries.set(key, JSON.stringify({ agents: { ids: ["x"], fallbackApplied: false }, readAtMs: "soon" }));
    let liveReads = 0;
    await readEligibleCached(bucket("100"), {
      resolver: async () => {
        liveReads++;
        return { ids: ["fresh"], fallbackApplied: false };
      },
      nowMs,
    });
    eq(liveReads, 1, "a stored read time that is not a number makes the entry a miss");
  } finally {
    cache.restore();
  }
}

assert(true, "suite reached its end");
finish();

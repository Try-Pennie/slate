import { resolveBucketSlots, type ReadDeps } from "../src/lib/availability/precompute-core.ts";
import type { BucketSlots } from "../src/lib/availability/service.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// #257/#234: the read path now reports WHERE the slots came from (source:
// hit=L1 Cache API, row=L2 precomputed bucket_slots row, compute=cold live
// compute) and WHEN they were computed (computedAt, from bucket_slots.computed_at),
// so /api/availability can expose x-slot-cache and x-slots-computed-at headers.
// The core invariant (never run the multi-agent compute when a good answer
// exists) is unchanged.

const sampleSlots = (): BucketSlots => ({
  bucket: { code: "411", name: "Call" } as BucketSlots["bucket"],
  eventType: { duration_min: 20, min_notice_min: 0 } as BucketSlots["eventType"],
  orgName: "Pennie",
  slots: ["2026-06-19T16:00:00.000Z"],
});

const WROTE_AT = "2026-06-19T12:00:00.000Z";

// Spy deps: count every call so we can assert what the read path did NOT do.
function deps(over: Partial<ReadDeps> & { calls: Record<string, number> }): ReadDeps {
  const c = over.calls;
  const bump = (k: string) => { c[k] = (c[k] ?? 0) + 1; };
  return {
    cacheGet: async () => { bump("cacheGet"); return null; },
    cachePut: async () => { bump("cachePut"); },
    readRow: async () => { bump("readRow"); return null; },
    compute: async () => { bump("compute"); return null; },
    writeRow: async () => { bump("writeRow"); return WROTE_AT; },
    ...over,
  };
}

// 1) Warm cache hit: return it (source=hit), carry the cached computedAt, never
// touch the row or compute.
{
  const calls: Record<string, number> = {};
  const hit = { ...sampleSlots(), computedAt: WROTE_AT };
  const d = deps({ calls, cacheGet: async () => { calls.cacheGet = (calls.cacheGet ?? 0) + 1; return hit; } });
  const r = await resolveBucketSlots("411", "2026-06-19T12:00:00.000Z", 4, d);
  assert(r !== null, "cache hit returns a value");
  eq(r!.source, "hit", "cache hit reports source=hit");
  eq(r!.computedAt, WROTE_AT, "cache hit carries the cached computedAt");
  eq(r!.slots, hit.slots, "cache hit returns the cached slots");
  assert(!calls.readRow && !calls.compute, "cache hit does NOT read the row or compute");
}

// 2) Cache miss, precomputed row present: return the row (source=row) with its
// computed_at, warm the cache, never compute.
{
  const calls: Record<string, number> = {};
  const row = sampleSlots();
  let cached: unknown = null;
  const d = deps({
    calls,
    readRow: async () => { calls.readRow = (calls.readRow ?? 0) + 1; return { payload: row, computed_at: WROTE_AT }; },
    cachePut: async (_k, v) => { calls.cachePut = (calls.cachePut ?? 0) + 1; cached = v; },
  });
  const r = await resolveBucketSlots("411", "2026-06-19T12:00:00.000Z", 4, d);
  eq(r!.source, "row", "row hit reports source=row");
  eq(r!.computedAt, WROTE_AT, "row hit reports the row's computed_at");
  eq(r!.slots, row.slots, "row hit returns the stored slots");
  assert(!calls.compute, "row hit does NOT run the multi-agent compute");
  assert(calls.cachePut === 1, "row hit warms the cache");
  eq((cached as { computedAt: string }).computedAt, WROTE_AT, "the cached blob carries computedAt so later L1 hits report it");
}

// 3) Cache miss + no row: bounded fail-open compute (source=compute), self-heal
// (write row + cache), computedAt from the write.
{
  const calls: Record<string, number> = {};
  const fresh = sampleSlots();
  const d = deps({ calls, compute: async () => { calls.compute = (calls.compute ?? 0) + 1; return fresh; } });
  const r = await resolveBucketSlots("411", "2026-06-19T12:00:00.000Z", 4, d);
  eq(r!.source, "compute", "never-computed bucket falls open to a live compute (source=compute)");
  eq(r!.computedAt, WROTE_AT, "compute path reports the timestamp it wrote");
  eq(r!.slots, fresh.slots, "compute path returns the freshly computed slots");
  assert(calls.writeRow === 1, "fail-open self-heals by writing the row");
  assert(calls.cachePut === 1, "fail-open warms the cache");
}

// 4) Cache miss + no row + compute also yields nothing (unknown bucket): null.
{
  const calls: Record<string, number> = {};
  const d = deps({ calls });
  const r = await resolveBucketSlots("nope", "2026-06-19T12:00:00.000Z", 4, d);
  eq(r, null, "unknown bucket returns null");
  assert(!calls.writeRow && !calls.cachePut, "nothing is written or cached for an unknown bucket");
}

finish();

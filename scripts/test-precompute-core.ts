import { resolveBucketSlots, type ReadDeps } from "../src/lib/availability/precompute-core.ts";
import type { BucketSlots } from "../src/lib/availability/service.ts";
import { assert, finish } from "./lib/harness.ts";

const sampleSlots = (): BucketSlots => ({
  bucket: { code: "411", name: "Call" } as BucketSlots["bucket"],
  eventType: { duration_min: 20, min_notice_min: 0 } as BucketSlots["eventType"],
  orgName: "Pennie",
  slots: ["2026-06-19T16:00:00.000Z"],
});

// Spy deps: count every call so we can assert what the read path did NOT do.
function deps(over: Partial<ReadDeps> & { calls: Record<string, number> }): ReadDeps {
  const c = over.calls;
  const bump = (k: string) => { c[k] = (c[k] ?? 0) + 1; };
  return {
    cacheGet: async () => { bump("cacheGet"); return null; },
    cachePut: async () => { bump("cachePut"); },
    readRow: async () => { bump("readRow"); return null; },
    compute: async () => { bump("compute"); return null; },
    writeRow: async () => { bump("writeRow"); },
    ...over,
  };
}

// 1) Warm cache hit: return it, never touch the row or compute.
{
  const calls: Record<string, number> = {};
  const hit = sampleSlots();
  const d = deps({ calls, cacheGet: async () => { calls.cacheGet = (calls.cacheGet ?? 0) + 1; return hit; } });
  const r = await resolveBucketSlots("411", "2026-06-19T12:00:00.000Z", 4, d);
  assert(r === hit, "cache hit returns the cached value");
  assert(!calls.readRow && !calls.compute, "cache hit does NOT read the row or compute");
}

// 2) Cache miss, precomputed row present: return the row, warm the cache, never compute.
{
  const calls: Record<string, number> = {};
  const row = sampleSlots();
  const d = deps({ calls, readRow: async () => { calls.readRow = (calls.readRow ?? 0) + 1; return { payload: row }; } });
  const r = await resolveBucketSlots("411", "2026-06-19T12:00:00.000Z", 4, d);
  assert(JSON.stringify(r) === JSON.stringify(row), "row hit returns the stored payload");
  assert(!calls.compute, "row hit does NOT run the multi-agent compute");
  assert(calls.cachePut === 1, "row hit warms the cache");
}

// 3) Cache miss + no row: bounded fail-open compute, then self-heal (write row + cache).
{
  const calls: Record<string, number> = {};
  const fresh = sampleSlots();
  const d = deps({ calls, compute: async () => { calls.compute = (calls.compute ?? 0) + 1; return fresh; } });
  const r = await resolveBucketSlots("411", "2026-06-19T12:00:00.000Z", 4, d);
  assert(r === fresh, "never-computed bucket falls open to a live compute");
  assert(calls.writeRow === 1, "fail-open self-heals by writing the row");
  assert(calls.cachePut === 1, "fail-open warms the cache");
}

finish();

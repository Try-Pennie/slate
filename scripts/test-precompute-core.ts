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

// Gate 1 (#1296) held open all week, so the existing assertions below stay about
// cache orchestration. The filter's own behaviour is the block at the end.
const OPEN_ALL_WEEK = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })), exceptions: [] };

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
    businessHours: async () => { bump("businessHours"); return OPEN_ALL_WEEK; },
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

// 5) #1296: the read FILTERS against the org's hours, on every tier.
//
// The cache-hit case is the one with teeth. A slot computed while the org was open
// until 20:00 is already sitting in the L1 cache when an admin narrows the day to
// 15:00. Nothing recomputes it for up to a cycle, so without a read-time filter the
// booker keeps offering a time the org has just closed, and it looks entirely
// healthy while doing so.
{
  const sample = (): BucketSlots => ({
    bucket: { code: "411", name: "Call" } as BucketSlots["bucket"],
    eventType: { duration_min: 30, min_notice_min: 0 } as BucketSlots["eventType"],
    orgName: "Pennie",
    // Monday 2026-06-08, New York: 09:00, 14:00, 19:00 local.
    slots: [
      "2026-06-08T13:00:00.000Z",
      "2026-06-08T18:00:00.000Z",
      "2026-06-08T23:00:00.000Z",
    ],
  });
  const narrowed = {
    zone: "America/New_York",
    rules: [{ weekday: 1, start_minute: 8 * 60, end_minute: 15 * 60 }], exceptions: [] };

  // -- a warm L1 hit, computed under the wider week
  {
    const calls: Record<string, number> = {};
    const hit = { ...sample(), computedAt: WROTE_AT };
    const d = deps({
      calls,
      cacheGet: async () => hit,
      businessHours: async () => narrowed,
    });
    const r = await resolveBucketSlots("411", "2026-06-08T04:00:00.000Z", 4, d);
    eq(r!.source, "hit", "the narrowed read still comes off the cache, no recompute");
    eq(
      r!.slots,
      ["2026-06-08T13:00:00.000Z", "2026-06-08T18:00:00.000Z"],
      "a cache hit is filtered to the CURRENT hours, so a narrowing lands on the next request",
    );
    assert(!calls.compute && !calls.writeRow, "the filter costs no compute and writes nothing");
  }

  // -- the stored row tier
  {
    const calls: Record<string, number> = {};
    const d = deps({
      calls,
      readRow: async () => ({ payload: sample(), computed_at: WROTE_AT }),
      businessHours: async () => narrowed,
    });
    const r = await resolveBucketSlots("411", "2026-06-08T04:00:00.000Z", 4, d);
    eq(r!.slots.length, 2, "the stored row is filtered too");
  }

  // -- the cold compute tier (already gated at compute time; filtering again is
  //    idempotent, and proves no tier can return an unfiltered list)
  {
    const calls: Record<string, number> = {};
    const d = deps({ calls, compute: async () => sample(), businessHours: async () => narrowed });
    const r = await resolveBucketSlots("411", "2026-06-08T04:00:00.000Z", 4, d);
    eq(r!.slots.length, 2, "the cold compute path is filtered on the way out as well");
  }

  // -- what gets CACHED is the unfiltered payload, so a WIDENING is just as
  //    immediate as a narrowing: the filter is applied per read, not baked in.
  {
    const calls: Record<string, number> = {};
    let cached: { slots: string[] } | null = null;
    const d = deps({
      calls,
      readRow: async () => ({ payload: sample(), computed_at: WROTE_AT }),
      cachePut: async (_k, v) => { cached = v as unknown as { slots: string[] }; },
      businessHours: async () => narrowed,
    });
    await resolveBucketSlots("411", "2026-06-08T04:00:00.000Z", 4, d);
    eq(
      cached!.slots.length,
      3,
      "the cache keeps the UNFILTERED payload, so re-opening the day serves the extra slot at once",
    );
  }

  // -- a slot whose instant cannot be read is dropped, never served
  {
    const calls: Record<string, number> = {};
    const broken = { ...sample(), slots: ["not-a-date", "2026-06-08T13:00:00.000Z"], computedAt: WROTE_AT };
    const d = deps({ calls, cacheGet: async () => broken, businessHours: async () => narrowed });
    const r = await resolveBucketSlots("411", "2026-06-08T04:00:00.000Z", 4, d);
    eq(r!.slots, ["2026-06-08T13:00:00.000Z"], "an unreadable instant is dropped from the offered list");
  }

  // -- a slot that STRADDLES the close is dropped whole, not truncated
  {
    const calls: Record<string, number> = {};
    // 14:45 local, a 30-minute slot ending 15:15, against a 15:00 close.
    const straddle = {
      ...sample(),
      slots: ["2026-06-08T18:45:00.000Z"],
      computedAt: WROTE_AT,
    };
    const d = deps({ calls, cacheGet: async () => straddle, businessHours: async () => narrowed });
    const r = await resolveBucketSlots("411", "2026-06-08T04:00:00.000Z", 4, d);
    eq(r!.slots, [], "a slot running past the close is dropped, matching the compute-time gate");
  }
}

// 6) #1326: the fail-open compute trims to the bookable-day count before it is
// stored or served.
//
// [nf, nt) is a SEARCH window, deliberately wider than the days we intend to offer,
// so a closed day inside it cannot eat one. Without the trim here the ONE bucket
// that takes the cold-compute branch would quietly offer a longer strip than every
// other bucket, and nothing about it would look wrong.
{
  const calls: Record<string, number> = {};
  // Six days of times with Sunday 2026-08-16 absent, which is what the wider window
  // produces. Four bookable days must reach Monday, not stop at the fourth calendar day.
  const wide: BucketSlots = {
    ...sampleSlots(),
    slots: [
      "2026-08-13T13:00:00.000Z",
      "2026-08-14T13:00:00.000Z",
      "2026-08-15T13:00:00.000Z",
      "2026-08-17T13:00:00.000Z",
      "2026-08-18T13:00:00.000Z",
    ],
  };
  let written: BucketSlots | null = null;
  const d = deps({
    calls,
    compute: async () => wide,
    writeRow: async (_c, v) => { written = v; return WROTE_AT; },
    businessHours: async () => OPEN_ALL_WEEK,
  });
  const r = await resolveBucketSlots("411", "2026-08-13T04:00:00.000Z", 4, d);

  eq(
    r!.slots.map((s) => s.slice(0, 10)).join(","),
    "2026-08-13,2026-08-14,2026-08-15,2026-08-17",
    "the cold compute serves four BOOKABLE days, walking past the empty Sunday",
  );
  assert(
    !r!.slots.some((s) => s.startsWith("2026-08-18")),
    "and stops at four rather than serving everything the wider window found",
  );
  // The row must match what is served, or the next reader of the row disagrees with
  // the customer who was just shown the trimmed list.
  eq(
    (written as unknown as BucketSlots).slots.length,
    4,
    "and the row it self-heals with holds the same four days, not the wider set",
  );
}

finish();

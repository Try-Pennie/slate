import { resolveBucketSlots, SUPERSEDED_BY_SAVE, type ReadDeps } from "../src/lib/availability/precompute-core.ts";
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
/** The read path's clock: the fixtures' own instant, injected rather than read (#3381). */
const NOW_MS = Date.parse("2026-06-19T12:00:07.000Z");

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
    nowMs: () => NOW_MS,
    compute: async () => { bump("compute"); return null; },
    writeRow: async () => { bump("writeRow"); return WROTE_AT; },
    writeFailed: () => { bump("writeFailed"); },
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
  const r = await resolveBucketSlots("411", 4, d);
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
  const r = await resolveBucketSlots("411", 4, d);
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
  const r = await resolveBucketSlots("411", 4, d);
  eq(r!.source, "compute", "never-computed bucket falls open to a live compute (source=compute)");
  eq(r!.computedAt, WROTE_AT, "compute path reports the timestamp it wrote");
  eq(r!.slots, fresh.slots, "compute path returns the freshly computed slots");
  assert(calls.writeRow === 1, "fail-open self-heals by writing the row");
  assert(calls.cachePut === 1, "fail-open warms the cache");
}

// 3b) #3119: the self-heal write is REFUSED. The lead still gets the times that were
// computed (this is the fail-open path, and a refused cache row must not become an
// empty booker), and the refusal is handed to writeFailed rather than read as stored.
{
  const calls: Record<string, number> = {};
  const fresh = sampleSlots();
  const refusals: { code: string; err: unknown }[] = [];
  const refused = new Error("row refused");
  const d = deps({
    calls,
    compute: async () => fresh,
    writeRow: async () => { throw refused; },
    writeFailed: (code, err) => { refusals.push({ code, err }); },
  });
  const r = await resolveBucketSlots("411", 4, d);
  eq(r!.source, "compute", "a refused self-heal write still serves the computed times");
  eq(r!.slots, fresh.slots, "the same slots it would have stored");
  eq(refusals.length, 1, "the refusal is reported once");
  eq(refusals[0]!.err, refused, "with the error itself");
  assert(r!.computedAt !== WROTE_AT && r!.computedAt !== null, "labelled with when the compute began, not a stamp nothing wrote");
}

// 3c) #3118: a settings save landed while the cold compute ran, so the write was
// refused as invalidated. Those slots were computed under the OLD settings, so they
// are neither served nor cached: the read computes once more, after the save, and
// serves and stores that.
{
  const calls: Record<string, number> = {};
  const before = { ...sampleSlots(), slots: ["2026-06-19T16:00:00.000Z"] };
  const after = { ...sampleSlots(), slots: ["2026-06-19T17:00:00.000Z"] };
  const computed = [before, after];
  const writes: BucketSlots[] = [];
  const cached: unknown[] = [];
  const d = deps({
    calls,
    compute: async () => computed.shift() ?? null,
    writeRow: async (_c, v) => {
      writes.push(v);
      return writes.length === 1 ? SUPERSEDED_BY_SAVE : WROTE_AT;
    },
    cachePut: async (_k, v) => { cached.push(v); },
  });
  const r = await resolveBucketSlots("411", 4, d);
  eq(r!.slots, after.slots, "the request is served the compute that began after the save");
  eq(writes.length, 2, "the superseded compute is redone once and stored");
  eq(cached.length, 1, "only the second compute is cached");
  eq((cached[0] as BucketSlots).slots, after.slots, "and the cache holds the new settings, never the old");
  eq(r!.computedAt, WROTE_AT, "labelled with the stamp the second write stored");
}

// 3d) #3118: a second save lands during the redo too. The redo began after the
// first save, but not after the second, so it is served to this one request (the
// fail-open path must not empty the booker) and NOT cached, and it stops there:
// one redo, never a loop on a busy settings screen.
{
  const calls: Record<string, number> = {};
  let n = 0;
  const cached: unknown[] = [];
  const d = deps({
    calls,
    compute: async () => { n++; return sampleSlots(); },
    writeRow: async () => SUPERSEDED_BY_SAVE,
    cachePut: async (_k, v) => { cached.push(v); },
  });
  const r = await resolveBucketSlots("411", 4, d);
  eq(n, 2, "it redoes the compute once, and only once");
  assert(r !== null && r.source === "compute", "the request is still answered");
  eq(cached.length, 0, "a payload superseded twice is never cached");
}

// 4) Cache miss + no row + compute also yields nothing (unknown bucket): null.
{
  const calls: Record<string, number> = {};
  const d = deps({ calls });
  const r = await resolveBucketSlots("nope", 4, d);
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
    const r = await resolveBucketSlots("411", 4, d);
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
    const r = await resolveBucketSlots("411", 4, d);
    eq(r!.slots.length, 2, "the stored row is filtered too");
  }

  // -- the cold compute tier (already gated at compute time; filtering again is
  //    idempotent, and proves no tier can return an unfiltered list)
  {
    const calls: Record<string, number> = {};
    const d = deps({ calls, compute: async () => sample(), businessHours: async () => narrowed });
    const r = await resolveBucketSlots("411", 4, d);
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
    await resolveBucketSlots("411", 4, d);
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
    const r = await resolveBucketSlots("411", 4, d);
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
    const r = await resolveBucketSlots("411", 4, d);
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
  const r = await resolveBucketSlots("411", 4, d);

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

// 7) #3381 step 3: the cold compute anchors on NOW, never on the caller's `from`.
//
// The stored row never depended on `from` (#3366), and every recompute path anchors
// on now. The cold compute anchored on the caller's: an evening Eastern lead sends
// their local midnight, which is YESTERDAY's UTC date, so the window started a day
// early and ran a day short at the far end; a booker that had paged forward anchored
// on a FUTURE day and stored a row with none of today's times. Either row then stood
// as the bucket's row until the next recompute.
{
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  const todayUtc = "2026-10-14T00:00:00.000Z";
  const windows: { from: string; to: string }[] = [];
  // The caller's `from` no longer reaches the core at all, so there is nothing for a
  // booker's local midnight or a paged forward day to anchor.
  await resolveBucketSlots("411", 4, deps({
    calls: {},
    nowMs: () => now,
    compute: async (_c, from, to) => {
      windows.push({ from, to });
      return sampleSlots();
    },
  }));
  eq(windows[0]!.from, todayUtc, "the cold compute's window starts on today's UTC day, the anchor every recompute uses");
  assert(
    Date.parse(windows[0]!.to) > now + 4 * 86_400_000,
    "and reaches past the horizon from TODAY, so the row it stores is not a day short",
  );
}

// 7b) And the stamp the cold write is labelled with is the injected clock's, not the
// wall clock's (#1048's "when the compute began", now testable).
{
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  let stamped = -1;
  await resolveBucketSlots("411", 4, deps({
    calls: {},
    nowMs: () => now,
    compute: async () => sampleSlots(),
    writeRow: async (_c, _v, atMs) => { stamped = atMs; return new Date(atMs).toISOString(); },
  }));
  eq(stamped, now, "the cold write is stamped from the injected clock");
}

// 8) #3381: every tier says which path wrote what it served, and whether a booking
// was spliced in since, for the `slots served` line.
{
  const fenceAt = Date.parse("2026-06-19T12:01:00.000Z");
  const spliced = {
    ...sampleSlots(),
    writtenBy: "push",
    splice: { seq: 1, fenceAt: new Date(fenceAt).toISOString(), windows: [{ atMs: fenceAt, fromMs: 0, lastStartMs: 1, reoffer: true }] },
  };
  let cached: Record<string, unknown> | null = null;
  const fromRow = await resolveBucketSlots("411", 4, deps({
    calls: {},
    readRow: async () => ({ payload: spliced, computed_at: WROTE_AT }),
    cachePut: async (_k, v) => { cached = v as unknown as Record<string, unknown>; },
  }));
  eq(fromRow!.writtenBy, "push", "a row read names its writer");
  eq(fromRow!.spliced, "2026-06-19T12:01:00.000Z+reoffer", "and the splice since its compute, re-offer marked");
  assert(!("splice" in fromRow!) && fromRow!.slots.length === 1, "the fence itself is still never served");
  eq(cached!.writtenBy, "push", "the edge cache entry carries the writer, so a hit can say it too");

  const fromHit = await resolveBucketSlots("411", 4, deps({
    calls: {},
    cacheGet: async () => ({ ...sampleSlots(), computedAt: WROTE_AT, writtenBy: "lane", spliced: null }),
  }));
  eq(fromHit!.writtenBy, "lane", "a hit names the writer its entry was cached with");

  const oldEntry = await resolveBucketSlots("411", 4, deps({
    calls: {},
    cacheGet: async () => ({ ...sampleSlots(), computedAt: WROTE_AT }),
  }));
  eq(oldEntry!.writtenBy, null, "an entry cached before this shipped says not recorded, never a writer");

  const cold = await resolveBucketSlots("411", 4, deps({ calls: {}, compute: async () => sampleSlots() }));
  eq(cold!.writtenBy, "cold", "a cold compute names itself");
  eq(cold!.spliced, null, "with nothing spliced");
}

// 9) #3713: the business hours read runs BESIDE the edge cache and stored row reads,
// not after them. Measured 2026-10-14 to 16 on lead reads: hours about 65ms, row about
// 50ms and cache about 15ms, one after another, on nearly every read, because both
// caches live 5 seconds and a lead read reaches an isolate a minute or more apart.
{
  const calls: Record<string, number> = {};
  let answerCache!: (v: null) => void;
  const pending = resolveBucketSlots("411", 4, deps({
    calls,
    cacheGet: () => { calls.cacheGet = (calls.cacheGet ?? 0) + 1; return new Promise((r) => { answerCache = r; }); },
    readRow: async () => ({ payload: sampleSlots(), computed_at: WROTE_AT }),
  }));
  await Promise.resolve();
  eq(calls.businessHours ?? 0, 1, "the hours read has started while the edge cache lookup is still waiting");
  answerCache(null);
  const r = await pending;
  eq(r!.source, "row", "and the read still serves the stored row once the cache misses");
  eq(calls.businessHours, 1, "with one hours read for the whole request");
}

// 9b) The cold compute groups days in the org's zone AND filters on the way out, and
// both use the one hours read the request started.
{
  const calls: Record<string, number> = {};
  await resolveBucketSlots("411", 4, deps({ calls, compute: async () => sampleSlots() }));
  eq(calls.businessHours, 1, "a cold compute reads the hours once, not once per use");
}

// 9c) Starting it early must not change what a failed read does. A cold isolate whose
// first hours read fails still fails the request (#1296: inventing a week could
// re-open hours an admin narrowed), on every tier.
{
  const failing = async () => { throw new Error("hours unreadable"); };
  for (const [tier, over] of [
    ["hit", { cacheGet: async () => ({ ...sampleSlots(), computedAt: WROTE_AT }) }],
    ["row", { readRow: async () => ({ payload: sampleSlots(), computed_at: WROTE_AT }) }],
    ["compute", { compute: async () => sampleSlots() }],
  ] as const) {
    let threw: unknown = null;
    try {
      await resolveBucketSlots("411", 4, deps({ calls: {}, ...over, businessHours: failing }));
    } catch (err) { threw = err; }
    assert(threw instanceof Error && /hours unreadable/.test(threw.message), `a failed hours read still fails a ${tier} read`);
  }
}

// 9d) An unknown bucket never reaches the served filter, so the early read's failure is
// never awaited. It must answer null, and leave no unhandled rejection behind, which
// on node kills the process and on Workers is logged as an uncaught error.
{
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => { unhandled.push(err); };
  process.on("unhandledRejection", onUnhandled);
  const r = await resolveBucketSlots("999", 4, deps({
    calls: {},
    businessHours: async () => { throw new Error("hours unreadable"); },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  eq(r, null, "an unknown bucket answers null even when the hours read failed");
  eq(unhandled.length, 0, "and the unawaited hours failure is not an unhandled rejection");
}

finish();

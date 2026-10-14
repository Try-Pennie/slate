// #2842: a pool's payload carries TWO slot lists, `slots` and `slotsWithoutLow`,
// and every step that shapes one must shape the other: the business hours filter
// on read, the bookable day trim on write, and the stored row validation. A step
// that forgot the second list would offer a top tier lead times the org has
// closed, or a strip longer than every other lead's.
import { resolveBucketSlots, type ReadDeps } from "../src/lib/availability/precompute-core.ts";
import { mapSlotLists, shapePrecomputedRow } from "../src/lib/availability/precompute-shape.ts";
import type { BucketSlots } from "../src/lib/availability/service.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MON_10 = "2026-06-22T14:00:00.000Z"; // Monday 10:00 New York
const MON_22 = "2026-06-23T02:00:00.000Z"; // Monday 22:00 New York, after hours
const TUE_10 = "2026-06-23T14:00:00.000Z";
const WED_10 = "2026-06-24T14:00:00.000Z";

const base = (over: Partial<BucketSlots> = {}): BucketSlots => ({
  bucket: { code: "311", name: "Call" } as BucketSlots["bucket"],
  eventType: { duration_min: 20, min_notice_min: 0 } as BucketSlots["eventType"],
  orgName: "Pennie",
  slots: [MON_10, MON_22, TUE_10, WED_10],
  slotsWithoutLow: [MON_22, TUE_10, WED_10],
  ...over,
});

const NINE_TO_FIVE = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1020 })),
  exceptions: [],
};

function deps(over: Partial<ReadDeps>): ReadDeps {
  return {
    cacheGet: async () => null,
    cachePut: async () => {},
    readRow: async () => null,
    nowMs: () => Date.parse("2026-06-22T12:00:00.000Z"),
    compute: async () => null,
    writeRow: async () => "2026-06-22T12:00:00.000Z",
    writeFailed: () => {
      throw new Error("no write fails in this suite");
    },
    businessHours: async () => NINE_TO_FIVE,
    ...over,
  };
}

// --- the helper applies one transform to both lists, and leaves an absent one absent ---
{
  const doubled = mapSlotLists(base(), (s) => s.slice(0, 1));
  eq(doubled.slots, [MON_10], "the main list is transformed");
  eq(doubled.slotsWithoutLow, [MON_22], "the second list is transformed too");
  const noSecond = mapSlotLists(base({ slotsWithoutLow: undefined }), (s) => s);
  assert(!("slotsWithoutLow" in noSecond), "an absent second list stays absent, never becomes empty");
}

// --- read: the business hours filter reaches both lists ---
{
  const r = await resolveBucketSlots("311", 4, deps({
    readRow: async () => ({ payload: base(), computed_at: "2026-06-22T12:00:00.000Z" }),
  }));
  assert(!r!.slots.includes(MON_22), "an after hours time is filtered from the main list");
  eq(r!.slotsWithoutLow, [TUE_10, WED_10], "and from the second list");
}

// --- cold compute: the bookable day trim reaches both lists, each on its OWN days ---
{
  let written: BucketSlots | null = null;
  const r = await resolveBucketSlots("311", 1, deps({
    compute: async () => base({ slotsWithoutLow: [TUE_10, WED_10] }),
    writeRow: async (_c, v) => { written = v; return "2026-06-22T12:00:00.000Z"; },
  }));
  eq(r!.slots, [MON_10], "the main list keeps its first bookable day");
  // Its own first day, not the main list's: the advisors without Low may be free
  // only from Tuesday, and trimming them to Monday would offer them nothing.
  eq(r!.slotsWithoutLow, [TUE_10], "the second list keeps ITS first bookable day");
  eq(written!.slotsWithoutLow, [TUE_10], "and that is what is stored");
}

// --- stored rows: a malformed second list is UNKNOWN, never a miss or an empty list ---
{
  const ok = shapePrecomputedRow({ payload: base() });
  eq(ok!.slotsWithoutLow, [MON_22, TUE_10, WED_10], "a well formed second list is kept");
  const bad = shapePrecomputedRow({ payload: { ...base(), slotsWithoutLow: "nope" } });
  assert(bad !== null, "a malformed second list does not throw the whole row away");
  assert(!("slotsWithoutLow" in bad!), "a malformed second list is dropped, which reads as unknown");
  const mixed = shapePrecomputedRow({ payload: { ...base(), slotsWithoutLow: [TUE_10, 7] } });
  assert(!("slotsWithoutLow" in mixed!), "a list holding a non string is dropped too");
}

finish();

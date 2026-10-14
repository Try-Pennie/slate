import { describe, it, expect, vi, beforeEach } from "vitest";

// #1326: recomputeBucketSlots trims to the bookable-day count BEFORE the row is
// written.
//
// The window it computes over is a search range, deliberately wider than the number
// of days we intend to offer, so a closed day inside it cannot eat one of them.
// The trim is what turns that wider result back into the answer, and it has to
// happen before the write: the stored row is what every later reader sees, so a row
// holding six days while the customer was shown four is a disagreement nobody would
// notice until they compared the two.
//
// This is the write path. The read/self-heal path has the same trim and is covered
// in scripts/test-precompute-core.ts.

const getBucketSlots = vi.hoisted(() => vi.fn());
// #1048: the row is written by a gated UPDATE (overwrite only a row older than this
// compute), falling back to an INSERT when the bucket has no row yet. This fake has no
// row, so the update matches nothing and the insert is what carries the payload; the
// gating itself is driven in scripts/test-slot-row-write.ts.
const insert = vi.hoisted(() =>
  vi.fn(async (_row: { payload: { slots: string[] } }) => ({ error: null })),
);
const from = vi.hoisted(() =>
  vi.fn(() => ({
    insert,
    update: () => ({
      eq: () => ({
        lt: () => ({ or: () => ({ select: async () => ({ data: [], error: null }) }) }),
      }),
    }),
  })),
);

vi.mock("./service", () => ({ getBucketSlots }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));

import { recomputeBucketSlots } from "./precompute";

/** Six days of times over a wider search window, with Sunday 2026-08-16 absent
 *  because nobody is rostered on it. */
const WIDE = {
  bucket: { code: "411" },
  eventType: { duration_min: 20 },
  orgName: "Pennie",
  slots: [
    "2026-08-13T13:00:00.000Z", // Thu
    "2026-08-13T14:00:00.000Z", // Thu, a second time on the same day
    "2026-08-14T13:00:00.000Z", // Fri
    "2026-08-15T13:00:00.000Z", // Sat
    "2026-08-17T13:00:00.000Z", // Mon
    "2026-08-18T13:00:00.000Z", // Tue
  ],
};

const writtenSlots = (): string[] => {
  return insert.mock.calls[0][0].payload.slots;
};
const daysIn = (slots: string[]) => [...new Set(slots.map((s) => s.slice(0, 10)))];

beforeEach(() => {
  vi.clearAllMocks();
  getBucketSlots.mockResolvedValue({ ...WIDE, slots: [...WIDE.slots] });
});

describe("recomputeBucketSlots bookable-day trim", () => {
  it("stores the first N days that HAVE times, walking past the empty Sunday", async () => {
    await recomputeBucketSlots("411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z", "lane", undefined, 4);

    expect(daysIn(writtenSlots())).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-17",
    ]);
  });

  it("keeps every time on a kept day, not just the first", async () => {
    await recomputeBucketSlots("411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z", "lane", undefined, 4);
    // Thursday has two; both must survive or the day is offered half empty.
    expect(writtenSlots().filter((s) => s.startsWith("2026-08-13"))).toHaveLength(2);
  });

  it("drops the days beyond the count, so the row matches what is served", async () => {
    await recomputeBucketSlots("411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z", "lane", undefined, 4);
    expect(writtenSlots().some((s) => s.startsWith("2026-08-18"))).toBe(false);
  });

  it("returns the trimmed payload, not the wider one it computed", async () => {
    const res = await recomputeBucketSlots(
      "411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z", "lane", undefined, 4,
    );
    expect(daysIn(res!.slots)).toHaveLength(4);
  });

  it("stores everything when no count is given, so an untrimmed caller is unchanged", async () => {
    // The parameter is optional and the monitor's probe calls without it; that path
    // must keep seeing the full computed window rather than silently losing days.
    await recomputeBucketSlots("411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z", "lane");
    expect(writtenSlots()).toHaveLength(WIDE.slots.length);
  });

  it("writes nothing at all when the compute throws", async () => {
    // Pre-existing #277 behaviour that the trim must not disturb: a failed read must
    // never overwrite a good row with an empty one, which reads as "no availability".
    getBucketSlots.mockRejectedValueOnce(new Error("availability read failed"));

    const res = await recomputeBucketSlots(
      "411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z", "lane", undefined, 4,
    );

    expect(res).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });
});

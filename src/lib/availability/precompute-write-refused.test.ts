import { describe, it, expect, vi, beforeEach } from "vitest";

// #3119 review (L30): a refused `bucket_slots` write is an ANSWER from
// `writeSlotRow` ("failed"), not a throw, so every caller that only awaited the
// write counted it as stored. The pooled path was fixed first; this pins the class
// for the single code writers: `writeBucketSlotsRow` and `recomputeBucketSlots`
// refuse to report success for a row the database did not take.

const getBucketSlots = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  insertError: null as { code: string; message: string } | null,
}));
const from = vi.hoisted(() =>
  vi.fn(() => ({
    insert: async () => ({ error: db.insertError }),
    update: () => ({
      eq: () => ({
        lt: () => ({ select: async () => ({ data: [], error: null }) }),
      }),
    }),
  })),
);

vi.mock("./service", () => ({ getBucketSlots }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../log.ts", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { recomputeBucketSlots, writeBucketSlotsRow, storeBucketSlotsRow } from "./precompute";
import { SlotRowRefused } from "./slot-row-write";

const PAYLOAD = {
  bucket: { code: "411" },
  eventType: { duration_min: 20 },
  orgName: "Pennie",
  slots: ["2026-08-13T13:00:00.000Z"],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.insertError = null;
  getBucketSlots.mockResolvedValue({ ...PAYLOAD });
});

describe("a refused slot row write (#3119)", () => {
  it("writeBucketSlotsRow returns the stamp when the row was stored", async () => {
    await expect(writeBucketSlotsRow("411", PAYLOAD as never, 1_000)).resolves.toBe(
      new Date(1_000).toISOString(),
    );
  });

  it("writeBucketSlotsRow throws SlotRowRefused when the database refuses the row", async () => {
    db.insertError = { code: "42501", message: "permission denied" };
    await expect(writeBucketSlotsRow("411", PAYLOAD as never, 1_000)).rejects.toBeInstanceOf(
      SlotRowRefused,
    );
  });

  it("storeBucketSlotsRow answers failed, for the pooled path to count", async () => {
    db.insertError = { code: "42501", message: "permission denied" };
    await expect(storeBucketSlotsRow("411", PAYLOAD as never, 1_000)).resolves.toBe("failed");
  });

  it("recomputeBucketSlots does not report a refused write as a refresh", async () => {
    db.insertError = { code: "42501", message: "permission denied" };
    await expect(
      recomputeBucketSlots("411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z"),
    ).rejects.toBeInstanceOf(SlotRowRefused);
  });

  it("recomputeBucketSlots still returns the payload when the row was stored", async () => {
    const res = await recomputeBucketSlots("411", "2026-08-13T04:00:00.000Z", "2026-08-19T04:00:00.000Z");
    expect(res?.slots).toEqual(PAYLOAD.slots);
  });
});

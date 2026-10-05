import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeBucketSlotsTable, type SlotRow } from "../../../scripts/lib/fake-bucket-slots-table";

// #3324: the wiring of the booked window splice. The rule and the race are pinned
// offline (scripts/test-booked-splice.ts, scripts/test-booked-splice-race.ts); these
// pin what only the real module can show: the advisor's pools come from the live
// bucket grouping, every one of them is spliced, a pool the advisor does not serve is
// left alone, busy time is read over the window rather than the horizon, and a splice
// that could not land REJECTS so afterResponse reports it.

const precompute = vi.hoisted(() => ({
  bucketsForAgent: vi.fn(async (_userId?: string): Promise<string[]> => []),
  listPoolBuckets: vi.fn(async (): Promise<unknown[]> => []),
  computeBucketSlotsForWindow: vi.fn(),
  writeBucketSlotsRow: vi.fn(),
  storeBucketSlotsRow: vi.fn(),
  recomputeBucketSlots: vi.fn(),
  readBucketSlotsRow: vi.fn(),
  touchedBucketCodes: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock("./precompute", () => precompute);

const EVENT = { duration_min: 20, buffer_before_min: 0, buffer_after_min: 0, daily_cap: null, min_notice_min: 0, slot_interval_min: 10 };
const service = vi.hoisted(() => ({
  getBucketSlots: vi.fn(),
  resolveBucketByCode: vi.fn(),
  loadBucketSlotInputs: vi.fn(),
  computeSlotsFromInputs: vi.fn(),
}));
vi.mock("./service", () => service);
vi.mock("@/lib/booking/settings", () => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log }));
const db = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => db.current }));

import { spliceBookedTimeAfterBooking, readSpliceInputsAfterBooking } from "./slot-cache";

const BOOKED_AT = "2026-10-13T14:00:00.000Z";
const BOOKED = { userId: "a", startsAt: BOOKED_AT, endsAt: "2026-10-13T14:20:00.000Z", fenceAtMs: Date.parse("2026-10-12T15:00:00.000Z") };

function pooled(code: string, debtTeam: string) {
  return {
    code,
    bucket: { id: `id-${code}`, code },
    orgId: "org-1",
    eventTypeId: "event-1",
    criteria: { debt_team: debtTeam },
    fallbackUserId: null,
    memberIds: [],
  };
}
const LOW = ["111", "112"].map((c) => pooled(c, "low"));
const MID = ["211", "212"].map((c) => pooled(c, "mid"));
const HIGH = ["311"].map((c) => pooled(c, "high"));

function row(code: string): SlotRow {
  return {
    bucket_code: code,
    payload: { bucket: { code }, eventType: EVENT, orgName: "Pennie", slots: ["2026-10-13T13:00:00.000Z", BOOKED_AT] },
    computed_at: "2026-10-12T14:58:00.000Z",
    invalidated_at: null,
  };
}

let table: ReturnType<typeof fakeBucketSlotsTable>;
const slotsOf = (code: string) =>
  (table.rows.find((r) => r.bucket_code === code)!.payload as { slots: string[] }).slots;

beforeEach(() => {
  vi.clearAllMocks();
  table = fakeBucketSlotsTable(["111", "112", "211", "212", "311"].map(row));
  db.current = table.db;
  // A serves the low and mid pools, never the high one.
  precompute.bucketsForAgent.mockResolvedValue(["111", "112", "211", "212"]);
  precompute.listPoolBuckets.mockResolvedValue([...LOW, ...MID, ...HIGH]);
  service.resolveBucketByCode.mockImplementation(async (code: string) => ({ bucket: { code }, eventType: EVENT }));
  service.loadBucketSlotInputs.mockImplementation(async (code: string, _from: string, _to: string, _r: unknown, resolved: unknown) => ({
    resolved,
    orgRes: { data: { name: "Pennie" }, error: null },
    membersResult: { members: [{ userId: "a", timezone: "America/New_York", dayCounts: new Map() }], lowIds: [] },
    businessHours: { zone: "America/New_York", rules: [], exceptions: [] },
    code,
  }));
  // Nobody is free at the booked time any more.
  service.computeSlotsFromInputs.mockReturnValue({ slots: [] });
});

describe("spliceBookedTimeAfterBooking (#3324)", () => {
  it("takes the booked time out of every pool the advisor serves, and only those", async () => {
    await spliceBookedTimeAfterBooking("111", BOOKED);
    for (const code of ["111", "112", "211", "212"]) {
      expect(slotsOf(code), code).toEqual(["2026-10-13T13:00:00.000Z"]);
    }
    expect(slotsOf("311"), "a pool the advisor does not serve is untouched").toContain(BOOKED_AT);
    expect(log.info).toHaveBeenCalledWith(
      "slot-cache",
      expect.objectContaining({ msg: "booked time spliced", pools: 2, spliced: 4, failed: 0 }),
    );
  });

  it("reads busy time over the booked window, once per pool, never over the horizon", async () => {
    await spliceBookedTimeAfterBooking("211", BOOKED);
    expect(service.loadBucketSlotInputs).toHaveBeenCalledTimes(2);
    for (const call of service.loadBucketSlotInputs.mock.calls) {
      expect(call[1]).toBe("2026-10-13T13:40:00.000Z");
      expect(call[2]).toBe("2026-10-13T14:40:00.000Z");
      // The bucket resolved to size the window is handed over, not read again.
      expect(call[4]).toEqual({ bucket: { code: call[0] }, eventType: EVENT });
    }
    expect(service.getBucketSlots).not.toHaveBeenCalled();
  });

  it("REJECTS when a code could not be spliced, leaving that row as it was", async () => {
    table.rows.find((r) => r.bucket_code === "212")!.payload = null;
    // A row with nothing to splice is not a failure (the lane builds it); a write
    // error is. Make every compare and swap on 211 lose.
    let n = 0;
    const churn = async () => {
      table.rows.find((r) => r.bucket_code === "211")!.computed_at = new Date(Date.UTC(2026, 9, 12, 14, 0, ++n)).toISOString();
      table.beforeNextUpdate(churn);
    };
    table.beforeNextUpdate(churn);
    await expect(spliceBookedTimeAfterBooking("111", BOOKED)).rejects.toThrow(/could not be spliced/);
    expect(slotsOf("211")).toContain(BOOKED_AT);
    expect(log.warn).toHaveBeenCalled();
  });

  it("REJECTS when the advisor serves no pool, rather than reporting a splice that never happened", async () => {
    precompute.bucketsForAgent.mockResolvedValue([]);
    await expect(spliceBookedTimeAfterBooking("111", BOOKED)).rejects.toThrow(/serves no pool/);
  });
});

describe("readSpliceInputsAfterBooking (#3324, the reads-only arm)", () => {
  it("makes the splice's reads and writes nothing", async () => {
    await readSpliceInputsAfterBooking("111", BOOKED);
    expect(service.loadBucketSlotInputs).toHaveBeenCalledTimes(2);
    expect(service.computeSlotsFromInputs).not.toHaveBeenCalled();
    expect(table.statements.update).toBe(0);
    expect(slotsOf("111")).toContain(BOOKED_AT);
  });
});

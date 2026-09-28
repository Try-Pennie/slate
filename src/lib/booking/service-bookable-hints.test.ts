import { describe, it, expect, vi, beforeEach } from "vitest";

// #2846: the bookable check's nearest time hints must come from the list the
// booker itself serves the lead, so a top tier lead cascaded below their own tier
// (#2842) is never pointed at a time only a Low carrier is free for, and a normal
// lead still is. The cached rows are faked one layer down (resolveBucketSlots), so
// the real display cascade, Low exclusion and open day window all run.

const mockResolveBucketSlots = vi.hoisted(() => vi.fn());
vi.mock("@/lib/availability/precompute-core", () => ({
  resolveBucketSlots: mockResolveBucketSlots,
}));

const mockBusinessHours = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking/business-hours-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/business-hours-load")>()),
  loadBusinessHoursCached: mockBusinessHours,
}));

const mockCoreCheck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking/orchestration")>()),
  checkBookable: mockCoreCheck,
}));

import { checkBookable } from "./service";
import type { BucketSlots } from "@/lib/availability/service";
import type { Bucket, EventType } from "@/lib/db/types";

const OPEN_ALL_WEEK = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

const eventType = {
  id: "et1",
  duration_min: 30,
  min_notice_min: 0,
  slot_interval_min: 30,
} as unknown as EventType;

function row(code: string, slots: string[], slotsWithoutLow: string[] = slots): BucketSlots {
  return {
    slotsWithoutLow,
    bucket: { id: `bkt-${code}`, org_id: "org1", code, is_test: false, criteria: {} } as unknown as Bucket,
    eventType,
    orgName: "Pennie",
    slots,
  };
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("checkBookable alternatives (#2846)", () => {
  // The time asked about, a time only a Low carrier is free for just after it, and
  // a later time an advisor without Low is free for.
  let asked: string;
  let lowOnly: string;
  let withoutLow: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBusinessHours.mockResolvedValue(OPEN_ALL_WEEK);
    const base = Math.ceil(Date.now() / HOUR) * HOUR;
    asked = iso(base + 2 * HOUR);
    lowOnly = iso(base + 3 * HOUR);
    withoutLow = iso(base + 4 * HOUR);
  });

  // The lead's own tier is full, so both the booker and the booking cascade drop
  // one rung; the rung has an advisor without Low at the asked time and later, and
  // only a Low carrier in between.
  function oneRungDown(own: string, rung: string) {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === own) return row(own, []);
      if (code === rung) return row(rung, [asked, lowOnly, withoutLow], [asked, withoutLow]);
      return null;
    });
    mockCoreCheck.mockResolvedValue({
      bookable: true,
      reason: "available",
      effectiveBucketCode: rung,
      tierFallback: true,
      rungsDropped: 1,
      wouldAssign: { id: "u1", name: "A", email: "a@x.com" },
    });
  }

  it("never suggests a top tier lead a time only a Low carrier is free for", async () => {
    oneRungDown("511", "411");
    const r = await checkBookable({ bucketCode: "511", startIso: asked });
    expect(r.alternatives.after).toBe(withoutLow);
    expect(r.alternatives.after).not.toBe(lowOnly);
  });

  it("does suggest that time to a lead whose cascade may include Low carriers", async () => {
    oneRungDown("311", "211");
    const r = await checkBookable({ bucketCode: "311", startIso: asked });
    expect(r.alternatives.after).toBe(lowOnly);
  });

  it("suggests the booker's times when nothing is bookable at the asked time", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "511") return row("511", []);
      if (code === "411") return row("411", [lowOnly, withoutLow], [withoutLow]);
      return null;
    });
    mockCoreCheck.mockResolvedValue({
      bookable: false,
      reason: "slot_taken",
      effectiveBucketCode: null,
      tierFallback: false,
      rungsDropped: 0,
      wouldAssign: null,
    });
    const r = await checkBookable({ bucketCode: "511", startIso: asked });
    expect(r.alternatives).toEqual({ before: null, after: withoutLow });
  });

  it("keeps the check's answer and gives no hints when the slot read fails", async () => {
    oneRungDown("511", "411");
    mockResolveBucketSlots.mockRejectedValue(new Error("read failed"));
    const r = await checkBookable({ bucketCode: "511", startIso: asked });
    expect(r.bookable).toBe(true);
    expect(r.alternatives).toEqual({ before: null, after: null });
  });
});

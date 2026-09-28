import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests for getBucketSlotsWithFallback's internal cascade, is_test skip,
// and routing descriptor builder. getCachedBucketSlots is intercepted by
// mocking resolveBucketSlots (the external function it delegates to), so no
// Cloudflare cache or Supabase is needed.

const mockResolveBucketSlots = vi.hoisted(() => vi.fn());
vi.mock("@/lib/availability/precompute-core", () => ({
  resolveBucketSlots: mockResolveBucketSlots,
}));

// #2840: the offered window is counted in the org's OPEN days. Open all day every
// day here, so a fixture's days are calendar days; a test about an unreadable week
// overrides it.
const mockBusinessHours = vi.hoisted(() => vi.fn());
vi.mock("@/lib/booking/business-hours-load", () => ({
  loadBusinessHoursCached: mockBusinessHours,
}));
const OPEN_ALL_WEEK = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
  exceptions: [],
};

import { getBucketSlotsWithFallback } from "./slot-cache";
import type { BucketSlots } from "./service";
import type { Bucket, EventType } from "@/lib/db/types";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];

const sharedEventType = {
  id: "et1",
  name: "Senior Call",
  regal_type: "call",
  description: "",
  duration_min: 30,
  min_notice_min: 0,
  daily_cap: null,
  buffer_before_min: 0,
  buffer_after_min: 0,
  slot_interval_min: 30,
} as unknown as EventType;

function makeBucketSlots(
  code: string,
  slots: string[],
  isTest = false,
  // #2842: the times an advisor WITHOUT Low is free. Defaults to the same list, so
  // a fixture that is not about the Low rule cascades as it always did.
  // "absent" is a row written before the field existed, which must read as unknown.
  slotsWithoutLow: string[] | "absent" = slots,
): BucketSlots {
  return {
    ...(slotsWithoutLow !== "absent" ? { slotsWithoutLow } : {}),
    bucket: {
      id: `bkt-${code}`,
      org_id: "org1",
      code,
      is_test: isTest,
      criteria: {},
    } as unknown as Bucket,
    eventType: sharedEventType,
    orgName: "Pennie",
    slots,
  };
}

const FROM_ISO = "2026-06-08T00:00:00.000Z";
const SLOT = "2026-06-08T13:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mockBusinessHours.mockResolvedValue(OPEN_ALL_WEEK);
});

describe("getBucketSlotsWithFallback", () => {
  it("returns the requested bucket with tier_fallback=false when it has slots", async () => {
    mockResolveBucketSlots.mockResolvedValue(makeBucketSlots("411", [SLOT]));

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result).not.toBeNull();
    expect(result!.bucket.code).toBe("411");
    expect(result!.slots).toEqual([SLOT]);
    expect(result!.routing.tier_fallback).toBe(false);
    expect(result!.routing.rungs_dropped).toBe(0);
    expect(result!.routing.effective_code).toBe("411");
    expect(result!.routing.requested_code).toBe("411");
    // Perf guard (#240): the common booker request is a SINGLE cached read; it
    // must never enter the tier cascade (which does N reads) when slots exist.
    expect(mockResolveBucketSlots).toHaveBeenCalledTimes(1);
  });

  it("returns null when the requested bucket does not exist", async () => {
    mockResolveBucketSlots.mockResolvedValue(null);

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result).toBeNull();
  });

  it("cascades to a lower tier when the requested window is empty", async () => {
    // "411" (requested): empty; "311" (one rung lower): has slots
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "411") return makeBucketSlots("411", []);
      if (code === "311") return makeBucketSlots("311", [SLOT]);
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result).not.toBeNull();
    expect(result!.bucket.code).toBe("311");
    expect(result!.slots).toEqual([SLOT]);
    expect(result!.routing.tier_fallback).toBe(true);
    expect(result!.routing.rungs_dropped).toBe(1);
    expect(result!.routing.effective_code).toBe("311");
    expect(result!.routing.requested_code).toBe("411");
    // 4xx = very_high, 3xx = high
    expect(result!.routing.requested_tier).toBe("very_high");
    expect(result!.routing.booked_tier).toBe("high");
    // Contrast with the perf guard above: the slow cascade path necessarily reads
    // more than once, which is why the hot-path single-read assertion is meaningful.
    expect(mockResolveBucketSlots.mock.calls.length).toBeGreaterThan(1);
  });

  // #2842: below an Ultra or Very High lead's own tier, only advisors who do NOT
  // carry Low may be offered, so the rung is judged on, and serves, its second list.
  it("judges a rung below a top tier lead on the advisors without Low, and serves only their times", async () => {
    const LOW_ONLY = "2026-06-08T14:00:00.000Z";
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "411") return makeBucketSlots("411", []);
      // 311: free times exist, but every free advisor carries Low.
      if (code === "311") return makeBucketSlots("311", [LOW_ONLY], false, []);
      // 211: a mix; only SLOT has an advisor without Low.
      if (code === "211") return makeBucketSlots("211", [SLOT, LOW_ONLY], false, [SLOT]);
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result!.bucket.code).toBe("211");
    expect(result!.slots).toEqual([SLOT]);
    expect(result!.routing.rungs_dropped).toBe(2);
  });

  it("never offers a top tier lead a rung whose second list is unknown", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "411") return makeBucketSlots("411", []);
      // A row written before the second list existed: unknown, so nobody.
      if (code === "311") return makeBucketSlots("311", [SLOT], false, "absent");
      if (code === "211") return makeBucketSlots("211", [], false, []);
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    // Nothing reachable: the requested bucket comes back with no times, and the
    // Low carriers' SLOT on 311 is not offered.
    expect(result!.bucket.code).toBe("411");
    expect(result!.slots).toEqual([]);
    expect(result!.routing.tier_fallback).toBe(false);
  });

  it("never cascades a top tier lead to Low", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "111") return makeBucketSlots("111", [SLOT]);
      return makeBucketSlots(code, []);
    });

    const result = await getBucketSlotsWithFallback("511", FROM_ISO);

    expect(result!.bucket.code).toBe("511");
    expect(result!.slots).toEqual([]);
    expect(mockResolveBucketSlots.mock.calls.map((c) => c[0])).not.toContain("111");
  });

  it("keeps Low carriers in a High lead's cascade, which may reach Low", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "311") return makeBucketSlots("311", []);
      if (code === "211") return makeBucketSlots("211", [SLOT], false, []);
      return null;
    });

    const result = await getBucketSlotsWithFallback("311", FROM_ISO);

    expect(result!.bucket.code).toBe("211");
    expect(result!.slots).toEqual([SLOT]);
  });

  it("serves the top tier lead's OWN tier in full, Low carriers included", async () => {
    mockResolveBucketSlots.mockResolvedValue(makeBucketSlots("411", [SLOT], false, []));

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result!.bucket.code).toBe("411");
    expect(result!.slots).toEqual([SLOT]);
  });

  it("never sends the second list to the booker", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "411") return makeBucketSlots("411", []);
      return makeBucketSlots(code, [SLOT]);
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result).not.toHaveProperty("slotsWithoutLow");
  });

  // --- #2840/#2841: three open days, then a fourth only as the last resort ---
  //
  // Sales ops, 2026-09-28, Sam: "You want to contain to 3 days. Cascade down with
  // rule set. All else fails, day 4 which is 100% open."
  describe("the three open day window", () => {
    // Monday 2026-06-08 08:00 New York. The third open day closes at the end of
    // Wednesday, 2026-06-11T04:00Z.
    const NOW = Date.parse("2026-06-08T12:00:00.000Z");
    const MON = "2026-06-08T14:00:00.000Z";
    const WED = "2026-06-10T14:00:00.000Z";
    const THU = "2026-06-11T14:00:00.000Z";
    const FRI = "2026-06-12T14:00:00.000Z";

    it("cascades to a lower tier that has a time inside the window before offering the lead's own tier a later day", async () => {
      mockResolveBucketSlots.mockImplementation(async (code: string) => {
        if (code === "511") return makeBucketSlots("511", [FRI]);
        if (code === "411") return makeBucketSlots("411", [MON]);
        return makeBucketSlots(code, []);
      });

      const result = await getBucketSlotsWithFallback("511", FROM_ISO, false, NOW);

      expect(result!.bucket.code).toBe("411");
      expect(result!.slots).toEqual([MON]);
      expect(result!.routing.window_extended).toBe(false);
    });

    it("offers only the times inside the window when the lead's own tier has some", async () => {
      mockResolveBucketSlots.mockResolvedValue(makeBucketSlots("411", [MON, WED, THU, FRI]));

      const result = await getBucketSlotsWithFallback("411", FROM_ISO, false, NOW);

      expect(result!.slots).toEqual([MON, WED]);
      expect(result!.routing.window_extended).toBe(false);
    });

    it("opens the fourth day on the lead's own tier first when every allowed tier is full for three days", async () => {
      mockResolveBucketSlots.mockImplementation(async (code: string) => {
        if (code === "511") return makeBucketSlots("511", [THU, FRI]);
        if (code === "411") return makeBucketSlots("411", [THU]);
        return makeBucketSlots(code, []);
      });

      const result = await getBucketSlotsWithFallback("511", FROM_ISO, false, NOW);

      expect(result!.bucket.code).toBe("511");
      expect(result!.slots).toEqual([THU, FRI]);
      expect(result!.routing.window_extended).toBe(true);
      expect(result!.routing.rungs_dropped).toBe(0);
    });

    it("walks the allowed ladder again for the fourth day when the lead's own tier has nothing at all", async () => {
      mockResolveBucketSlots.mockImplementation(async (code: string) => {
        if (code === "311") return makeBucketSlots("311", []);
        if (code === "211") return makeBucketSlots("211", [FRI]);
        return makeBucketSlots(code, []);
      });

      const result = await getBucketSlotsWithFallback("311", FROM_ISO, false, NOW);

      expect(result!.bucket.code).toBe("211");
      expect(result!.slots).toEqual([FRI]);
      expect(result!.routing.window_extended).toBe(true);
    });

    it("never offers a top tier lead a Low carrier's fourth day either", async () => {
      mockResolveBucketSlots.mockImplementation(async (code: string) => {
        if (code === "511") return makeBucketSlots("511", []);
        if (code === "411") return makeBucketSlots("411", [THU], false, []);
        return makeBucketSlots(code, []);
      });

      const result = await getBucketSlotsWithFallback("511", FROM_ISO, false, NOW);

      expect(result!.slots).toEqual([]);
      expect(result!.routing.window_extended).toBe(false);
    });

    it("serves the stored window unchanged when the org's week cannot be read, and says it did not extend", async () => {
      // No window can be measured, so none is imposed: the rows are already the
      // horizon the settings ask for, which is the behaviour before #2840.
      mockBusinessHours.mockRejectedValue(new Error("business hours are unusable"));
      mockResolveBucketSlots.mockResolvedValue(makeBucketSlots("411", [MON, FRI]));

      const result = await getBucketSlotsWithFallback("411", FROM_ISO, false, NOW);

      expect(result!.slots).toEqual([MON, FRI]);
      expect(result!.routing.window_extended).toBe(false);
    });
  });

  it("skips an is_test bucket in the cascade so a real lower tier wins", async () => {
    // "511": empty (requested); "411": empty; "311": is_test with slots → skipped;
    // "211": real with slots → wins (rungsDropped = 3: indices 511→411→311→211)
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "511") return makeBucketSlots("511", []);
      if (code === "411") return makeBucketSlots("411", []);
      if (code === "311") return makeBucketSlots("311", [SLOT], /* isTest */ true);
      if (code === "211") return makeBucketSlots("211", [SLOT]);
      return null;
    });

    const result = await getBucketSlotsWithFallback("511", FROM_ISO);

    expect(result).not.toBeNull();
    expect(result!.bucket.code).toBe("211");
    expect(result!.routing.tier_fallback).toBe(true);
    expect(result!.routing.rungs_dropped).toBe(3);
    expect(result!.routing.requested_code).toBe("511");
    expect(result!.routing.effective_code).toBe("211");
  });

  // #2660: the public test bucket is served when the route authorises it, and a
  // REAL code can never reach it through the display cascade. Both directions
  // in one fixture (L159): the same ladder that never asks for the test code DOES
  // cascade to a real lower rung, so the negative is not satisfied by a fixture
  // that could never cascade at all.
  it("serves the public test bucket when the route has authorised the test code", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) =>
      code === PUBLIC_TEST ? makeBucketSlots(PUBLIC_TEST, [SLOT], /* isTest */ true) : null,
    );

    const result = await getBucketSlotsWithFallback(PUBLIC_TEST, FROM_ISO, /* authorizedForTest */ true);

    expect(result).not.toBeNull();
    expect(result!.bucket.code).toBe(PUBLIC_TEST);
    expect(result!.slots).toEqual([SLOT]);
    expect(result!.routing.tier_fallback).toBe(false);
    expect(mockResolveBucketSlots).toHaveBeenCalledTimes(1);
  });

  it("never asks for the public test bucket while cascading a real code, and still cascades to a real rung", async () => {
    const asked: string[] = [];
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      asked.push(code);
      if (code === "411") return makeBucketSlots("411", []);
      if (code === "311") return makeBucketSlots("311", []);
      if (code === "211") return makeBucketSlots("211", [SLOT]);
      if (code === PUBLIC_TEST) return makeBucketSlots(PUBLIC_TEST, [SLOT], /* isTest */ true);
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO, /* authorizedForTest */ true);

    // The positive control: the ladder is live and found the real rung.
    expect(result!.bucket.code).toBe("211");
    expect(result!.routing.rungs_dropped).toBe(2);
    // The negative: the test bucket sits on no ladder, so it was never even read,
    // and that holds even for a caller authorised to see it.
    expect(asked).not.toContain(PUBLIC_TEST);
  });

  it("hides an unauthorized test bucket like an unknown code, without running the cascade (#601)", async () => {
    // Requested "411" is a hidden test bucket with an empty window. An unknown
    // code returns null after a single resolve; the test bucket must do the same
    // work (NOT fall through to the tier cascade) so its 404 timing matches.
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "411") return makeBucketSlots("411", [], /* isTest */ true);
      // A real lower tier exists with slots; the cascade must never reach it.
      if (code === "311") return makeBucketSlots("311", [SLOT]);
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO, /* authorizedForTest */ false);

    expect(result).toBeNull();
    // Resolved exactly once (the requested code); the cascade never ran.
    expect(mockResolveBucketSlots).toHaveBeenCalledTimes(1);
    expect(mockResolveBucketSlots).toHaveBeenCalledWith("411", expect.anything(), expect.anything(), expect.anything());
  });

  it("serves an authorized test bucket its own slots (#601)", async () => {
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (code === "411") return makeBucketSlots("411", [SLOT], /* isTest */ true);
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO, /* authorizedForTest */ true);

    expect(result).not.toBeNull();
    expect(result!.bucket.code).toBe("411");
    expect(result!.slots).toEqual([SLOT]);
  });

  it("returns the requested bucket with empty slots and tier_fallback=false when no tier has slots", async () => {
    // Every tier in the "411" ladder ("411", "311", "211", "111") is empty.
    mockResolveBucketSlots.mockImplementation(async (code: string) => {
      if (["411", "311", "211", "111"].includes(code)) {
        return makeBucketSlots(code, []);
      }
      return null;
    });

    const result = await getBucketSlotsWithFallback("411", FROM_ISO);

    expect(result).not.toBeNull();
    expect(result!.bucket.code).toBe("411"); // returned the requested bucket
    expect(result!.slots).toEqual([]);
    expect(result!.routing.tier_fallback).toBe(false);
    expect(result!.routing.rungs_dropped).toBe(0);
    expect(result!.routing.effective_code).toBe("411");
  });
});

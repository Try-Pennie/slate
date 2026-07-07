import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests for getBucketSlotsWithFallback's internal cascade, is_test skip,
// and routing descriptor builder. getCachedBucketSlots is intercepted by
// mocking resolveBucketSlots (the external function it delegates to), so no
// Cloudflare cache or Supabase is needed.

const mockResolveBucketSlots = vi.hoisted(() => vi.fn());
vi.mock("@/lib/availability/precompute-core", () => ({
  resolveBucketSlots: mockResolveBucketSlots,
}));

import { getBucketSlotsWithFallback } from "./slot-cache";
import type { BucketSlots } from "./service";
import type { Bucket, EventType } from "@/lib/db/types";

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
): BucketSlots {
  return {
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

beforeEach(() => vi.clearAllMocks());

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

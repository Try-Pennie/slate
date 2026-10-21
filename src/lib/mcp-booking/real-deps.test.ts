import { describe, it, expect, vi, beforeEach } from "vitest";

// #4014: Marcia's find_times reads slots FROM the day it was asked for, so the
// production wiring must hand that day to the tiered read as `lookFromMs`. The
// booker's call site passes none; this pins that Marcia's does.

const mockFallback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/availability/slot-cache", () => ({ getBucketSlotsWithFallback: mockFallback }));
vi.mock("@/lib/booking/service", () => ({}));
vi.mock("@/lib/booking/reason-options", () => ({}));
vi.mock("@/lib/salesforce/lead-contact", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/env", () => ({ mcpBookingGatewaySecret: () => "test-secret" }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert: vi.fn() }));
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome: vi.fn() }));

import { realMarciaDeps } from "./real-deps";

const NOW = Date.parse("2026-10-21T14:00:00.000Z");
const FROM = "2026-10-23T04:00:00.000Z";

beforeEach(() => {
  mockFallback.mockReset();
});

describe("realMarciaDeps().readSlots", () => {
  it("judges the tier and the offered days from the requested day", async () => {
    mockFallback.mockResolvedValue({ slots: ["2026-10-23T14:00:00.000Z"], eventType: { min_notice_min: 120 }, computedAt: "2026-10-21T13:59:00.000Z" });

    const read = await realMarciaDeps().readSlots("511", FROM, true, NOW);

    expect(mockFallback).toHaveBeenCalledTimes(1);
    const [code, from, allowTest, nowMs, , opts] = mockFallback.mock.calls[0]!;
    expect([code, from, allowTest, nowMs]).toEqual(["511", FROM, true, NOW]);
    expect(opts).toEqual({ lookFromMs: Date.parse(FROM) });
    expect(read).toEqual({ slots: ["2026-10-23T14:00:00.000Z"], minNoticeMin: 120, computedAt: "2026-10-21T13:59:00.000Z" });
  });

  it("answers null for a bucket the read does not know", async () => {
    mockFallback.mockResolvedValue(null);
    expect(await realMarciaDeps().readSlots("999", FROM, false, NOW)).toBeNull();
  });

  it("refuses a from it cannot read rather than reading from now", async () => {
    // An unreadable from never reaches here from find_times, which refuses it first;
    // if one did, judging it from now would answer a question nobody asked.
    await expect(realMarciaDeps().readSlots("511", "not a date", false, NOW)).rejects.toThrow();
    expect(mockFallback).not.toHaveBeenCalled();
  });
});

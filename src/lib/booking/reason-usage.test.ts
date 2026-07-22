import { describe, it, expect, vi, beforeEach } from "vitest";

// The shared reason-usage aggregation (#990/#989). supabaseAdmin is mocked so the
// helper's RPC call, parse, and fail-loud error path are exercised without a DB.
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin }));

import {
  loadReasonUsageCounts,
  parseReasonUsage,
  emptyReasonUsage,
  REASON_USAGE_WINDOW_DAYS,
} from "./reason-usage";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseReasonUsage", () => {
  // booking_events.action is PAST tense; the RPC emits it verbatim and the parser
  // translates it to the present-tense ReasonAction the store/editor use (#990).
  it("maps the past-tense '<event_action>|<code>' jsonb into present-tense reason buckets", () => {
    const out = parseReasonUsage({
      "rescheduled|schedule_conflict": 4,
      "cancelled|other": 2,
      "reassigned|coverage": 7,
    });
    expect(out.reschedule.schedule_conflict).toBe(4);
    expect(out.cancel.other).toBe(2);
    expect(out.reassign.coverage).toBe(7);
  });

  it("ignores malformed keys and unmapped actions rather than throwing", () => {
    const out = parseReasonUsage({ nofield: 1, "bogus|x": 3, "reassigned|escalation": 5 });
    expect(out.reassign.escalation).toBe(5);
    expect(out).toEqual({ ...emptyReasonUsage(), reassign: { escalation: 5 } });
  });

  it("returns an empty structure for null/non-object input", () => {
    expect(parseReasonUsage(null)).toEqual(emptyReasonUsage());
    expect(parseReasonUsage("nope")).toEqual(emptyReasonUsage());
  });
});

describe("loadReasonUsageCounts", () => {
  it("queries the window from now and returns the parsed counts", async () => {
    admin.rpc.mockResolvedValueOnce({ data: { "reassigned|coverage": 3 }, error: null });
    const now = Date.parse("2026-07-22T00:00:00.000Z");
    const out = await loadReasonUsageCounts(REASON_USAGE_WINDOW_DAYS, now);

    expect(admin.rpc).toHaveBeenCalledWith("reason_usage_counts", {
      p_since: "2026-04-23T00:00:00.000Z", // 90 days before the given now
    });
    expect(out.reassign.coverage).toBe(3);
  });

  it("throws on a real read error instead of degrading to empty (fail-loud, #277)", async () => {
    admin.rpc.mockResolvedValueOnce({ data: null, error: { message: "relation does not exist" } });
    await expect(loadReasonUsageCounts()).rejects.toThrow(/relation does not exist/);
  });
});

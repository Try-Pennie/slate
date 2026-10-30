import { describe, it, expect, vi, beforeEach } from "vitest";

// #4391: the live count of a full day refusal, `bump_program_lead_outcome('limit_refused')`
// (migration 0215). The pure module catches a failure here and still answers the full day
// (scripts/test-program-lead-booking.ts); this pins that the live count asks the right
// function with the right kind, and THROWS on a refused call rather than reading as counted.
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));

import { countLimitRefusal } from "./program-lead-booking-service";

describe("countLimitRefusal (#4391)", () => {
  beforeEach(() => rpc.mockReset());

  it("bumps the limit_refused count", async () => {
    rpc.mockResolvedValueOnce({ data: 3, error: null });
    await countLimitRefusal("2026-07-01");
    expect(rpc).toHaveBeenCalledWith("bump_program_lead_outcome", { p_kind: "limit_refused" });
  });

  it("throws when the count was refused, so the failure is logged rather than read as counted", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
    await expect(countLimitRefusal("2026-07-01")).rejects.toThrow(/bump_program_lead_outcome failed: permission denied/);
  });

  it("throws when the call itself fails", async () => {
    rpc.mockRejectedValueOnce(new Error("fetch failed"));
    await expect(countLimitRefusal("2026-07-01")).rejects.toThrow("fetch failed");
  });
});

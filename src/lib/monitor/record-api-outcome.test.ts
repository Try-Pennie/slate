import { describe, it, expect, vi, beforeEach } from "vitest";

// recordApiOutcome (#418) defers a best-effort tally increment. This exercises
// that it builds the right RPC args (including the error code on the error path)
// and that a bump failure surfaces (throws inside the deferred work so
// afterResponse logs it) rather than being swallowed. supabaseAdmin and
// afterResponse are mocked; the real args builder runs.
const rpc = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc })) }));
// Capture the deferred work so the test can run it and await its result.
const deferred = vi.hoisted(() => ({ work: null as null | (() => Promise<unknown>) }));
const after = vi.hoisted(() => ({
  afterResponse: vi.fn((_ctx: string, work: () => Promise<unknown>) => {
    deferred.work = work;
  }),
}));

vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/after-response", () => after);

import { recordApiOutcome } from "./record-api-outcome";

beforeEach(() => {
  vi.clearAllMocks();
  deferred.work = null;
  rpc.mockResolvedValue({ error: null });
});

describe("recordApiOutcome", () => {
  it("defers a bump with the outcome and an empty error code on the success path", async () => {
    recordApiOutcome("created", "DEBT1", null);
    expect(after.afterResponse).toHaveBeenCalledOnce();
    await deferred.work!();
    expect(rpc).toHaveBeenCalledWith(
      "bump_booking_api_outcome",
      expect.objectContaining({ p_outcome: "created", p_bucket: "DEBT1", p_error_code: "" }),
    );
    // The day is a bucketed ET date, not empty.
    expect(rpc.mock.calls[0][1].p_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("carries the error code on the error path", async () => {
    recordApiOutcome("error", "DEBT1", "NO_ELIGIBLE_AGENTS");
    await deferred.work!();
    expect(rpc).toHaveBeenCalledWith(
      "bump_booking_api_outcome",
      expect.objectContaining({ p_outcome: "error", p_error_code: "NO_ELIGIBLE_AGENTS" }),
    );
  });

  it("surfaces a bump failure instead of swallowing it", async () => {
    rpc.mockResolvedValueOnce({ error: { message: "deadlock detected" } });
    recordApiOutcome("created", "DEBT1", null);
    // The deferred work rejects; afterResponse (real impl) would log it at warn.
    await expect(deferred.work!()).rejects.toThrow(/deadlock detected/);
  });

  it("never throws synchronously on the caller's path", () => {
    // Even if the deferred work will fail, scheduling it must not throw into the
    // booking response.
    expect(() => recordApiOutcome("deduped", "DEBT2", null)).not.toThrow();
  });
});

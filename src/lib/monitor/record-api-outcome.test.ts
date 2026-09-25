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

// #1616: the test marker is resolved server-side from the bucket. Stubbed here so
// this file stays about the tally; test-traffic.test.ts owns the resolution rules.
const resolveTrafficMarkers = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/after-response", () => after);
vi.mock("@/lib/monitor/test-traffic", () => ({ resolveTrafficMarkers }));

import { recordApiOutcome } from "./record-api-outcome";

const REAL = { by: "bucket", code: "DEBT1", host: { prefill: null, referrer_origin: null } } as const;

beforeEach(() => {
  vi.clearAllMocks();
  deferred.work = null;
  rpc.mockResolvedValue({ error: null });
  resolveTrafficMarkers.mockResolvedValue({ isTest: false, hostClass: "none" });
});

describe("recordApiOutcome", () => {
  it("defers a bump with the outcome and an empty error code on the success path", async () => {
    recordApiOutcome("created", "DEBT1", null, REAL);
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
    recordApiOutcome("error", "DEBT1", "NO_ELIGIBLE_AGENTS", REAL);
    await deferred.work!();
    expect(rpc).toHaveBeenCalledWith(
      "bump_booking_api_outcome",
      expect.objectContaining({ p_outcome: "error", p_error_code: "NO_ELIGIBLE_AGENTS" }),
    );
  });

  it("surfaces a bump failure instead of swallowing it", async () => {
    rpc.mockResolvedValueOnce({ error: { message: "deadlock detected" } });
    recordApiOutcome("created", "DEBT1", null, REAL);
    // The deferred work rejects; afterResponse (real impl) would log it at warn.
    await expect(deferred.work!()).rejects.toThrow(/deadlock detected/);
  });

  it("never throws synchronously on the caller's path", () => {
    // Even if the deferred work will fail, scheduling it must not throw into the
    // booking response.
    expect(() => recordApiOutcome("deduped", "DEBT2", null, REAL)).not.toThrow();
  });
});

describe("recordApiOutcome and the test marker (#1616)", () => {
  it("stamps the row as test when the attempt resolves to a test bucket", async () => {
    resolveTrafficMarkers.mockResolvedValue({ isTest: true, hostClass: "none" });
    recordApiOutcome("error", "", "reschedule_conflict", { by: "manageToken", token: "tok" });
    await deferred.work!();
    expect(resolveTrafficMarkers).toHaveBeenCalledWith({ by: "manageToken", token: "tok" });
    expect(rpc.mock.calls[0][1].p_is_test).toBe(true);
  });

  it("stamps the row as real otherwise", async () => {
    recordApiOutcome("created", "DEBT1", null, REAL);
    await deferred.work!();
    expect(rpc.mock.calls[0][1].p_is_test).toBe(false);
  });

  it("resolves the marker AFTER the response, so the booking path pays nothing", () => {
    recordApiOutcome("created", "DEBT1", null, REAL);
    // Scheduling alone must not have gone to the database.
    expect(resolveTrafficMarkers).not.toHaveBeenCalled();
  });
});

describe("recordApiOutcome and the host page class (#2752)", () => {
  it("stamps the class the markers resolved, so an off site tester is kept out of the failure rate", async () => {
    resolveTrafficMarkers.mockResolvedValue({ isTest: false, hostClass: "offsite" });
    const source = {
      by: "bucket",
      code: "100",
      host: { prefill: { parentOrigin: "http://localhost:3000" }, referrer_origin: null },
    } as const;
    recordApiOutcome("error", "100", "slot_unavailable", source);
    await deferred.work!();
    expect(resolveTrafficMarkers).toHaveBeenCalledWith(source);
    expect(rpc.mock.calls[0][1].p_host_class).toBe("offsite");
    expect(rpc.mock.calls[0][1].p_is_test).toBe(false);
  });

  it("stamps production for the production site, which still counts", async () => {
    resolveTrafficMarkers.mockResolvedValue({ isTest: false, hostClass: "production" });
    recordApiOutcome("created", "100", null, REAL);
    await deferred.work!();
    expect(rpc.mock.calls[0][1].p_host_class).toBe("production");
  });
});

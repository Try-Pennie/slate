import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #3575: a booking-API INTERNAL fault pages the production incident channel. When
// the attempt is the smoke canary's (an `is_test` bucket), the caller passes
// `isTest: true` and the fault is logged in full but not paged; a real fault still
// pages. Seam: `@/lib/notify/dispatch` is mocked so no real Slack call is made; the
// reporter (`reportInternalError`) and the error mapping are left REAL, because the
// wiring from `apiErrorBody` through to the page decision is exactly what is tested.
const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => dispatch);

import { apiErrorBody } from "@/lib/booking/direct-cancel-http";

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("apiErrorBody test-traffic paging (#3575)", () => {
  it("an INTERNAL fault on test traffic is logged but does NOT page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await apiErrorBody(new Error("canary blew up"), "INTERNAL", "book", "Booking failed", {
      isTest: true,
    });
    // The caller still gets the generic 500 body; only the Slack page is withheld.
    expect(body).toEqual({ error: expect.any(String), code: "INTERNAL" });
    expect(body.error).not.toContain("canary blew up");
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("an INTERNAL fault on real traffic still pages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await apiErrorBody(new Error("real book blew up"), "INTERNAL", "book", "Booking failed", {
      isTest: false,
    });
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("defaults to paging when no test marker is given, the safe direction", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await apiErrorBody(new Error("book blew up"), "INTERNAL", "book", "Booking failed");
    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("a non-INTERNAL mapped error keeps its own message and never pages", async () => {
    const body = await apiErrorBody(new Error("slot taken"), "SLOT_TAKEN", "book", "Booking failed", {
      isTest: false,
    });
    expect(body).toEqual({ error: "slot taken", code: "SLOT_TAKEN" });
    expect(dispatch.sendThrottledAlert).not.toHaveBeenCalled();
  });
});

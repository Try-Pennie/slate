import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #598: an unexpected fault must return a generic body to the client while the
// real detail (table names, Google error text) stays in the server log only.
// #802: it must also TELL someone. The log has 7-day retention and nothing
// watching it, so a silent 500 is only ever found by someone going to look.

const dispatch = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", () => dispatch);

import { internalErrorResponse, reportInternalError, INTERNAL_ERROR_COOLDOWN_MS } from "@/lib/api/errors";

beforeEach(() => {
  vi.clearAllMocks();
  dispatch.sendThrottledAlert.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("internalErrorResponse", () => {
  it("returns a generic 500 body that does NOT leak the error message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await internalErrorResponse(
      new Error('relation "bookings" does not exist'),
      "cancel",
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/bookings|does not exist/);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("logs the real error with its context so detail is retained server-side", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("Google 503 backend error");
    await internalErrorResponse(err, "reschedule");
    expect(spy).toHaveBeenCalled();
    // The context label and the real error both reach the log.
    const logged = spy.mock.calls[0];
    expect(JSON.stringify(logged)).toContain("reschedule");
    expect(logged).toContain(err);
  });

  it("handles a non-Error throw without leaking its stringification", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await internalErrorResponse("raw string blow up", "booking");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("blow up");
  });
});

describe("internalErrorResponse alerting (#802)", () => {
  it("fires a throttled alert carrying the route context and the real detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await internalErrorResponse(new Error("Google 503 backend error"), "admin/bookings/[id]/cancel");

    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
      string,
    ];
    // Keyed PER CONTEXT: a persistently-broken route must not throttle away the
    // first alert from a different route that breaks at the same time.
    expect(key).toContain("admin/bookings/[id]/cancel");
    expect(cooldown).toBe(INTERNAL_ERROR_COOLDOWN_MS);
    // Slack is internal, so the alert (unlike the client body) SHOULD name the fault.
    expect(text).toContain("admin/bookings/[id]/cancel");
    expect(text).toContain("Google 503 backend error");
  });

  it("uses a different throttle key per route so one noisy route cannot mask another", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await internalErrorResponse(new Error("boom"), "booking");
    await internalErrorResponse(new Error("boom"), "bookings/reassign");

    const calls = dispatch.sendThrottledAlert.mock.calls as unknown as [string, number, string][];
    const keys = calls.map((c) => c[0]);
    expect(new Set(keys).size).toBe(2);
  });

  // The failure path is the whole point of the fail-loud rule: the alert writes to
  // alert_state, so whatever broke the route can break the alert too. A monitoring
  // outage must never turn a 500 into a crash (or into a 200).
  it("still returns the generic 500 when the alert itself throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dispatch.sendThrottledAlert.mockRejectedValueOnce(new Error("slack is down"));

    const res = await internalErrorResponse(new Error("db exploded"), "booking");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("db exploded");
    expect(body.error).not.toContain("slack");
    // The alert's own failure is itself logged, never swallowed into silence.
    expect(JSON.stringify(errSpy.mock.calls)).toContain("slack is down");
  });

  it("reportInternalError alerts without producing a response (for non-response 500 paths)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await reportInternalError(new Error("bot api blew up"), "bookings-api/book");

    expect(dispatch.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = dispatch.sendThrottledAlert.mock.calls[0] as unknown as [
      string,
      number,
      string,
    ];
    expect(key).toContain("bookings-api/book");
    expect(text).toContain("bot api blew up");
  });
});

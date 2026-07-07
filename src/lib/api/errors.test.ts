import { describe, it, expect, vi, afterEach } from "vitest";
import { internalErrorResponse } from "@/lib/api/errors";

// #598: an unexpected fault must return a generic body to the client while the
// real detail (table names, Google error text) stays in the server log only.

afterEach(() => vi.restoreAllMocks());

describe("internalErrorResponse", () => {
  it("returns a generic 500 body that does NOT leak the error message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = internalErrorResponse(
      new Error("relation \"bookings\" does not exist"),
      "cancel",
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/bookings|does not exist/);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("logs the real error with its context so detail is retained server-side", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("Google 503 backend error");
    internalErrorResponse(err, "reschedule");
    expect(spy).toHaveBeenCalled();
    // The context label and the real error both reach the log.
    const logged = spy.mock.calls[0];
    expect(JSON.stringify(logged)).toContain("reschedule");
    expect(logged).toContain(err);
  });

  it("handles a non-Error throw without leaking its stringification", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = internalErrorResponse("raw string blow up", "booking");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("blow up");
  });
});

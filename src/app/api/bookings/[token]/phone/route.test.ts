import { describe, it, expect, vi, beforeEach } from "vitest";

// The manage-token phone correction (#1341). The route is a thin shell: it caps
// the payload, hands the number to the shared rule, and reports back exactly what
// was stored. What is worth pinning here is that it NEVER invents a verdict of
// its own, because a second, laxer opinion about a phone number is how the
// product ends up saying two different things about one number.
const service = vi.hoisted(() => ({
  updateBookingPhone: vi.fn(
    async (
      _token: string,
      _phone: string,
    ): Promise<{ ok: boolean; phone?: string; error?: string }> => ({
      ok: true,
      phone: "(215) 555-9999",
    }),
  ),
}));
const errors = vi.hoisted(() => ({
  internalErrorResponse: vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "Something went wrong." }), { status: 500 }),
  ),
}));

vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/api/errors", () => errors);

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/bookings/tok1/phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ token: "tok1" }) },
  );
}

describe("POST /api/bookings/[token]/phone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.updateBookingPhone.mockResolvedValue({ ok: true, phone: "(215) 555-9999" });
  });

  it("returns the STORED number, not the one that was typed", async () => {
    const res = await post({ phone: "2155559999" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phone).toBe("(215) 555-9999");
    expect(service.updateBookingPhone).toHaveBeenCalledWith("tok1", "2155559999");
  });

  it("passes the manage token from the path, so the edit is scoped to that booking", async () => {
    await post({ phone: "2155559999" });
    expect(service.updateBookingPhone.mock.calls[0][0]).toBe("tok1");
  });

  it("relays the service's own refusal rather than a generic one", async () => {
    // Four different things can refuse a number, and they send the reader
    // somewhere different. Flattening them into "invalid" here would have a lead
    // retyping the same number (L11).
    service.updateBookingPhone.mockResolvedValue({
      ok: false,
      error: "We can only call US numbers.",
    });

    const res = await post({ phone: "+442071838750" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("We can only call US numbers.");
  });

  it("refuses a malformed body before anything is written", async () => {
    const res = await post({ nope: true });

    expect(res.status).toBe(400);
    expect(service.updateBookingPhone).not.toHaveBeenCalled();
  });

  it("refuses an oversized payload before it can reach Postgres or a calendar body", async () => {
    const res = await post({ phone: "2".repeat(5000) });

    expect(res.status).toBe(400);
    expect(service.updateBookingPhone).not.toHaveBeenCalled();
  });

  // The failure path: a write that threw must never come back looking like a save.
  it("does not report a saved number when the write itself failed", async () => {
    service.updateBookingPhone.mockRejectedValue(new Error("booking phone update failed"));

    const res = await post({ phone: "2155559999" });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.phone).toBeUndefined();
    // The detail is kept server-side rather than handed to a lead.
    expect(errors.internalErrorResponse).toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("booking phone update failed");
  });
});

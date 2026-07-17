import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the per-booking history viewer (#561). requireManager (the
// manager+ gate) and listBookingHistory are mocked so this exercises only the
// glue: the 403 gate, the 404 for a booking the caller can't see, the 200 shape,
// and the fail-loud 500 when the underlying read throws (rather than an empty 200).
const auth = vi.hoisted(() => ({
  requireManager: vi.fn(async () => ({ id: "mgr1", org_id: "org1" })),
}));
const history = vi.hoisted(() => ({ listBookingHistory: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/history", () => history);

import { GET } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

const params = { params: Promise.resolve({ id: "bk1" }) };
const req = {} as Parameters<typeof GET>[0];

beforeEach(() => vi.clearAllMocks());

describe("GET /admin/bookings/[id]/history", () => {
  it("returns 403 when the caller is not a manager", async () => {
    auth.requireManager.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await GET(req, params);
    expect(res.status).toBe(403);
    expect(history.listBookingHistory).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking is absent or in another org", async () => {
    history.listBookingHistory.mockResolvedValueOnce(null);
    const res = await GET(req, params);
    expect(res.status).toBe(404);
  });

  it("scopes the read to the caller's org and returns the events on success", async () => {
    const events = [{ id: "e1", action: "cancelled", who: "Customer" }];
    history.listBookingHistory.mockResolvedValueOnce(events);
    const res = await GET(req, params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events });
    expect(history.listBookingHistory).toHaveBeenCalledWith("bk1", "org1");
  });

  it("returns 500 (does not degrade to empty) when the read throws", async () => {
    history.listBookingHistory.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(req, params);
    expect(res.status).toBe(500);
  });
});

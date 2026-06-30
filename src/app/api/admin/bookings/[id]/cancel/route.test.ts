import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the admin cancel route. Manager+ gated (#544): managers, not just
// admins, can cancel from the admin page. requireManager + adminCancelBooking are
// mocked so this exercises only the glue.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => {}),
  requireManager: vi.fn(async () => {}),
}));
const service = vi.hoisted(() => ({ adminCancelBooking: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";

function req(body: unknown): Parameters<typeof POST>[0] {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}
const params = { params: Promise.resolve({ id: "bk1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/[id]/cancel", () => {
  it("is gated at manager level so managers (not just admins) can cancel (#544)", async () => {
    service.adminCancelBooking.mockResolvedValueOnce(undefined);
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(auth.requireManager).toHaveBeenCalled();
    expect(auth.requireAdmin).not.toHaveBeenCalled();
  });

  it("maps a cancel failure to 500", async () => {
    service.adminCancelBooking.mockRejectedValueOnce(new Error("Cancel failed"));
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Cancel failed");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the admin cancel route. Manager+ gated (#544): managers, not just
// admins, can cancel from the admin page. requireBookingActor (the manager+ gate +
// #549 actor resolver) + adminCancelBooking are mocked so this exercises only the glue.
const auth = vi.hoisted(() => ({
  requireBookingActor: vi.fn(
    async (): Promise<{ userId: string; actingAsUserId: string | null }> => ({
      userId: "mgr1",
      actingAsUserId: null,
    }),
  ),
}));
const service = vi.hoisted(() => ({ adminCancelBooking: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

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
    expect(auth.requireBookingActor).toHaveBeenCalled();
  });

  it("returns 403 when the caller is not manager+ (denial branch, #606)", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(403);
    expect(service.adminCancelBooking).not.toHaveBeenCalled();
  });

  it("records WHICH staff user cancelled by threading the actor (#549)", async () => {
    auth.requireBookingActor.mockResolvedValueOnce({ userId: "admin1", actingAsUserId: "mgr2" });
    service.adminCancelBooking.mockResolvedValueOnce(undefined);
    await POST(req({ reason: "schedule_conflict" }), params);
    expect(service.adminCancelBooking).toHaveBeenCalledWith(
      "bk1",
      expect.anything(),
      { userId: "admin1", actingAsUserId: "mgr2" },
    );
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.adminCancelBooking.mockRejectedValueOnce(
      new Error('relation "bookings" does not exist'),
    );
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/bookings|does not exist/);
  });
});

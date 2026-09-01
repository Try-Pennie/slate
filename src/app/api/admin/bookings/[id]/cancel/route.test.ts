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

/** Same-origin headers, which is what Slate's own UI sends. The routes refuse a
 *  request that says it came from elsewhere (#1046), so every fake carries them;
 *  `crossOrigin` below overrides them to drive the refusal. */
const SAME_ORIGIN_HEADERS = {
  origin: "https://slate.trypennie.app",
  "sec-fetch-site": "same-origin",
  host: "slate.trypennie.app",
};
function req(
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN_HEADERS,
): Parameters<typeof POST>[0] {
  return {
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as Parameters<typeof POST>[0];
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

// #1046: the session cookie is this route's only credential, so a request that says
// it came from another site is refused before the auth check and before the body is
// read. Wired route by route, so it is asserted route by route: the static guard
// (scripts/test-same-origin-coverage.ts) proves the CALL is present in every one,
// and this proves the call actually refuses on this route rather than being
// unreachable behind an earlier return.
describe("admin cancel refuses a cross-origin request (#1046)", () => {
  it("403s a cross-site request without authenticating or writing", async () => {
    const res = await POST(req({ reason: "schedule_conflict" }, { ...SAME_ORIGIN_HEADERS, origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params);

    expect(res.status).toBe(403);
    expect(auth.requireBookingActor).not.toHaveBeenCalled();
    expect(service.adminCancelBooking).not.toHaveBeenCalled();
  });

  it("still serves the same-origin request the UI sends", async () => {
    // The positive control. Without it a guard that refused everything would pass
    // the test above while breaking the whole surface.
    const res = await POST(req({ reason: "schedule_conflict" }), params);
    expect(res.status).not.toBe(403);
  });
});

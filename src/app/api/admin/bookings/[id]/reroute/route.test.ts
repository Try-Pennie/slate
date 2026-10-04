import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the reroute routes (#3249): start and current (this route), confirm
// and release (beside it). The manager gate and the service are mocked, so this
// exercises the glue: the gate, the same origin refusal, input checking, and that
// each refusal answers with its own status and sentence (L11).
const auth = vi.hoisted(() => ({
  requireBookingActor: vi.fn(async () => ({ userId: "mgr1", actingAsUserId: null as string | null })),
}));
const service = vi.hoisted(() => {
  class Named extends Error {}
  return {
    adminStartReroute: vi.fn(),
    adminCurrentReroute: vi.fn(),
    adminConfirmReroute: vi.fn(),
    adminReleaseReroute: vi.fn(),
    // The shared reassign mapper checks these classes with instanceof.
    DailyCapExceededError: class extends Named {},
    BookingNotFoundError: class extends Named {},
    AgentNotAvailableError: class extends Named {},
    BookingNotChangeableError: class extends Named {},
    ReassignAcrossWorldsError: class extends Named {},
  };
});
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { POST, GET } from "./route";
import { POST as CONFIRM } from "./confirm/route";
import { DELETE as RELEASE } from "./hold/route";
import { RerouteRefusedError } from "@/lib/booking/reroute";
import { VerifyUnavailableError } from "@/lib/booking/orchestration";
import { NotAuthorizedError } from "@/lib/auth/http";

const SAME = { origin: "https://slate.trypennie.app", "sec-fetch-site": "same-origin", host: "slate.trypennie.app" };
const CROSS = { ...SAME, origin: "https://evil.example", "sec-fetch-site": "cross-site" };
const req = (body: unknown, headers: Record<string, string> = SAME) =>
  ({ json: async () => body, headers: new Headers(headers) }) as unknown as Parameters<typeof POST>[0];
const params = { params: Promise.resolve({ id: "bk1" }) };
const HOLD = "11111111-2222-4333-8444-555555555555";

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/bookings/[id]/reroute", () => {
  it("starts a reroute for the bucket asked for, as the signed in manager", async () => {
    service.adminStartReroute.mockResolvedValueOnce({ kind: "move", holdId: HOLD, secondsRemaining: 300 });
    const res = await POST(req({ bucketCode: "512" }), params);
    expect(res.status).toBe(200);
    expect(service.adminStartReroute).toHaveBeenCalledWith("bk1", "512", { userId: "mgr1", actingAsUserId: null });
    expect((await res.json()).holdId).toBe(HOLD);
  });

  it("refuses a request from another site before touching anything", async () => {
    const res = await POST(req({ bucketCode: "512" }, CROSS), params);
    expect(res.status).toBe(403);
    expect(auth.requireBookingActor).not.toHaveBeenCalled();
    expect(service.adminStartReroute).not.toHaveBeenCalled();
  });

  it("refuses somebody who may not change bookings", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(req({ bucketCode: "512" }), params);
    expect(res.status).toBe(403);
    expect(service.adminStartReroute).not.toHaveBeenCalled();
  });

  it("refuses a body with no bucket", async () => {
    const res = await POST(req({}), params);
    expect(res.status).toBe(400);
  });

  it("answers each refusal with its own status and sentence", async () => {
    service.adminStartReroute.mockRejectedValueOnce(new RerouteRefusedError("agent_link"));
    const a = await POST(req({ bucketCode: "512" }), params);
    expect(a.status).toBe(409);
    const aBody = await a.json();
    expect(aBody.code).toBe("agent_link");
    expect(aBody.error).toMatch(/specific advisor/);

    service.adminStartReroute.mockRejectedValueOnce(new RerouteRefusedError("unknown_bucket"));
    const b = await POST(req({ bucketCode: "999" }), params);
    expect(b.status).toBe(400);
    expect((await b.json()).error).not.toBe(aBody.error);
  });

  it("answers an unreadable calendar as a retriable 503, never a refusal", async () => {
    service.adminStartReroute.mockRejectedValueOnce(new VerifyUnavailableError());
    const res = await POST(req({ bucketCode: "512" }), params);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("VERIFY_UNAVAILABLE");
  });
});

describe("GET /admin/bookings/[id]/reroute", () => {
  it("returns the live hold so a reload restores the panel", async () => {
    service.adminCurrentReroute.mockResolvedValueOnce({ kind: "move", holdId: HOLD, secondsRemaining: 42 });
    const res = await GET(req(null), params);
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.secondsRemaining).toBe(42);
  });

  it("returns null when nothing is held", async () => {
    service.adminCurrentReroute.mockResolvedValueOnce(null);
    const res = await GET(req(null), params);
    expect((await res.json()).proposal).toBeNull();
  });

  it("is manager gated", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    expect((await GET(req(null), params)).status).toBe(403);
  });
});

describe("POST /admin/bookings/[id]/reroute/confirm", () => {
  it("confirms a move by its hold, with the note", async () => {
    service.adminConfirmReroute.mockResolvedValueOnce({ kind: "moved" });
    const res = await CONFIRM(req({ holdId: HOLD, note: "lead is Ultra High" }), params);
    expect(res.status).toBe(200);
    expect(service.adminConfirmReroute).toHaveBeenCalledWith("bk1", HOLD, null, "lead is Ultra High", { userId: "mgr1", actingAsUserId: null });
  });

  it("confirms a keep by the bucket to correct to, with no hold", async () => {
    service.adminConfirmReroute.mockResolvedValueOnce({ kind: "kept" });
    await CONFIRM(req({ holdId: null, bucketCode: "512" }), params);
    expect(service.adminConfirmReroute).toHaveBeenCalledWith("bk1", null, "512", null, expect.anything());
  });

  it("refuses a keep with no bucket, and a move whose hold is not an id", async () => {
    expect((await CONFIRM(req({ holdId: null }), params)).status).toBe(400);
    expect((await CONFIRM(req({ holdId: "not-an-id" }), params)).status).toBe(400);
    expect(service.adminConfirmReroute).not.toHaveBeenCalled();
  });

  it("refuses a request from another site", async () => {
    expect((await CONFIRM(req({ holdId: HOLD }, CROSS), params)).status).toBe(403);
    expect(service.adminConfirmReroute).not.toHaveBeenCalled();
  });

  it("names a booking the lead moved during the hold", async () => {
    service.adminConfirmReroute.mockRejectedValueOnce(new RerouteRefusedError("booking_moved"));
    const res = await CONFIRM(req({ holdId: HOLD }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/moved this call/);
  });
});

describe("DELETE /admin/bookings/[id]/reroute/hold", () => {
  it("releases the booking's held advisor", async () => {
    service.adminReleaseReroute.mockResolvedValueOnce({ released: true });
    const res = await RELEASE(req(null), params);
    expect(res.status).toBe(200);
    expect(service.adminReleaseReroute).toHaveBeenCalledWith("bk1", expect.anything());
    expect((await res.json()).released).toBe(true);
  });

  it("refuses a request from another site", async () => {
    expect((await RELEASE(req(null, CROSS), params)).status).toBe(403);
    expect(service.adminReleaseReroute).not.toHaveBeenCalled();
  });
});

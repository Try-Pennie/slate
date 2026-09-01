import { describe, it, expect, vi, beforeEach } from "vitest";

// HTTP wiring for the bulk coverage-reassign endpoint (#974). requireBookingActor
// (manager+ gate + #549 actor resolver) and the three service functions are
// mocked so this exercises only the route glue: auth, input validation (range +
// reason, via the real pure validators), and the start / preview / progress
// branches. validateReason (@/lib/booking/core) and parseBulkReassignRange
// (@/lib/booking/bulk-reassign) run for real.
const auth = vi.hoisted(() => ({
  requireBookingActor: vi.fn(
    async (): Promise<{ userId: string; actingAsUserId: string | null }> => ({
      userId: "mgr1",
      actingAsUserId: null,
    }),
  ),
}));
const service = vi.hoisted(() => ({
  startBulkReassign: vi.fn(),
  previewBulkReassign: vi.fn(),
  getBulkReassignProgress: vi.fn(),
}));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/booking/service", () => service);

import { GET, POST } from "./route";
import { NotAuthorizedError } from "@/lib/auth/http";

/** Same-origin headers, which is what Slate's own UI sends. The route refuses a
 *  request that says it came from elsewhere (#1046), so every fake carries them;
 *  the refusal test below overrides them. */
const SAME_ORIGIN_HEADERS = {
  origin: "https://slate.trypennie.app",
  "sec-fetch-site": "same-origin",
  host: "slate.trypennie.app",
};
const CROSS_ORIGIN_HEADERS = {
  ...SAME_ORIGIN_HEADERS,
  origin: "https://evil.example",
  "sec-fetch-site": "cross-site",
};
function postReq(
  body: unknown,
  headers: Record<string, string> = SAME_ORIGIN_HEADERS,
): Parameters<typeof POST>[0] {
  return {
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as Parameters<typeof POST>[0];
}
function getReq(query: string): Parameters<typeof GET>[0] {
  return { url: `https://slate.test/api/admin/agents/out1/bulk-reassign${query}` } as unknown as Parameters<
    typeof GET
  >[0];
}
const params = { params: Promise.resolve({ id: "out1" }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /admin/agents/[id]/bulk-reassign", () => {
  it("starts a sweep and threads the actor, range and reason into the service", async () => {
    auth.requireBookingActor.mockResolvedValueOnce({ userId: "admin1", actingAsUserId: "mgr2" });
    service.startBulkReassign.mockResolvedValueOnce({ jobId: "job1", itemCount: 7 });
    const res = await POST(
      postReq({ from: "2026-07-25T00:00:00.000Z", to: "2026-07-28T00:00:00.000Z", reason: "coverage" }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: "job1", itemCount: 7 });
    expect(service.startBulkReassign).toHaveBeenCalledWith(
      expect.objectContaining({
        outUserId: "out1",
        rangeStartIso: "2026-07-25T00:00:00.000Z",
        rangeEndIso: "2026-07-28T00:00:00.000Z",
        reason: expect.objectContaining({ code: "coverage" }),
        actor: { userId: "admin1", actingAsUserId: "mgr2" },
      }),
    );
  });

  it("defaults to now-onward (open-ended) when no range is given", async () => {
    service.startBulkReassign.mockResolvedValueOnce({ jobId: "job2", itemCount: 0 });
    const res = await POST(postReq({ reason: "coverage" }), params);
    expect(res.status).toBe(200);
    expect(service.startBulkReassign).toHaveBeenCalledWith(expect.objectContaining({ rangeEndIso: null }));
  });

  it("returns 403 when the caller is not manager+ (denial branch)", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await POST(postReq({ reason: "coverage" }), params);
    expect(res.status).toBe(403);
    expect(service.startBulkReassign).not.toHaveBeenCalled();
  });

  it("rejects an invalid range (end on/before start) with 400", async () => {
    const res = await POST(
      postReq({ from: "2026-07-28T00:00:00.000Z", to: "2026-07-25T00:00:00.000Z", reason: "coverage" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(service.startBulkReassign).not.toHaveBeenCalled();
  });

  it("rejects an invalid reason with 400", async () => {
    const res = await POST(postReq({ reason: "not_a_reason" }), params);
    expect(res.status).toBe(400);
    expect(service.startBulkReassign).not.toHaveBeenCalled();
  });
});

describe("GET /admin/agents/[id]/bulk-reassign", () => {
  it("returns 403 when the caller is not manager+", async () => {
    auth.requireBookingActor.mockRejectedValueOnce(new NotAuthorizedError());
    const res = await GET(getReq("?from=2026-07-25T00:00:00.000Z"), params);
    expect(res.status).toBe(403);
  });

  it("returns a preview count when no jobId is given", async () => {
    service.previewBulkReassign.mockResolvedValueOnce(4);
    const res = await GET(getReq("?from=2026-07-25T00:00:00.000Z"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 4 });
    expect(service.previewBulkReassign).toHaveBeenCalledWith("out1", "2026-07-25T00:00:00.000Z", null);
  });

  it("returns job progress when a jobId is given", async () => {
    const progress = {
      job: { id: "job1", out_user_id: "out1", status: "active" },
      summary: { total: 3, counts: { pending: 1, moved: 1, unplaceable: 1, skipped: 0, failed: 0 }, done: false },
      actionable: [{ bookingId: "bk1", status: "unplaceable", detail: "no agent free", startsAt: "x", attendeeName: "Kris" }],
    };
    service.getBulkReassignProgress.mockResolvedValueOnce(progress);
    const res = await GET(getReq("?jobId=job1"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(progress);
  });

  it("404s a jobId that belongs to a DIFFERENT agent (no cross-agent leakage)", async () => {
    service.getBulkReassignProgress.mockResolvedValueOnce({
      job: { id: "job1", out_user_id: "someone_else", status: "active" },
      summary: { total: 0, counts: { pending: 0, moved: 0, unplaceable: 0, skipped: 0, failed: 0 }, done: true },
      actionable: [],
    });
    const res = await GET(getReq("?jobId=job1"), params);
    expect(res.status).toBe(404);
  });

  it("404s an unknown jobId", async () => {
    service.getBulkReassignProgress.mockResolvedValueOnce(null);
    const res = await GET(getReq("?jobId=nope"), params);
    expect(res.status).toBe(404);
  });
});

// #1046: the session cookie is this route's only credential, so a request that says
// it came from another site is refused before the auth check and before the body is
// read. The static guard (scripts/test-same-origin-coverage.ts) proves every
// cookie-authed mutation route carries the CALL; this proves the call on this route
// actually refuses rather than sitting unreachable behind an earlier return.
describe("bulk reassign start refuses a cross-origin request (#1046)", () => {
  it("403s a cross-site request without authenticating or writing", async () => {
    const res = await POST(postReq({ reason: "coverage" }, CROSS_ORIGIN_HEADERS), params);

    expect(res.status).toBe(403);
    expect(auth.requireBookingActor).not.toHaveBeenCalled();
    expect(service.startBulkReassign).not.toHaveBeenCalled();
  });

  it("still serves the same-origin request the UI sends", async () => {
    // The positive control: a guard that refused everything would pass the test
    // above while breaking the whole surface.
    const res = await POST(postReq({ reason: "coverage" }), params);
    expect(res.status).not.toBe(403);
  });
});

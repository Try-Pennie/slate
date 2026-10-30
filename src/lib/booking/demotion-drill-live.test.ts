import { describe, it, expect, vi, beforeEach } from "vitest";

// #3615: the reroute drill's real wiring. The drill's steps are node-tested over a fake world, but
// a fake booking cannot see the booking path's own gates: the first live run (Actions run
// 38185518019) was refused "Unknown booking bucket" at the book step, because the booking path
// refuses every TEST bucket unless the caller says it may book one, and this wiring never said so.
// Pinned here by capturing what the drill hands the real booking call.

const service = vi.hoisted(() => ({
  bookViaApi: vi.fn(),
  cancelBooking: vi.fn(),
  adminMoveBackDemotionReroute: vi.fn(),
  drainBulkReassignJob: vi.fn(),
  startBulkReassign: vi.fn(),
}));
vi.mock("@/lib/booking/service", () => service);
const availability = vi.hoisted(() => ({
  resolveBucketByCode: vi.fn(),
  resolveBucketAgentIds: vi.fn(),
  getBucketSlots: vi.fn(),
  namedAgentResolver: vi.fn((userId: string) => ({ agent: userId })),
}));
vi.mock("@/lib/availability/service", () => availability);
vi.mock("@/lib/booking/bulk-reassign-store", () => ({
  demotionBookings: vi.fn(),
  pinnedDemotionBookingIds: vi.fn(async () => new Map()),
  rerouteCandidatesForAgent: vi.fn(async () => []),
}));
const users = vi.hoisted(() => ({
  rows: [
    { id: "a", email: "a@x.com", attributes: { debt_team: ["drill"] }, is_test: true },
    { id: "b", email: "b@x.com", attributes: { debt_team: ["drill"] }, is_test: true },
  ],
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq", "update", "filter", "limit"]) b[m] = () => b;
      b.maybeSingle = () => b;
      b.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: users.rows, error: null }).then(resolve);
      return b;
    },
  }),
}));

import { runDemotionDrillLive } from "./demotion-drill-live";

beforeEach(() => {
  vi.clearAllMocks();
  availability.resolveBucketByCode.mockResolvedValue({ bucket: { id: "bk-drill", org_id: "org1", is_test: true }, eventType: {} });
  availability.resolveBucketAgentIds.mockResolvedValue(["a", "b"]);
  availability.getBucketSlots.mockResolvedValue({ slots: ["2026-10-14T15:00:00.000Z"] });
  // Refuse the booking so the run stops at the step under test; cleanup still runs.
  service.bookViaApi.mockRejectedValue(new Error("stop here"));
});

describe("the reroute drill's booking (#3615)", () => {
  it("books the DRILL test bucket and says it may book a test bucket", async () => {
    await runDemotionDrillLive();
    expect(service.bookViaApi).toHaveBeenCalledTimes(1);
    const input = service.bookViaApi.mock.calls[0][0];
    expect(input.bucketCode).toBe("DRILL");
    expect(input.allowTestBuckets).toBe(true);
    expect(input.startIso).toBe("2026-10-14T15:00:00.000Z");
    expect(input.attendee.email).toMatch(/^smoketest\+reroute-drill-.+@trypennie\.com$/);
  });
});

describe("the reroute drill's time (2026-10-30)", () => {
  // The drill booked the bucket's first time, which only ONE test advisor was free at (the other
  // had a calendar event), so the call could only land on that one and the sweep rightly found
  // nobody to take it. Each advisor's times are read on their own and the first shared one booked.
  it("books the first time every drill advisor is free, read per advisor", async () => {
    availability.getBucketSlots.mockImplementation(async (_code: string, _from: string, _to: string, resolver?: { agent: string }) =>
      resolver?.agent === "a"
        ? { slots: ["2026-10-30T17:00:00.000Z", "2026-10-30T18:00:00.000Z"] }
        : resolver?.agent === "b"
          ? { slots: ["2026-10-30T18:00:00.000Z"] }
          : { slots: ["2026-10-30T17:00:00.000Z"] },
    );
    await runDemotionDrillLive();
    expect(availability.namedAgentResolver.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
    expect(service.bookViaApi.mock.calls[0][0].startIso).toBe("2026-10-30T18:00:00.000Z");
  });

  it("books nothing when the advisors share no free time", async () => {
    availability.getBucketSlots.mockImplementation(async (_c: string, _f: string, _t: string, resolver?: { agent: string }) =>
      ({ slots: [resolver?.agent === "a" ? "2026-10-30T17:00:00.000Z" : "2026-10-30T18:00:00.000Z"] }),
    );
    const r = await runDemotionDrillLive();
    expect(r.reason).toBe("no-free-slot");
    expect(service.bookViaApi).not.toHaveBeenCalled();
  });
});

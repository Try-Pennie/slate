import { describe, it, expect, vi, beforeEach } from "vitest";

// #1616, and the single most important test in that change.
//
// The reschedule path is the one route `bucket_code` cannot reach: it records an
// EMPTY bucket code, and 4 of the smoke canary's 16 attempts per pass land here,
// including the `reschedule_conflict` the canary raises ON PURPOSE. A change that
// only proved the booker path would pass while leaving the defect in place: the
// canary's errors would stay in the failure rate and its successes would leave.
//
// So this drives the REAL route handler with the REAL recordApiOutcome and the
// REAL marker resolver, mocking only the booking service, the reason options and
// the database. What is asserted is the argument that actually reaches the tally
// RPC, not an intermediate call nobody ships.

const service = vi.hoisted(() => {
  class RescheduleConflictError extends Error {
    constructor() {
      super("This booking was just changed. Refresh and try again.");
      this.name = "RescheduleConflictError";
    }
  }
  class SlotUnavailableError extends Error {}
  class VerifyUnavailableError extends Error {}
  class RescheduleLockUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  return {
    rescheduleBooking: vi.fn(),
    RescheduleConflictError,
    SlotUnavailableError,
    VerifyUnavailableError,
    RescheduleLockUnavailableError,
    NoEligibleAgentsError,
  };
});

const rpc = vi.hoisted(() => vi.fn());
const bookingMaybeSingle = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() =>
  vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: bookingMaybeSingle }) }) })),
);
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn(() => ({ rpc, from })) }));

// afterResponse defers the tally under waitUntil; capture the work so the test can
// run it, which is exactly what Cloudflare does after the response is sent.
const deferred = vi.hoisted(() => ({ work: null as null | (() => Promise<unknown>) }));

/** #1046: the route throttles per address. Stubbed permissive here; the refusal
 *  itself is covered in route.test.ts beside this file. */
vi.mock("@/lib/rate-limit", () => ({ manageWithinLimit: vi.fn(async () => true) }));
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/after-response", () => ({
  afterResponse: (_ctx: string, work: () => Promise<unknown>) => {
    deferred.work = work;
  },
}));
vi.mock("@/lib/booking/reason-options", () => ({
  loadReasonOptions: async () => ({
    reschedule: { all: [{ code: "schedule_conflict", label: "Schedule conflict" }] },
  }),
}));

import { POST } from "./route";

function req(body: unknown): Parameters<typeof POST>[0] {
  return {
    json: async () => body,
    // The route throttles per address (#1046), so the fake carries one.
    headers: new Headers({ "cf-connecting-ip": "203.0.113.9" }),
  } as unknown as Parameters<typeof POST>[0];
}
const BODY = { start: "2026-07-01T15:00:00.000Z", reason: "schedule_conflict" };
const params = (token: string) => ({ params: Promise.resolve({ token }) });

/** Run the route, then run the tally work it deferred, and return the RPC args. */
async function recordedTallyArgs(token: string): Promise<Record<string, unknown>> {
  await POST(req(BODY), params(token));
  expect(deferred.work).not.toBeNull();
  await deferred.work!();
  expect(rpc).toHaveBeenCalledWith("bump_booking_api_outcome", expect.anything());
  return rpc.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.work = null;
  rpc.mockResolvedValue({ error: null });
  service.rescheduleBooking.mockResolvedValue({
    booking: { id: "b1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
    manageUrl: "https://slate.example/manage/tok",
  });
});

describe("the reschedule path carries the test marker (#1616)", () => {
  it("marks the canary's DELIBERATE reschedule_conflict as test traffic", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: true } }, error: null });
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());

    const args = await recordedTallyArgs("tok-smoke");
    expect(args.p_error_code).toBe("reschedule_conflict");
    // The row it would otherwise be indistinguishable from: an empty bucket code.
    expect(args.p_bucket).toBe("");
    expect(args.p_is_test).toBe(true);
  });

  it("marks the canary's successful reschedule as test traffic too", async () => {
    // Both halves, or the exclusion is worse than none: dropping the successes
    // while keeping the errors would make the measured share 100 percent.
    bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: true } }, error: null });

    const args = await recordedTallyArgs("tok-smoke");
    expect(args.p_outcome).toBe("rescheduled");
    expect(args.p_is_test).toBe(true);
  });

  it("leaves a real lead's reschedule conflict IN the failure rate", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: false } }, error: null });
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());

    const args = await recordedTallyArgs("tok-real");
    expect(args.p_error_code).toBe("reschedule_conflict");
    expect(args.p_is_test).toBe(false);
  });

  it("counts the attempt when the booking lookup fails, rather than hiding it", async () => {
    // The failure path. An unreadable marker must never be the reason a real
    // customer failure disappears from the one check watching for it.
    bookingMaybeSingle.mockResolvedValue({ data: null, error: { message: "timeout" } });
    service.rescheduleBooking.mockRejectedValueOnce(new service.RescheduleConflictError());

    const args = await recordedTallyArgs("tok");
    expect(args.p_is_test).toBe(false);
  });

  it("resolves the marker from the token the request was made against", async () => {
    bookingMaybeSingle.mockResolvedValue({ data: { buckets: { is_test: true } }, error: null });
    await recordedTallyArgs("tok-smoke");
    expect(from).toHaveBeenCalledWith("bookings");
  });
});

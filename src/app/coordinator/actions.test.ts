import { describe, it, expect, vi, beforeEach } from "vitest";
import { PARTNER_BUCKET_CODE } from "@/lib/embed/public-test-bucket";

// #4205: the coordinator page's server functions check the role THEMSELVES, rate limit
// per person, and answer typed results rather than throwing. The operations behind them
// are driven by the node suites (scripts/test-coordinator-*.ts); this pins the wiring:
// who gets in, what a refusal reads, and that a double press reaches the booking under
// one submission id. Every value is invented.

const auth = vi.hoisted(() => ({
  coordinatorDeskUser: vi.fn(),
  // The real one's contract: the desk user, or a throw (a 403 at the HTTP layer).
  requireCoordinatorDesk: vi.fn(),
}));
const limiter = vi.hoisted(() => ({ allowRequest: vi.fn(async () => true) }));
const live = vi.hoisted(() => {
  const place = vi.fn();
  const readLead = vi.fn();
  const routings: unknown[] = [];
  const lookupRoutings: unknown[] = [];
  const readQueue = vi.fn();
  const readSettings = vi.fn();
  return {
    place,
    readLead,
    readQueue,
    readSettings,
    routings,
    lookupRoutings,
    transferDeps: () => ({ readQueue, readSettings }),
    lookupDeps: () => ({
      readLead,
      readLeadXbc: async () => "412",
      // Any code but the score's is a test bucket here, so the drill case resolves the
      // partner test bucket by the constant the product uses.
      resolveBucketByCode: async (code: string) => ({ bucket: { code, is_test: code !== "412", org_id: "org1" }, eventType: { duration_min: 30 } }),
      findActiveBookingsForPerson: async () => [],
      businessHours: async () => ({ zone: "America/New_York", rules: [], exceptions: [] }),
      horizonDays: async () => 10,
      now: () => Date.parse("2026-06-08T12:00:00.000Z"),
    }),
    placeCallDeps: () => ({
      findCustomer: async (_reference: string, routing: unknown) => (routings.push(routing), {
        ok: true,
        customer: {
          salesforceLeadId: "00QUi00000AbCdEMAC",
          name: "Invented Customer",
          firstName: "Invented",
          email: "invented@example.com",
          phone: "+15555550100",
          zone: "America/Phoenix",
          zoneFrom: "zip",
          bucketCode: "412",
          bucketSource: "salesforce",
          bucketIsTest: false,
          durationMin: 30,
        },
      }),
      place,
      rescheduleReasons: async () => [],
      mintSubmissionId: () => "6f1c2d3e-0000-4000-8000-0000000000ff",
    }),
  };
});

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/rate-limit", () => limiter);
vi.mock("@/lib/coordinator/live", () => live);
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { checkCoordinatorTransfer, lookupCoordinatorCustomer, placeCoordinatorCall } from "./actions";

const COORDINATOR = { id: "coord-1", role: "coordinator", is_test: false };
const DRILL_COORDINATOR = { id: "coord-drill", role: "coordinator", is_test: true };
const SUBMISSION = "6f1c2d3e-0000-4000-8000-000000000001";
const booked = {
  kind: "booked",
  on: "advisor",
  booking: { id: "bk1", starts_at: "2026-06-09T17:00:00.000Z", agent_name: "Advisor A" },
  manageUrl: "https://slate.test/booking/manage/tok1",
  replayed: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  live.routings.length = 0;
  live.place.mockReset();
  auth.coordinatorDeskUser.mockResolvedValue(COORDINATOR);
  auth.requireCoordinatorDesk.mockResolvedValue(COORDINATOR);
  limiter.allowRequest.mockResolvedValue(true);
  live.readQueue.mockResolvedValue({ ok: true, free: 19 });
  live.readSettings.mockResolvedValue({ threshold: 3, line: "786-504-0671" });
});

describe("placeCoordinatorCall (#4205)", () => {
  it("refuses somebody who may not use the page, and books nothing", async () => {
    auth.coordinatorDeskUser.mockResolvedValue(null);
    const out = await placeCoordinatorCall({ reference: "00QUi00000AbCdEMAC", startIso: "2026-06-09T17:00:00.000Z", submissionId: SUBMISSION });
    expect(out).toMatchObject({ kind: "refused", reason: "not-authorized", submissionId: SUBMISSION });
    expect(live.place).not.toHaveBeenCalled();
    expect(limiter.allowRequest).not.toHaveBeenCalled();
  });

  it("books as the signed in coordinator, keyed per person in the limiter", async () => {
    live.place.mockResolvedValue(booked);
    const out = await placeCoordinatorCall({ reference: "00QUi00000AbCdEMAC", startIso: "2026-06-09T17:00:00.000Z", submissionId: SUBMISSION });
    expect(out).toMatchObject({ kind: "booked", on: "advisor", submissionId: SUBMISSION });
    expect(live.place).toHaveBeenCalledWith(expect.objectContaining({ coordinatorUserId: "coord-1", submissionId: SUBMISSION, timezone: "America/Phoenix" }));
    expect(limiter.allowRequest).toHaveBeenCalledWith({ kind: "opaque", key: "coordinator:coord-1" }, expect.any(Array));
  });

  it("sends a double press to the booking under the SAME submission id, so it books once", async () => {
    live.place.mockResolvedValueOnce(booked).mockResolvedValueOnce({ ...booked, replayed: true });
    const press = { reference: "00QUi00000AbCdEMAC", startIso: "2026-06-09T17:00:00.000Z", submissionId: SUBMISSION };
    const [first, second] = await Promise.all([placeCoordinatorCall(press), placeCoordinatorCall(press)]);
    expect(live.place.mock.calls.map((c) => c[0].submissionId)).toEqual([SUBMISSION, SUBMISSION]);
    expect([first.kind, second.kind]).toEqual(["booked", "booked"]);
    expect(second).toMatchObject({ replayed: true });
  });

  it("answers a limiter refusal as its own sentence, and books nothing", async () => {
    limiter.allowRequest.mockResolvedValue(false);
    const out = await placeCoordinatorCall({ reference: "00QUi00000AbCdEMAC", startIso: "2026-06-09T17:00:00.000Z", submissionId: SUBMISSION });
    expect(out).toMatchObject({ kind: "refused", reason: "rate-limited", retryable: true });
    expect(live.place).not.toHaveBeenCalled();
  });

  it("answers an unexpected failure as a refusal with no raw error in it", async () => {
    live.place.mockRejectedValue(new Error("connection reset by peer"));
    const out = await placeCoordinatorCall({ reference: "00QUi00000AbCdEMAC", startIso: "2026-06-09T17:00:00.000Z", submissionId: SUBMISSION });
    expect(out).toMatchObject({ kind: "refused", reason: "internal", retryable: true, submissionId: SUBMISSION });
    expect(out.sentence).not.toMatch(/connection reset/);
  });

  it("routes by the signed in coordinator's own is_test, never by anything the page sent (Dan, 2026-10-27)", async () => {
    live.place.mockResolvedValue(booked);
    const sent = { reference: "00QUi00000AbCdEMAC", startIso: "2026-06-09T17:00:00.000Z", submissionId: SUBMISSION, bucketCode: "412", testCoordinator: false } as never;
    auth.coordinatorDeskUser.mockResolvedValue(DRILL_COORDINATOR);
    await placeCoordinatorCall(sent);
    auth.coordinatorDeskUser.mockResolvedValue(COORDINATOR);
    await placeCoordinatorCall({ ...(sent as object), testCoordinator: true } as never);
    expect(live.routings).toEqual([{ testCoordinator: true }, { testCoordinator: false }]);
  });

  it("ignores a payload that is not the shape the page sends, rather than throwing", async () => {
    const out = await placeCoordinatorCall({ reference: 42, startIso: null } as never);
    expect(out.kind).toBe("refused");
  });
});

describe("lookupCoordinatorCustomer (#4205)", () => {
  it("refuses somebody who may not use the page before Salesforce is asked", async () => {
    auth.coordinatorDeskUser.mockResolvedValue(null);
    const out = await lookupCoordinatorCustomer({ reference: "00QUi00000AbCdEMAC" });
    expect(out).toMatchObject({ ok: false, refusal: "not-authorized" });
    expect(live.readLead).not.toHaveBeenCalled();
  });

  it("says Salesforce could not be reached when it could not, never that there is no lead", async () => {
    live.readLead.mockRejectedValue(new Error("SF query failed: 503"));
    const out = await lookupCoordinatorCustomer({ reference: "00QUi00000AbCdEMAC" });
    expect(out).toMatchObject({ ok: false, refusal: "salesforce-unreadable" });
    expect(!out.ok && out.sentence).toMatch(/Salesforce/);
  });

  it("finds the customer, in the zone their Lead gives", async () => {
    live.readLead.mockResolvedValue({
      id: "00QUi00000AbCdEMAC",
      name: "Invented Customer",
      firstName: "Invented",
      email: null,
      phone: null,
      postalCode: "85001",
      state: "AZ",
    });
    const out = await lookupCoordinatorCustomer({ reference: "00QUi00000AbCdEMAC" });
    expect(out.ok && out.customer.zone).toBe("America/Phoenix");
  });

  it("looks a drill coordinator's customer up on the partner test bucket, whatever the Lead's score (Dan, 2026-10-27)", async () => {
    live.readLead.mockResolvedValue({ id: "00QUi00000AbCdEMAC", name: "Invented Customer", firstName: "Invented", email: null, phone: null, postalCode: "85001", state: "AZ" });
    auth.coordinatorDeskUser.mockResolvedValue(DRILL_COORDINATOR);
    const drill = await lookupCoordinatorCustomer({ reference: "00QUi00000AbCdEMAC", bucketCode: "412" } as never);
    expect(drill.ok && drill.customer.bucketCode).toBe(PARTNER_BUCKET_CODE);
    auth.coordinatorDeskUser.mockResolvedValue(COORDINATOR);
    const real = await lookupCoordinatorCustomer({ reference: "00QUi00000AbCdEMAC", testCoordinator: true } as never);
    expect(real.ok && real.customer.bucketCode).toBe("412");
  });
});

describe("the actions the page can call (#4316)", () => {
  // A server action is a public endpoint whoever renders the form, so every one the
  // module exports is callable by any signed in coordinator. Each derives the bucket on
  // the server from the Lead and the signed in person; an action taking a bucket code
  // from the browser (the old placeholder count did) would read any bucket, test ones
  // included. A new export has to be added here on purpose.
  it("exports only the customer lookup, the booking and the transfer check", async () => {
    // #4380: the transfer check takes nothing from the browser at all; the queue is chosen
    // on the endpoint's side and the threshold and line are the stored settings.
    const actions = await import("./actions");
    expect(Object.keys(actions).sort()).toEqual(["checkCoordinatorTransfer", "lookupCoordinatorCustomer", "placeCoordinatorCall"]);
  });
});

describe("checkCoordinatorTransfer (#4380)", () => {
  it("refuses somebody who may not use the page before the queue is asked", async () => {
    auth.requireCoordinatorDesk.mockRejectedValue(new Error("Not authorized"));
    const out = await checkCoordinatorTransfer();
    expect(out).toEqual({ kind: "refused", refusal: "not-authorized" });
    expect(live.readQueue).not.toHaveBeenCalled();
    expect(limiter.allowRequest).not.toHaveBeenCalled();
  });

  it("offers the transfer line when the count reaches the stored threshold, keyed per person in the limiter", async () => {
    live.readQueue.mockResolvedValue({ ok: true, free: 3 });
    await expect(checkCoordinatorTransfer()).resolves.toEqual({ kind: "offer", line: "786-504-0671" });
    expect(limiter.allowRequest).toHaveBeenCalledWith({ kind: "opaque", key: "coordinator:coord-1" }, expect.any(Array));
  });

  it("offers nothing when fewer are free than the stored threshold", async () => {
    live.readQueue.mockResolvedValue({ ok: true, free: 4 });
    live.readSettings.mockResolvedValue({ threshold: 5, line: "212-555-0100" });
    await expect(checkCoordinatorTransfer()).resolves.toEqual({ kind: "busy" });
  });

  it("says unreadable, never busy, when the queue cannot be read or the settings cannot", async () => {
    live.readQueue.mockResolvedValue({ ok: false, why: "timeout", detail: "no answer within 3000ms" });
    await expect(checkCoordinatorTransfer()).resolves.toEqual({ kind: "unreadable", why: "count" });
    live.readQueue.mockResolvedValue({ ok: true, free: 19 });
    live.readSettings.mockResolvedValue(null);
    await expect(checkCoordinatorTransfer()).resolves.toEqual({ kind: "unreadable", why: "settings" });
  });

  it("answers a thrown dependency as unreadable rather than throwing", async () => {
    live.readQueue.mockRejectedValue(new Error("boom"));
    await expect(checkCoordinatorTransfer()).resolves.toEqual({ kind: "unreadable", why: "count" });
  });

  it("answers a limiter refusal as its own refusal, and asks nothing", async () => {
    limiter.allowRequest.mockResolvedValue(false);
    await expect(checkCoordinatorTransfer()).resolves.toEqual({ kind: "refused", refusal: "rate-limited" });
    expect(live.readQueue).not.toHaveBeenCalled();
  });
});

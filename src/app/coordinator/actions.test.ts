import { describe, it, expect, vi, beforeEach } from "vitest";

// #4205: the coordinator page's server functions check the role THEMSELVES, rate limit
// per person, and answer typed results rather than throwing. The operations behind them
// are driven by the node suites (scripts/test-coordinator-*.ts); this pins the wiring:
// who gets in, what a refusal reads, and that a double press reaches the booking under
// one submission id. Every value is invented.

const auth = vi.hoisted(() => ({ coordinatorDeskUser: vi.fn() }));
const limiter = vi.hoisted(() => ({ allowRequest: vi.fn(async () => true) }));
const live = vi.hoisted(() => {
  const place = vi.fn();
  const readLead = vi.fn();
  return {
    place,
    readLead,
    lookupDeps: () => ({
      readLead,
      readLeadXbc: async () => "412",
      resolveBucketByCode: async () => ({ bucket: { code: "412", is_test: false, org_id: "org1" }, eventType: { duration_min: 30 } }),
      findActiveBookingsForPerson: async () => [],
      businessHours: async () => ({ zone: "America/New_York", rules: [], exceptions: [] }),
      horizonDays: async () => 10,
      now: () => Date.parse("2026-06-08T12:00:00.000Z"),
    }),
    placeholderCallsDeps: () => ({
      resolveBucketByCode: async () => ({ bucket: { code: "412", is_test: false, org_id: "org1" }, eventType: { duration_min: 30 } }),
      findPlaceholder: async () => ({ id: "marcia" }),
      countOverlapping: async () => {
        throw new Error("statement timeout");
      },
    }),
    placeCallDeps: () => ({
      findCustomer: async () => ({
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

import { countPlaceholderCalls, lookupCoordinatorCustomer, placeCoordinatorCall } from "./actions";

const COORDINATOR = { id: "coord-1", role: "coordinator" };
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
  auth.coordinatorDeskUser.mockResolvedValue(COORDINATOR);
  limiter.allowRequest.mockResolvedValue(true);
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
});

describe("countPlaceholderCalls (#4205)", () => {
  it("refuses somebody who may not use the page", async () => {
    auth.coordinatorDeskUser.mockResolvedValue(null);
    expect(await countPlaceholderCalls({ bucketCode: "412", startIso: "2026-06-09T17:00:00.000Z" })).toMatchObject({ ok: false, refusal: "not-authorized" });
  });

  it("says it could not count when the read fails, never zero", async () => {
    const out = await countPlaceholderCalls({ bucketCode: "412", startIso: "2026-06-09T17:00:00.000Z" });
    expect(out).toMatchObject({ ok: false, refusal: "internal" });
  });
});

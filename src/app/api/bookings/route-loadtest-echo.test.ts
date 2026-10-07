import { describe, it, expect, vi, beforeEach } from "vitest";

// #3325: under SLATE_LOADTEST, every answer the direct booking API gives carries the
// deployment's own time of answering, beside the address it saw.
//
// The load run's burst judges how fast the SLOT_TAKEN answers come after the last
// winner, and it judges that on ONE clock, the deployment's: four runners' clocks
// disagree with each other by more than the bound being judged. So the stamp has to
// be on every answer the burst can receive, the winner and the refusals alike, and a
// return added to the handler later must carry it by construction. That is why it is
// stamped where the handler is wrapped, and what these cases drive through the real
// route.
//
// The other direction, the flag OFF adding nothing, is asserted in route.test.ts,
// which runs this route without the flag.
//
// The flag is set in `vi.hoisted` because `loadtest-stub.ts` reads it at import
// time, which runs before any statement in this module body.
vi.hoisted(() => {
  process.env.SLATE_LOADTEST = "true";
});

const regalKey = vi.hoisted(() => ({ primary: vi.fn(() => "real-secret") }));
vi.mock("@/lib/env", () => ({
  bookingApiKeyFor: (caller: string, slot: string) =>
    caller === "regal" && slot === "primary" ? regalKey.primary() : "",
}));
vi.mock("@/lib/rate-limit", () => ({
  exactCeilingWithinLimit: vi.fn(async () => true),
  bookingApiWriteWithinLimit: vi.fn(async () => true),
  bookingApiReadWithinLimit: vi.fn(async () => true),
  bookingApiIpWithinLimit: vi.fn(async () => true),
  bearerFailureWithinLimit: vi.fn(async () => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const service = vi.hoisted(() => {
  class SlotUnavailableError extends Error {}
  class RaceLostRefusalError extends SlotUnavailableError {}
  class VerifyUnavailableError extends Error {}
  class NoEligibleAgentsError extends Error {}
  class UnknownBucketError extends Error {}
  class OutsideCallingWindowError extends Error {}
  class AttendeeEmailRefusedError extends Error {}
  return {
    bookViaApi: vi.fn(),
    previewBooking: vi.fn(),
    pageBookingFailure: vi.fn(async () => {}),
    listBookings: vi.fn(),
    getPersonBookingById: vi.fn(),
    lookupPersonBookings: vi.fn(),
    bookingDetailExtras: vi.fn(),
    SlotUnavailableError,
    RaceLostRefusalError,
    VerifyUnavailableError,
    NoEligibleAgentsError,
    UnknownBucketError,
    OutsideCallingWindowError,
    AttendeeEmailRefusedError,
  };
});
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome: vi.fn() }));

import { POST } from "./route";
import { ANSWERED_AT_HEADER, CONFIRM_LINE_HEADER, SEEN_IP_HEADER, readLoadtestEcho } from "@/lib/loadtest-echo";
import { ENTRY_AT_HEADER, INVOCATION_INDEX_HEADER, LOADTEST_LEG_HEADER } from "@/lib/booking/wait-marks";

const BODY = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
  externalId: "lead-abc-123",
};

function post(authorization: string) {
  return POST(
    new Request("http://localhost/api/bookings", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: JSON.stringify(BODY),
    }) as never,
  );
}

/** The stamp, read through the run's own reader, and the window it must sit in. */
async function stampedWithin(send: () => Promise<Response>) {
  const before = Date.now();
  const res = await send();
  const after = Date.now();
  return { res, at: readLoadtestEcho(res.headers).answeredAtMs, before, after };
}

beforeEach(() => {
  regalKey.primary.mockReturnValue("real-secret");
  service.bookViaApi.mockReset();
});

describe("POST /api/bookings under SLATE_LOADTEST", () => {
  it("stamps the winner's answer with the time it was built, beside the address", async () => {
    service.bookViaApi.mockResolvedValue({
      outcome: "created",
      booking: {
        id: "bk-1",
        external_id: "lead-abc-123",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:20:00.000Z",
        status: "confirmed",
        agent_name: "Agent A",
        agent_email: "a@x.com",
        routing_trace: { bucket_code: "411" },
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const { res, at, before, after } = await stampedWithin(() => post("Bearer real-secret"));
    expect(res.status).toBe(200);
    expect(at.state).toBe("read");
    if (at.state === "read") {
      expect(at.value).toBeGreaterThanOrEqual(before);
      expect(at.value).toBeLessThanOrEqual(after);
    }
    expect(res.headers.get(SEEN_IP_HEADER)).toBe("203.0.113.9");
  });

  it("stamps a SLOT_TAKEN answer, which is the one the burst's speed clause measures", async () => {
    service.bookViaApi.mockRejectedValue(new service.SlotUnavailableError("taken"));
    const { res, at, before, after } = await stampedWithin(() => post("Bearer real-secret"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("SLOT_TAKEN");
    expect(at.state).toBe("read");
    if (at.state === "read") {
      expect(at.value).toBeGreaterThanOrEqual(before);
      expect(at.value).toBeLessThanOrEqual(after);
    }
  });

  // #3325: the line the confirm took, recorded by the confirm path into the request's
  // facts, rides on the same answer, so the burst can require every confirm be shared.
  it("stamps which confirm line served the call, from what the confirm recorded", async () => {
    service.bookViaApi.mockImplementation(async (_input: unknown, facts?: { line?: unknown }) => {
      if (facts) facts.line = { line: "shared", reason: "ok", key: "ladder", lineMs: 41 };
      throw new service.SlotUnavailableError("taken");
    });
    const res = await post("Bearer real-secret");
    expect(res.status).toBe(409);
    const echo = readLoadtestEcho(res.headers);
    expect(res.headers.get(CONFIRM_LINE_HEADER)).toBe("shared");
    expect(echo.line).toMatchObject({ state: "read", value: "shared" });
    expect(echo.lineMs).toMatchObject({ state: "read", value: 41 });
  });

  // #3354: the wait before the confirm's profile is split by marks this request
  // carries. The route stamps its own two points before the booking path runs, and
  // takes the Worker's entry stamp and invocation count from the request.
  it("hands the booking path marks already stamped at the Worker entry, the handler and auth", async () => {
    let seen:
      | { marks?: { fields(): Record<string, number | string> }; isolateInvocationIndex?: number | null; lineTrace?: string; loadtestLeg?: string }
      | undefined;
    service.bookViaApi.mockImplementation(async (_input: unknown, facts?: typeof seen) => {
      seen = facts;
      throw new service.SlotUnavailableError("taken");
    });
    const entered = Date.now() - 50;
    const res = await POST(
      new Request("http://localhost/api/bookings", {
        method: "POST",
        headers: {
          authorization: "Bearer real-secret",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
          [ENTRY_AT_HEADER]: String(entered),
          [INVOCATION_INDEX_HEADER]: "0",
          [LOADTEST_LEG_HEADER]: "burst",
        },
        body: JSON.stringify(BODY),
      }) as never,
    );
    expect(res.status).toBe(409);
    const fields = seen?.marks?.fields() ?? {};
    expect(typeof fields.wait_route_ms).toBe("number");
    expect(typeof fields.wait_auth_ms).toBe("number");
    expect(String(fields.wait_missing)).toBe("line_start,line_turn,decided,profile");
    expect(seen?.isolateInvocationIndex).toBe(0);
    // #3354: a trace for this confirm's shared line calls, and the leg its driver named.
    expect(seen?.lineTrace).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen?.loadtestLeg).toBe("burst");
  });

  it("leaves the line unsaid when the confirm recorded none, so the run reads it as not said", async () => {
    const res = await post("Bearer wrong-secret");
    expect(res.headers.get(CONFIRM_LINE_HEADER)).toBeNull();
  });

  it("stamps a refusal made before the booking was even read", async () => {
    // A rejected key never reaches the confirm, and still answers through the same
    // wrapper, so a burst request refused this way is measured rather than unstamped.
    const { res, at } = await stampedWithin(() => post("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(res.headers.get(ANSWERED_AT_HEADER)).not.toBeNull();
    expect(at.state).toBe("read");
  });
});

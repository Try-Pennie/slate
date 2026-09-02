import { describe, it, expect, vi, beforeEach } from "vitest";

// The WIRING for #1429: the shared authorizer reports which refusal it made, and
// records the ones the refusal catalog says are counted.
//
// The decision itself is pure and covered by scripts/test-api-auth-refusal.ts.
// What that suite cannot see is whether the decision is actually CONNECTED: a
// counting rule nothing calls is a rule that never fires, and it would look
// identical in review (L3, built is not wired). So this drives the real authorizer
// with the recorder mocked, and asserts what reached it.

const env = vi.hoisted(() => ({
  bookingApiKeyPrimary: vi.fn(() => "goodsecret"),
  bookingApiKeySecondary: vi.fn(() => ""),
}));
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async (_caller: unknown, _rules: unknown) => true),
  bookingApiWriteWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiReadWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiIpWithinLimit: vi.fn(async (_ip: string) => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const tally = vi.hoisted(() => ({ recordApiOutcome: vi.fn() }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/monitor/record-api-outcome", () => tally);

import { authorizeBookingApi } from "./route-auth";
import { DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "@/lib/rate-limit-core";

function req(authorization?: string) {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("https://slate.trypennie.app/api/bookings", {
    method: "POST",
    headers,
  }) as unknown as Parameters<typeof authorizeBookingApi>[0];
}

/** The error codes handed to the tally as `error` outcomes. */
function recordedCodes() {
  return tally.recordApiOutcome.mock.calls
    .filter((c) => c[0] === "error")
    .map((c) => c[2] as string);
}

/** Every outcome NAME recorded, so a test can assert what reached the failure
 *  share separately from what reached the private counters (#1442, #1450). */
function recordedOutcomes() {
  return tally.recordApiOutcome.mock.calls.map((c) => c[0] as string);
}

describe("authorizeBookingApi refusal reasons (#1429)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.bookingApiKeyPrimary.mockReturnValue("goodsecret");
    env.bookingApiKeySecondary.mockReturnValue("");
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  it("names a rotated key as bad_credential and counts it, so a locked out integration moves the failure share", async () => {
    const out = await authorizeBookingApi(req("Bearer stalekey"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("bad_credential");
    expect(out.response.status).toBe(401);
    expect(recordedCodes()).toEqual(["API_KEY_REJECTED"]);
  });

  it("treats a missing Authorization header as the same credential failure", async () => {
    const out = await authorizeBookingApi(req());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("bad_credential");
    expect(recordedCodes()).toEqual(["API_KEY_REJECTED"]);
  });

  it("names an endpoint with no configured key as not_configured, under its own code", async () => {
    env.bookingApiKeyPrimary.mockReturnValue("");
    env.bookingApiKeySecondary.mockReturnValue("");
    const out = await authorizeBookingApi(req("Bearer anything"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("not_configured");
    expect(out.response.status).toBe(503);
    // A DIFFERENT code, because the repair is different: a secret nobody set is a
    // deploy gap, not a caller holding a stale key.
    expect(recordedCodes()).toEqual(["API_NOT_CONFIGURED"]);
    // And into its own counter, which pages on the FIRST one: only our own deploy
    // can produce this, so there is nothing benign it could be.
    expect(recordedOutcomes()).toContain("refused_not_configured");
  });

  // The half that keeps the counting honest. A throttle is one caller going faster
  // than its budget, and recording it as a FAILURE would put that caller's volume
  // in the denominator the failure share is measured against, diluting the share
  // a real outage has to move.
  //
  // #1442 keeps that exactly as it was and adds a second counter beside it, under
  // a name outside OUTCOME_ORDER, so a SUSTAINED trip can be measured against the
  // ceiling without ever entering the share. So the assertion is no longer "it
  // records nothing", it is the sharper one: nothing reached the share, and the
  // private counter got the trip.
  it("names a per-key ceiling trip as throttled_key and keeps it out of the failure share", async () => {
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(false);
    const out = await authorizeBookingApi(req("Bearer goodsecret"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("throttled_key");
    expect(out.response.status).toBe(429);
    expect(recordedCodes()).toEqual([]);
    expect(recordedOutcomes()).toEqual(["refused_ceiling_key"]);
  });

  it("names the per-IP backstop as throttled_ip, and counts it apart from the key ceiling", async () => {
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(false);
    const out = await authorizeBookingApi(req("Bearer goodsecret"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("throttled_ip");
    expect(recordedCodes()).toEqual([]);
    // Apart, not summed: the two bound different things and their repairs are
    // different numbers, so a page that named the wrong one would send somebody
    // to change a limit that was never the problem.
    expect(recordedOutcomes()).toEqual(["refused_ceiling_ip"]);
  });

  // #1450. The endpoint is public, so anything crawling the internet produces a
  // 401 continuously. A credential SIGNAL built on that would page on background
  // noise, so the private counter takes only a bearer that was PRESENT and wrong.
  // The failure-share code is unchanged in both cases, which is what keeps the
  // existing window seeing a busy lockout.
  it("counts a present but wrong bearer as a credential refusal", async () => {
    const out = await authorizeBookingApi(req("Bearer stalekey"));
    expect(out.ok).toBe(false);
    expect(recordedCodes()).toEqual(["API_KEY_REJECTED"]);
    expect(recordedOutcomes()).toContain("refused_key_wrong");
  });

  it("does NOT count a request that carried no credential at all", async () => {
    const out = await authorizeBookingApi(req());
    expect(out.ok).toBe(false);
    // Still counted into the share under the same code, because a caller sending
    // nothing is still a refused attempt.
    expect(recordedCodes()).toEqual(["API_KEY_REJECTED"]);
    // But not into the credential signal, which exists to notice a locked out
    // integration rather than a passing crawler.
    expect(recordedOutcomes()).not.toContain("refused_key_wrong");
  });

  it("counts nothing on the read path, so bookable-check traffic stays out of the booking failure share", async () => {
    const out = await authorizeBookingApi(
      req("Bearer stalekey"),
      undefined,
      DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
      true,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The reason is still reported: only the COUNTING differs by surface.
    expect(out.reason).toBe("bad_credential");
    expect(tally.recordApiOutcome).not.toHaveBeenCalled();
  });

  it("records nothing at all when the key is good and nothing is throttled", async () => {
    const out = await authorizeBookingApi(req("Bearer goodsecret"));
    expect(out.ok).toBe(true);
    expect(tally.recordApiOutcome).not.toHaveBeenCalled();
  });

  it("records the refusal exactly once, so a retry of the same call cannot double count", async () => {
    await authorizeBookingApi(req("Bearer stalekey"));
    expect(recordedCodes()).toHaveLength(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The pure half, deliberately NOT mocked: the route's key shape is what these assert on.
import { rateLimitKey, type CallerKey } from "@/lib/rate-limit-core";

// Error mapping for the public embed booking route. Focus of #358: an
// empty/misconfigured bucket now throws NoEligibleAgentsError (was
// SlotUnavailableError) — the consumer must still see "no times" (409), not a
// 500. createBooking + rate-limit are mocked so this exercises only the route's
// validation + error mapping.

const service = vi.hoisted(() => {
  class SlotUnavailableError extends Error {}
  // #2838: refused after a lost overlap race, a SlotUnavailableError underneath.
  class RaceLostRefusalError extends SlotUnavailableError {
    lostRaces: number;
    boundHit: boolean;
    constructor(lostRaces: number, boundHit: boolean) {
      super("taken");
      this.lostRaces = lostRaces;
      this.boundHit = boundHit;
    }
  }
  class VerifyUnavailableError extends Error {}
  // #3442: the retryable timeout after a lost race with too little budget to walk down.
  class LostRaceOutOfTimeError extends VerifyUnavailableError {}
  class NoEligibleAgentsError extends Error {}
  // #1337: the route declines rather than creating when the person already has
  // an active call. The class must exist on the mock for the instanceof branch.
  class ExistingCallError extends Error {
    existingCall: unknown;
    constructor(existingCall: unknown) {
      super("already has a call");
      this.existingCall = existingCall;
    }
  }
  // #1641: the one-call-per-person check could not be MADE (its bookings read
  // failed). The route refuses with a retriable 503 rather than letting the read
  // failure read as "this lead has no call" and creating a duplicate.
  class ExistingCallCheckUnavailableError extends Error {}
  // #2667: a bucket code that resolves to nothing, or to a hidden test bucket.
  // The route must map it to a client refusal rather than the internal error path.
  class UnknownBucketError extends Error {}
  // #2310: a start outside the lead's calling window in the zone they sent.
  class OutsideCallingWindowError extends Error {
    zone: string;
    constructor(zone: string) {
      super("outside the calling window");
      this.zone = zone;
    }
  }
  // #3359: Google refused the lead's address on the create.
  class AttendeeEmailRefusedError extends Error {
    readonly field = "email" as const;
    constructor(cause: unknown) {
      super("Enter a valid email address");
      this.cause = cause;
    }
  }
  return {
    UnknownBucketError,
    OutsideCallingWindowError,
    AttendeeEmailRefusedError,
    createBooking: vi.fn(),
    bookingDetailExtras: vi.fn((_booking: unknown) => ({
      contact: { name: "Kris", email: "k@x.com", phone: "+12035615295" },
      calendarLinks: { google: "g", outlook: "o", office365: "m", ics: "i" },
    })),
    // Mirrors DuplicateWarning in src/lib/booking/orchestration.ts: a weak
    // one-signal identity match arrives as the bare `disclose: false` (#1340).
    findDuplicateBookingWarning: vi.fn(
      async (): Promise<
        | { disclose: true; startsAt: string; manageUrl: string }
        | { disclose: false }
        | null
      > => null,
    ),
    SlotUnavailableError,
    RaceLostRefusalError,
    VerifyUnavailableError,
    LostRaceOutOfTimeError,
    NoEligibleAgentsError,
    ExistingCallError,
    ExistingCallCheckUnavailableError,
    pageBookingFailure: vi.fn(async (_err: unknown) => {}),
  };
});
const rateLimit = vi.hoisted(() => ({
  allowRequest: vi.fn(async (_caller: unknown, _rules?: unknown) => true),
  refundRequest: vi.fn(async (_caller: unknown, _rules?: unknown) => {}),
  bookingWithinLimit: vi.fn(async () => true),
  // #3364: the retry credit. No credit by default, so every older case that blocks at the
  // edge still sees the 429 it always did.
  bookingRetryCredit: vi.fn(async (_ip: string): Promise<string> => "no-credit"),
  grantBookingRetryCredit: vi.fn(async (_ip: string) => {}),
  clientIp: () => "203.0.113.1",
  BOOKING_HOURLY_RATE_RULES: [{ prefix: "book:h", windowSeconds: 3600, max: 10 }],
  BOOKING_CONTACT_HOURLY_RATE_RULES: [{ prefix: "book:contact:h", windowSeconds: 3600, max: 5 }],
  // Real normalizer (pure): the route relies on its exact key shape, so mocking
  // it would let a key-shape regression pass. Two discriminated keys per contact.
  contactRateKeys: (a: { email?: string | null; phone?: string | null }) => {
    const keys: string[] = [];
    const email = (a.email ?? "").trim().toLowerCase();
    if (email) keys.push(`email:${email}`);
    const phone = (a.phone ?? "").replace(/\D/g, "");
    if (phone) keys.push(`phone:${phone}`);
    return keys;
  },
}));

const recordApiOutcome = vi.hoisted(() => vi.fn());
const bookingSettings = vi.hoisted(() => ({
  // Open by default, so every pre-existing test in this file still exercises the
  // ordinary path rather than silently testing a paused booker.
  readPublicBookingPaused: vi.fn(async (): Promise<boolean | null> => false),
}));
vi.mock("@/lib/booking/service", () => service);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/monitor/record-api-outcome", () => ({ recordApiOutcome }));

// #2297: the kill switch's DB reader is the seam. The pure judge
// (`judgePublicBooking`) is deliberately NOT mocked, so these drive the real
// decision, including the direction it fails in.
vi.mock("@/lib/booking/settings", () => bookingSettings);

// #2073: an agent's own booking link. The token resolves through this seam; the
// judge behind it is driven by scripts/test-agent-link.ts.
const agentLinkStore = vi.hoisted(() => ({ resolveAgentLink: vi.fn() }));
vi.mock("@/lib/agent-link/store", () => agentLinkStore);

// #3366: the stored row check after a refusal. Its decision and read are pinned by
// scripts/test-refusal-stored-offer.ts; here it is a seam, so the route is proven to
// hand it every refusal without a test ever reaching the real table.
// #3796: it is handed the failure path as `answer`, and holds the answer for the
// refresh a stale row asks for; by default the seam answers at once.
const storedOffer = vi.hoisted(() => ({
  answerAfterRefusalRefresh: vi.fn(async (_err: unknown, answer: () => Promise<unknown>) => answer()),
}));
vi.mock("@/lib/booking/refusal-stored-offer-live", () => storedOffer);

// #3460: the confirm's early reads. A seam here: what they do is driven by
// confirm-line-live.test.ts and scripts/test-pool-grouping.ts; this pins WHEN the route
// starts them.
const prelude = vi.hoisted(() => ({ startConfirmPrelude: vi.fn() }));
vi.mock("@/lib/booking/confirm-line-live", () => prelude);

// #4391: a program lead's confirm. Its decisions are pinned by
// scripts/test-program-lead-booking.ts; here it is a seam, so the route is proven to
// send a verified program lead there, and nobody else.
const programLeadBooking = vi.hoisted(() => ({ bookProgramLeadLive: vi.fn() }));
vi.mock("@/lib/booking/program-lead-booking-service", () => programLeadBooking);

import { POST } from "./route";
import { DeadlineExceededError } from "@/lib/fetch-within-deadline";
import { ROUTE_CHECK_STAGES } from "@/lib/booking/confirm-profile";
import { deadlineWithinBudget } from "@/lib/call-budget";
import { BOOKING_CONFIRM_BUDGET_MS } from "@/lib/booking/confirm-budget";
import { PUBLIC_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { AGENT_LINK_COPY, BOOKING_ERROR_COPY, TEST_ACCESS_COPY } from "@/lib/booking/booker-copy";
import { PARTNER_KEYS } from "@/lib/booking/partner-keys";
import { LeadCodeUnavailableError } from "@/lib/routing/lead-code";
import { TEST_PASS_HEADER, TEST_PASS_REFUSAL_CODES } from "@/lib/embed/test-pass-header";
import { TEST_PASS_TTL_MS, mintTestPass } from "@/lib/embed/test-pass";
import { HIDDEN_TEST_BUCKET_CODES } from "@/lib/embed/public-test-bucket";
import { REFERRER_ORIGIN_MAX_CHARS } from "@/lib/embed/referrer-origin";
import { INVALID_EMAIL } from "@/lib/attendee";
import { OUTCOME_ORDER, PROGRAM_PLACEHOLDER_OUTCOME } from "@/lib/monitor/booking-api-outcome";
import { mintProgramLeadToken } from "@/lib/booking/program-lead-token";
import { PLACEHOLDER_DAY_FULL_CODE, PlaceholderDayFullError } from "@/lib/booking/program-lead-booking";

const PUBLIC_TEST = PUBLIC_TEST_BUCKET_CODES[0];
// #2666: the public test bucket is booked only with the pass `/book` handed an
// approved page. The secret it is signed with, for every test in this file.
const SECRET = "b".repeat(64);
vi.stubEnv("EMBED_TEST_PASS_SECRET", SECRET);
const goodPass = () => mintTestPass({ code: PUBLIC_TEST, secret: SECRET, nowMs: Date.now() }).value;

const VALID_BODY = {
  bucketCode: "411",
  start: "2026-07-01T15:00:00.000Z",
  timezone: "America/New_York",
  attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
};

function post(body: unknown, pass?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (pass) headers.set(TEST_PASS_HEADER, pass);
  return POST(
    new Request("http://localhost/booking", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as never,
  );
}

describe("POST /booking (embed) error mapping", () => {
  beforeEach(() => {
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.refundRequest.mockClear();
    service.createBooking.mockReset();
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
  });

  it("returns 429 (without touching the DB or createBooking) when the per-minute edge limiter blocks", async () => {
    rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    // Edge block short-circuits before the hourly DB cap and the booking itself.
    expect(rateLimit.allowRequest).not.toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
    // #3460: and before the confirm's early reads, which a flood must not buy (L498).
    expect(prelude.startConfirmPrelude).not.toHaveBeenCalled();
  });

  // #3460, #3355 item 1: the booker has no bearer key, so the confirm's early reads (the
  // shared line switch and the pool grouping snapshot) start once its address has passed
  // the edge limiter, and run during the pause flag, the caps and the body read.
  it("#3460 starts the confirm's early reads once the edge limiter has passed, with this request's facts", async () => {
    prelude.startConfirmPrelude.mockClear();
    service.createBooking.mockResolvedValueOnce({
      booking: { id: "bk-p", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(prelude.startConfirmPrelude).toHaveBeenCalledTimes(1);
    const limiter = rateLimit.bookingWithinLimit.mock.invocationCallOrder.at(-1)!;
    const started = prelude.startConfirmPrelude.mock.invocationCallOrder[0]!;
    const paused = bookingSettings.readPublicBookingPaused.mock.invocationCallOrder.at(-1)!;
    expect(started).toBeGreaterThan(limiter);
    expect(started).toBeLessThan(paused);
    // The same facts the service is handed, so the confirm awaits the fetch it started.
    expect(prelude.startConfirmPrelude.mock.calls[0]![0]).toBe(service.createBooking.mock.calls.at(-1)![1]);
  });

  // #3364: the 2026-10-06 dead end. A lead refused for a taken time three times was then
  // refused at the edge minute window when they picked the next time along.
  describe("a retry after a taken time (#3364)", () => {
    beforeEach(() => {
      rateLimit.bookingRetryCredit.mockReset();
      rateLimit.bookingRetryCredit.mockResolvedValue("no-credit");
      rateLimit.grantBookingRetryCredit.mockClear();
    });

    it("lets a confirm the edge window refused through when the address has an earned credit", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
      rateLimit.bookingRetryCredit.mockResolvedValueOnce("allowed");
      service.createBooking.mockResolvedValueOnce({
        booking: { id: "bk-r", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
        manageUrl: "https://slate.test/booking/manage/tok",
      });
      const res = await post(VALID_BODY);
      expect(res.status).toBe(200);
      expect(rateLimit.bookingRetryCredit).toHaveBeenCalledWith("203.0.113.1");
      // Still under every other cap: the credit replaces the minute window only.
      expect(rateLimit.allowRequest).toHaveBeenCalled();
      const line = info.mock.calls.map(String).find((l) => l.includes('msg="retry after a taken time"'));
      expect(line).toContain("tag=booking-rate-limit");
      info.mockRestore();
    });

    it("keeps the 429, with the builder's wait-a-minute sentence, when there is no credit to spend", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
      rateLimit.bookingRetryCredit.mockResolvedValueOnce("spent");
      const res = await post(VALID_BODY);
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe(BOOKING_ERROR_COPY.tooManyTriesJustNow);
      expect(rateLimit.allowRequest).not.toHaveBeenCalled();
      expect(service.createBooking).not.toHaveBeenCalled();
      // The throttle line says why the credit did not carry it, so a cluster can be read.
      const line = info.mock.calls.map(String).find((l) => l.includes('msg="throttled"'));
      expect(line).toContain('retry="spent"');
      info.mockRestore();
    });

    it("never consults the credit when the edge window allows the confirm", async () => {
      service.createBooking.mockRejectedValueOnce(new service.NoEligibleAgentsError("none"));
      await post(VALID_BODY);
      expect(rateLimit.bookingRetryCredit).not.toHaveBeenCalled();
    });

    it("earns a credit for the address when the time was taken, a lost race included", async () => {
      service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
      expect((await post(VALID_BODY)).status).toBe(409);
      expect(rateLimit.grantBookingRetryCredit).toHaveBeenCalledWith("203.0.113.1");
      service.createBooking.mockRejectedValueOnce(new service.RaceLostRefusalError(2, false));
      expect((await post(VALID_BODY)).status).toBe(409);
      expect(rateLimit.grantBookingRetryCredit).toHaveBeenCalledTimes(2);
    });

    it("earns nothing for any refusal that is not a taken time", async () => {
      for (const err of [
        new service.NoEligibleAgentsError("none"),
        new service.ExistingCallError({ disclose: false }),
        new service.VerifyUnavailableError("outage"),
        new service.OutsideCallingWindowError("Pacific/Honolulu"),
        new service.UnknownBucketError("nope"),
      ]) {
        service.createBooking.mockRejectedValueOnce(err);
        await post(VALID_BODY);
      }
      expect(rateLimit.grantBookingRetryCredit).not.toHaveBeenCalled();
    });

    it("keeps the longer wait sentence for the hourly and contact caps", async () => {
      rateLimit.allowRequest.mockResolvedValueOnce(false);
      const res = await post(VALID_BODY);
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe(BOOKING_ERROR_COPY.tooManyTries);
    });
  });

  it("returns 429 when the hourly DB cap blocks (checked after the edge limiter)", async () => {
    rateLimit.allowRequest.mockResolvedValueOnce(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    expect(rateLimit.bookingWithinLimit).toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  // #962: the edge per-minute window has no refund path, so a transient server
  // outage (503) still consumes one of the lead's 3/min. A block is normally a
  // spammy visitor (not an incident, so no alert), but every booking 429 is logged
  // with its scope + ip at a queryable tag/level so a too-tight limit surfaces: a
  // cluster of edge-minute 429s from many distinct IPs is the signal.
  it("logs a queryable throttle line naming the edge-minute scope + ip (#962)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);

    const res = await post(VALID_BODY);

    expect(res.status).toBe(429);
    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-rate-limit"));
    expect(line).toBeDefined();
    expect(line).toContain('scope="edge-minute"');
    expect(line).toContain('ip="203.0.113.1"');
    info.mockRestore();
  });

  it("logs the throttle line with the hourly scope when the DB cap blocks (#962)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    rateLimit.allowRequest.mockResolvedValueOnce(false);

    await post(VALID_BODY);

    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-rate-limit"));
    expect(line).toContain('scope="hourly"');
    info.mockRestore();
  });

  it("refunds the hourly IP cap AND both per-contact caps on a verify outage, never the edge burst window (#1033)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.VerifyUnavailableError("outage"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    // 1 IP-cap refund + 1 per email + 1 per phone: a server outage must not burn
    // the lead's contact budget any more than it burns their IP budget.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
  });

  // #3102: the whole request runs under one budget, so a dozen slow calls cannot
  // add up past the booker's 20 second abort; and the refunds a timed out confirm
  // still owes the lead run under their own small allowance, not the spent budget.
  it("runs the booking under the confirm budget and the refunds under the cleanup allowance (#3102)", async () => {
    let bookingWait: number | null = null;
    const refundLabels: string[] = [];
    service.createBooking.mockImplementationOnce(async () => {
      bookingWait = deadlineWithinBudget(60_000, "probe").waitMs;
      throw new service.VerifyUnavailableError("outage");
    });
    rateLimit.refundRequest.mockImplementation(async () => {
      refundLabels.push(deadlineWithinBudget(60_000, "probe").reportAs.budget?.label ?? "none");
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(bookingWait).not.toBeNull();
    expect(bookingWait!).toBeLessThanOrEqual(BOOKING_CONFIRM_BUDGET_MS);
    expect(refundLabels).toEqual(["the booking cleanup", "the booking cleanup", "the booking cleanup"]);
    rateLimit.refundRequest.mockReset();
  });

  // The rest of the failure path, the outcome it records included, runs under the
  // same allowance: after a timeout the confirm budget is spent, and work left
  // under it would fail at once and lose the record of the failure.
  it("records the failure outcome under the cleanup allowance, not the spent confirm budget (#3102)", async () => {
    const labels: (string | undefined)[] = [];
    recordApiOutcome.mockImplementation(() => {
      labels.push(deadlineWithinBudget(60_000, "probe").reportAs.budget?.label);
    });
    service.createBooking.mockRejectedValueOnce(new Error("boom"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels)).toEqual(new Set(["the booking cleanup"]));
    recordApiOutcome.mockReset();
  });

  // #3102: the paused-booker read happens BEFORE the booking's try, under the
  // confirm budget, so a deadline there used to escape as an unhandled 500. It is
  // the same outage the confirm answers with its retryable 503.
  it("answers a deadline from a read before the try with the retryable 503 (#3102)", async () => {
    bookingSettings.readPublicBookingPaused.mockRejectedValueOnce(
      new DeadlineExceededError("supabase", 4000, { label: "the booking confirm", totalMs: 12_000 }),
    );
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toBe("We hit a temporary issue confirming this time. Please try again in a moment.");
    expect(service.createBooking).not.toHaveBeenCalled();
    expect(service.pageBookingFailure).toHaveBeenCalledOnce();
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "",
      "verify_unavailable",
      expect.objectContaining({ by: "unidentifiable" }),
    );
    service.pageBookingFailure.mockClear();
  });

  it("answers a deadline in the advisor link read the same way, not as a 500 (#3102)", async () => {
    agentLinkStore.resolveAgentLink.mockRejectedValueOnce(new DeadlineExceededError("supabase", 15000));
    rateLimit.refundRequest.mockClear();
    recordApiOutcome.mockClear();
    const { bucketCode: _code, ...noBucket } = VALID_BODY;
    const res = await post({ ...noBucket, agentLink: "rdaboub", prefill: {} });
    expect(res.status).toBe(503);
    // Every cap this request spent before the read is handed back: the IP cap and
    // both contact caps. The outage is ours, so the lead must not pay for it.
    const refunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(refunded.sort()).toEqual(["203.0.113.1", "email:dana@example.com", "phone:2155550100"].sort());
    // An advisor link confirm is not a routed booking, so it stays out of the
    // routed tally, on this path as on every other.
    expect(recordApiOutcome).not.toHaveBeenCalled();
    service.pageBookingFailure.mockClear();
  });

  it("hands back only the caps a request had spent when a later cap read times out (#3102)", async () => {
    rateLimit.refundRequest.mockClear();
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest
      .mockResolvedValueOnce(true) // the IP hourly cap
      .mockResolvedValueOnce(true) // the email cap
      .mockRejectedValueOnce(new DeadlineExceededError("supabase", 4000, { label: "the booking confirm", totalMs: 12_000 }));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    const refunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(refunded.sort()).toEqual(["203.0.113.1", "email:dana@example.com"].sort());
    // Counted against the bucket the request named, now that it is known.
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "411",
      "verify_unavailable",
      expect.objectContaining({ by: "bucket", code: "411" }),
    );
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    service.pageBookingFailure.mockClear();
  });

  // The duplicate warning is read AFTER the booking exists. A deadline there must
  // not turn a booking that was made into a failure: the lead gets the call they
  // booked, with no warning, rather than a 500 or an outage they would retry into.
  it("keeps a created booking's success when the duplicate warning read times out (#3102)", async () => {
    service.createBooking.mockResolvedValueOnce({
      booking: {
        id: "b1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        agent_name: "Jane",
        prefill: null,
        salesforce_id: null,
        external_id: null,
      },
      manageUrl: "https://x.test/m/t",
      newlyInserted: true,
    } as never);
    service.findDuplicateBookingWarning.mockRejectedValueOnce(
      new DeadlineExceededError("supabase", 2000, { label: "the booking confirm", totalMs: 12_000 }),
    );
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; duplicateWarning?: unknown };
    expect(body.id).toBe("b1");
    expect(body.duplicateWarning).toBeNull();
    expect(service.pageBookingFailure).not.toHaveBeenCalled();
  });

  it("answers a retriable 503 when the existing-call check could not be made (#1641)", async () => {
    service.createBooking.mockRejectedValueOnce(
      new service.ExistingCallCheckUnavailableError(
        "We hit a temporary issue booking this time. Please try again in a moment.",
      ),
    );
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    // One short human sentence, and nothing about the read that failed: the
    // table name, the driver message and the stack belong in the log only.
    expect(body.error).toBe(
      "We hit a temporary issue booking this time. Please try again in a moment.",
    );
    expect(JSON.stringify(body)).not.toMatch(/bookings|select|supabase|Error:/i);
    // A fault on our side must not burn the lead's budget, so they can retry at
    // once. Same refund set as the other transient 503.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
    // Counted as an error under its own code, so the booking-failure-rate window
    // (#1313) names it rather than a run of these hiding inside "internal".
    expect(recordApiOutcome).toHaveBeenCalledWith(
      "error",
      "411",
      "existing_call_unavailable",
      { by: "bucket", code: "411", host: { prefill: null, referrer_origin: null } },
    );
  });

  // #2638: the lead's XBC could not be read from Salesforce, so the service
  // refused rather than routing them to the catch-all. A retriable 503, refunded,
  // counted under its own code, and never a booking in the Low pool.
  it("answers 503 and refunds when the lead's routing code cannot be read from Salesforce (#2638)", async () => {
    service.createBooking.mockRejectedValueOnce(
      new LeadCodeUnavailableError(new Error("SF query failed: 503 unavailable")),
    );
    const res = await post({ ...VALID_BODY, bucketCode: "100", requestedCode: "", salesforceId: "00Q5e00000AbCdEEAU" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("We hit a temporary issue booking this time. Please try again in a moment.");
    expect(JSON.stringify(body)).not.toMatch(/SF query|salesforce|Error:/i);
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    expect(recordApiOutcome).toHaveBeenCalledWith("error", "100", "lead_code_unavailable", {
      by: "bucket",
      code: "100",
      host: { prefill: null, referrer_origin: null },
    });
  });

  it("does not call a booking a test one when the link carried no routable code (#2638)", async () => {
    await post({ ...VALID_BODY, bucketCode: PUBLIC_TEST, requestedCode: "" }, goodPass());
    expect(service.createBooking).toHaveBeenCalledWith(expect.objectContaining({ allowTestBuckets: false }), expect.anything());
    await post({ ...VALID_BODY, bucketCode: PUBLIC_TEST, requestedCode: PUBLIC_TEST }, goodPass());
    expect(service.createBooking).toHaveBeenLastCalledWith(expect.objectContaining({ allowTestBuckets: true }), expect.anything());
  });

  // #3221: what the lead waited, measurable outside a load test. One line per
  // confirm, under the route's own tag, carrying the wait and the status only.
  it("logs one line per confirm with the time the lead waited for the answer (#3221)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    const lines = info.mock.calls.map(String).filter((l) => l.includes('msg="confirm answered"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("tag=booking ");
    expect(lines[0]).toMatch(/response_ms=\d+/);
    expect(lines[0]).toContain("status=409");
    expect(lines[0]).not.toContain("dana");
    expect(lines[0]).not.toContain("2155550100");
  });

  // #3300: a confirm that ran out of time says where it went, and whose it was. The
  // service is handed the request's own profile, charges a stage to it, and runs
  // out of budget; the line carries the profile, the timeout and the lead's id.
  it("logs where a timed out confirm's time went, with the lead's Salesforce id (#3300)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.createBooking.mockImplementationOnce((async (
      _input: unknown,
      facts?: { profile?: { time: (s: string, fn: () => Promise<unknown>) => Promise<unknown> } },
    ) => {
      await facts?.profile?.time("assign-and-verify", async () => {});
      // As the service throws it: the retryable outage, carrying the deadline as its cause.
      throw Object.assign(new service.VerifyUnavailableError("try again"), {
        cause: new DeadlineExceededError("supabase", 0, { label: "the booking confirm", totalMs: 12_000 }),
      });
    }) as never);
    const res = await post({ ...VALID_BODY, salesforceId: "00QUi00000zhEUPMA2" });
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("timed_out=true");
    // The 15 character key, which both spellings of one lead share.
    expect(lines[0]).toContain('lead_id="00QUi00000zhEUP"');
    expect(lines[0]).toMatch(/stages_run=\d+/);
    expect(lines[0]).toMatch(/stages="[^"]*assign-and-verify:\d+\/1/);
    expect(lines[0]).toMatch(/stages="[^"]*route-checks:\d+\/1/);
    // The confirm budget reported its calls to this profile (none here: the service is a fake).
    expect(lines[0]).toContain("calls_made=0");
    expect(lines[0]).toMatch(/unattributed_ms=\d+/);
    // Never anything else about the lead.
    expect(lines[0]).not.toMatch(/dana|2155550100/i);
  });

  // The other half (L1): the same route with an ordinary quick answer keeps its line short.
  it("keeps an ordinary fast confirm's line to the wait and the status (#3300)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.createBooking.mockResolvedValueOnce({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", agent_name: "Jane", prefill: null, salesforce_id: null, external_id: null },
      manageUrl: "https://x.test/m/t",
      newlyInserted: true,
    });
    const res = await post({ ...VALID_BODY, salesforceId: "00QUi00000zhEUPMA2" });
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(200);
    expect(lines[0]).not.toContain("stages_run");
    expect(lines[0]).not.toContain("lead_id");
    expect(lines[0]).not.toContain("timed_out");
  });

  // #3366, #3796: a refused confirm is answered THROUGH the stored row check, which
  // holds the 409 for the refresh a stale row asks for, so the booker's reload that
  // follows reads the refreshed row. The 409 itself is exactly what it was.
  it("answers a refusal only once the stored row check lets it go, still 409 (#3366, #3796)", async () => {
    const err = new service.SlotUnavailableError("taken");
    service.createBooking.mockRejectedValueOnce(err);
    let release: (() => void) | undefined;
    storedOffer.answerAfterRefusalRefresh.mockImplementationOnce(async (_err, answer) => {
      const res = await answer();
      await new Promise<void>((r) => { release = r; });
      return res;
    });
    let answered = false;
    const pending = post(VALID_BODY).then((r) => { answered = true; return r; });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    release!();
    const res = await pending;
    expect(res.status).toBe(409);
    expect(storedOffer.answerAfterRefusalRefresh).toHaveBeenCalledWith(err, expect.any(Function));
  });

  it("refunds the IP cap AND both contact keys on a taken-slot 409, which isn't the lead's fault (#1089)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    // Same refund set as the 503 verify-outage path: a slot grabbed by someone
    // else a moment earlier must not burn a real lead's IP or contact budget.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    const keysRefunded = rateLimit.refundRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(keysRefunded).toContain("203.0.113.1");
    expect(keysRefunded).toContain("email:dana@example.com");
    expect(keysRefunded).toContain("phone:2155550100");
  });

  it("refuses a start outside the lead's calling window with its own code and the builder's sentence (#2310)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.OutsideCallingWindowError("Pacific/Honolulu"));
    const res = await post({ ...VALID_BODY, timezone: "Pacific/Honolulu" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("OUTSIDE_CALLING_WINDOW");
    expect(body.error).toBe(BOOKING_ERROR_COPY.outsideCallingHours);
    // Not the lead's fault in the budget sense: another time will book, so the
    // attempt is handed back like a lost race.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
    expect(recordApiOutcome).toHaveBeenCalledWith("error", "411", "outside_calling_window", {
      by: "bucket",
      code: "411",
      host: { prefill: null, referrer_origin: null },
    });
  });

  // #3359: on 2026-10-06 this answered 500 internal five times, and the lead never
  // learned the email was the problem. It is a refusal about one field.
  it("answers Google refusing the attendee email as a 400 against the email field, never internal (#3359)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.AttendeeEmailRefusedError(new Error("google 400")));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors).toEqual({ email: INVALID_EMAIL });
    expect(body.error).toBe(BOOKING_ERROR_COPY.checkContactDetails);
    expect(recordApiOutcome).toHaveBeenCalledWith("error", "411", "attendee_email_refused", {
      by: "bucket",
      code: "411",
      host: { prefill: null, referrer_origin: null },
    });
    expect(recordApiOutcome).not.toHaveBeenCalledWith("error", "411", "internal", expect.anything());
    // Our check arriving late is not an attempt the lead should pay for: the
    // corrected retry must not meet a rate limit.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(3);
  });

  it("passes the zone the booker sent through to the booking (#2310)", async () => {
    service.createBooking.mockResolvedValueOnce({
      booking: { id: "b1", starts_at: VALID_BODY.start, ends_at: VALID_BODY.start, prefill: {} },
      manageUrl: "u",
    });
    await post({ ...VALID_BODY, timezone: "Pacific/Honolulu" });
    expect(service.createBooking.mock.calls[0][0].timezone).toBe("Pacific/Honolulu");
  });

  // #2549: the first name the lead answered in its own field reaches the booking,
  // so it can be stored rather than split back out of the joined name.
  it("passes the answered first name through to the booking, trimmed (#2549)", async () => {
    service.createBooking.mockResolvedValueOnce({
      booking: { id: "b1", starts_at: VALID_BODY.start, ends_at: VALID_BODY.start, prefill: {} },
      manageUrl: "u",
    });
    await post({ ...VALID_BODY, attendee: { ...VALID_BODY.attendee, name: "Mary Jo Smith", firstName: " Mary Jo " } });
    expect(service.createBooking.mock.calls[0][0].attendee).toEqual(
      expect.objectContaining({ name: "Mary Jo Smith", firstName: "Mary Jo" }),
    );
  });

  // #3495: the tier the booker had on show rides through to createBooking, which
  // records it instead of reading the availability cache for it. A measure only, so
  // anything that is not a tier name is dropped and the lead still books.
  it("passes the tier the page had on show through, and books when it is not a tier name (#3495)", async () => {
    const created = {
      booking: { id: "b1", starts_at: VALID_BODY.start, ends_at: VALID_BODY.start, prefill: {} },
      manageUrl: "u",
    };
    service.createBooking.mockResolvedValue(created);
    await post({ ...VALID_BODY, shownTier: "high" });
    expect(service.createBooking.mock.calls[0][0].shownTier).toBe("high");

    const res = await post({ ...VALID_BODY, shownTier: "High | Both | Legal" });
    expect(res.status).toBe(200);
    expect(service.createBooking.mock.calls[1][0].shownTier).toBeUndefined();

    await post(VALID_BODY);
    expect(service.createBooking.mock.calls[2][0].shownTier).toBeUndefined();
  });

  // #2728: the framing page's origin rides through to createBooking, which reduces
  // it itself; a value of the wrong type must never cost the lead the booking.
  it("passes the referrer origin through, and books when it is not even a string (#2728)", async () => {
    const created = {
      booking: { id: "b1", starts_at: VALID_BODY.start, ends_at: VALID_BODY.start, prefill: {} },
      manageUrl: "u",
    };
    service.createBooking.mockResolvedValue(created);
    await post({ ...VALID_BODY, referrerOrigin: "http://localhost:3000" });
    expect(service.createBooking.mock.calls[0][0].referrerOrigin).toBe("http://localhost:3000");

    const res = await post({ ...VALID_BODY, referrerOrigin: { href: "x" } });
    expect(res.status).toBe(200);
    expect(service.createBooking.mock.calls[1][0].referrerOrigin).toBeUndefined();

    await post(VALID_BODY);
    expect(service.createBooking.mock.calls[2][0].referrerOrigin).toBeUndefined();

    // Bounded like every sibling field: an oversized value is dropped at the edge,
    // never handed on, and the lead still books.
    const oversized = `https://partner.example/${"a".repeat(REFERRER_ORIGIN_MAX_CHARS)}`;
    const big = await post({ ...VALID_BODY, referrerOrigin: oversized });
    expect(big.status).toBe(200);
    expect(service.createBooking.mock.calls[3][0].referrerOrigin).toBeUndefined();
    const atCap = "https://p.example/".padEnd(REFERRER_ORIGIN_MAX_CHARS, "a");
    await post({ ...VALID_BODY, referrerOrigin: atCap });
    expect(service.createBooking.mock.calls[4][0].referrerOrigin).toBe(atCap);
  });

  it("does NOT refund on an empty/misconfigured-pool 409 (NoEligibleAgents), which is not a retryable slot race (#1089)", async () => {
    service.createBooking.mockRejectedValueOnce(new service.NoEligibleAgentsError("no advisors"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    // An empty pool is a config problem, not a slot someone else just took, so a
    // retry won't help and we don't hand the budget back.
    expect(rateLimit.refundRequest).not.toHaveBeenCalled();
  });

  it("rejects a filled honeypot with a generic 400 and never creates a booking (#1033)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await post({ ...VALID_BODY, website: "https://spam.example" });
    expect(res.status).toBe(400);
    expect(service.createBooking).not.toHaveBeenCalled();
    // The rejection reveals nothing honeypot-specific (indistinguishable from a
    // schema failure) but IS logged at a queryable tag for observability.
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/honeypot|website|bot/i);
    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-honeypot"));
    expect(line).toBeDefined();
    info.mockRestore();
  });

  it("an empty honeypot books normally (a real submission never trips it) (#1033)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-hp", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post({ ...VALID_BODY, website: "" });
    expect(res.status).toBe(200);
    expect(service.createBooking).toHaveBeenCalled();
  });

  it("returns 429 when the per-contact cap blocks, after the IP cap and without creating a booking (#1033)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // IP key (a bare ip) passes; the per-contact email key is over its cap.
    rateLimit.allowRequest.mockImplementation(
      async (caller: unknown) => !rateLimitKey(caller as CallerKey).startsWith("email:"),
    );
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    expect(service.createBooking).not.toHaveBeenCalled();
    const line = info.mock.calls.map(String).find((l) => l.includes("tag=booking-rate-limit"));
    expect(line).toContain('scope="contact"');
    info.mockRestore();
  });

  // #1727: the booker's own refusals are recorded under names OUTSIDE OUTCOME_ORDER,
  // so a sustained run can be judged against its own total without ever entering the
  // denominator the booking failure share is measured against.
  describe("records its own refusals outside the failure share (#1727)", () => {
    beforeEach(() => recordApiOutcome.mockClear());

    it("records an hourly address cap trip as refused_embed_ip_hour, before any bucket is known", async () => {
      rateLimit.allowRequest.mockResolvedValueOnce(false);
      const res = await post(VALID_BODY);
      expect(res.status).toBe(429);
      expect(recordApiOutcome).toHaveBeenCalledTimes(1);
      expect(recordApiOutcome).toHaveBeenCalledWith(
        "refused_embed_ip_hour",
        "",
        null,
        expect.objectContaining({ by: "unidentifiable" }),
      );
    });

    it("records a per contact cap trip as refused_embed_contact_hour against the bucket the body named", async () => {
      rateLimit.allowRequest.mockImplementation(
        async (caller: unknown) => !rateLimitKey(caller as CallerKey).startsWith("email:"),
      );
      const res = await post(VALID_BODY);
      expect(res.status).toBe(429);
      expect(recordApiOutcome).toHaveBeenCalledTimes(1);
      expect(recordApiOutcome).toHaveBeenCalledWith(
        "refused_embed_contact_hour",
        "411",
        null,
        expect.objectContaining({ by: "bucket", code: "411" }),
      );
    });

    it("records a honeypot trip as refused_embed_honeypot and nothing as an error", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const res = await post({ ...VALID_BODY, website: "https://spam.example" });
      expect(res.status).toBe(400);
      expect(recordApiOutcome).toHaveBeenCalledTimes(1);
      expect(recordApiOutcome).toHaveBeenCalledWith(
        "refused_embed_honeypot",
        "411",
        null,
        expect.objectContaining({ by: "bucket", code: "411" }),
      );
    });

    it("records nothing for the edge minute window, which stays deliberately uncounted", async () => {
      rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
      const res = await post(VALID_BODY);
      expect(res.status).toBe(429);
      expect(recordApiOutcome).not.toHaveBeenCalled();
    });
  });

  it("checks BOTH the IP cap and the per-contact caps on a normal booking (#1033)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-c", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    const keysChecked = rateLimit.allowRequest.mock.calls.map((c) => rateLimitKey(c[0] as CallerKey));
    expect(keysChecked).toContain("203.0.113.1"); // per-IP
    expect(keysChecked).toContain("email:dana@example.com"); // per-contact email
    expect(keysChecked).toContain("phone:2155550100"); // per-contact phone
  });

  it("maps an empty/misconfigured pool to 409 (not 500)", async () => {
    service.createBooking.mockRejectedValue(new service.NoEligibleAgentsError("no advisors"));
    expect((await post(VALID_BODY)).status).toBe(409);
  });

  it("still maps a full slot to 409 and a verify outage to 503", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    expect((await post(VALID_BODY)).status).toBe(409);
    service.createBooking.mockRejectedValueOnce(new service.VerifyUnavailableError("outage"));
    expect((await post(VALID_BODY)).status).toBe(503);
  });

  it("maps an unexpected failure to a generic 500 that does not leak internals (#598)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.createBooking.mockRejectedValueOnce(new Error('relation "buckets" does not exist'));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toMatch(/buckets|does not exist/);
  });

  it("returns the booking on success", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "bk-1" });
  });

  // #2643: the Booker posts this response to the host page, so the host learns the
  // add to calendar links however it ends the booking. The contact is deliberately
  // NOT here: this answer travels to the host as a browser message, the host already
  // holds the lead's contact, and trypennie reads it server side through the lookup.
  it("carries the calendar links, and not the lead's contact", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post(VALID_BODY);
    const body = await res.json();
    expect(body.calendarLinks).toEqual({ google: "g", outlook: "o", office365: "m", ics: "i" });
    expect(body).not.toHaveProperty("contact");
    expect(service.bookingDetailExtras.mock.calls.at(-1)?.[0]).toMatchObject({ id: "bk-1" });
  });

  // #2165: the confirmation screen names who will call. Read off the booking that
  // was just made, so it is the advisor the call is with at this moment, and null
  // (never a placeholder) when the booking carries no name.
  it("names the advisor the new booking is with, and null when it holds none", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        agent_name: "Aisha Bello",
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    expect((await (await post(VALID_BODY)).json()).advisorName).toBe("Aisha Bello");

    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", agent_name: null },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const body = await (await post(VALID_BODY)).json();
    expect(body).toHaveProperty("advisorName");
    expect(body.advisorName).toBeNull();
  });

  it("passes the lead's other active booking through as duplicateWarning (#626)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-2", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    service.findDuplicateBookingWarning.mockResolvedValue({
      disclose: true,
      startsAt: "2026-07-02T18:00:00.000Z",
      manageUrl: "https://slate.test/booking/manage/tok-old",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "bk-2",
      duplicateWarning: {
        disclose: true,
        startsAt: "2026-07-02T18:00:00.000Z",
        manageUrl: "https://slate.test/booking/manage/tok-old",
      },
    });
    // Detection excludes the just-created booking and matches by attendee.
    expect(service.findDuplicateBookingWarning).toHaveBeenCalledWith(
      expect.objectContaining({ excludeBookingId: "bk-2" }),
    );
  });

  // #1337: one call per person is enforced here. The route opts in (the direct
  // booking API must not, since its cross-bucket rebook creates before it
  // cancels, #364), and a decline reaches the client as a 409 carrying the call
  // they already have, with nothing created.
  it("opts into refusing a second booking for someone who already has a call (#1337)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-9", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    expect(service.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ refuseIfPersonHasCall: true }),
      expect.anything(),
    );
  });

  it("declines with a 409 naming the existing call, and refunds the rate limit (#1337)", async () => {
    service.createBooking.mockRejectedValue(
      new service.ExistingCallError({
        disclose: true,
        startsAt: "2026-07-02T18:00:00.000Z",
        advisorName: "Aisha Bello",
        manageToken: "tok-old",
      }),
    );
    const res = await post(VALID_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      existingCall: {
        disclose: true,
        startsAt: "2026-07-02T18:00:00.000Z",
        advisorName: "Aisha Bello",
        manageToken: "tok-old",
      },
    });
    // Being declined is not an attempt the lead should pay for, and the Move they
    // are about to make is a separate request.
    expect(rateLimit.refundRequest).toHaveBeenCalled();
  });

  it("passes a withheld existing call through carrying no details (#1337/#1340)", async () => {
    service.createBooking.mockRejectedValue(
      new service.ExistingCallError({ disclose: false }),
    );
    const res = await post(VALID_BODY);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.existingCall).toEqual({ disclose: false });
    expect(JSON.stringify(body)).not.toContain("tok-old");
  });

  // #1340: the route is the wire between the strict disclosure decision and the
  // booker. A withheld match must reach the client as the bare refusal, with no
  // start time and no manage url reconstructed anywhere along the way.
  it("passes a withheld match through carrying no booking details (#1340)", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-3", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok-new",
    });
    service.findDuplicateBookingWarning.mockResolvedValue({ disclose: false });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicateWarning).toEqual({ disclose: false });
    // The only manage url in the response is the lead's own new booking.
    expect(JSON.stringify(body)).not.toContain("tok-old");
  });
});

// #1313: the embed booker is the surface most customers actually book through,
// and its outcomes were not counted at all, so the tally the admin panel reads
// (and any rate signal built on it) was blind to the busiest route. Every branch
// records, including the refusals, because the failure MIX is the thing worth
// watching: one customer losing a race is ordinary contention, and fifty refused
// in two hours is the cal.com failure of 2026-08-06, which nothing could tell
// apart without a count.
// #2660: the PUBLIC test bucket is bookable from the Booker with no key. The
// route says so to the service through `allowTestBuckets`, exactly when the code
// is the public test code and never otherwise, and it tells the host page the
// booking is a test one so the host can label its own confirmed page.
describe("POST /booking on the public test bucket (#2660)", () => {
  beforeEach(() => {
    service.createBooking.mockReset();
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-t", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
  });

  it("lets the service book the public test bucket, and says the booking is a test", async () => {
    const res = await post({ ...VALID_BODY, bucketCode: PUBLIC_TEST }, goodPass());
    expect(res.status).toBe(200);
    expect((service.createBooking.mock.calls[0] as unknown[])[0]).toMatchObject({
      bucketCode: PUBLIC_TEST,
      allowTestBuckets: true,
    });
    expect(await res.json()).toMatchObject({ id: "bk-t", isTest: true });
    // The duplicate warning is asked in the TEST world too, so a real lead's call
    // is never named on a tester's confirmation (#2660, L342).
    expect((service.findDuplicateBookingWarning.mock.calls[0] as unknown[])[0]).toMatchObject({ isTest: true });
  });

  it("never lets a real code book a test bucket, and says the booking is real", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect((service.createBooking.mock.calls[0] as unknown[])[0]).toMatchObject({
      bucketCode: VALID_BODY.bucketCode,
      allowTestBuckets: false,
    });
    expect(await res.json()).toMatchObject({ id: "bk-t", isTest: false });
    expect((service.findDuplicateBookingWarning.mock.calls[0] as unknown[])[0]).toMatchObject({ isTest: false });
  });
});

// #2666: the confirm is the third place the pass is checked, and the one where a
// pass that ran out matters most: a modal left open past its expiry reaches here
// with a form already filled, so it has its own code and its own sentence.
describe("POST /booking and the test pass (#2666)", () => {
  beforeEach(() => {
    service.createBooking.mockReset();
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-t", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
    rateLimit.refundRequest.mockClear();
    recordApiOutcome.mockClear();
  });

  it("refuses the public test bucket with no pass, creating nothing", async () => {
    const res = await post({ ...VALID_BODY, bucketCode: PUBLIC_TEST, requestedCode: PUBLIC_TEST });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: TEST_ACCESS_COPY.passRefused,
      code: TEST_PASS_REFUSAL_CODES.refused,
    });
    expect(service.createBooking).not.toHaveBeenCalled();
    // Not the tester's attempt to pay for, and not a lead refused either.
    expect(rateLimit.refundRequest).toHaveBeenCalledTimes(1);
    expect(recordApiOutcome).not.toHaveBeenCalled();
  });

  it("refuses a pass that ran out mid booking with its own code and sentence", async () => {
    const stale = mintTestPass({ code: PUBLIC_TEST, secret: SECRET, nowMs: Date.now() - TEST_PASS_TTL_MS - 1 }).value;
    const res = await post({ ...VALID_BODY, bucketCode: PUBLIC_TEST, requestedCode: PUBLIC_TEST }, stale);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: TEST_ACCESS_COPY.passExpired,
      code: TEST_PASS_REFUSAL_CODES.expired,
    });
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it("a good pass for the public bucket cannot book the canary's bucket", async () => {
    service.createBooking.mockRejectedValue(new service.UnknownBucketError("Unknown booking bucket"));
    const res = await post({ ...VALID_BODY, bucketCode: HIDDEN_TEST_BUCKET_CODES[0] }, goodPass());
    expect(res.status).toBe(422);
    expect(service.createBooking).toHaveBeenCalledWith(expect.objectContaining({ allowTestBuckets: false }), expect.anything());
  });

  it("a real bucket is booked with no pass at all", async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
  });
});

// #2667: a code that resolves to no bucket, or to a HIDDEN test bucket, used to
// fall through to the internal error path: a lead read "something went wrong on
// our end" for their own bad link, and `internal_error:booking` paged on a
// request anybody on the internet can send as often as they like (L498). It is a
// client refusal now, with the same body for both causes so the response can
// never say a hidden bucket exists (#601), and it is counted rather than paged.
describe("POST /booking on an unknown or hidden bucket (#2667)", () => {
  beforeEach(() => {
    recordApiOutcome.mockClear();
    service.createBooking.mockReset();
    service.createBooking.mockRejectedValue(new service.UnknownBucketError("Unknown booking bucket"));
  });

  it("refuses with the booker's own sentence, never the internal error", async () => {
    const res = await post({ ...VALID_BODY, bucketCode: "999" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: BOOKING_ERROR_COPY.unknownBucket, code: "UNKNOWN_BUCKET" });
    expect(body.error).not.toMatch(/on our end|our side/);
    const outcomes = recordApiOutcome.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(outcomes).toEqual([["error", "999", "unknown_bucket"]]);
  });

  it("answers a hidden test bucket byte for byte like an unknown code", async () => {
    const unknown = await post({ ...VALID_BODY, bucketCode: "999" });
    const hidden = await post({ ...VALID_BODY, bucketCode: "SMOKE" });
    expect(hidden.status).toBe(unknown.status);
    expect(await hidden.text()).toBe(await unknown.text());
    // The service was told it may NOT book a test bucket for either: the route
    // never guesses, it relays the constant's answer.
    for (const call of service.createBooking.mock.calls as unknown[][]) {
      expect(call[0]).toMatchObject({ allowTestBuckets: false });
    }
    const codes = recordApiOutcome.mock.calls.map((c) => c[2]);
    expect(codes).toEqual(["unknown_bucket", "unknown_bucket"]);
    expect(codes).not.toContain("internal");
  });
});

describe("POST /booking outcome tally (#1313)", () => {
  beforeEach(() => recordApiOutcome.mockClear());
  const outcomes = () => recordApiOutcome.mock.calls.map((c) => [c[0], c[2]]);

  it("counts a successful booking", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["created", null]]);
    // Always with the bucket, so a failure confined to one bucket is visible.
    expect(recordApiOutcome.mock.calls[0][1]).toBe(VALID_BODY.bucketCode);
  });

  // #1318: the two 400s were a customer refused with nothing anywhere counting it.
  // The live case is #1425, which made a phone number carrying an extension a
  // refusal: any upstream source still sending one now fails EVERY time, and without
  // this count the only symptom is a quieter funnel.
  it("counts a request whose body Slate rejects", async () => {
    const res = await post({ ...VALID_BODY, timezone: 42 });
    expect(res.status).toBe(400);
    expect(outcomes()).toEqual([["error", "invalid_request"]]);
    // The bucket is read off the RAW body, which is the only place it exists when the
    // parse is what failed, so a fault confined to one bucket stays visible.
    expect(recordApiOutcome.mock.calls[0][1]).toBe(VALID_BODY.bucketCode);
  });

  it("counts contact details Slate will not take, under a different code", async () => {
    const res = await post({
      ...VALID_BODY,
      attendee: { ...VALID_BODY.attendee, phone: "2155550100 x4021" },
    });
    expect(res.status).toBe(400);
    // Its own code, not the schema one: a wave of each means a different thing, and a
    // page naming "invalid_request" for a contact rule would send the reader to the
    // wrong place.
    expect(outcomes()).toEqual([["error", "invalid_contact"]]);
  });

  it("counts NOTHING the failure share divides by for a bot tripping the honeypot", async () => {
    const res = await post({ ...VALID_BODY, website: "http://spam.example" });
    expect(res.status).toBe(400);
    // Deliberate (#1318). The share's denominator is every OUTCOME_ORDER outcome
    // summed, so counting a bot there would make a real outage look proportionally
    // smaller while it floods. #1727 records the trip on its own counter instead, a
    // name outside OUTCOME_ORDER, so a sustained run can be judged on its own.
    expect(outcomes()).toEqual([["refused_embed_honeypot", null]]);
    expect((OUTCOME_ORDER as readonly string[]).includes("refused_embed_honeypot")).toBe(false);
  });

  it("counts a slot refused at confirm under its own code", async () => {
    service.createBooking.mockRejectedValue(new service.SlotUnavailableError("taken"));
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["error", "slot_unavailable"]]);
  });

  // #2838: a confirm that lost the overlap race is counted a second time, on a row
  // outside the failure share, so the daily race whisper can see both halves: the
  // ones handed to the next advisor and the ones refused. The ordinary outcome is
  // unchanged, so the failure share reads exactly what it read before.
  it("counts a booking handed on after a lost race beside the ordinary created row", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        routing_trace: { bucket_code: "411", race_lost: ["a"] },
      },
      manageUrl: "https://slate.test/booking/manage/tok",
      newlyInserted: true,
    });
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["created", null], ["race_reassigned", null]]);
  });

  // #3267: a confirm that answered the booking and left the work after its save to
  // the reservation drain is counted beside its created row, outside the failure
  // share, so the monitor lane can page on the share of them.
  it("counts a booking whose follow up work was left to the drain beside the created row", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
      },
      manageUrl: "https://slate.test/booking/manage/tok",
      newlyInserted: true,
      followUpLeftToDrain: true,
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(outcomes()).toEqual([["created", null], ["follow_up_left_to_drain", null]]);
  });

  it("does not count a race again on a replay that returns an earlier confirm's booking", async () => {
    // A double click or retry with the same key returns the booking already made,
    // whose trace describes the earlier confirm's race. That race was counted then.
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        routing_trace: { bucket_code: "411", race_lost: ["a"] },
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["created", null]]);
  });

  it("counts an uncontested booking once", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-1",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        routing_trace: { bucket_code: "411" },
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["created", null]]);
  });

  // #3797: a time taken after the lead's list was computed is a PROVEN lost race,
  // counted on its own row in place of the error, so it is outside the failure share.
  it("counts a proven lost race at the free check apart, in place of the error", async () => {
    const { traced } = await import("@/lib/booking/refusal-trace");
    service.createBooking.mockRejectedValue(
      traced(new service.SlotUnavailableError("taken"), {
        requestedStart: VALID_BODY.start,
        bucketCode: "411",
        stage: "candidate_read_empty",
        rungs: [],
        offerVerdict: "race",
      }),
    );
    const res = await post({ ...VALID_BODY, slotsComputedAt: "2026-10-16T02:24:08.327Z" });
    expect(res.status).toBe(409);
    expect(outcomes()).toEqual([["race_since_offer", null]]);
    // The stamp the lead's list carried reaches the confirm, which judges it.
    expect(service.createBooking.mock.calls.at(-1)?.[0]).toMatchObject({ servedComputedAt: "2026-10-16T02:24:08.327Z" });
  });

  it("keeps a refusal judged a stale offer, or not judged, as the error it always was", async () => {
    const { traced } = await import("@/lib/booking/refusal-trace");
    for (const offerVerdict of ["stale_offer", "unknown", undefined] as const) {
      recordApiOutcome.mockClear();
      service.createBooking.mockRejectedValue(
        traced(new service.SlotUnavailableError("taken"), {
          requestedStart: VALID_BODY.start,
          bucketCode: "411",
          stage: "candidate_read_empty",
          rungs: [],
          ...(offerVerdict ? { offerVerdict } : {}),
        }),
      );
      await post(VALID_BODY);
      expect(outcomes()).toEqual([["error", "slot_unavailable"]]);
    }
  });

  it("counts a refusal after a lost race apart from a time already taken", async () => {
    service.createBooking.mockRejectedValue(new service.RaceLostRefusalError(1, false));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    expect(outcomes()).toEqual([["error", "slot_unavailable"], ["race_refused", null]]);
  });

  it("counts a refusal at the reassign bound on its own row", async () => {
    service.createBooking.mockRejectedValue(new service.RaceLostRefusalError(4, true));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    expect(outcomes()).toEqual([["error", "slot_unavailable"], ["race_refused_bound", null]]);
  });

  // #3442: a lost race with too little budget left to walk down the ladder is told to
  // retry (503), and counted in the race tally beside the timeout it is answered as.
  it("counts a lost race told to retry for budget in the race tally", async () => {
    service.createBooking.mockRejectedValue(new service.LostRaceOutOfTimeError());
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(outcomes()).toEqual([["error", "verify_unavailable"], ["race_retry_budget", null]]);
  });

  it("counts no race for an ordinary timeout", async () => {
    service.createBooking.mockRejectedValue(new service.VerifyUnavailableError());
    expect((await post(VALID_BODY)).status).toBe(503);
    expect(outcomes()).toEqual([["error", "verify_unavailable"]]);
  });

  it("counts an empty pool apart from a lost slot race", async () => {
    service.createBooking.mockRejectedValue(new service.NoEligibleAgentsError("none"));
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["error", "no_eligible_agents"]]);
  });

  it("counts a verify outage apart from both", async () => {
    service.createBooking.mockRejectedValue(new service.VerifyUnavailableError("down"));
    await post(VALID_BODY);
    expect(outcomes()).toEqual([["error", "verify_unavailable"]]);
  });

  it("counts a refused second booking as a dedupe, not an error", async () => {
    service.createBooking.mockRejectedValue(
      new service.ExistingCallError({ disclose: false }),
    );
    await post(VALID_BODY);
    // Declining a duplicate is the product working, so it must not inflate the
    // failure share the rate signal will watch.
    expect(outcomes()).toEqual([["deduped", "existing_call"]]);
  });

  it("counts an unexpected failure rather than losing it", async () => {
    service.createBooking.mockRejectedValue(new Error("something else"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect(outcomes()).toEqual([["error", "internal"]]);
  });
});

// The public booking kill switch (#2297). What is asserted here is not that a flag
// works, it is the three things that make the switch worth having: nothing is
// created while it is on, a lead's booking budget is not spent on a refusal they
// did not cause, and a flag that CANNOT be read refuses rather than booking on.
describe("POST /booking kill switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.allowRequest.mockResolvedValue(true);
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
    service.createBooking.mockResolvedValue({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:20:00.000Z" },
      manageUrl: "https://example.test/manage/t",
    });
  });

  it("creates nothing and refuses with 503 while bookings are paused", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(service.createBooking).not.toHaveBeenCalled();
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  // The switch is an operator action, so the lead did nothing wrong. Spending one
  // of their ten an hour on it would mean a pause that lasted an hour left real
  // leads throttled after it was lifted.
  it("does not spend the lead's hourly or contact budget on a paused refusal", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    await post(VALID_BODY);
    expect(rateLimit.allowRequest).not.toHaveBeenCalled();
  });

  // Both halves, so neither assertion can be satisfied by a route hard wired to
  // one answer (L1): the SAME request books when the flag reads false.
  // #3325: the confirm line facts the service records reach the route's own
  // "confirm answered" line, so a fallback rate and the line's cost can be counted.
  it("hands the booking the facts it logs, so the line that served the confirm is on its log line (#3325)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    service.createBooking.mockImplementationOnce((async (_input: unknown, facts?: { line?: unknown }) => {
      if (facts) facts.line = { line: "shared", reason: "ok", key: "ladder", lineMs: 87 };
      return {
        booking: { id: "b1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", agent_name: "Jane", prefill: null, salesforce_id: null, external_id: null },
        manageUrl: "https://x.test/m/t",
        newlyInserted: true,
      };
    }) as never);
    const res = await post(VALID_BODY);
    const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
    info.mockRestore();
    expect(res.status).toBe(200);
    expect(lines.at(-1)).toContain('line="shared"');
    expect(lines.at(-1)).toContain("line_ms=87");
  });

  it("books exactly as before when the flag reads false", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(service.createBooking).toHaveBeenCalledTimes(1);
  });

  // The direction that makes the switch trustworthy. A read failure must not
  // resolve to "not paused", which is the #277 shape.
  it("refuses, and creates nothing, when the pause flag cannot be read", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(null);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  // An unreadable flag is a fault somebody has to repair; a pause is somebody
  // holding bookings on purpose. They must not arrive as the same thing, or the
  // pause explains away the fault (L11).
  it("says something different to the lead, and records differently, for a fault than for a pause", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    const pausedBody = await (await post(VALID_BODY)).json();
    const pausedOutcomes = recordApiOutcome.mock.calls.slice();

    recordApiOutcome.mockClear();
    bookingSettings.readPublicBookingPaused.mockResolvedValue(null);
    const faultBody = await (await post(VALID_BODY)).json();
    const faultOutcomes = recordApiOutcome.mock.calls.slice();

    expect(faultBody.error).not.toBe(pausedBody.error);
    // The fault is counted as an error under its own code, so the booking
    // failure-rate window pages on the share and names it. The deliberate pause
    // is not, because it would page somebody about a thing they just did.
    expect(faultOutcomes.some((c) => c[0] === "error" && c[2] === "booking_pause_unreadable")).toBe(true);
    expect(pausedOutcomes.some((c) => c[0] === "error")).toBe(false);
  });
});

// #2561: the confirm's answer names one lead's booking and carries the manage URL a
// cancel or reschedule is authorised by. Nothing between the browser and the Worker
// was told not to keep it, so a shared cache (a corporate proxy, an ISP one, a
// back/forward store) could hand one lead's confirmation to the next reader. Every
// ending is asserted, not just the happy one: the header is applied by wrapping the
// handler rather than by stamping each of its thirteen returns, and the thing worth
// proving about a wrapper is that a return nobody remembered still carries it (L96).
describe("confirm answers are never stored (#2561)", () => {
  const noStore = (res: Response) => res.headers.get("cache-control");

  beforeEach(() => {
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingWithinLimit.mockReset();
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    service.createBooking.mockReset();
    service.findDuplicateBookingWarning.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
  });

  it("on a confirmed booking", async () => {
    service.createBooking.mockResolvedValueOnce({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00Z", ends_at: "2026-07-01T15:30:00Z", agent_name: "A", agent_email: "a@b.com" },
      manageUrl: "https://slate.trypennie.app/booking/manage/tok1",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a rejected body, which never reaches the booking layer", async () => {
    const res = await post({ ...VALID_BODY, bucketCode: "" });
    expect(res.status).toBe(400);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a throttled address, the one refusal a cache could replay for free", async () => {
    rateLimit.bookingWithinLimit.mockResolvedValueOnce(false);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(429);
    expect(noStore(res)).toBe("no-store");
  });

  it("while public booking is paused, which answers from the kill switch", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValueOnce(true);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(503);
    expect(noStore(res)).toBe("no-store");
  });

  it("on a taken slot, which answers 409 through the error map", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(409);
    expect(noStore(res)).toBe("no-store");
  });

  it("on an unexpected fault, which returns through a different helper entirely", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    service.createBooking.mockRejectedValueOnce(new Error("boom"));
    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    expect(noStore(res)).toBe("no-store");
  });
});

// #2659: the Booker posts this response to the host page as `slate:bookingSuccessful`,
// so the host learns the two partner join keys it put on the URL back from the
// booking that was actually made, and can carry them onto its own confirmed
// page. Null when the page passed none, so the field is always there to read.
describe("POST /booking partner join keys (#2659)", () => {
  it("carries submissionId and regalProfileId from the booking's prefill", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-pk",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        prefill: { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU", [PARTNER_KEYS.regalProfileId]: "rp_01HZY3" },
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "bk-pk",
      submissionId: "a0G5x00000AbCdEQAU",
      regalProfileId: "rp_01HZY3",
    });
  });

  it("answers null for each key the page did not pass", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-pk",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        prefill: { [PARTNER_KEYS.submissionId]: "a0G5x00000AbCdEQAU" },
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const body = await (await post(VALID_BODY)).json();
    expect(body.submissionId).toBe("a0G5x00000AbCdEQAU");
    expect(body.regalProfileId).toBeNull();
  });
});

// #2752: every attempt recorded here carries the host page facts the confirm holds,
// in the shape the booking row stores them, so the tally can judge them through the
// off site page's own predicate and keep a tester on a real code out of the failure
// rate. The framing page is reduced exactly as createBooking reduces it.
describe("POST /booking records the host page with each attempt (#2752)", () => {
  beforeEach(() => recordApiOutcome.mockClear());
  const hostOf = (i = 0) => (recordApiOutcome.mock.calls[i][3] as { host?: unknown }).host;

  it("carries a localhost tester's declared origin and framing page on a refusal", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    await post({
      ...VALID_BODY,
      bucketCode: "100",
      prefill: { parentOrigin: "http://localhost:3000", embed: "1" },
      referrerOrigin: "http://localhost:3000/test-page?lead=x",
    });
    expect(recordApiOutcome.mock.calls[0][2]).toBe("slot_unavailable");
    expect(hostOf()).toEqual({
      prefill: { parentOrigin: "http://localhost:3000" },
      // Reduced to the bare origin, never the path or query the client sent.
      referrer_origin: "http://localhost:3000",
    });
  });

  it("carries the production site on a created booking", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z" },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    await post({ ...VALID_BODY, prefill: { parentOrigin: "https://www.trypennie.com" } });
    expect(recordApiOutcome.mock.calls[0][0]).toBe("created");
    expect(hostOf()).toEqual({ prefill: { parentOrigin: "https://www.trypennie.com" }, referrer_origin: null });
  });

  it("carries no host when the confirm recorded none, which still counts", async () => {
    service.createBooking.mockRejectedValueOnce(new service.SlotUnavailableError("taken"));
    await post(VALID_BODY);
    expect(hostOf()).toEqual({ prefill: null, referrer_origin: null });
  });

  it("reads the host off the raw body when the body itself is what failed to parse", async () => {
    await post({ ...VALID_BODY, timezone: 42, prefill: { parentOrigin: "https://dev.trypennie.com" } });
    expect(recordApiOutcome.mock.calls[0][2]).toBe("invalid_request");
    expect(hostOf()).toEqual({ prefill: { parentOrigin: "https://dev.trypennie.com" }, referrer_origin: null });
  });
});

// #2750: the host looks a booking up by the lead id the booking is STORED under,
// so the confirm response carries the booking's own ids as stored. On a fresh
// booking they are the page's; the reschedule route is where they differ.
describe("POST /booking carries the booking's own identity (#2750)", () => {
  it("answers salesforceId and externalId off the stored booking", async () => {
    service.createBooking.mockResolvedValue({
      booking: {
        id: "bk-id",
        starts_at: "2026-07-01T15:00:00.000Z",
        ends_at: "2026-07-01T15:30:00.000Z",
        salesforce_id: "00QStored000001",
        external_id: "00QStoredExt001",
      },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const body = await (await post(VALID_BODY)).json();
    expect(body).toMatchObject({ id: "bk-id", salesforceId: "00QStored000001", externalId: "00QStoredExt001" });
  });

  it("answers null, never absent, for an id the booking does not hold", async () => {
    service.createBooking.mockResolvedValue({
      booking: { id: "bk-id", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", salesforce_id: null, external_id: null },
      manageUrl: "https://slate.test/booking/manage/tok",
    });
    const body = await (await post(VALID_BODY)).json();
    expect(body).toHaveProperty("salesforceId", null);
    expect(body).toHaveProperty("externalId", null);
  });
});

describe("POST /booking through an agent's own link (#2073, #3026)", () => {
  const TOKEN = "ab".repeat(32);
  // #3026: the booker sends the advisor's readable name as `agentLink`.
  const NAME = "rdaboub";
  const LINK_BODY = {
    agentLink: NAME,
    start: "2026-07-01T15:00:00.000Z",
    timezone: "America/New_York",
    attendee: { name: "Dana Lee", email: "dana@example.com", phone: "2155550100" },
    prefill: {},
  };
  const bookable = {
    ok: true,
    agent: { id: "u1", name: "Jane Doe", email: "jane@x.com", bookable: true, deactivated_at: null },
    bucketCode: "411",
    bucket: { code: "411", is_test: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.allowRequest.mockResolvedValue(true);
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
    agentLinkStore.resolveAgentLink.mockResolvedValue(bookable);
    service.createBooking.mockResolvedValue({
      booking: { id: "b1", starts_at: "2026-07-01T15:00:00.000Z", ends_at: "2026-07-01T15:30:00.000Z", agent_name: "Jane Doe", prefill: {} },
      manageUrl: "https://slate.test/booking/manage/t",
    });
  });

  it("books the named agent in their own bucket, with no person rule and no routing", async () => {
    const res = await post(LINK_BODY);
    expect(res.status).toBe(200);
    expect(agentLinkStore.resolveAgentLink).toHaveBeenCalledWith(NAME);
    const input = service.createBooking.mock.calls[0][0];
    expect(input.agentLinkUserId).toBe("u1");
    expect(input.bucketCode).toBe("411");
    expect(input.refuseIfPersonHasCall).toBe(false);
    expect(input.requestedCode).toBeUndefined();
    expect(input.allowTestBuckets).toBe(false);
    const body = await res.json();
    expect(body.isTest).toBe(false);
    expect(body.advisorName).toBe("Jane Doe");
  });

  it("still accepts the old agentLinkToken field from a page loaded before #3026", async () => {
    const { agentLink: _name, ...rest } = LINK_BODY;
    const res = await post({ ...rest, agentLinkToken: TOKEN });
    expect(res.status).toBe(200);
    expect(agentLinkStore.resolveAgentLink).toHaveBeenCalledWith(TOKEN);
    expect(service.createBooking.mock.calls[0][0].agentLinkUserId).toBe("u1");
  });

  it("refuses a body naming the link twice, in both fields", async () => {
    expect((await post({ ...LINK_BODY, agentLinkToken: TOKEN })).status).toBe(400);
    expect(agentLinkStore.resolveAgentLink).not.toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it("refuses an empty link as a bad request, in either field, before any read", async () => {
    const { agentLink: _name, ...rest } = LINK_BODY;
    expect((await post({ ...rest, agentLink: "" })).status).toBe(400);
    expect((await post({ ...rest, agentLinkToken: "" })).status).toBe(400);
    expect(agentLinkStore.resolveAgentLink).not.toHaveBeenCalled();
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it("never logs the name a refused link carried (#3026)", async () => {
    agentLinkStore.resolveAgentLink.mockResolvedValue({ ok: false, why: "unknown" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post(LINK_BODY)).status).toBe(404);
    const logged = JSON.stringify([info.mock.calls, logSpy.mock.calls, warn.mock.calls]);
    expect(logged).toContain("unknown");
    expect(logged).not.toContain(NAME);
    info.mockRestore();
    logSpy.mockRestore();
    warn.mockRestore();
  });

  it("is kept out of the routed booking tally and warns about no other call", async () => {
    await post(LINK_BODY);
    expect(recordApiOutcome).not.toHaveBeenCalled();
    expect(service.findDuplicateBookingWarning).not.toHaveBeenCalled();
  });

  it("refuses a link that books nobody with one sentence, creating nothing", async () => {
    const bodies = new Set<string>();
    for (const why of ["unknown", "departed", "not_bookable", "no_bucket"]) {
      agentLinkStore.resolveAgentLink.mockResolvedValue({ ok: false, why });
      const res = await post(LINK_BODY);
      expect(res.status).toBe(404);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]).error).toBe(AGENT_LINK_COPY.unavailable);
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it("books a test agent's link as a test booking", async () => {
    agentLinkStore.resolveAgentLink.mockResolvedValue({ ...bookable, bucketCode: "SMOKE", bucket: { code: "SMOKE", is_test: true } });
    const res = await post(LINK_BODY);
    expect(service.createBooking.mock.calls[0][0].allowTestBuckets).toBe(true);
    expect((await res.json()).isTest).toBe(true);
  });

  it("is paused by the kill switch like every public booking", async () => {
    bookingSettings.readPublicBookingPaused.mockResolvedValue(true);
    const res = await post(LINK_BODY);
    expect(res.status).toBe(503);
    expect(agentLinkStore.resolveAgentLink).not.toHaveBeenCalled();
  });

  it("is rate limited like every public booking", async () => {
    rateLimit.bookingWithinLimit.mockResolvedValue(false);
    const res = await post(LINK_BODY);
    expect(res.status).toBe(429);
    expect(agentLinkStore.resolveAgentLink).not.toHaveBeenCalled();
  });

  it("maps the named agent being busy to the ordinary taken slot answer", async () => {
    service.createBooking.mockRejectedValue(new service.SlotUnavailableError("taken"));
    const res = await post(LINK_BODY);
    expect(res.status).toBe(409);
    expect(recordApiOutcome).not.toHaveBeenCalled();
  });

  it("refuses a body naming both a bucket and a link, or neither", async () => {
    expect((await post({ ...LINK_BODY, bucketCode: "411" })).status).toBe(400);
    const { agentLink: _dropped, ...neither } = LINK_BODY;
    expect((await post(neither)).status).toBe(400);
    expect(service.createBooking).not.toHaveBeenCalled();
  });

  it("an unreadable link is a fault, never the not taking bookings sentence", async () => {
    agentLinkStore.resolveAgentLink.mockRejectedValue(new Error("db down"));
    const res = await post(LINK_BODY);
    expect(res.status).toBe(500);
    expect(service.createBooking).not.toHaveBeenCalled();
  });
});

// #3493: the route's checks before the confirm (the edge limit, the pause flag, the
// hourly cap, the body read, the contact caps, an advisor link) ran inside ONE span,
// `route-checks`, so a confirm that spent 1.5s there could not say which check cost
// it. Each now carries its own stage inside that span, named by ROUTE_CHECK_STAGES,
// and the outer span stays, so every reader of `route-checks` reads what it did.
describe("POST /booking times each of its checks (#3493)", () => {
  // The clock is SET, never waited on (L290): only `Date` is faked, so the profile's
  // reads see a check take exactly SLOW_MS while every timer runs as it always does.
  const SLOW_MS = 40;
  const slowly = async <T,>(value: T | Error): Promise<T> => {
    vi.setSystemTime(Date.now() + SLOW_MS);
    if (value instanceof Error) throw value;
    return value;
  };
  const deadline = () => new DeadlineExceededError("supabase", 4000, { label: "the booking confirm", totalMs: 12_000 });
  /** The `confirm answered` line's stages, as name to [ms, runs]. */
  function stagesOf(line: string): Map<string, [number, number]> {
    const raw = /stages="([^"]*)"/.exec(line)?.[1];
    expect(raw, `the line carries a profile: ${line}`).toBeTypeOf("string");
    const out = new Map<string, [number, number]>();
    for (const token of raw!.split(",")) {
      const m = /^(.+):(\d+)\/(\d+)$/.exec(token);
      expect(m, `a readable stage token: ${token}`).not.toBeNull();
      out.set(m![1]!, [Number(m![2]), Number(m![3])]);
    }
    return out;
  }
  async function answeredLine(body: unknown): Promise<{ status: number; line: string }> {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post(body);
      const lines = info.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes('msg="confirm answered"'));
      expect(lines).toHaveLength(1);
      return { status: res.status, line: lines[0]! };
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  }

  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.refundRequest.mockClear();
    bookingSettings.readPublicBookingPaused.mockResolvedValue(false);
    service.createBooking.mockReset();
    service.pageBookingFailure.mockClear();
    // The confirm runs out of time, so its line carries the profile (#3300).
    service.createBooking.mockRejectedValue(
      Object.assign(new service.VerifyUnavailableError("try again"), { cause: deadline() }),
    );
  });

  it("charges each check its own stage inside route-checks, the slow one included", async () => {
    bookingSettings.readPublicBookingPaused.mockImplementationOnce(() => slowly<boolean | null>(false));
    const { status, line } = await answeredLine(VALID_BODY);
    expect(status).toBe(503);
    const stages = stagesOf(line);
    expect(stages.get("route-checks")?.[1]).toBe(1);
    expect(stages.get(ROUTE_CHECK_STAGES.edgeLimit)?.[1]).toBe(1);
    expect(stages.get(ROUTE_CHECK_STAGES.pauseFlag)?.[1]).toBe(1);
    expect(stages.get(ROUTE_CHECK_STAGES.hourlyCap)?.[1]).toBe(1);
    expect(stages.get(ROUTE_CHECK_STAGES.bodyRead)?.[1]).toBe(1);
    // One cap per contact key, the email and the phone, each its own run.
    expect(stages.get(ROUTE_CHECK_STAGES.contactCap)?.[1]).toBe(2);
    // No advisor link was posted, so none was read and none is claimed.
    expect(stages.has(ROUTE_CHECK_STAGES.agentLink)).toBe(false);
    // The slow read is charged to the pause flag, and not to the check after it.
    const [pauseMs] = stages.get(ROUTE_CHECK_STAGES.pauseFlag)!;
    expect(pauseMs).toBe(SLOW_MS);
    expect(stages.get(ROUTE_CHECK_STAGES.hourlyCap)![0]).toBe(0);
    // Inside the outer span, never past it.
    expect(stages.get("route-checks")![0]).toBeGreaterThanOrEqual(pauseMs);
  });

  it("still charges a check that THREW for the time it spent, and times nothing after it", async () => {
    rateLimit.allowRequest.mockImplementationOnce(() => slowly<boolean>(deadline()));
    const { status, line } = await answeredLine(VALID_BODY);
    expect(status).toBe(503);
    expect(line).toContain("timed_out=true");
    const stages = stagesOf(line);
    expect(stages.get(ROUTE_CHECK_STAGES.hourlyCap)?.[1]).toBe(1);
    expect(stages.get(ROUTE_CHECK_STAGES.hourlyCap)![0]).toBe(SLOW_MS);
    expect(stages.has(ROUTE_CHECK_STAGES.bodyRead)).toBe(false);
    expect(stages.has(ROUTE_CHECK_STAGES.contactCap)).toBe(false);
  });

  it("times an advisor link read, and charges it when the read fails", async () => {
    agentLinkStore.resolveAgentLink.mockImplementationOnce(() => slowly(deadline()));
    const { bucketCode: _code, ...noBucket } = VALID_BODY;
    const { status, line } = await answeredLine({ ...noBucket, agentLink: "rdaboub", prefill: {} });
    expect(status).toBe(503);
    const stages = stagesOf(line);
    expect(stages.get(ROUTE_CHECK_STAGES.agentLink)?.[1]).toBe(1);
    expect(stages.get(ROUTE_CHECK_STAGES.agentLink)![0]).toBe(SLOW_MS);
  });
});

// #4391: a program lead's confirm goes through the program path, and only theirs.
describe("POST /booking for a program lead (#4391)", () => {
  const LEAD = "00Q000000000001";
  const PROGRAM_SECRET = "p".repeat(64);
  const tokenFor = (salesforceId: string, bookingId: string | null = null) =>
    mintProgramLeadToken({ salesforceId, bookingId, secret: PROGRAM_SECRET, nowMs: Date.now() }).value;
  // A forgery always CHANGES the signature's last character. Overwriting it with a fixed
  // "0" left the token genuine whenever the signature (which moves with the clock)
  // already ended in "0", one run in sixteen, and the test then failed at random.
  const forge = (token: string) => `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
  const BODY = { ...VALID_BODY, salesforceId: LEAD };
  const routed = {
    booking: { id: "bk-r", kind: "routed", agent_name: "Agent A", starts_at: BODY.start, ends_at: "2026-07-01T15:30:00.000Z", prefill: {} },
    manageUrl: "https://slate.test/booking/manage/tok-r",
    newlyInserted: true,
  };
  const onPlaceholder = {
    booking: { id: "bk-p", kind: "staff_placed", agent_name: "Marcia", starts_at: BODY.start, ends_at: "2026-07-01T15:30:00.000Z", prefill: {} },
    manageUrl: "https://slate.test/booking/manage/tok-p",
    newlyInserted: true,
  };

  beforeEach(() => {
    vi.stubEnv("PROGRAM_LEAD_TOKEN_SECRET", PROGRAM_SECRET);
    rateLimit.allowRequest.mockReset();
    rateLimit.allowRequest.mockResolvedValue(true);
    rateLimit.bookingWithinLimit.mockResolvedValue(true);
    rateLimit.refundRequest.mockClear();
    rateLimit.grantBookingRetryCredit.mockClear();
    service.createBooking.mockReset();
    service.findDuplicateBookingWarning.mockResolvedValue(null);
    programLeadBooking.bookProgramLeadLive.mockReset();
    recordApiOutcome.mockClear();
  });

  const outcomes = () => recordApiOutcome.mock.calls.map((c) => [c[0], c[2]]);

  it("sends a lead with a good token through the program path, with the confirm the normal create would get", async () => {
    programLeadBooking.bookProgramLeadLive.mockResolvedValueOnce({ result: routed, path: "real-slot", onPlaceholder: false });
    const res = await post({ ...BODY, programLeadToken: tokenFor(LEAD) });
    expect(res.status).toBe(200);
    expect(service.createBooking).not.toHaveBeenCalled();
    const [input, facts] = programLeadBooking.bookProgramLeadLive.mock.calls[0]!;
    expect(input).toMatchObject({ bucketCode: "411", salesforceId: LEAD, startIso: BODY.start, refuseIfPersonHasCall: true });
    expect(facts).toBe(prelude.startConfirmPrelude.mock.calls.at(-1)![0]);
    expect(outcomes()).toEqual([["created", null]]);
    expect((await res.json()).advisorName).toBe("Agent A");
  });

  it("records a call that went straight to the placeholder as its own outcome, never created or an error, and names no advisor", async () => {
    programLeadBooking.bookProgramLeadLive.mockResolvedValueOnce({ result: onPlaceholder, path: "straight", onPlaceholder: true });
    const res = await post({ ...BODY, programLeadToken: tokenFor(LEAD) });
    expect(res.status).toBe(200);
    expect(outcomes()).toEqual([[PROGRAM_PLACEHOLDER_OUTCOME.straight, null]]);
    expect(OUTCOME_ORDER as readonly string[]).not.toContain(PROGRAM_PLACEHOLDER_OUTCOME.straight);
    const body = await res.json();
    expect(body.advisorName).toBeNull();
    expect(body.id).toBe("bk-p");
  });

  it("records a lost race that fell to the placeholder as its own outcome, not a refusal", async () => {
    programLeadBooking.bookProgramLeadLive.mockResolvedValueOnce({ result: onPlaceholder, path: "lost-race", onPlaceholder: true });
    const res = await post({ ...BODY, programLeadToken: tokenFor(LEAD) });
    expect(res.status).toBe(200);
    expect(outcomes()).toEqual([[PROGRAM_PLACEHOLDER_OUTCOME.afterRace, null]]);
    expect(OUTCOME_ORDER as readonly string[]).not.toContain(PROGRAM_PLACEHOLDER_OUTCOME.afterRace);
  });

  it("answers a full day with its own code and sentence, never the taken time one, and gives the lead's caps back", async () => {
    programLeadBooking.bookProgramLeadLive.mockRejectedValueOnce(new PlaceholderDayFullError("2026-07-01"));
    const res = await post({ ...BODY, programLeadToken: tokenFor(LEAD) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(PLACEHOLDER_DAY_FULL_CODE);
    expect(body.error).toBe(BOOKING_ERROR_COPY.placeholderDayFull);
    expect(body.error).not.toBe(BOOKING_ERROR_COPY.slotTaken);
    expect(rateLimit.refundRequest).toHaveBeenCalled();
    expect(rateLimit.grantBookingRetryCredit).toHaveBeenCalledWith("203.0.113.1");
    expect(outcomes().filter(([o]) => o === "error")).toEqual([]);
  });

  it.each([
    ["no token", undefined],
    ["a token for another lead", "other"],
    ["a forged token", "forged"],
    ["a move token", "move"],
  ])("books an ordinary confirm with %s", async (_label, kind) => {
    service.createBooking.mockResolvedValueOnce(routed);
    const token =
      kind === "other" ? tokenFor("00Q000000000002")
        : kind === "forged" ? forge(tokenFor(LEAD))
          : kind === "move" ? tokenFor(LEAD, "6f1c2d3e-0000-4000-8000-000000000001")
            : undefined;
    const res = await post({ ...BODY, ...(token ? { programLeadToken: token } : {}) });
    expect(res.status).toBe(200);
    expect(programLeadBooking.bookProgramLeadLive).not.toHaveBeenCalled();
    expect(service.createBooking).toHaveBeenCalledTimes(1);
    expect(service.createBooking.mock.calls[0]![0].programLead).toBeUndefined();
  });

  it("never takes an advisor's own link down the program path", async () => {
    agentLinkStore.resolveAgentLink.mockResolvedValueOnce({
      ok: true,
      agent: { id: "u1" },
      bucketCode: "411",
      bucket: { is_test: false },
    });
    service.createBooking.mockResolvedValueOnce(routed);
    const { bucketCode: _code, ...noBucket } = BODY;
    const res = await post({ ...noBucket, agentLink: "rdaboub", programLeadToken: tokenFor(LEAD) });
    expect(res.status).toBe(200);
    expect(programLeadBooking.bookProgramLeadLive).not.toHaveBeenCalled();
  });
});

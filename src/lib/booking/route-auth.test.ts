import { describe, it, expect, vi, beforeEach } from "vitest";

// The WIRING for #1429: the shared authorizer reports which refusal it made, and
// records the ones the refusal catalog says are counted.
//
// The decision itself is pure and covered by scripts/test-api-auth-refusal.ts.
// What that suite cannot see is whether the decision is actually CONNECTED: a
// counting rule nothing calls is a rule that never fires, and it would look
// identical in review (L3, built is not wired). So this drives the real authorizer
// with the recorder mocked, and asserts what reached it.

// #2865: the key these tests authenticate with is Regal's. There is no shared caller.
const regalKey = vi.hoisted(() => ({ primary: vi.fn(() => "goodsecret"), secondary: vi.fn(() => "") }));
const env = vi.hoisted(() => ({
  bookingApiKeyFor: vi.fn((caller: string, slot: string) =>
    caller !== "regal" ? "" : slot === "primary" ? regalKey.primary() : regalKey.secondary(),
  ),
}));
const regalKeyFor = (caller: string, slot: string) =>
  caller !== "regal" ? "" : slot === "primary" ? regalKey.primary() : regalKey.secondary();
const rateLimit = vi.hoisted(() => ({
  exactCeilingWithinLimit: vi.fn(async (_caller: unknown, _rules: unknown) => true),
  bookingApiWriteWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiReadWithinLimit: vi.fn(async (_keyId: string) => true),
  bookingApiIpWithinLimit: vi.fn(async (_ip: string) => true),
  bearerFailureWithinLimit: vi.fn(async (_ip: string) => true),
  clientIp: (headers: Headers) => headers.get("cf-connecting-ip")?.trim() ?? "unknown",
}));
const tally = vi.hoisted(() => ({ recordApiOutcome: vi.fn() }));
const seen = vi.hoisted(() => ({ recordCallerSeen: vi.fn() }));
const retired = vi.hoisted(() => ({ watchRetiredKey: vi.fn() }));

vi.mock("@/lib/env", () => env);
vi.mock("@/lib/rate-limit", () => rateLimit);
vi.mock("@/lib/monitor/record-api-outcome", () => tally);
vi.mock("@/lib/booking/record-caller-seen", () => seen);
vi.mock("@/lib/booking/retired-key-watch", () => retired);

import { authorizeBookingApi } from "./route-auth";
import { DIRECT_BOOKING_API_HOURLY_RATE_RULES, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "@/lib/rate-limit-core";
import { FULL_API_CALLERS } from "@/lib/booking/api-auth";

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
    regalKey.primary.mockReturnValue("goodsecret");
    regalKey.secondary.mockReturnValue("");
    env.bookingApiKeyFor.mockImplementation(regalKeyFor);
    rateLimit.exactCeilingWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
    rateLimit.bearerFailureWithinLimit.mockResolvedValue(true);
  });

  it("#3142 answers 429 past the failed credential ceiling, and buys none of a refusal's work", async () => {
    rateLimit.bearerFailureWithinLimit.mockResolvedValue(false);
    const out = await authorizeBookingApi(req("Bearer stalekey"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("throttled_credential");
    expect(out.response.status).toBe(429);
    expect(rateLimit.bearerFailureWithinLimit).toHaveBeenCalledWith("203.0.113.7");
    expect(retired.watchRetiredKey).not.toHaveBeenCalled();
    expect(recordedOutcomes()).toEqual([]);
  });

  it("#3142 never asks the failed credential ceiling about a good key", async () => {
    const out = await authorizeBookingApi(req("Bearer goodsecret"));
    expect(out.ok).toBe(true);
    expect(rateLimit.bearerFailureWithinLimit).not.toHaveBeenCalled();
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
    regalKey.primary.mockReturnValue("");
    regalKey.secondary.mockReturnValue("");
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

// #2645: the ceiling and the logs name the CALLER, not the slot. Before the split
// every system shared one key, so "per key" meant per everyone. That pair is retired
// (#2865), so the second caller here is the canary.
describe("authorizeBookingApi caller attribution (#2645)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
      caller === "trypennie"
        ? slot === "primary" ? "trypennie-old" : "trypennie-new"
        : slot !== "primary" ? "" : caller === "regal" ? "regalsecret" : caller === "canary" ? "canarysecret" : "",
    );
    rateLimit.exactCeilingWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  /** Every per key budget the authorizer spent, edge and hourly, as one list. */
  function budgetsSpent() {
    return [
      ...rateLimit.bookingApiWriteWithinLimit.mock.calls.map((c) => `edge:${c[0]}`),
      ...rateLimit.exactCeilingWithinLimit.mock.calls
        .map((c) => (c[0] as { kind: string; key?: string }))
        .filter((c) => c.kind === "opaque")
        .map((c) => `hourly:${c.key}`),
    ];
  }

  it("reports which caller a key belongs to", async () => {
    const out = await authorizeBookingApi(req("Bearer regalsecret"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.caller).toBe("regal");
    expect(out.keyId).toBe("regal:primary");
  });

  it("charges both of one caller's rotation slots to ONE budget", async () => {
    await authorizeBookingApi(req("Bearer trypennie-old"));
    await authorizeBookingApi(req("Bearer trypennie-new"));
    // Per slot would give a caller mid rotation twice its ceiling.
    expect(budgetsSpent().sort()).toEqual(["edge:trypennie", "edge:trypennie", "hourly:key:trypennie", "hourly:key:trypennie"]);
  });

  it("gives each caller its own budget, so one partner cannot spend another's", async () => {
    await authorizeBookingApi(req("Bearer regalsecret"));
    await authorizeBookingApi(req("Bearer canarysecret"));
    expect(budgetsSpent().sort()).toEqual(["edge:canary", "edge:regal", "hourly:key:canary", "hourly:key:regal"]);
  });
});

// #2717: the readiness gate asks whether trypennie's key has authenticated from
// production, and the answer is only as real as the wiring that records it (L3). So
// the real authorizer is driven and what reached the recorder is asserted: a success
// names its caller, method and the request's own headers, and a refusal of any kind
// records nothing, because a key that was refused has not been seen working.
describe("authorizeBookingApi records who authenticated (#2717)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.bookingApiKeyFor.mockImplementation((caller: string, slot: string) =>
      caller === "trypennie" && slot === "primary" ? "trypenniesecret" : "",
    );
    rateLimit.exactCeilingWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  it("records the caller, method and headers of a success", async () => {
    const r = req("Bearer trypenniesecret");
    const out = await authorizeBookingApi(r, undefined, null, true);
    expect(out.ok).toBe(true);
    expect(seen.recordCallerSeen).toHaveBeenCalledTimes(1);
    const [caller, method, headers] = seen.recordCallerSeen.mock.calls[0];
    expect(caller).toBe("trypennie");
    expect(method).toBe("POST");
    expect(headers).toBe(r.headers);
  });

  it("records nothing for a refused key", async () => {
    await authorizeBookingApi(req("Bearer stalekey"));
    expect(seen.recordCallerSeen).not.toHaveBeenCalled();
  });

  // #2868: a probe marker changes only how a SUCCESS is recorded, so a marked call
  // whose key fails auth leaves no row under the caller or under probe:<caller>.
  it("records nothing for a marked probe whose key fails auth", async () => {
    const r = req("Bearer stalekey");
    r.headers.set("x-slate-probe", "key check");
    const out = await authorizeBookingApi(r);
    expect(out.ok).toBe(false);
    expect(seen.recordCallerSeen).not.toHaveBeenCalled();
  });

  it("hands a marked probe that authenticates to the recorder with its headers, so it is recorded as a probe", async () => {
    const r = req("Bearer trypenniesecret");
    r.headers.set("x-slate-probe", "key check");
    const out = await authorizeBookingApi(r);
    expect(out.ok).toBe(true);
    expect(seen.recordCallerSeen).toHaveBeenCalledTimes(1);
    const [, , headers] = seen.recordCallerSeen.mock.calls[0];
    expect((headers as Headers).get("x-slate-probe")).toBe("key check");
  });

  it("records nothing for a good key the ceiling refused", async () => {
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(false);
    await authorizeBookingApi(req("Bearer trypenniesecret"));
    expect(seen.recordCallerSeen).not.toHaveBeenCalled();
  });
});

describe("authorizeBookingApi asks whether a refused key is a retired one (#2879)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.bookingApiKeyFor.mockImplementation(regalKeyFor);
    regalKey.primary.mockReturnValue("goodsecret");
    rateLimit.exactCeilingWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  it("hands a refused, present token to the watcher with the method, path and headers", async () => {
    const r = req("Bearer oldsharedkey");
    const out = await authorizeBookingApi(r);
    expect(retired.watchRetiredKey).toHaveBeenCalledTimes(1);
    const [token, method, path, headers] = retired.watchRetiredKey.mock.calls[0];
    expect(token).toBe("oldsharedkey");
    expect(method).toBe("POST");
    expect(path).toBe("/api/bookings");
    expect(headers).toBe(r.headers);
    // Refused exactly as before: the same 401 and the same body.
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.response.status).toBe(401);
    expect(await out.response.json()).toEqual({ error: "unauthorized" });
  });

  // #3460, #3355 item 1: a confirm starts its early reads (the shared line switch and the
  // pool grouping snapshot) the moment its key is known to be good, so they run during
  // the ceilings' I/O. Never before: a flood of bad keys must not buy a directory call
  // or a switch read per request (L498). Ordered on one injected clock.
  it("#3460 runs the authenticated hook only for a good key, and before the ceilings answer", async () => {
    let clock = 0;
    const at: Record<string, number> = {};
    rateLimit.bookingApiWriteWithinLimit.mockImplementation(async () => {
      at.ceiling = ++clock;
      return true;
    });
    const onAuthenticated = vi.fn(() => {
      at.hook = ++clock;
    });
    const out = await authorizeBookingApi(
      req("Bearer goodsecret"),
      DIRECT_BOOKING_API_HOURLY_RATE_RULES,
      DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
      false,
      FULL_API_CALLERS,
      onAuthenticated,
    );
    expect(out.ok).toBe(true);
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(at.hook).toBeLessThan(at.ceiling!);

    onAuthenticated.mockClear();
    for (const bad of [req("Bearer stalekey"), req()]) {
      await authorizeBookingApi(bad, DIRECT_BOOKING_API_HOURLY_RATE_RULES, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES, false, FULL_API_CALLERS, onAuthenticated);
    }
    rateLimit.bearerFailureWithinLimit.mockResolvedValue(false);
    await authorizeBookingApi(req("Bearer stalekey"), DIRECT_BOOKING_API_HOURLY_RATE_RULES, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES, false, FULL_API_CALLERS, onAuthenticated);
    regalKey.primary.mockReturnValue("");
    await authorizeBookingApi(req("Bearer goodsecret"), DIRECT_BOOKING_API_HOURLY_RATE_RULES, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES, false, FULL_API_CALLERS, onAuthenticated);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("#3529 stamps each step of the ceilings as it answers, so the auth wait can be split", async () => {
    const log: string[] = [];
    rateLimit.bookingApiWriteWithinLimit.mockImplementation(async () => (log.push("key edge"), true));
    rateLimit.exactCeilingWithinLimit.mockImplementation(async (who: unknown) => (log.push((who as { kind: string }).kind === "opaque" ? "key ceiling" : "ip ceiling"), true));
    rateLimit.bookingApiIpWithinLimit.mockImplementation(async () => (log.push("ip edge"), true));
    const onStep = (step: string) => void log.push(`step:${step}`);
    const run = () =>
      authorizeBookingApi(req("Bearer goodsecret"), DIRECT_BOOKING_API_HOURLY_RATE_RULES, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES, false, FULL_API_CALLERS, undefined, onStep);
    expect((await run()).ok).toBe(true);
    // #3124: the two paths run side by side, so only each path's OWN order is fixed: its
    // edge limiter, its step, its exact ceiling, its step. Every step is stamped.
    const keyOrder = log.filter((l) => l.includes("key"));
    const ipOrder = log.filter((l) => l.includes("ip"));
    expect(keyOrder).toEqual(["key edge", "step:key_edge", "key ceiling", "step:key_ceiling"]);
    expect(ipOrder).toEqual(["ip edge", "step:ip_edge", "ip ceiling", "step:ip_ceiling"]);

    // A refusal on its edge limiter stamps that path's edge and asks nothing more of it.
    log.length = 0;
    rateLimit.bookingApiWriteWithinLimit.mockImplementation(async () => (log.push("key edge"), false));
    expect((await run()).ok).toBe(false);
    expect(log.filter((l) => l.includes("key"))).toEqual(["key edge", "step:key_edge"]);
  });

  it("asks nothing for a request with no credential, a good key, or no key configured", async () => {
    await authorizeBookingApi(req());
    await authorizeBookingApi(req("Bearer goodsecret"));
    env.bookingApiKeyFor.mockImplementation(() => "");
    await authorizeBookingApi(req("Bearer oldsharedkey"));
    expect(retired.watchRetiredKey).not.toHaveBeenCalled();
  });
});

// #3124: the per caller and the per address checks run side by side, so a lead whose
// confirm meets a stall on both exact ceilings waits one deadline for the pair, not two
// (#3894 set that deadline at 1s on the premise of one wait). Load run 39510932720 failed
// its confirm startup bar on exactly the sequential sum: 748ms on the key's ceiling, then
// the address's full 1000ms. The ANSWER is decided as before: a key refusal wins.
describe("authorizeBookingApi asks the key and address ceilings side by side (#3124)", () => {
  const STALL_MS = 950;
  const isKey = (who: unknown) => (who as { kind: string }).kind === "opaque";
  const run = (ipRules: typeof DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES | null = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES, r = req("Bearer goodsecret")) =>
    authorizeBookingApi(r, DIRECT_BOOKING_API_HOURLY_RATE_RULES, ipRules, false, FULL_API_CALLERS);

  beforeEach(() => {
    vi.clearAllMocks();
    regalKey.primary.mockReturnValue("goodsecret");
    regalKey.secondary.mockReturnValue("");
    env.bookingApiKeyFor.mockImplementation(regalKeyFor);
    rateLimit.exactCeilingWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiReadWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  it("answers in one deadline when both exact ceilings stall near it, not two", async () => {
    // The stall is a timer on vitest's clock, never a real wait (L524).
    vi.useFakeTimers();
    try {
      rateLimit.exactCeilingWithinLimit.mockImplementation(
        () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STALL_MS)),
      );
      let settled = false;
      const out = run().then((o) => ((settled = true), o));
      await vi.advanceTimersByTimeAsync(STALL_MS);
      expect(settled).toBe(true);
      expect((await out).ok).toBe(true);
      expect(rateLimit.exactCeilingWithinLimit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Every combination of the two exact ceilings' verdicts, so the precedence is pinned
  // where both are asked rather than inferred from the order they used to be asked in.
  it.each([
    { key: true, ip: true, want: "ok" },
    { key: false, ip: true, want: "throttled_key" },
    { key: false, ip: false, want: "throttled_key" },
    { key: true, ip: false, want: "throttled_ip" },
  ])("key ceiling $key and address ceiling $ip answers $want", async ({ key, ip, want }) => {
    rateLimit.exactCeilingWithinLimit.mockImplementation(async (who: unknown) => (isKey(who) ? key : ip));
    const out = await run();
    expect(out.ok ? "ok" : out.reason).toBe(want);
    // One refusal counted, under the reason answered, never one per ceiling that said no.
    expect(recordedOutcomes()).toEqual(want === "ok" ? [] : [want === "throttled_key" ? "refused_ceiling_key" : "refused_ceiling_ip"]);
    if (!out.ok) expect(out.response.status).toBe(429);
  });

  it("asks the address even when the key refuses, which is the counting change #3124 accepts", async () => {
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(false);
    const out = await run();
    expect(out.ok ? "ok" : out.reason).toBe("throttled_key");
    expect(rateLimit.bookingApiIpWithinLimit).toHaveBeenCalledWith("203.0.113.7");
    // Each path keeps its own order: a refused edge never spends its own exact ceiling.
    expect(rateLimit.exactCeilingWithinLimit.mock.calls.map(([who]) => isKey(who))).toEqual([false]);
  });

  it("asks no address at all when the route opts out of the address ceiling", async () => {
    const out = await run(null);
    expect(out.ok).toBe(true);
    expect(rateLimit.bookingApiIpWithinLimit).not.toHaveBeenCalled();
    expect(rateLimit.exactCeilingWithinLimit.mock.calls.map(([who]) => isKey(who))).toEqual([true]);
  });

  it("hands an unreadable address to the address checks to decline, and the key still decides (#1557)", async () => {
    const noAddress = new Request("https://slate.trypennie.app/api/bookings", {
      method: "POST",
      headers: { authorization: "Bearer goodsecret" },
    }) as unknown as Parameters<typeof authorizeBookingApi>[0];
    rateLimit.exactCeilingWithinLimit.mockImplementation(async (who: unknown) => !isKey(who));
    const out = await run(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES, noAddress);
    expect(out.ok ? "ok" : out.reason).toBe("throttled_key");
    expect(rateLimit.bookingApiIpWithinLimit).toHaveBeenCalledWith("unknown");
    expect(rateLimit.exactCeilingWithinLimit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "address", ip: "unknown" }),
      DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
      null,
    );
  });

  it("keeps a key refusal's answer when the address path throws, and throws a key failure as before", async () => {
    rateLimit.exactCeilingWithinLimit.mockImplementation(async (who: unknown) => {
      if (isKey(who)) return false;
      throw new Error("address counter broke");
    });
    const refused = await run();
    expect(refused.ok ? "ok" : refused.reason).toBe("throttled_key");

    rateLimit.exactCeilingWithinLimit.mockImplementation(async (who: unknown) => {
      if (isKey(who)) throw new Error("key counter broke");
      return false;
    });
    await expect(run()).rejects.toThrow("key counter broke");

    rateLimit.exactCeilingWithinLimit.mockImplementation(async (who: unknown) => {
      if (isKey(who)) return true;
      throw new Error("address counter broke");
    });
    await expect(run()).rejects.toThrow("address counter broke");
  });
});

// #3456: the booking API's exact hourly ceilings live in a Durable Object the kept load
// test Worker keeps between runs, so a load run's counts leaked into the next run or arm
// inside the hour. Under SLATE_LOADTEST the counts are scoped to the run that names itself
// on the request; in production the header is never read, so no caller can choose its key.
describe("authorizeBookingApi scopes the exact ceilings to a load run (#3456)", () => {
  const scopesAsked = () => rateLimit.exactCeilingWithinLimit.mock.calls.map((c) => (c as unknown[])[2] ?? null);
  const withRun = (value: string) => {
    const r = req("Bearer goodsecret");
    (r.headers as Headers).set("x-loadtest-run", value);
    return r;
  };
  const withLoadtest = async (value: string | undefined, run: () => Promise<void>) => {
    const saved = process.env.SLATE_LOADTEST;
    if (value === undefined) delete process.env.SLATE_LOADTEST;
    else process.env.SLATE_LOADTEST = value;
    try {
      await run();
    } finally {
      if (saved === undefined) delete process.env.SLATE_LOADTEST;
      else process.env.SLATE_LOADTEST = saved;
    }
  };
  beforeEach(() => {
    vi.clearAllMocks();
    env.bookingApiKeyFor.mockImplementation(regalKeyFor);
    rateLimit.exactCeilingWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiWriteWithinLimit.mockResolvedValue(true);
    rateLimit.bookingApiIpWithinLimit.mockResolvedValue(true);
  });

  it("ignores the header in production, so both ceilings are counted under production's keys", async () => {
    await withLoadtest(undefined, async () => {
      expect((await authorizeBookingApi(withRun("run-1-1"))).ok).toBe(true);
    });
    expect(scopesAsked()).toEqual([null, null]);
  });

  it("scopes both ceilings to the run a load test request names", async () => {
    await withLoadtest("true", async () => {
      expect((await authorizeBookingApi(withRun("run-38933668981-1"))).ok).toBe(true);
    });
    expect(scopesAsked()).toEqual(["run-38933668981-1", "run-38933668981-1"]);
  });

  it("counts a load test request that names no run, or an unreadable one, unscoped", async () => {
    await withLoadtest("true", async () => {
      await authorizeBookingApi(req("Bearer goodsecret"));
      await authorizeBookingApi(withRun("run 1; drop"));
    });
    expect(scopesAsked()).toEqual([null, null, null, null]);
  });
});

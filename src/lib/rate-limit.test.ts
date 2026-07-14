import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #597: allowRequest fails OPEN when the rate_limit_hit RPC errors. That is a
// DELIBERATE choice (a limiter hiccup must never block a real customer's booking,
// and verify-on-book plus the unique-slot index still bound the damage), but it was
// SILENT: the only signal was a console.error, and Cloudflare does not capture those
// in this project. So the limiter could switch itself off across every endpoint and
// nothing, anywhere, would say so.
//
// Fail open, but fail LOUD.

const rpc = vi.hoisted(() => vi.fn());
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
);
const limit = vi.hoisted(() => vi.fn(async (_opts: { key: string }) => ({ success: true })));
const cf = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
const getCloudflareContext = vi.hoisted(() => vi.fn(() => ({ env: cf.env })));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import { allowRequest, refundRequest, availabilityWithinLimit } from "./rate-limit";
import type { RateLimitRule } from "@/lib/rate-limit-core";

const RULES: RateLimitRule[] = [
  { prefix: "test:m", windowSeconds: 60, max: 5 },
  { prefix: "test:h", windowSeconds: 3600, max: 50 },
];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("allowRequest (#597)", () => {
  it("allows a request under the limit", async () => {
    await expect(allowRequest("1.2.3.4", RULES)).resolves.toBe(true);
  });

  it("blocks when a rule is exceeded", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(allowRequest("1.2.3.4", RULES)).resolves.toBe(false);
  });

  // The failure path. Before this, a broken limiter was indistinguishable from a
  // working one.
  it("ALERTS when the limiter itself fails, instead of silently switching off", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });

    const allowed = await allowRequest("1.2.3.4", RULES);

    // Still fails open: a limiter outage must not block real bookings.
    expect(allowed).toBe(true);
    // But it is no longer silent.
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/rate limit/i);
    // The message has to name the failure or nobody can act on it.
    expect(text).toMatch(/relation does not exist/);
  });

  // The alert is best effort. It writes to alert_state, so the very outage that broke
  // the limiter can break the alert too. If that throws into allowRequest, a limiter
  // failure becomes a BOOKING failure, which is the opposite of failing open, and far
  // worse than the problem being fixed.
  it("still allows the request when the alert itself throws", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(allowRequest("1.2.3.4", RULES)).resolves.toBe(true);
  });
});

// The per-IP ceiling on the booking API (#597) was sized on an ASSUMPTION: the auto-booker
// does ~2000/day, so 60/min leaves headroom. Nobody verified how BURSTY it really is. If it
// ever works through a backlog and fires 100 bookings in a minute from one host, we now
// reject real bookings that used to succeed, and #418 (outcome visibility) is unbuilt, so
// today nothing would tell us. Alert the first time that ceiling actually turns someone away.
//
// Deliberately NOT every rule: the public booking limiter (3/min) blocks spammy visitors as
// a matter of course, and alerting on that would be pure noise. Opt in per rule.
describe("alert on block (#796)", () => {
  const LOUD: RateLimitRule[] = [
    { prefix: "bookapi:ip:m", windowSeconds: 60, max: 60, alertOnBlock: true },
  ];
  const QUIET: RateLimitRule[] = [{ prefix: "book:m", windowSeconds: 60, max: 3 }];

  it("alerts when a rule marked alertOnBlock actually blocks", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(allowRequest("203.0.113.9", LOUD)).resolves.toBe(false);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Must name the IP, or nobody can tell our own bot from an attacker.
    expect(text).toMatch(/203\.0\.113\.9/);
  });

  it("stays SILENT when an ordinary rule blocks (a throttled visitor is not an incident)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(allowRequest("203.0.113.9", QUIET)).resolves.toBe(false);

    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("still blocks the request when the alert itself throws", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(allowRequest("203.0.113.9", LOUD)).resolves.toBe(false);
  });
});

// #796: the refund path had the same silent shape as the allow path. When a booking fails
// for a reason that is NOT the customer's fault, Slate hands back their rate-limit budget so
// a server fault cannot eat their allowance (#319). If that refund fails, the customer
// quietly loses budget because of OUR fault and nobody finds out.
describe("refundRequest (#796)", () => {
  const RULES2: RateLimitRule[] = [{ prefix: "book:m", windowSeconds: 60, max: 3 }];

  it("ALERTS when a refund fails instead of only logging", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "refund fn missing" } });

    await refundRequest("1.2.3.4", RULES2);

    expect(sendThrottledAlert).toHaveBeenCalled();
    expect(String(sendThrottledAlert.mock.calls[0]?.[2] ?? "")).toMatch(/refund fn missing/);
  });

  it("never throws, even when the alert itself fails (a refund must not break the response)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(refundRequest("1.2.3.4", RULES2)).resolves.toBeUndefined();
  });
});

// #796, the defect the issue actually names. The availability limiter guards the Booker's
// slot hot path, and it swallowed EVERY failure and returned "allowed". Two ways it can be
// off, both previously invisible:
//
//   1. it throws (the binding is broken, or we are not in a Worker at all), or
//   2. the binding is simply absent, which is one deleted line of wrangler.jsonc away and
//      leaves the endpoint with no throttle at all, forever, saying nothing.
//
// Fail open, as before: a limiter hiccup must never break a legitimate Booker load. But
// fail LOUD, because a rate limiter nobody knows is dead is worse than no rate limiter.
describe("availabilityWithinLimit (#796)", () => {
  // The in-isolate alert gate is time-based, so each test starts past the last one's
  // cooldown rather than reaching into module state to reset it.
  let clock = Date.UTC(2026, 6, 14);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    cf.env = { AVAIL_RATE_LIMITER: { limit } };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a request the limiter permits", async () => {
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("blocks when the limiter says the IP is over, and stays silent (a throttled visitor is not an incident)", async () => {
    limit.mockResolvedValue({ success: false });

    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(false);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("ALERTS when the limiter throws, instead of failing open in silence", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    // Still fails open.
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/availability/i);
    // Name the failure, or nobody can act on it.
    expect(text).toMatch(/limiter unavailable/);
  });

  it("ALERTS when the binding is missing entirely (the throttle is simply OFF)", async () => {
    cf.env = {};

    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    expect(String(sendThrottledAlert.mock.calls[0]?.[2] ?? "")).toMatch(/AVAIL_RATE_LIMITER/);
  });

  // The alert's throttle lives in Postgres (alert_state), so attempting it means a DB
  // round-trip. On THIS path that has teeth: the limiter is most likely to fail under a
  // traffic flood, which is exactly when we must not add a database query to every request
  // and turn a dead limiter into a dead database.
  it("does not re-attempt the alert on every request during a sustained outage", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    for (let i = 0; i < 25; i++) {
      await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);
    }

    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("re-alerts once the cooldown has passed, so a lasting outage is not forgotten", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    await availabilityWithinLimit("1.2.3.4");
    vi.setSystemTime(clock + 31 * 60_000);
    await availabilityWithinLimit("1.2.3.4");

    expect(sendThrottledAlert).toHaveBeenCalledTimes(2);
  });

  it("still allows the request when the alert itself throws", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);
  });
});

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
const isWorkersRuntime = vi.hoisted(() => vi.fn(() => true));
// The marker is REPORTED, never decided on, so the real one is fine here: under
// vitest it reads back node's user agent, which is exactly the value a dev server
// would log.
const workersRuntimeMarker = vi.hoisted(() => () => globalThis.navigator?.userAgent ?? null);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));
// #1525: the fail-open ALERT is gated on actually running on the Workers runtime,
// because the same code path runs under `next dev` against the LIVE alert store, and
// a laptop paging the on-call about a production abuse control being off is a false
// alarm that costs an investigation. Defaults to true here so every existing case
// still asserts production behaviour; the off-platform case sets it false explicitly.
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime, workersRuntimeMarker }));

import {
  allowRequest,
  refundRequest,
  availabilityWithinLimit,
  bookingWithinLimit,
  routingWithinLimit,
  bookingApiWriteWithinLimit,
  bookingApiIpWithinLimit,
  bookingApiReadWithinLimit,
} from "./rate-limit";
import type { RateLimitRule } from "@/lib/rate-limit-core";
import { UNIDENTIFIED_IP } from "@/lib/rate-limit-core";
import {
  BURST_CEILING_PER_MINUTE,
  BURST_ESCALATE_AT,
} from "@/lib/rate-limit-burst";

const RULES: RateLimitRule[] = [
  { prefix: "test:m", windowSeconds: 60, max: 5 },
  { prefix: "test:h", windowSeconds: 3600, max: 50 },
];

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: true, error: null });
  isWorkersRuntime.mockReturnValue(true);
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
  it("ALERTS in plain language, keeping the raw error to the logs, when the limiter fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const allowed = await allowRequest("1.2.3.4", RULES);

    // Still fails open: a limiter outage must not block real bookings.
    expect(allowed).toBe(true);
    // But it is no longer silent.
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/rate limit/i);
    // The customer-facing Slack line must NOT leak the raw DB error to a
    // non-technical on-call (the readability defect the user reported)...
    expect(text).not.toMatch(/relation does not exist/);
    // ...but the cause is still recoverable, from the server logs.
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/relation does not exist/);
    consoleErr.mockRestore();
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

  it("ALERTS in plain language, keeping the raw error to the logs, when a refund fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "refund fn missing" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await refundRequest("1.2.3.4", RULES2);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/allowance|refund/i);
    expect(text).not.toMatch(/refund fn missing/);
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/refund fn missing/);
    consoleErr.mockRestore();
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
/**
 * The shared burst counter (#1536), as a Durable Object namespace fake.
 *
 * `burstCount` is what the object answers, so a test can put an address over the ceiling
 * without driving hundreds of requests through the escalation threshold first.
 */
let burstCount = 1;
let burstFetches = 0;
const burstNamespace = () => ({
  idFromName: (name: string) => ({ name }),
  get: () => ({
    fetch: async () => {
      burstFetches += 1;
      return new Response(JSON.stringify({ count: burstCount }), {
        headers: { "content-type": "application/json" },
      });
    },
  }),
});

describe("availabilityWithinLimit (#796)", () => {
  // The in-isolate alert gate is time-based, so each test starts past the last one's
  // cooldown rather than reaching into module state to reset it.
  let clock = Date.UTC(2026, 6, 14);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    // BOTH bindings, because production binds both and a fake that binds one is a fake
    // that agrees with an assumption nothing checks (L143): with the burst namespace
    // absent, every case here would run through the missing-binding alarm instead of
    // through the path it names.
    burstCount = 1;
    cf.env = { AVAIL_RATE_LIMITER: { limit }, AVAIL_BURST_LIMITER: burstNamespace() };
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

  // --- the second ceiling (#1536) ---------------------------------------------
  // The decision logic is pinned in scripts/test-burst-ceiling.ts against an injected
  // counter. What can only be checked HERE is the wiring: that the availability path
  // actually reaches it, that a refusal from it refuses the request, and that a counter
  // we cannot reach fails open and loud like every other limiter on this path (L3: built
  // is not wired, and wired is not proven).

  it("costs no round trip to the shared counter on an ordinary request", async () => {
    burstFetches = 0;
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);
    expect(burstFetches).toBe(0);
  });

  it("refuses a request once the shared counter puts the address past the ceiling", async () => {
    burstCount = BURST_CEILING_PER_MINUTE + 1;
    let allowed = true;
    // Past the escalation threshold, which is where the shared counter is consulted at all.
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
      allowed = await availabilityWithinLimit("9.9.9.9");
    }
    expect(allowed).toBe(false);
    // And a throttled visitor is still not an incident, exactly as for the edge check.
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("serves the request, loudly, when the shared counter cannot be reached", async () => {
    cf.env = {
      AVAIL_RATE_LIMITER: { limit },
      AVAIL_BURST_LIMITER: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          fetch: async () => new Response("nope", { status: 500 }),
        }),
      },
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    let allowed = false;
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
      allowed = await availabilityWithinLimit("8.8.8.8");
    }
    expect(allowed).toBe(true);
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Plain language, no internal binding name, same contract as the edge limiter's.
    expect(text).toMatch(/availability/i);
    expect(text).not.toMatch(/AVAIL_BURST_LIMITER/);
    consoleErr.mockRestore();
  });

  it("serves the request, loudly, when the burst binding is missing entirely", async () => {
    cf.env = { AVAIL_RATE_LIMITER: { limit } };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    // wrangler.jsonc always binds it, so absent means broken rather than unconfigured, and
    // the specific cause is still recoverable from the logs.
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/AVAIL_BURST_LIMITER/);
    consoleErr.mockRestore();
  });

  it("declines to judge a request with no identifiable address, and says so", async () => {
    // "unknown" is a SHARED bucket, not an address: counting unrelated callers against one
    // counter would turn a per-address ceiling into a global one, and the first thing it
    // would refuse is real leads (L75). Behind Cloudflare this cannot happen, which is
    // exactly why reaching it is worth reporting.
    burstFetches = 0;
    burstCount = BURST_CEILING_PER_MINUTE + 1;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    let allowed = false;
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
      allowed = await availabilityWithinLimit(UNIDENTIFIED_IP);
    }
    expect(allowed).toBe(true);
    expect(burstFetches).toBe(0);
    expect(sendThrottledAlert).toHaveBeenCalled();
    consoleErr.mockRestore();
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
    // The Slack line stays plain: the raw Error (in dev, a Next.js config stack
    // trace) must never reach a non-technical on-call. The cause is in the logs.
    expect(text).not.toMatch(/limiter unavailable/);
  });

  it("ALERTS when the binding is missing entirely (the throttle is simply OFF)", async () => {
    cf.env = {};

    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Plain-language impact, no internal binding name in the customer-facing line.
    expect(text).toMatch(/availability/i);
    expect(text).not.toMatch(/AVAIL_RATE_LIMITER/);
    // The specific cause (the missing binding) is still recoverable from the logs.
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/AVAIL_RATE_LIMITER/);
    consoleErr.mockRestore();
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

  // #1525. On 2026-08-17 `rate_limit_broken:availability` paged at 14:44 UTC saying the
  // only abuse control on the one endpoint anybody on the internet can reach was OFF.
  // Production's limiter was enforcing correctly the whole time (measured: 45 sequential
  // requests over one socket, the first 29 served and #30 onward 429), and Cloudflare's
  // logs held ZERO `tag=rate-limit` lines across the window while the positive control
  // (`tag=recompute`) returned 101. The alert came from a machine running `next dev`:
  // next.config.ts does not call initOpenNextCloudflareForDev, so getCloudflareContext
  // THROWS there, and .env.local points at the live alert store and the live Slack channel.
  //
  // Off the Workers runtime there is no limiter to be broken and no production request
  // being served, so the claim the alert makes is not just unproven, it is not even
  // about anything. It must not be made (L36: an alert that cries wolf gets ignored).
  it("#1525 does NOT page when there is no Cloudflare platform at all (a dev server)", async () => {
    isWorkersRuntime.mockReturnValue(false);
    getCloudflareContext.mockImplementation(() => {
      throw new Error("`getCloudflareContext` has been called without having called `initOpenNextCloudflareForDev`");
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    // Still fails open: dev must keep working.
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).not.toHaveBeenCalled();
    // Silent to Slack, never silent full stop, and it says WHICH cause this is rather
    // than borrowing the production outage wording (L11).
    const logged = JSON.stringify(consoleErr.mock.calls);
    expect(logged).toMatch(/not running on the Cloudflare runtime/i);
    expect(logged).not.toMatch(/failing open/);
    consoleErr.mockRestore();
  });

  // The other half, and the reason the gate is a runtime check rather than a match on the
  // error text: ON the platform, an unreadable context means the throttle really is off
  // for requests we are really serving, and that must still page.
  it("#1525 DOES page when the platform is Cloudflare and the context cannot be read", async () => {
    getCloudflareContext.mockImplementation(() => {
      throw new Error("context unavailable");
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  // #1525 asked the reader to "check the Cloudflare logs for tag=rate-limit". That
  // instruction only works if the log records the outage. It did not: the log line sat
  // BELOW the 30-minute alert gate, so a sustained outage wrote one line per isolate per
  // half hour and the logs undercounted it by orders of magnitude. The DB round-trip is
  // what needed bounding on a hot path, not a console line.
  it("#1525 logs every fail-open, not only the ones that clear the alert cooldown", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await availabilityWithinLimit("1.2.3.4");
    vi.setSystemTime(clock + 11_000);
    await availabilityWithinLimit("1.2.3.4");
    vi.setSystemTime(clock + 22_000);
    await availabilityWithinLimit("1.2.3.4");

    // One alert (the DB round-trip stays bounded)...
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    // ...but three records of the outage.
    const failOpenLines = consoleErr.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("limiter failing open"),
    );
    expect(failOpenLines).toHaveLength(3);
    consoleErr.mockRestore();
  });

  // The log is throttled too, just far more loosely, because a limiter is likeliest to
  // fail under the very flood it exists to absorb and an unbounded line per request is a
  // second outage. Bounded per isolate per area, not per 30 minutes.
  it("#1525 still bounds the log, so a flood cannot write a line per request", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 40; i++) await availabilityWithinLimit("1.2.3.4");

    const failOpenLines = consoleErr.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("limiter failing open"),
    );
    expect(failOpenLines).toHaveLength(1);
    consoleErr.mockRestore();
  });
});

describe("bookingWithinLimit (#237)", () => {
  // Same edge-limiter contract as availability: the public booking per-minute
  // burst window (#237) moved off the DB onto the BOOKING_RATE_LIMITER binding.
  let clock = Date.UTC(2026, 6, 20);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    cf.env = { BOOKING_RATE_LIMITER: { limit } };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a request the limiter permits", async () => {
    await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(true);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("blocks when the limiter says the IP is over, and stays silent", async () => {
    limit.mockResolvedValue({ success: false });
    await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(false);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("fails OPEN and ALERTS in plain language when the limiter throws", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/booking/i);
    expect(text).not.toMatch(/limiter unavailable/);
  });

  it("fails OPEN and ALERTS when the binding is missing, keeping the binding name out of the alert", async () => {
    cf.env = {};
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(true);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).not.toMatch(/BOOKING_RATE_LIMITER/);
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/BOOKING_RATE_LIMITER/);
    consoleErr.mockRestore();
  });

  it("does not re-attempt the alert on every request during a sustained outage", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));
    for (let i = 0; i < 25; i++) {
      await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(true);
    }
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });
});

// #961: the routing-preview and direct booking API per-minute burst windows moved
// off the DB onto their own Workers rate-limit bindings, mirroring the availability
// and public-booking edge limiters. Same fail-open + fail-loud contract; the two
// per-KEY booking-API windows key on the API key id rather than the IP, and the
// per-IP backstop additionally ALERTS when it blocks (a block there is a signal
// that the ceiling is too tight or a key leaked, #597/#796).
describe("edge per-minute limiters (#961)", () => {
  let clock = Date.UTC(2026, 6, 21);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routingWithinLimit allows, blocks silently, and fails open + alerts when it throws", async () => {
    cf.env = { ROUTING_RATE_LIMITER: { limit } };
    await expect(routingWithinLimit("1.2.3.4")).resolves.toBe(true);
    expect(sendThrottledAlert).not.toHaveBeenCalled();

    limit.mockResolvedValueOnce({ success: false });
    await expect(routingWithinLimit("1.2.3.4")).resolves.toBe(false);
    expect(sendThrottledAlert).not.toHaveBeenCalled();

    limit.mockRejectedValueOnce(new Error("limiter unavailable"));
    await expect(routingWithinLimit("1.2.3.4")).resolves.toBe(true); // fail open
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/routing/i);
    expect(text).not.toMatch(/limiter unavailable/);
  });

  it("bookingApiWriteWithinLimit keys on the API key id and blocks SILENTLY (a per-key throttle is not an incident)", async () => {
    cf.env = { BOOKINGAPI_RATE_LIMITER: { limit } };
    await expect(bookingApiWriteWithinLimit("primary")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "primary" });

    limit.mockResolvedValueOnce({ success: false });
    await expect(bookingApiWriteWithinLimit("primary")).resolves.toBe(false);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("bookingApiReadWithinLimit keys on the API key id (its own binding, separate from writes)", async () => {
    cf.env = { BOOKINGAPI_READ_RATE_LIMITER: { limit } };
    await expect(bookingApiReadWithinLimit("secondary")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "secondary" });
  });

  it("bookingApiIpWithinLimit ALERTS in plain language when it blocks, naming the IP (#796)", async () => {
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit } };
    limit.mockResolvedValue({ success: false });

    await expect(bookingApiIpWithinLimit("203.0.113.9")).resolves.toBe(false);

    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Names the IP so nobody can't tell our own bot from an attacker, states the
    // window in plain words, and never leaks the internal binding name.
    expect(text).toMatch(/203\.0\.113\.9/);
    expect(text).toMatch(/per minute/);
    expect(text).not.toMatch(/BOOKINGAPI_IP_RATE_LIMITER/);
  });

  it("bookingApiIpWithinLimit stays silent when the limiter permits the request", async () => {
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit } };
    await expect(bookingApiIpWithinLimit("203.0.113.9")).resolves.toBe(true);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("bookingApiIpWithinLimit still BLOCKS even when the block alert itself throws", async () => {
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit } };
    limit.mockResolvedValue({ success: false });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(bookingApiIpWithinLimit("203.0.113.9")).resolves.toBe(false);
  });
});

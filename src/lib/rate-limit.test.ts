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

// #3364: the retry credit reads its earned row directly, so the client also answers
// `from(...).select(...).eq(...).maybeSingle()`, resolving to whatever `earnedRow` says.
const earnedRow = vi.hoisted(() => ({
  read: vi.fn(async (_key: string): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null })),
}));
const from = vi.hoisted(() =>
  vi.fn((_table: string) => ({
    select: (_cols: string) => ({
      eq: (_col: string, key: string) => ({ maybeSingle: () => earnedRow.read(key) }),
    }),
  })),
);
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ rpc, from }) }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));
// #1525: the fail-open ALERT is gated on actually running on the Workers runtime,
// because the same code path runs under `next dev` against the LIVE alert store, and
// a laptop paging the on-call about a production abuse control being off is a false
// alarm that costs an investigation. Defaults to true here so every existing case
// still asserts production behaviour; the off-platform case sets it false explicitly.
vi.mock("@/lib/platform/runtime", () => ({ isWorkersRuntime, workersRuntimeMarker }));
// #3145: work handed to `after()` is QUEUED here and run only by `flushAfter`, the
// way the platform runs it once the response has gone, so a test can tell work done
// inside the request from work deferred past it.
const afterQueue = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn);
  },
}));
async function flushAfter(): Promise<void> {
  while (afterQueue.length > 0) await afterQueue.shift()!();
}
/** For the cases where the send itself fails: run the deferred page, which must resolve
 *  rather than reject (a monitoring failure never escapes), and return what was logged so
 *  the case can show the failure was recorded rather than lost. */
async function flushFailedSend(): Promise<string> {
  const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(flushAfter()).resolves.toBeUndefined();
    // An Error serializes to {} under JSON.stringify, so its message is spelled out.
    return JSON.stringify(consoleErr.mock.calls, (_k, v: unknown) =>
      v instanceof Error ? `Error: ${v.message}` : v,
    );
  } finally {
    consoleErr.mockRestore();
  }
}

import {
  allowRequest,
  refundRequest,
  availabilityWithinLimit,
  bookingWithinLimit,
  routingWithinLimit,
  bookingApiWriteWithinLimit,
  bookingApiIpWithinLimit,
  bookingApiReadWithinLimit,
  manageWithinLimit,
  landingIdentityAllowed,
  callMeNowAllowed,
  bearerFailureWithinLimit,
  grantBookingRetryCredit,
  bookingRetryCredit,
  exactCeilingWithinLimit,
  EXACT_CEILING_DEADLINE_MS,
  resetLimiterAlertGatesForTests,
} from "./rate-limit";
import {
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  friendlyRateArea,
  limiterFailOpenAlert,
  refundFailedAlert,
  LIMITER_FAIL_OPEN_PAGE_AFTER,
  LIMITER_FAIL_OPEN_WINDOW_MS,
  LANDING_LIMITER,
  LANDING_IDENTITY_HOURLY_RATE_RULES,
  type RateLimitRule,
} from "@/lib/rate-limit-core";
import {
  BURST_ESCALATE_AT,
  BURST_MEMO_MS,
  burstEscalateAt,
  applyCounterRequest,
  exactCeilingKey,
  readCounterRequest,
  type CounterWindow,
} from "@/lib/rate-limit-burst";
import { insideCallBudget, withinCallBudget } from "@/lib/call-budget";
import {
  UNIDENTIFIED_IP,
  AVAILABILITY_LIMITER,
  BOOKING_LIMITER,
  BOOKING_API_WRITE_LIMITER,
  BOOKING_API_IP_LIMITER,
  BOOKING_API_READ_LIMITER,
  CLIENT_ERROR_ADDRESS_POLICY,
  EDGE_LIMITERS,
} from "@/lib/rate-limit-core";

/** #3670: a single fail open pages nothing, so a case about the PAGE drives the sustained run
 *  that raises one: the threshold's worth of the same failure, inside the window. Returns the
 *  last answer, which every one of them shares. */
async function sustained<T>(call: () => Promise<T>): Promise<T> {
  let last!: T;
  for (let i = 0; i < LIMITER_FAIL_OPEN_PAGE_AFTER; i++) last = await call();
  return last;
}

const RULES: RateLimitRule[] = [
  { prefix: "test:m", windowSeconds: 60, max: 5 },
  { prefix: "test:h", windowSeconds: 3600, max: 50 },
];

/** An identified caller: the ordinary case every test below is about. The
 *  unidentified one has its own describe block (#1557). */
const ADDRESS = { kind: "address", ip: "1.2.3.4", policy: BOOKING_LIMITER } as const;

beforeEach(() => {
  vi.clearAllMocks();
  afterQueue.length = 0;
  resetLimiterAlertGatesForTests();
  // clearAllMocks keeps implementations, so a case that sets a lasting answer for the earned
  // row read (the sustained retry credit case, #3670) would otherwise leak it into every later
  // case that reads the row without its own once answer.
  earnedRow.read.mockResolvedValue({ data: null, error: null });
  rpc.mockResolvedValue({ data: true, error: null });
  isWorkersRuntime.mockReturnValue(true);
});

describe("allowRequest (#597)", () => {
  it("allows a request under the limit", async () => {
    await expect(allowRequest(ADDRESS, RULES)).resolves.toBe(true);
  });

  it("blocks when a rule is exceeded", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(allowRequest(ADDRESS, RULES)).resolves.toBe(false);
  });

  // The failure path. Before this, a broken limiter was indistinguishable from a
  // working one.
  it("ALERTS in plain language, keeping the raw error to the logs, when the limiter fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    const allowed = await sustained(() => allowRequest(ADDRESS, RULES));

    // Still fails open: a limiter outage must not block real bookings.
    expect(allowed).toBe(true);
    // But it is no longer silent.
    await flushAfter();
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

    await expect(sustained(() => allowRequest(ADDRESS, RULES))).resolves.toBe(true);
    const logged = await flushFailedSend();
    expect(sendThrottledAlert).toHaveBeenCalled();
    expect(logged).toMatch(/alert failed/);
    expect(logged).toMatch(/alert store unreachable/);
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
  const LOUD_CALLER = {
    kind: "address",
    ip: "203.0.113.9",
    keyPrefix: "ip:",
    policy: BOOKING_API_IP_LIMITER,
  } as const;

  it("alerts when a rule marked alertOnBlock actually blocks", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(allowRequest(LOUD_CALLER, LOUD)).resolves.toBe(false);

    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Must name the IP, or nobody can tell our own bot from an attacker.
    expect(text).toMatch(/203\.0\.113\.9/);
  });

  it("stays SILENT when an ordinary rule blocks (a throttled visitor is not an incident)", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(allowRequest(LOUD_CALLER, QUIET)).resolves.toBe(false);

    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("still blocks the request when the alert itself throws", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(allowRequest(LOUD_CALLER, LOUD)).resolves.toBe(false);
    const logged = await flushFailedSend();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(logged).toMatch(/alert failed/);
    expect(logged).toMatch(/alert store unreachable/);
  });
});

// #1557: a caller we cannot identify. `clientIp` falls back to a literal when no address
// header is present, and that value is a SHARED bucket: counting every such request against
// one counter turns a per address ceiling into a global one, and the first thing a
// global-by-accident ceiling refuses is a real lead. The answer is per limit, because
// refusing is right for the client error beacon and wrong for the booking confirm.
describe("a caller with no address (#1557)", () => {
  const RULES3: RateLimitRule[] = [{ prefix: "book:h", windowSeconds: 3600, max: 10 }];
  const unidentified = (policy: typeof BOOKING_LIMITER | typeof CLIENT_ERROR_ADDRESS_POLICY) =>
    ({ kind: "address", ip: UNIDENTIFIED_IP, policy }) as const;

  it("never counts one into the shared bucket, whichever way the limit answers", async () => {
    await allowRequest(unidentified(BOOKING_LIMITER), RULES3);
    await allowRequest(unidentified(CLIENT_ERROR_ADDRESS_POLICY), RULES3);
    // The defect IS the counting. Neither answer may touch a counter, or the ceiling is
    // still global for every caller we could not read.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("serves one on the booking confirm, because refusing one refuses a customer", async () => {
    await expect(allowRequest(unidentified(BOOKING_LIMITER), RULES3)).resolves.toBe(true);
  });

  it("refuses one on the client error beacon, which fails closed", async () => {
    await expect(allowRequest(unidentified(CLIENT_ERROR_ADDRESS_POLICY), RULES3)).resolves.toBe(
      false,
    );
  });

  // Behind Cloudflare this cannot happen, so it is news either way: a ceiling that has
  // quietly stopped applying looks exactly like a ceiling nobody is hitting.
  it("reports it rather than handling it in silence", async () => {
    await allowRequest(unidentified(BOOKING_LIMITER), RULES3);
    await flushAfter();
    const call = sendThrottledAlert.mock.calls.find((c) =>
      String(c[0]).startsWith("rate_limit_unidentified:"),
    );
    expect(call).toBeDefined();
    expect(String(call?.[2])).toMatch(/no client address/i);
  });

  it("gives nothing back on a refund, because nothing was ever counted", async () => {
    await refundRequest(unidentified(BOOKING_LIMITER), RULES3);
    expect(rpc).not.toHaveBeenCalled();
  });

  // An API key id came out of authentication, so the address rule must not reach it: an
  // integrator who happened to name a key with the fallback value would otherwise be the
  // one caller never counted at all.
  it("still counts an opaque key that merely looks like the fallback", async () => {
    await expect(
      allowRequest({ kind: "opaque", key: `key:${UNIDENTIFIED_IP}` }, RULES3),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalled();
  });

  it("does not consult the edge limiter for one either", async () => {
    await expect(bookingWithinLimit(UNIDENTIFIED_IP)).resolves.toBe(true);
    expect(limit).not.toHaveBeenCalled();
  });
});

// #796: the refund path had the same silent shape as the allow path. When a booking fails
// for a reason that is NOT the customer's fault, Slate hands back their rate-limit budget so
// a server fault cannot eat their allowance (#319). If that refund fails, the customer
// quietly loses budget because of OUR fault and nobody finds out.
// #3364: a lead refused for a taken time earns a bounded retry past the edge minute window.
// The decision and its bound are pinned in scripts/test-booking-retry-credit.ts; what is
// driven here is the wiring to rate_limits and the failure paths, which must keep the 429
// (the behaviour before this existed) and say so.
describe("the booking retry credit (#3364)", () => {
  const nowIso = () => new Date().toISOString();

  it("earns a credit through rate_limit_hit under the address's earned key", async () => {
    await grantBookingRetryCredit("198.51.100.20");
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "book:retry:earned:198.51.100.20",
      p_window_seconds: 60,
      p_max: 3,
    });
  });

  it("lets a refused address through by spending a live credit", async () => {
    earnedRow.read.mockResolvedValueOnce({ data: { count: 2, window_start: nowIso() }, error: null });
    rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(bookingRetryCredit("198.51.100.21")).resolves.toBe("allowed");
    expect(from).toHaveBeenCalledWith("rate_limits");
    expect(earnedRow.read).toHaveBeenCalledWith("book:retry:earned:198.51.100.21");
    // The spend ceiling is what was earned, never more.
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "book:retry:spent:198.51.100.21",
      p_window_seconds: 60,
      p_max: 2,
    });
  });

  it("refuses an address with no credit, and spends nothing", async () => {
    earnedRow.read.mockResolvedValueOnce({ data: null, error: null });
    await expect(bookingRetryCredit("198.51.100.22")).resolves.toBe("no-credit");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses once every credit is spent", async () => {
    earnedRow.read.mockResolvedValueOnce({ data: { count: 3, window_start: nowIso() }, error: null });
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(bookingRetryCredit("198.51.100.23")).resolves.toBe("spent");
  });

  // The failure paths: the exemption fails CLOSED, so the lead keeps the 429 they would
  // have had anyway, and LOUD, so a credit that has quietly stopped working is heard.
  it("keeps the 429 and alerts, raw error to the logs only, when the earned row cannot be read", async () => {
    earnedRow.read.mockResolvedValue({ data: null, error: { message: "permission denied for rate_limits" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    // A different address each time: the credit's own in isolate gate answers a repeat from
    // one address without reading, so only distinct callers make a sustained run of reads.
    let n = 0;
    await expect(sustained(() => bookingRetryCredit(`198.51.100.${40 + n++}`))).resolves.toBe("unreadable");
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("rate_limit_refund_broken:book:retry:spent");
    expect(text).not.toMatch(/permission denied/);
    // An Error serializes to {} under JSON.stringify, so its message is spelled out.
    const logged = JSON.stringify(consoleErr.mock.calls, (_k, v: unknown) =>
      v instanceof Error ? `Error: ${v.message}` : v,
    );
    expect(logged).toMatch(/permission denied/);
    consoleErr.mockRestore();
  });

  it("keeps the 429 when the stored window stamp is unreadable, rather than counting it live", async () => {
    earnedRow.read.mockResolvedValueOnce({ data: { count: 3, window_start: "not a time" }, error: null });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(bookingRetryCredit("198.51.100.25")).resolves.toBe("unreadable");
    expect(rpc).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("keeps the 429 when the spend fails", async () => {
    earnedRow.read.mockResolvedValueOnce({ data: { count: 1, window_start: nowIso() }, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(bookingRetryCredit("198.51.100.26")).resolves.toBe("unreadable");
    consoleErr.mockRestore();
  });

  it("never throws when earning fails, and alerts on the earned key", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sustained(() => grantBookingRetryCredit("198.51.100.27"))).resolves.toBeUndefined();
    await flushAfter();
    expect(sendThrottledAlert.mock.calls[0]?.[0]).toBe("rate_limit_refund_broken:book:retry:earned");
    consoleErr.mockRestore();
  });

  it("neither earns nor spends for a caller with no address, who was never counted", async () => {
    await grantBookingRetryCredit(UNIDENTIFIED_IP);
    await expect(bookingRetryCredit(UNIDENTIFIED_IP)).resolves.toBe("unjudged");
    expect(rpc).not.toHaveBeenCalled();
    expect(earnedRow.read).not.toHaveBeenCalled();
  });
});

describe("refundRequest (#796)", () => {
  const RULES2: RateLimitRule[] = [{ prefix: "book:m", windowSeconds: 60, max: 3 }];

  it("ALERTS in plain language, keeping the raw error to the logs, when a refund fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "refund fn missing" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await sustained(() => refundRequest(ADDRESS, RULES2));

    await flushAfter();
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

    await expect(sustained(() => refundRequest(ADDRESS, RULES2))).resolves.toBeUndefined();
    const logged = await flushFailedSend();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(logged).toMatch(/alert failed/);
    expect(logged).toMatch(/alert store unreachable/);
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
  // cooldown rather than reaching into module state to reset it. Two hours, not one: a
  // case here moves its own clock 31 minutes on, and an hour after that lands inside the
  // 30 minute cooldown it stamped, so the next case would attempt no send at all and every
  // assertion that nothing was sent would pass without being tested (#3145).
  let clock = Date.UTC(2026, 6, 14);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 2 * 60 * 60_000;
    vi.setSystemTime(clock);
    // BOTH bindings, because production binds both and a fake that binds one is a fake
    // that agrees with an assumption nothing checks (L143): with the burst namespace
    // absent, every case here would run through the missing-binding alarm instead of
    // through the path it names.
    burstCount = 1;
    cf.env = { AVAIL_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a request the limiter permits", async () => {
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);
    await flushAfter();
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
    burstCount = AVAILABILITY_LIMITER.burstCeilingPerMinute + 1;
    let allowed = true;
    // Past the escalation threshold, which is where the shared counter is consulted at all.
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
      allowed = await availabilityWithinLimit("9.9.9.9");
    }
    expect(allowed).toBe(false);
    // And a throttled visitor is still not an incident, exactly as for the edge check.
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("serves the request, loudly, when the shared counter cannot be reached", async () => {
    cf.env = {
      AVAIL_RATE_LIMITER: { limit },
      BURST_LIMITER: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          fetch: async () => new Response("nope", { status: 500 }),
        }),
      },
    };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    let allowed = false;
    // Past escalation, where the counter is asked at all, and then a sustained run of it
    // (#3670), one memo period apart so each one really asks rather than reusing the last answer.
    for (let i = 0; i < BURST_ESCALATE_AT + LIMITER_FAIL_OPEN_PAGE_AFTER; i++) {
      vi.setSystemTime(clock + i * BURST_MEMO_MS);
      allowed = await availabilityWithinLimit("8.8.8.8");
    }
    expect(allowed).toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Plain language, no internal binding name, same contract as the edge limiter's.
    expect(text).toMatch(/availability/i);
    expect(text).not.toMatch(/BURST_LIMITER/);
    consoleErr.mockRestore();
  });

  // #3145 (L1017). The counter's failure is noticed inside the request, which on the
  // booking confirm runs under the lead's call budget. A page sent from there inherits
  // that budget: when the counter was slow to fail, the budget is spent and the page's
  // own alert_state read fails at once, so the outage is never said. And as a bare
  // float it is not kept alive past the response at all. So the page goes after the
  // response and outside the budget, as the Google breaker's does (#3134).
  it("pages about an unreachable counter after the response, outside the lead's budget", async () => {
    cf.env = {
      AVAIL_RATE_LIMITER: { limit },
      BURST_LIMITER: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
      },
    };
    const inBudget: boolean[] = [];
    sendThrottledAlert.mockImplementation(async () => {
      inBudget.push(insideCallBudget());
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await withinCallBudget(12_000, "the booking confirm", async () => {
      for (let i = 0; i < BURST_ESCALATE_AT + LIMITER_FAIL_OPEN_PAGE_AFTER; i++) {
        vi.setSystemTime(clock + i * BURST_MEMO_MS);
        await expect(availabilityWithinLimit("7.7.7.7")).resolves.toBe(true);
      }
      // Nothing is sent while the request is still answering...
      expect(sendThrottledAlert).not.toHaveBeenCalled();
    });
    // ...it was handed to after(), which keeps it alive past the response.
    expect(afterQueue.length).toBe(1);
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(inBudget).toEqual([false]);
    consoleErr.mockRestore();
  });

  it("serves the request, loudly, when the burst binding is missing entirely", async () => {
    cf.env = { AVAIL_RATE_LIMITER: { limit } };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sustained(() => availabilityWithinLimit("1.2.3.4"))).resolves.toBe(true);

    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalled();
    // wrangler.jsonc always binds it, so absent means broken rather than unconfigured, and
    // the specific cause is still recoverable from the logs.
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/BURST_LIMITER/);
    consoleErr.mockRestore();
  });

  it("declines to judge a request with no identifiable address, and says so", async () => {
    // "unknown" is a SHARED bucket, not an address: counting unrelated callers against one
    // counter would turn a per-address ceiling into a global one, and the first thing it
    // would refuse is real leads (L75). Behind Cloudflare this cannot happen, which is
    // exactly why reaching it is worth reporting.
    burstFetches = 0;
    burstCount = AVAILABILITY_LIMITER.burstCeilingPerMinute + 1;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    let allowed = false;
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
      allowed = await availabilityWithinLimit(UNIDENTIFIED_IP);
    }
    expect(allowed).toBe(true);
    expect(burstFetches).toBe(0);
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("blocks when the limiter says the IP is over, and stays silent (a throttled visitor is not an incident)", async () => {
    limit.mockResolvedValue({ success: false });

    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(false);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("ALERTS when the limiter throws, instead of failing open in silence", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    // Still fails open.
    await expect(sustained(() => availabilityWithinLimit("1.2.3.4"))).resolves.toBe(true);

    await flushAfter();
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
    await expect(sustained(() => availabilityWithinLimit("1.2.3.4"))).resolves.toBe(true);

    await flushAfter();
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

    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
  });

  it("re-alerts once the cooldown has passed, so a lasting outage is not forgotten", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    await sustained(() => availabilityWithinLimit("1.2.3.4"));
    vi.setSystemTime(clock + 31 * 60_000);
    await sustained(() => availabilityWithinLimit("1.2.3.4"));

    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(2);
  });

  it("still allows the request when the alert itself throws", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(sustained(() => availabilityWithinLimit("1.2.3.4"))).resolves.toBe(true);
    const logged = await flushFailedSend();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(logged).toMatch(/alert failed/);
    expect(logged).toMatch(/alert store unreachable/);
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

    await flushAfter();
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

    await expect(sustained(() => availabilityWithinLimit("1.2.3.4"))).resolves.toBe(true);

    await flushAfter();
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

    for (let i = 0; i < LIMITER_FAIL_OPEN_PAGE_AFTER; i++) {
      vi.setSystemTime(clock + i * 11_000);
      await availabilityWithinLimit("1.2.3.4");
    }

    // One alert (the DB round-trip stays bounded)...
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    // ...but a record of every one of them, each counting the run so far (#3670).
    const failOpenLines = consoleErr.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("limiter failing open"),
    );
    expect(failOpenLines).toHaveLength(LIMITER_FAIL_OPEN_PAGE_AFTER);
    expect(String(failOpenLines.at(-1)?.[0])).toMatch(new RegExp(`in_window=${LIMITER_FAIL_OPEN_PAGE_AFTER}\\b`));
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
    burstCount = 1;
    cf.env = { BOOKING_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a request the limiter permits", async () => {
    await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("blocks when the limiter says the IP is over, and stays silent", async () => {
    limit.mockResolvedValue({ success: false });
    await expect(bookingWithinLimit("1.2.3.4")).resolves.toBe(false);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("fails OPEN and ALERTS in plain language when the limiter throws", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));

    await expect(sustained(() => bookingWithinLimit("1.2.3.4"))).resolves.toBe(true);

    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/booking/i);
    expect(text).not.toMatch(/limiter unavailable/);
  });

  it("fails OPEN and ALERTS when the binding is missing, keeping the binding name out of the alert", async () => {
    cf.env = {};
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sustained(() => bookingWithinLimit("1.2.3.4"))).resolves.toBe(true);

    await flushAfter();
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
    await flushAfter();
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
    burstCount = 1;
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routingWithinLimit allows, blocks silently, and fails open + alerts when it throws", async () => {
    cf.env = { ROUTING_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    await expect(routingWithinLimit("1.2.3.4")).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();

    limit.mockResolvedValueOnce({ success: false });
    await expect(routingWithinLimit("1.2.3.4")).resolves.toBe(false);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();

    limit.mockRejectedValue(new Error("limiter unavailable"));
    await expect(sustained(() => routingWithinLimit("1.2.3.4"))).resolves.toBe(true); // fail open
    await flushAfter();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    expect(text).toMatch(/routing/i);
    expect(text).not.toMatch(/limiter unavailable/);
  });

  it("bookingApiWriteWithinLimit keys on the API key id and blocks SILENTLY (a per-key throttle is not an incident)", async () => {
    cf.env = { BOOKINGAPI_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    await expect(bookingApiWriteWithinLimit("primary")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "primary" });

    limit.mockResolvedValueOnce({ success: false });
    await expect(bookingApiWriteWithinLimit("primary")).resolves.toBe(false);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("bookingApiReadWithinLimit keys on the API key id (its own binding, separate from writes)", async () => {
    cf.env = { BOOKINGAPI_READ_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    await expect(bookingApiReadWithinLimit("secondary")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "secondary" });
  });

  it("bookingApiIpWithinLimit ALERTS in plain language when it blocks, naming the IP (#796)", async () => {
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: false });

    await expect(bookingApiIpWithinLimit("203.0.113.9")).resolves.toBe(false);

    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalled();
    const text = String(sendThrottledAlert.mock.calls[0]?.[2] ?? "");
    // Names the IP so nobody can't tell our own bot from an attacker, states the
    // window in plain words, and never leaks the internal binding name.
    expect(text).toMatch(/203\.0\.113\.9/);
    expect(text).toMatch(/per minute/);
    expect(text).not.toMatch(/BOOKINGAPI_IP_RATE_LIMITER/);
  });

  it("bookingApiIpWithinLimit stays silent when the limiter permits the request", async () => {
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    await expect(bookingApiIpWithinLimit("203.0.113.9")).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("bookingApiIpWithinLimit still BLOCKS even when the block alert itself throws", async () => {
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: false });
    sendThrottledAlert.mockRejectedValueOnce(new Error("alert store unreachable"));

    await expect(bookingApiIpWithinLimit("203.0.113.9")).resolves.toBe(false);
    const logged = await flushFailedSend();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    expect(logged).toMatch(/alert failed/);
    expect(logged).toMatch(/alert store unreachable/);
  });
});

// #1556. #1536 closed the concurrent-burst hole on /api/availability and left it open on the
// other five limiters, which was never a different defect: the native binding counts the same
// way for all of them (45 sequential blocked at the ceiling, 60 parallel blocked zero times).
//
// The decision logic is pinned offline in scripts/test-burst-ceiling.ts. What can only be
// checked HERE is the wiring, which is the actual content of the issue (L3: built is not wired,
// and wired is not proven). Each case drives a DIFFERENT endpoint, because "the shared function
// has it" is exactly the claim that was true of availability while five endpoints had nothing.
describe("the burst ceiling reaches every edge limiter (#1556)", () => {
  let clock = Date.UTC(2026, 7, 18);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    burstCount = 1;
    burstFetches = 0;
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a public booking confirm once the shared counter puts the address past ITS ceiling", async () => {
    cf.env = { BOOKING_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    // Over booking's ceiling and well UNDER availability's, so a shared number would serve
    // this and the case would prove nothing.
    burstCount = BOOKING_LIMITER.burstCeilingPerMinute + 1;
    expect(burstCount).toBeLessThan(AVAILABILITY_LIMITER.burstCeilingPerMinute);

    let allowed = true;
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await bookingWithinLimit("9.9.9.9");

    expect(allowed).toBe(false);
    // A throttled visitor is still not an incident.
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("refuses a routing lookup past its ceiling, and a booking API key past its own", async () => {
    cf.env = { ROUTING_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    burstCount = 100_000;
    let allowed = true;
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await routingWithinLimit("9.9.9.9");
    expect(allowed).toBe(false);

    cf.env = { BOOKINGAPI_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    let keyAllowed = true;
    for (let i = 0; i <= burstEscalateAt(BOOKING_API_WRITE_LIMITER); i++) {
      keyAllowed = await bookingApiWriteWithinLimit("leaked-key");
    }
    expect(keyAllowed).toBe(false);
  });

  // #1565: the machine to machine limiters escalate at their own sustained limit, not at
  // availability's 20, so an integrator polling inside its allowance pays no round trip.
  it("does not charge a booking API key a round trip for polling inside its sustained limit", async () => {
    cf.env = { BOOKINGAPI_READ_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    burstFetches = 0;
    // Past the old shared threshold, and well inside the read path's 600 a minute.
    for (let i = 0; i <= BURST_ESCALATE_AT * 5; i++) {
      await expect(bookingApiReadWithinLimit("regal")).resolves.toBe(true);
    }
    expect(burstFetches).toBe(0);

    for (let i = 0; i < BOOKING_API_READ_LIMITER.perMinute; i++) {
      await bookingApiReadWithinLimit("regal");
    }
    expect(burstFetches, "past its sustained limit it is counted exactly").toBeGreaterThan(0);
  });

  it("logs an escalation once, naming the lane and the integrator but never an address", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    cf.env = {
      BOOKINGAPI_RATE_LIMITER: { limit },
      BOOKINGAPI_IP_RATE_LIMITER: { limit },
      BURST_LIMITER: burstNamespace(),
    };
    const escalatedLines = () =>
      info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('msg="escalated"'));

    for (let i = 0; i < burstEscalateAt(BOOKING_API_WRITE_LIMITER) + 30; i++) {
      await bookingApiWriteWithinLimit("regal");
    }
    expect(escalatedLines()).toHaveLength(1);
    const line = escalatedLines()[0]!;
    expect(line).toContain("tag=rate-limit-burst");
    expect(line).toContain('area="booking-api"');
    expect(line).toContain(`escalate_at=${burstEscalateAt(BOOKING_API_WRITE_LIMITER)}`);
    expect(line).toContain('caller="regal"');

    for (let i = 0; i <= burstEscalateAt(BOOKING_API_IP_LIMITER); i++) {
      await bookingApiIpWithinLimit("203.0.113.77");
    }
    expect(escalatedLines()).toHaveLength(2);
    expect(escalatedLines()[1]).toContain('area="booking-api-ip"');
    expect(escalatedLines()[1]).not.toContain("203.0.113.77");
    info.mockRestore();
  });

  it("counts each endpoint separately, so one endpoint's traffic cannot spend another's ceiling", async () => {
    // The shape decision: ONE Durable Object namespace with the endpoint in the key. If the
    // key were the address alone, these two would share a count and the same address loading
    // the booker would push its own confirm over the lower ceiling.
    const keysAsked: string[] = [];
    cf.env = {
      BOOKING_RATE_LIMITER: { limit },
      AVAIL_RATE_LIMITER: { limit },
      BURST_LIMITER: {
        idFromName: (name: string) => {
          keysAsked.push(name);
          return { name };
        },
        get: () => ({
          fetch: async () =>
            new Response(JSON.stringify({ count: 1 }), {
              headers: { "content-type": "application/json" },
            }),
        }),
      },
    };

    for (let i = 0; i <= BURST_ESCALATE_AT; i++) await availabilityWithinLimit("1.2.3.4");
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) await bookingWithinLimit("1.2.3.4");

    expect(keysAsked.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(keysAsked);
    expect(distinct.size).toBe(2);
    for (const k of distinct) expect(k).toContain("1.2.3.4");
  });

  it("still applies the ceiling when the NATIVE binding is missing (two controls, not one)", async () => {
    // A missing rate-limit binding used to switch the burst ceiling off with it, because the
    // burst step only ran after the native check had SUCCEEDED. They are independent controls
    // (L53), so the endpoint whose native throttle is off is exactly the one that still needs
    // the backstop.
    cf.env = { BURST_LIMITER: burstNamespace() };
    burstCount = BOOKING_LIMITER.burstCeilingPerMinute + 1;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    let allowed = true;
    for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await bookingWithinLimit("9.9.9.9");

    expect(allowed).toBe(false);
    consoleErr.mockRestore();
  });

  it("does not pay a round trip for a request the native limiter has already refused", async () => {
    cf.env = { BOOKING_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: false });

    for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
      await expect(bookingWithinLimit("9.9.9.9")).resolves.toBe(false);
    }

    expect(burstFetches).toBe(0);
  });

  it("does NOT apply the unidentified-address rule to a per-KEY limiter", async () => {
    // The fallback is an ADDRESS that could not be read. An API key id comes from auth and can
    // never be it, so an integrator whose key happened to be named that must still be counted,
    // and nothing should be reported about a missing client address.
    cf.env = { BOOKINGAPI_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    burstCount = BOOKING_API_WRITE_LIMITER.burstCeilingPerMinute + 1;

    let allowed = true;
    for (let i = 0; i <= burstEscalateAt(BOOKING_API_WRITE_LIMITER); i++) {
      allowed = await bookingApiWriteWithinLimit(UNIDENTIFIED_IP);
    }

    expect(allowed).toBe(false);
    expect(burstFetches).toBeGreaterThan(0);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("every limiter in the table is reachable through a wrapper that applies the ceiling", async () => {
    // The completeness half. A seventh limiter added to the table with no wrapper carrying the
    // ceiling would leave this suite green while shipping the exact gap #1556 is about, so the
    // check enumerates the table rather than the cases above (L96).
    const wrappers: Record<string, (k: string) => Promise<boolean>> = {
      availability: availabilityWithinLimit,
      booking: bookingWithinLimit,
      routing: routingWithinLimit,
      "booking-api": bookingApiWriteWithinLimit,
      "booking-api-ip": bookingApiIpWithinLimit,
      "booking-api-read": bookingApiReadWithinLimit,
      manage: manageWithinLimit,
      landing: landingIdentityAllowed,
      "call-me-now": callMeNowAllowed,
      "bearer-failure": bearerFailureWithinLimit,
    };
    expect(Object.keys(wrappers).sort()).toEqual(EDGE_LIMITERS.map((l) => l.area).sort());

    for (const spec of EDGE_LIMITERS) {
      burstCount = spec.burstCeilingPerMinute + 1;
      cf.env = { [spec.binding]: { limit }, BURST_LIMITER: burstNamespace() };
      let allowed = true;
      for (let i = 0; i <= burstEscalateAt(spec); i++) {
        allowed = await wrappers[spec.area]!(`198.51.100.${EDGE_LIMITERS.indexOf(spec)}`);
      }
      expect(allowed, `${spec.binding} enforces its burst ceiling`).toBe(false);
    }
  });
});

describe("landingIdentityAllowed (#3106)", () => {
  let clock = Date.UTC(2026, 9, 3);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    burstCount = 1;
    burstFetches = 0;
    cf.env = { MANAGE_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a lookup under both ceilings, counting the edge window apart from the manage link's", async () => {
    await expect(landingIdentityAllowed("203.0.113.5")).resolves.toBe(true);
    // The binding is shared with the manage link, so the key must not be the bare address,
    // or a lead reloading their landing page would spend their own manage allowance.
    expect(limit).toHaveBeenCalledWith({ key: "landing:203.0.113.5" });
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "landing:h:203.0.113.5",
      p_window_seconds: 3600,
      p_max: 30,
    });
  });

  it("refuses at the edge without a database round trip", async () => {
    limit.mockResolvedValue({ success: false });
    await expect(landingIdentityAllowed("203.0.113.5")).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses once the exact hourly cap is spent", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(landingIdentityAllowed("203.0.113.5")).resolves.toBe(false);
  });

  it("refuses a caller with no address rather than counting them into a shared bucket", async () => {
    await expect(landingIdentityAllowed(UNIDENTIFIED_IP)).resolves.toBe(false);
    expect(limit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("callMeNowAllowed (#3718)", () => {
  let clock = Date.UTC(2026, 9, 14);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    burstCount = 1;
    burstFetches = 0;
    cf.env = { MANAGE_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a press under both ceilings, counted apart from the manage link and the landing lookup", async () => {
    await expect(callMeNowAllowed("203.0.113.5")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "cmn:203.0.113.5" });
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", {
      p_key: "cmn:h:203.0.113.5",
      p_window_seconds: 3600,
      p_max: 20,
    });
  });

  it("refuses at the edge without a database round trip", async () => {
    limit.mockResolvedValue({ success: false });
    await expect(callMeNowAllowed("203.0.113.5")).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses once the exact hourly cap is spent", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(callMeNowAllowed("203.0.113.5")).resolves.toBe(false);
  });

  it("refuses a caller with no address, since every such caller would share one count", async () => {
    await expect(callMeNowAllowed(UNIDENTIFIED_IP)).resolves.toBe(false);
    expect(limit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("bearerFailureWithinLimit (#3142)", () => {
  let clock = Date.UTC(2026, 9, 4);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60 * 60_000;
    vi.setSystemTime(clock);
    burstCount = 1;
    cf.env = { BOOKINGAPI_IP_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts failures apart from the per address backstop an authenticated caller spends", async () => {
    await expect(bearerFailureWithinLimit("203.0.113.9")).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith({ key: "authfail:203.0.113.9" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses past the ceiling and stays silent, since a flood of bad tokens is not news", async () => {
    limit.mockResolvedValue({ success: false });
    await expect(bearerFailureWithinLimit("203.0.113.9")).resolves.toBe(false);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });
});

// #3145 (L1017), the whole class rather than one site. Every limiter failure, block and
// unidentified caller is noticed INSIDE a request, which on the booking confirm, reschedule
// and manage routes is the lead's call budget. A page sent from there inherits that budget,
// so a spent one refuses the page's own alert_state read and the outage goes unsaid, and an
// awaited page also holds the lead's response for a Slack send. So every page this module
// sends goes after the response and outside the budget. Driven through the public entry
// points, one per alert site.
describe("every limiter page goes after the response, outside the lead's budget (#3145)", () => {
  // Well past any cooldown an earlier case stamped, including those run on the real clock.
  let clock = Date.UTC(2030, 0, 1);
  const RULES4: RateLimitRule[] = [
    { prefix: "bookapi:ip:m", windowSeconds: 60, max: 60, alertOnBlock: true },
  ];
  const LOUD = {
    kind: "address",
    ip: "203.0.113.7",
    keyPrefix: "ip:",
    policy: BOOKING_API_IP_LIMITER,
  } as const;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Past every in-isolate cooldown the previous case stamped.
    clock += 2 * 60 * 60_000;
    vi.setSystemTime(clock);
    burstCount = 1;
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
    // clearAllMocks keeps a queued once-implementation an earlier case never consumed,
    // which would answer this case's send in place of the recorder below.
    sendThrottledAlert.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases: Array<{ name: string; arrange: () => void; act: () => Promise<unknown> }> = [
    {
      name: "the burst binding is missing (the !ns branch)",
      arrange: () => {
        cf.env = { AVAIL_RATE_LIMITER: { limit } };
      },
      act: () => sustained(() => availabilityWithinLimit("1.2.3.4")),
    },
    {
      name: "the native limiter throws (its catch)",
      arrange: () => {
        cf.env = { AVAIL_RATE_LIMITER: { limit }, BURST_LIMITER: burstNamespace() };
        limit.mockRejectedValue(new Error("limiter exploded"));
      },
      act: () => sustained(() => availabilityWithinLimit("1.2.3.4")),
    },
    {
      name: "the native binding is missing",
      arrange: () => {
        cf.env = { BURST_LIMITER: burstNamespace() };
      },
      act: () => sustained(() => availabilityWithinLimit("1.2.3.4")),
    },
    {
      name: "the request context cannot be read (the context catch)",
      arrange: () => {
        getCloudflareContext.mockImplementation(() => {
          throw new Error("no context");
        });
      },
      act: () => sustained(() => availabilityWithinLimit("1.2.3.4")),
    },
    {
      name: "the database limiter fails",
      arrange: () => {
        rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
      },
      act: () => sustained(() => allowRequest(ADDRESS, [RULES[0]!])),
    },
    {
      name: "a machine ceiling blocks",
      arrange: () => {
        rpc.mockResolvedValue({ data: false, error: null });
      },
      act: () => allowRequest(LOUD, RULES4),
    },
    {
      name: "a caller has no address",
      arrange: () => {},
      act: () =>
        allowRequest({ kind: "address", ip: UNIDENTIFIED_IP, policy: BOOKING_LIMITER }, RULES),
    },
    {
      name: "a refund fails",
      arrange: () => {
        rpc.mockResolvedValue({ data: null, error: { message: "refund fn missing" } });
      },
      act: () => sustained(() => refundRequest(ADDRESS, [RULES[0]!])),
    },
  ];

  for (const c of cases) {
    it(`when ${c.name}`, async () => {
      c.arrange();
      const inBudget: boolean[] = [];
      sendThrottledAlert.mockImplementation(async () => {
        inBudget.push(insideCallBudget());
      });
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await withinCallBudget(12_000, "the booking confirm", async () => {
        await c.act();
        // Nothing is sent while the lead is still waiting for an answer...
        expect(sendThrottledAlert).not.toHaveBeenCalled();
      });
      // ...it was handed to after(), which keeps it alive past the response...
      expect(afterQueue.length).toBe(1);
      await flushAfter();
      // ...and it runs once, with no budget over it.
      expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
      expect(inBudget).toEqual([false]);
      consoleErr.mockRestore();
    });
  }
});

// #3416: the booking API's hourly per caller and per address ceilings, counted per request in
// the edge counter instead of a `rate_limit_hit` row. They are a security control, so what these
// pin is that the move changed WHERE the number lives and nothing the control decides: the
// limit, the key, the refusal, the block alert, and above all the direction it fails, which is
// OPEN and LOUD exactly as `allowRequest` fails on an unreadable row (its own cases above).
describe("exactCeilingWithinLimit, the hourly ceilings at the edge (#3416)", () => {
  // A fake object that counts with the arithmetic the deployed object runs, so a hit here is
  // counted exactly as production counts it (scripts/test-exact-ceiling.ts drives the real
  // class around a fake storage).
  const objects = new Map<string, CounterWindow>();
  const asked: string[] = [];
  const exactNamespace = () => ({
    idFromName: (name: string) => ({ name }),
    get: (id: unknown) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const name = (id as { name: string }).name;
        asked.push(name);
        const request = readCounterRequest(JSON.parse(String(init?.body)));
        if (request.kind === "unreadable") return Response.json({ error: request.detail }, { status: 400 });
        const step = applyCounterRequest(objects.get(name) ?? null, request, Date.now());
        objects.set(name, step.next);
        return Response.json(step.reply);
      },
    }),
  });
  /** A namespace whose one object answers every hit with `answer`. */
  const answering = (answer: () => Promise<Response>) => ({
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: answer }),
  });
  const KEY_CALLER = { kind: "opaque", key: "key:regal" } as const;
  const IP_CALLER = { kind: "address", ip: "203.0.113.9", keyPrefix: "ip:", policy: BOOKING_API_IP_LIMITER } as const;
  const KEY_RULE = DIRECT_BOOKING_API_HOURLY_RATE_RULES[0]!;
  const IP_RULE = DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES[0]!;
  const KEY_OBJECT = "exact:bookapi:h:key:regal";
  const IP_OBJECT = "exact:bookapi:ip:h:ip:203.0.113.9";

  // Two hours a case, past the edge alert gate's half hour cooldown, so every case attempts
  // its own page rather than inheriting a gate the last one closed (#3145).
  let clock = Date.UTC(2026, 9, 1);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 2 * 60 * 60_000;
    vi.setSystemTime(clock);
    objects.clear();
    asked.length = 0;
    cf.env = { BURST_LIMITER: exactNamespace() };
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts each ceiling under its Postgres row's own key, and never asks Supabase", async () => {
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(true);
    await expect(exactCeilingWithinLimit(IP_CALLER, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(true);
    expect(asked).toEqual([KEY_OBJECT, IP_OBJECT]);
    expect(rpc).not.toHaveBeenCalled();
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("still refuses at the per caller limit: hit 6000 is allowed, hit 6001 is not", async () => {
    objects.set(KEY_OBJECT, { windowStartMs: Date.now(), count: KEY_RULE.max - 1 });
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(true);
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(false);
    // A refused hit still counts, as rate_limit_hit counts it, so the caller stays refused.
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(false);
    expect(objects.get(KEY_OBJECT)?.count).toBe(KEY_RULE.max + 2);
    // The per caller rule never alerted on a block, and still does not.
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("still refuses at the per address limit, and still pages the block naming the address", async () => {
    objects.set(IP_OBJECT, { windowStartMs: Date.now(), count: IP_RULE.max - 1 });
    await expect(exactCeilingWithinLimit(IP_CALLER, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(true);
    await expect(exactCeilingWithinLimit(IP_CALLER, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(false);
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("rate_limit_blocked:bookapi:ip:h");
    expect(text).toMatch(/ip:203\.0\.113\.9/);
    expect(text).toMatch(/1200 requests per hour/);
  });

  it("keeps one count per caller, so one caller at its limit refuses nobody else", async () => {
    objects.set(KEY_OBJECT, { windowStartMs: Date.now(), count: KEY_RULE.max });
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(false);
    await expect(
      exactCeilingWithinLimit({ kind: "opaque", key: "key:canary" }, DIRECT_BOOKING_API_HOURLY_RATE_RULES),
    ).resolves.toBe(true);
  });

  // #3456: two load run arms inside one hour, each scoped to its own run. The kept load
  // test Worker keeps its counter between runs, so before this the second arm inherited the
  // first arm's count and met the 6000 ceiling partway through.
  it("starts a second load run arm at zero, while the first arm's count stands", async () => {
    const ARM_A = "run-1001-1";
    const ARM_B = "run-1002-1";
    const objectA = exactCeilingKey(KEY_RULE.prefix, "key:regal", ARM_A);
    const objectB = exactCeilingKey(KEY_RULE.prefix, "key:regal", ARM_B);
    // Arm A drives the caller to its ceiling.
    objects.set(objectA, { windowStartMs: Date.now(), count: KEY_RULE.max });
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES, ARM_A)).resolves.toBe(false);
    // Arm B, the same caller in the same hour, starts at one.
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES, ARM_B)).resolves.toBe(true);
    expect(objects.get(objectB)?.count).toBe(1);
    expect(objects.get(objectA)?.count).toBe(KEY_RULE.max + 1);
    // And neither arm wrote production's own key for the caller.
    expect(asked).toEqual([objectA, objectB]);
    expect(objects.has(KEY_OBJECT)).toBe(false);
  });

  it("counts under production's own key when no run scope is given, so production is unchanged", async () => {
    expect(exactCeilingKey(KEY_RULE.prefix, "key:regal", null)).toBe(KEY_OBJECT);
    expect(exactCeilingKey(KEY_RULE.prefix, "key:regal")).toBe(KEY_OBJECT);
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES, null)).resolves.toBe(true);
    expect(asked).toEqual([KEY_OBJECT]);
  });

  it("opens a new window once the old one is strictly older than an hour", async () => {
    objects.set(KEY_OBJECT, { windowStartMs: Date.now() - 3_600_001, count: KEY_RULE.max + 50 });
    await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(true);
    expect(objects.get(KEY_OBJECT)).toEqual({ windowStartMs: Date.now(), count: 1 });
  });

  it("serves a caller with no address uncounted, and says so, exactly as allowRequest does (#1557)", async () => {
    const unknown = { kind: "address", ip: UNIDENTIFIED_IP, policy: BOOKING_API_IP_LIMITER } as const;
    await expect(exactCeilingWithinLimit(unknown, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(true);
    await expect(allowRequest(unknown, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(true);
    expect(asked).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    await flushAfter();
    expect(sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual([
      "rate_limit_unidentified:booking-api-ip",
      "rate_limit_unidentified:booking-api-ip",
    ]);
  });

  // PARITY, not endorsement. The authorizer hands the per address ceiling a key carrying the
  // `ip:` prefix, and `judgeCaller` is asked about the PREFIXED key, which never equals the
  // fallback, so the #1557 rule above is never reached on this ceiling: a caller with no address
  // is counted into one shared `ip:unknown` count. That is what the Postgres ceiling did, so it
  // is what this one does; serving them unjudged instead would change a security control, which
  // is a decision for its owner rather than a side effect of moving it. Unreachable behind
  // Cloudflare, which always sets the address. When it is changed, it changes in both.
  it("treats the authorizer's prefixed no-address key exactly as allowRequest does", async () => {
    const prefixed = { kind: "address", ip: UNIDENTIFIED_IP, keyPrefix: "ip:", policy: BOOKING_API_IP_LIMITER } as const;
    await expect(exactCeilingWithinLimit(prefixed, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(true);
    await expect(allowRequest(prefixed, DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)).resolves.toBe(true);
    expect(asked).toEqual(["exact:bookapi:ip:h:ip:unknown"]);
    expect(rpc).toHaveBeenCalledWith("rate_limit_hit", expect.objectContaining({ p_key: "bookapi:ip:h:ip:unknown" }));
  });

  // THE DIRECTION. Today a `rate_limit_hit` that errors (a missing function, a refused
  // connection, a deadline, which PostgREST hands back as an error rather than throwing) makes
  // `allowRequest` CONTINUE: the request is served, and the outage is paged in plain words
  // under `rate_limit_broken:<prefix>`. Every way the edge counter can fail to count has to
  // land on that same side, under that same key, with those same words.
  const unreachable: { name: string; arrange: () => void }[] = [
    {
      name: "the object throws",
      arrange: () => {
        cf.env = { BURST_LIMITER: answering(async () => Promise.reject(new Error("object unreachable"))) };
      },
    },
    {
      name: "the object answers an error",
      arrange: () => {
        cf.env = { BURST_LIMITER: answering(async () => new Response("nope", { status: 500 })) };
      },
    },
    {
      name: "the object counts a different window (code from before this change, mid rollout)",
      arrange: () => {
        cf.env = { BURST_LIMITER: answering(async () => Response.json({ count: 1, windowStartMs: 0 })) };
      },
    },
    {
      name: "the binding is missing",
      arrange: () => {
        cf.env = {};
      },
    },
    {
      name: "the request context cannot be read",
      arrange: () => {
        getCloudflareContext.mockImplementation(() => {
          throw new Error("no context");
        });
      },
    },
  ];
  for (const c of unreachable) {
    it(`serves the request and pages, as allowRequest does, when ${c.name}`, async () => {
      c.arrange();
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(sustained(() => exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES))).resolves.toBe(true);
      // Nothing is sent while the caller waits; the page goes after the response.
      expect(sendThrottledAlert).not.toHaveBeenCalled();
      await flushAfter();
      expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
      const [key, , text] = sendThrottledAlert.mock.calls[0]!;
      expect(key).toBe(`rate_limit_broken:${KEY_RULE.prefix}`);
      // The same words allowRequest pages with for this rule (built by the same builder from
      // the same prefix), and no internal name or raw error in them.
      expect(text).toBe(
        limiterFailOpenAlert(friendlyRateArea(KEY_RULE.prefix), {
          count: LIMITER_FAIL_OPEN_PAGE_AFTER,
          windowMs: LIMITER_FAIL_OPEN_WINDOW_MS,
          atLeast: false,
        }),
      );
      expect(text).toMatch(/booking API/);
      expect(text).not.toMatch(/BURST_LIMITER|object unreachable|no context/);
      consoleErr.mockRestore();
    });
  }

  it("serves the request, loudly, when the object does not answer inside the request's budget", async () => {
    cf.env = { BURST_LIMITER: answering(() => new Promise<Response>(() => {})) };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    // A short budget stands for a confirm with little left: the hit waits only for that, as
    // the Supabase request it replaced did, and is then served rather than held.
    await expect(
      sustained(() =>
        withinCallBudget(30, "the booking confirm", () =>
          exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES),
        ),
      ),
    ).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual([`rate_limit_broken:${KEY_RULE.prefix}`]);
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/did not answer/);
    consoleErr.mockRestore();
  });

  it("gives up on a stalled counter after one second, serves the lead, and a sustained stall still pages (#3828, #3894)", async () => {
    // Load run 38933668981: two counters stalled 4 to 5 seconds at once, and a lead's confirm
    // waited out the stall because the deadline was the 15 second Supabase one. Production's
    // counter answers in about 75ms (261ms at the 95th percentile) and took over 1 second on
    // 19 of 7,151 calls in a week. Dan, 2026-10-18 (#3894): one second, so a cold confirm that
    // meets a stall stays inside the load run's 2500ms startup bar. Real time, on a counter that
    // never answers: the body path does not run under fake timers, and the bounds are loose on
    // purpose, so this asserts the deadline in force and not the machine's speed (L290). The
    // upper bound sits below the old two seconds, so a revert fails here and not only on the pin.
    //
    // A sustained stall is the page's threshold of these hits, sent together so the case costs
    // one deadline rather than five; each is its own failed count on this isolate, exactly as
    // five leads meeting one stalled object are.
    cf.env = { BURST_LIMITER: answering(() => new Promise<Response>(() => {})) };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = performance.now();
    const served = await Promise.all(
      Array.from({ length: LIMITER_FAIL_OPEN_PAGE_AFTER }, () =>
        exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES),
      ),
    );
    const waited = performance.now() - started;
    expect(served).toEqual(Array.from({ length: LIMITER_FAIL_OPEN_PAGE_AFTER }, () => true));
    expect(waited).toBeGreaterThanOrEqual(EXACT_CEILING_DEADLINE_MS - 50);
    expect(waited).toBeLessThan(1_900);
    expect(EXACT_CEILING_DEADLINE_MS).toBe(1_000);
    // Nothing is sent while the leads wait; the one page goes after the response.
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    await flushAfter();
    expect(sendThrottledAlert.mock.calls.map((c) => c[0])).toEqual([`rate_limit_broken:${KEY_RULE.prefix}`]);
    consoleErr.mockRestore();
  });

  it("pages an outage once per isolate per cooldown, not once per request", async () => {
    cf.env = {};
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) {
      await expect(exactCeilingWithinLimit(KEY_CALLER, DIRECT_BOOKING_API_HOURLY_RATE_RULES)).resolves.toBe(true);
    }
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    consoleErr.mockRestore();
  });
});

// #3670. `rate_limit_broken:landing:h` paged on 2026-10-13 for ONE hourly count that failed, saying
// the limit "has stopped working ... right now", and `pnpm verify:burst-counter` passed minutes
// later. Dan: "we probably shouldn't alert on one instance". A fail open is now counted per area on
// the isolate that saw it, and pages only once LIMITER_FAIL_OPEN_PAGE_AFTER of them land inside
// LIMITER_FAIL_OPEN_WINDOW_MS, worded as the count it measured. Every negative assertion below
// flushes the deferred work first, because a page is handed to after() and a "not called" read
// before the flush passes whatever the code does.
describe("a single fail open pages nothing; a sustained run pages (#3670)", () => {
  const LANDING_CALLER = { kind: "address", ip: "198.51.100.4", policy: LANDING_LIMITER } as const;
  const LANDING_RULE = LANDING_IDENTITY_HOURLY_RATE_RULES[0]!;
  const brokenCounter = () => ({
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
  });
  const failOpenLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => String(c[0] ?? "").includes("limiter failing open"));

  // Each case starts well past the last one's window AND cooldown, so none inherits a count.
  let clock = Date.UTC(2031, 0, 1);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 3 * 60 * 60_000;
    vi.setSystemTime(clock);
    cf.env = { BURST_LIMITER: brokenCounter(), AVAIL_RATE_LIMITER: { limit } };
    limit.mockResolvedValue({ success: true });
    getCloudflareContext.mockImplementation(() => ({ env: cf.env }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the worked case: one failed landing count is served, logged, and pages nothing", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(exactCeilingWithinLimit(LANDING_CALLER, LANDING_IDENTITY_HOURLY_RATE_RULES)).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    // Never silent full stop: the single instance is still a log line.
    expect(failOpenLines(consoleErr)).toHaveLength(1);
    expect(JSON.stringify(consoleErr.mock.calls)).toMatch(/landing:h/);
    consoleErr.mockRestore();
  });

  it("one short of the threshold inside the window pages nothing", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < LIMITER_FAIL_OPEN_PAGE_AFTER - 1; i++) {
      await exactCeilingWithinLimit(LANDING_CALLER, LANDING_IDENTITY_HOURLY_RATE_RULES);
    }
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("the threshold spread wider than the window pages nothing", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < LIMITER_FAIL_OPEN_PAGE_AFTER * 2; i++) {
      vi.setSystemTime(clock + i * LIMITER_FAIL_OPEN_WINDOW_MS);
      await exactCeilingWithinLimit(LANDING_CALLER, LANDING_IDENTITY_HOURLY_RATE_RULES);
    }
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("a sustained run inside the window pages once, worded as the count it measured", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < LIMITER_FAIL_OPEN_PAGE_AFTER + 3; i++) {
      vi.setSystemTime(clock + i * 1_000);
      await expect(exactCeilingWithinLimit(LANDING_CALLER, LANDING_IDENTITY_HOURLY_RATE_RULES)).resolves.toBe(true);
    }
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe(`rate_limit_broken:${LANDING_RULE.prefix}`);
    expect(text).toBe(
      limiterFailOpenAlert(friendlyRateArea(LANDING_RULE.prefix), {
        count: LIMITER_FAIL_OPEN_PAGE_AFTER,
        windowMs: LIMITER_FAIL_OPEN_WINDOW_MS,
        atLeast: false,
      }),
    );
    expect(text).not.toMatch(/stopped working|right now/);
    consoleErr.mockRestore();
  });

  it("a native limiter that throws once pages nothing", async () => {
    limit.mockRejectedValue(new Error("limiter unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(availabilityWithinLimit("1.2.3.4")).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(failOpenLines(consoleErr)).toHaveLength(1);
    consoleErr.mockRestore();
  });

  it("allowRequest: one failed database count pages nothing, a sustained run pages per rule", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(allowRequest(ADDRESS, RULES)).resolves.toBe(true);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    for (let i = 1; i < LIMITER_FAIL_OPEN_PAGE_AFTER; i++) await allowRequest(ADDRESS, RULES);
    await flushAfter();
    expect(sendThrottledAlert.mock.calls.map((c) => c[0]).sort()).toEqual(
      RULES.map((r) => `rate_limit_broken:${r.prefix}`).sort(),
    );
    consoleErr.mockRestore();
  });

  it("refundRequest: one failed refund pages nothing, a sustained run pages with its count", async () => {
    const REFUND_RULES: RateLimitRule[] = [{ prefix: "book:m", windowSeconds: 60, max: 3 }];
    rpc.mockResolvedValue({ data: null, error: { message: "refund fn missing" } });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await refundRequest(ADDRESS, REFUND_RULES);
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    for (let i = 1; i < LIMITER_FAIL_OPEN_PAGE_AFTER; i++) await refundRequest(ADDRESS, REFUND_RULES);
    await flushAfter();
    expect(sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = sendThrottledAlert.mock.calls[0]!;
    expect(key).toBe("rate_limit_refund_broken:book:m");
    expect(text).toBe(
      refundFailedAlert(friendlyRateArea("book:m"), {
        count: LIMITER_FAIL_OPEN_PAGE_AFTER,
        windowMs: LIMITER_FAIL_OPEN_WINDOW_MS,
        atLeast: false,
      }),
    );
    consoleErr.mockRestore();
  });

  it("off the Workers runtime a sustained run is logged and still never pages (#1525)", async () => {
    isWorkersRuntime.mockReturnValue(false);
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < LIMITER_FAIL_OPEN_PAGE_AFTER * 2; i++) {
      await exactCeilingWithinLimit(LANDING_CALLER, LANDING_IDENTITY_HOURLY_RATE_RULES);
    }
    await flushAfter();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});

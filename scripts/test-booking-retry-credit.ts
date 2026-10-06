// #3364: a lead refused for a taken time gets a bounded number of retries past the
// edge minute window, and nobody else does.
//
// On 2026-10-06 two real leads had their picked time refused as `slot_unavailable`
// three or four times each inside a minute, each picking the next time along, and
// were then refused with a 429 by the public booking's edge minute window (3 a
// minute per address). The native Cloudflare limiter cannot be refunded, so the
// hourly and contact caps were handed back on every one of those 409s while the
// minute window went on counting them at full weight.
//
// The credit is what makes the refusal weigh less: each taken time refusal earns one
// retry for that address, and a request the native window refused is let through
// only by spending one. What is pinned here, each against a fake store that answers
// exactly as `rate_limit_hit` does (a window anchored at its first hit):
//
//   1. The lead from the incident: three refusals, then the next pick goes through.
//   2. A credit is earned only by a refusal. A flood that was never refused gets
//      nothing, and costs no spend.
//   3. THE ABUSE BOUND. A flood of confirms for a taken time from one address,
//      across any number of isolates, reaches the route at most
//      `native + RETRY_CREDIT_CAP` times a minute, however many it sends.
//   4. Concurrent retries cannot overspend a credit (the spend is one atomic hit).
//   5. A credit dies with its window.
//   6. The isolate gate: past the cap, an isolate stops asking the store at all, so a
//      flood cannot buy a database round trip per request.
//   7. A store that fails THROWS rather than answering, so the wrapper keeps the 429
//      (the exemption fails closed, which is exactly today's behaviour).
//
// The IO wrapper (log, alert, unidentified caller) is driven in src/lib/rate-limit.test.ts,
// and the route wiring in src/app/booking/route.test.ts.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-booking-retry-credit.ts
import {
  RetryCredits,
  RETRY_CREDIT_CAP,
  type RetryCreditStore,
} from "../src/lib/rate-limit-retry-credit.ts";
import {
  BOOKING_RETRY_CREDIT_RULES,
  BOOKING_LIMITER,
  rateLimitPrunePlan,
} from "../src/lib/rate-limit-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const WINDOW_MS = 60_000;

/** `rate_limit_hit` and a read of its row, in memory. The window opens at the first hit
 *  and resets in place once it is older than the window, exactly as 0024 does. */
function fakeStore(clock: { now: number }) {
  const rows = new Map<string, { windowStartMs: number; count: number }>();
  const calls = { earn: 0, read: 0, spend: 0 };
  const hit = (key: string, max: number): boolean => {
    const row = rows.get(key);
    if (!row || row.windowStartMs < clock.now - WINDOW_MS) {
      rows.set(key, { windowStartMs: clock.now, count: 1 });
      return 1 <= max;
    }
    row.count += 1;
    return row.count <= max;
  };
  const store: RetryCreditStore = {
    async earn(key) {
      calls.earn += 1;
      hit(key, RETRY_CREDIT_CAP);
    },
    async readEarned(key) {
      calls.read += 1;
      const row = rows.get(key);
      return row ? { ...row } : null;
    },
    async spend(key, max) {
      calls.spend += 1;
      return hit(key, max);
    },
  };
  return { store, rows, calls };
}

/** The native window: `perMinute` per fixed minute, the way the binding is configured. */
function nativeWindow(clock: { now: number }, perMinute: number) {
  let windowStart = -1;
  let count = 0;
  return () => {
    const start = Math.floor(clock.now / WINDOW_MS) * WINDOW_MS;
    if (start !== windowStart) {
      windowStart = start;
      count = 0;
    }
    count += 1;
    return count <= perMinute;
  };
}

const IP = "203.0.113.7";

// --- the shape of the bound itself -----------------------------------------------------------
eq(RETRY_CREDIT_CAP, 3, "the cap is three retries, which covers the incident's three to four refusals");
assert(
  RETRY_CREDIT_CAP <= BOOKING_LIMITER.perMinute,
  "the cap never exceeds the minute window it extends, so a refused flood at most doubles it",
);
assert(
  BOOKING_LIMITER.perMinute + RETRY_CREDIT_CAP < BOOKING_LIMITER.burstCeilingPerMinute,
  "the native window plus every credit still sits under the burst ceiling behind it",
);
// The rows live in rate_limits, so they must be pruned like every other limiter row.
const pruned = rateLimitPrunePlan().flatMap((g) => g.prefixes);
for (const rule of BOOKING_RETRY_CREDIT_RULES) {
  assert(pruned.includes(rule.prefix), `the prune covers ${rule.prefix}`);
  eq(rule.windowSeconds, 60, `${rule.prefix} counts over a minute, the window it extends`);
  eq(rule.max, RETRY_CREDIT_CAP, `${rule.prefix} restates the cap the module enforces`);
}
assert(
  BOOKING_RETRY_CREDIT_RULES[0].prefix.includes("earned") && BOOKING_RETRY_CREDIT_RULES[1].prefix.includes("spent"),
  "the earned key comes first and the spent key second, the order the module reads them in",
);

// --- 1. the lead from the incident ------------------------------------------------------------
{
  const clock = { now: 1_000_000 * WINDOW_MS };
  const { store } = fakeStore(clock);
  const credits = new RetryCredits(store);
  const native = nativeWindow(clock, BOOKING_LIMITER.perMinute);
  // Three confirms inside the window, each refused for a taken time.
  for (let i = 0; i < 3; i++) {
    clock.now += 5_000;
    assert(native(), `refused confirm ${i + 1} passes the native window`);
    await credits.earn(IP);
  }
  // The fourth pick is the one that met a 429 on 2026-10-06.
  clock.now += 5_000;
  assert(!native(), "the native window refuses the fourth confirm, as it did in production");
  eq(await credits.judge(IP, clock.now), "allowed", "a lead refused for taken times gets the next pick through");
}

// --- 2. no refusal, no credit ---------------------------------------------------------------
{
  const clock = { now: 2_000_000 * WINDOW_MS };
  const { store, calls } = fakeStore(clock);
  const credits = new RetryCredits(store);
  eq(await credits.judge(IP, clock.now), "no-credit", "an address never refused earns nothing");
  eq(calls.spend, 0, "and spends nothing, so a flood with no refusal behind it costs one read");
  // Another address's refusals are not this one's credit.
  await credits.earn("198.51.100.9");
  eq(await credits.judge(IP, clock.now), "no-credit", "a credit belongs to the address that earned it");
}

// --- 3. THE ABUSE BOUND: a refused flood from one address ------------------------------------
{
  const clock = { now: 3_000_000 * WINDOW_MS };
  const { store } = fakeStore(clock);
  // Ten isolates, each with its own in-memory gate, all sharing one store: the shape a
  // flood spread across a datacenter takes.
  const isolates = Array.from({ length: 10 }, () => new RetryCredits(store));
  const native = nativeWindow(clock, BOOKING_LIMITER.perMinute);
  const perMinute = new Map<number, number>();
  for (let i = 0; i < 5 * 600; i++) {
    clock.now += 100; // ten requests a second, for five minutes
    const isolate = isolates[i % isolates.length];
    let reached = native();
    if (!reached) reached = (await isolate.judge(IP, clock.now)) === "allowed";
    if (reached) {
      const minute = Math.floor(clock.now / WINDOW_MS);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
      // Every confirm in the flood is for a time already taken, so each earns a credit.
      await isolate.earn(IP);
    }
  }
  const worst = Math.max(...perMinute.values());
  const total = [...perMinute.values()].reduce((a, b) => a + b, 0);
  assert(worst > BOOKING_LIMITER.perMinute, `the credit does let a refused address past the native window (worst minute ${worst})`);
  // The spend window is anchored at its first spend rather than on the minute, so one
  // calendar minute can hold the tail of one spend window and the head of the next. The
  // bound that matters is per spend window, and over the run it is the total.
  assert(
    total <= 6 * (BOOKING_LIMITER.perMinute + RETRY_CREDIT_CAP),
    `3000 refused confirms over five minutes reach the route at most ${6 * (BOOKING_LIMITER.perMinute + RETRY_CREDIT_CAP)} times (reached ${total})`,
  );
  assert(
    worst <= BOOKING_LIMITER.perMinute + 2 * RETRY_CREDIT_CAP,
    `no calendar minute holds more than the native window plus two spend windows (worst ${worst})`,
  );
}

// --- 4. concurrent retries cannot overspend --------------------------------------------------
{
  const clock = { now: 4_000_000 * WINDOW_MS };
  const { store } = fakeStore(clock);
  const seed = new RetryCredits(store);
  await seed.earn(IP);
  await seed.earn(IP);
  // Two credits earned; twenty retries land at once across twenty isolates.
  const verdicts = await Promise.all(
    Array.from({ length: 20 }, () => new RetryCredits(store).judge(IP, clock.now)),
  );
  eq(verdicts.filter((v) => v === "allowed").length, 2, "twenty concurrent retries spend exactly the two credits earned");
  // And never more than the cap, however many were earned.
  for (let i = 0; i < 10; i++) await seed.earn("192.0.2.1");
  const many = await Promise.all(
    Array.from({ length: 20 }, () => new RetryCredits(store).judge("192.0.2.1", clock.now)),
  );
  eq(many.filter((v) => v === "allowed").length, RETRY_CREDIT_CAP, "ten earned credits still spend at most the cap");
}

// --- 5. a credit dies with its window ---------------------------------------------------------
{
  const clock = { now: 5_000_000 * WINDOW_MS };
  const { store } = fakeStore(clock);
  const credits = new RetryCredits(store);
  await credits.earn(IP);
  clock.now += WINDOW_MS + 1_000;
  eq(await credits.judge(IP, clock.now), "no-credit", "a refusal more than a minute old earns nothing now");
}

// --- 6. the isolate gate ------------------------------------------------------------------------
{
  const clock = { now: 6_000_000 * WINDOW_MS };
  const { store, calls } = fakeStore(clock);
  const credits = new RetryCredits(store);
  for (let i = 0; i < 200; i++) await credits.judge(IP, clock.now);
  eq(calls.read, RETRY_CREDIT_CAP, "an isolate asks the store at most the cap times a minute for one address");
  eq(await credits.judge(IP, clock.now), "isolate-gate", "and then answers by itself");
  clock.now += WINDOW_MS;
  await credits.judge(IP, clock.now);
  eq(calls.read, RETRY_CREDIT_CAP + 1, "the gate reopens with the next window");
}

// --- 7. a failing store throws, never answers ----------------------------------------------
{
  const broken: RetryCreditStore = {
    earn: async () => {
      throw new Error("earn refused");
    },
    readEarned: async () => {
      throw new Error("read refused");
    },
    spend: async () => {
      throw new Error("spend refused");
    },
  };
  const credits = new RetryCredits(broken);
  let threw: unknown = null;
  try {
    await credits.judge(IP, Date.now());
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && threw.message === "read refused", "an unreadable credit throws rather than reading as allowed or as none");
  let earnThrew: unknown = null;
  try {
    await credits.earn(IP);
  } catch (err) {
    earnThrew = err;
  }
  assert(earnThrew instanceof Error && earnThrew.message === "earn refused", "a failed earn throws, so the wrapper can say so");

  // A spend that fails after a good read throws too, rather than being read as spent.
  const clock = { now: 7_000_000 * WINDOW_MS };
  const { store } = fakeStore(clock);
  await store.earn(`${BOOKING_RETRY_CREDIT_RULES[0].prefix}:${IP}`);
  const halfBroken = new RetryCredits({ ...store, spend: async () => {
    throw new Error("spend refused");
  } });
  let spendThrew: unknown = null;
  try {
    await halfBroken.judge(IP, clock.now);
  } catch (err) {
    spendThrew = err;
  }
  assert(spendThrew instanceof Error && spendThrew.message === "spend refused", "a failed spend throws as well");
}

finish();

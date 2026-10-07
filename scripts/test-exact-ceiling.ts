// #3416: the booking API's exact hourly ceilings, moved from Postgres to the edge counter.
//
// The hourly per caller and per address ceilings were `rate_limit_hit` rows, and every booking
// API call paid a Supabase round trip for each before it reached the confirm line. A burst of a
// hundred confirms for one slot made two hundred of them in one second, and the Supabase API
// layer queued them in front of the one confirm that would actually book (load run 37547143303).
// They now count in the `BURST_LIMITER` Durable Object the per minute burst windows already use.
//
// These are security controls, so the point of this suite is that NOTHING about them changed
// except where the number is kept. The arithmetic is `rate_limit_hit`'s (migration 0024),
// asserted here clause by clause: the window opens at its first hit, every hit counts whether
// or not it is refused, the window resets only once STRICTLY older than its length, and a hit is
// allowed while the count including it is at most the limit. The direction it fails (open, and
// loud) is asserted where the failure is handled, in src/lib/rate-limit.test.ts.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-exact-ceiling.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  applyCounterRequest,
  bumpSharedWindow,
  BURST_WINDOW_MS,
  burstKey,
  EXACT_CEILING_AREA,
  exactCeilingAllows,
  exactCeilingKey,
  hitAnchoredWindow,
  MAX_EXACT_WINDOW_MS,
  readCounterRequest,
  readExactCeilingReply,
  type CounterWindow,
} from "@/lib/rate-limit-burst";
import {
  BOOKABLE_CHECK_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
  EDGE_LIMITERS,
  rateLimitKey,
  BOOKING_API_IP_LIMITER,
} from "@/lib/rate-limit-core";
import { BURST_VERIFY_AREA, BURST_VERIFY_KEY } from "@/lib/monitor/burst-counter-probe";
import { BurstLimiter } from "../worker/burst-limiter.ts";

const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;

/** Every rule an authorizer hands the exact counter, read off the shipped tables (L41). */
const BOOKING_API_HOURLY_RULES = [
  ...DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  ...DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  ...DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
  ...BOOKABLE_CHECK_HOURLY_RATE_RULES,
];

// --- the limits themselves did not move ---------------------------------------
{
  // Pinned by value: this change moves where the count is kept and nothing else, so a limit that
  // moved with it would be a different control shipped under the same name.
  eq(
    BOOKING_API_HOURLY_RULES.map((r) => `${r.prefix}/${r.windowSeconds}/${r.max}/${r.alertOnBlock === true}`).join(","),
    "bookapi:h/3600/6000/false,bookapi:ip:h/3600/1200/true,bookapi:read:h/3600/30000/false,bookapi:bookable:h/3600/200/false",
    "the booking API's hourly ceilings keep their prefixes, windows, limits and block alert",
  );
}

// --- rate_limit_hit's arithmetic, clause by clause ----------------------------
{
  const first = hitAnchoredWindow(null, T0, HOUR);
  eq(first, { windowStartMs: T0, count: 1 }, "the first hit opens the window AT that hit, counting itself");
  const second = hitAnchoredWindow(first, T0 + 10 * 60_000, HOUR);
  eq(second, { windowStartMs: T0, count: 2 }, "a later hit adds one and keeps the window where it opened");
  // Anchored to the first hit, not to a clock boundary: a window opened at 10:59 still runs to
  // 11:59. A clock aligned window here would have been a different ceiling.
  const offBoundary = hitAnchoredWindow(null, T0 + 59 * 60_000, HOUR);
  eq(
    hitAnchoredWindow(offBoundary, T0 + 61 * 60_000, HOUR).count,
    2,
    "the window is anchored to its first hit, not to the top of an hour",
  );
  // `window_start < now() - window` resets; equal does not.
  eq(hitAnchoredWindow(first, T0 + HOUR, HOUR), { windowStartMs: T0, count: 2 }, "a hit exactly one window after the first still counts in it");
  eq(
    hitAnchoredWindow(first, T0 + HOUR + 1, HOUR),
    { windowStartMs: T0 + HOUR + 1, count: 1 },
    "a hit strictly after the window resets it in place, at that hit",
  );
}

{
  // Every rule, walked to one past its limit: the hit AT the limit is allowed and the next is
  // refused, and a refused hit still counts, so the caller stays refused for the rest of the
  // window rather than earning a hit back by being turned away.
  for (const rule of BOOKING_API_HOURLY_RULES) {
    const windowMs = rule.windowSeconds * 1000;
    let w: CounterWindow | null = null;
    const verdicts: boolean[] = [];
    for (let i = 0; i < rule.max + 2; i++) {
      w = hitAnchoredWindow(w, T0 + i, windowMs);
      verdicts.push(exactCeilingAllows(w.count, rule.max));
    }
    assert(verdicts.slice(0, rule.max).every(Boolean), `${rule.prefix}: every hit up to ${rule.max} is allowed`);
    eq(verdicts[rule.max], false, `${rule.prefix}: hit ${rule.max + 1} is refused`);
    eq(verdicts[rule.max + 1], false, `${rule.prefix}: and a refused hit still counts, so the next is refused too`);
    eq(w?.count, rule.max + 2, `${rule.prefix}: refused hits are counted, as rate_limit_hit counts them`);
  }
}

// --- the key is the Postgres row's key, in a space nobody else uses -----------
{
  const keyCaller = rateLimitKey({ kind: "opaque", key: "key:regal" });
  const ipCaller = rateLimitKey({ kind: "address", ip: "203.0.113.9", keyPrefix: "ip:", policy: BOOKING_API_IP_LIMITER });
  eq(exactCeilingKey("bookapi:h", keyCaller), "exact:bookapi:h:key:regal", "per caller: the row key `bookapi:h:key:<caller>`, under exact:");
  eq(exactCeilingKey("bookapi:ip:h", ipCaller), "exact:bookapi:ip:h:ip:203.0.113.9", "per address: the row key `bookapi:ip:h:ip:<address>`, under exact:");
  for (const spec of EDGE_LIMITERS) {
    assert(spec.area !== EXACT_CEILING_AREA, `the ${spec.area} burst limiter cannot share the exact ceilings' key space`);
  }
  assert(BURST_VERIFY_AREA !== EXACT_CEILING_AREA, "nor can the verification command, which writes");
  assert(!BURST_VERIFY_KEY.startsWith(`${EXACT_CEILING_AREA}:`), "the verification key is not an exact ceiling's key");
  assert(
    !exactCeilingKey("bookapi:h", keyCaller).startsWith(burstKey("booking-api", "")),
    "and an exact key is never a burst key for the same caller",
  );
}

// --- what the object is asked -------------------------------------------------
{
  eq(readCounterRequest({ bump: 5 }), { kind: "burst", bump: 5 }, "the burst tracker's report reads as it always did");
  eq(readCounterRequest({}), { kind: "burst", bump: 1 }, "a report with no bump counts one");
  eq(readCounterRequest(null), { kind: "burst", bump: 1 }, "an unreadable body counts one, never none");
  eq(readCounterRequest({ hit: { windowMs: HOUR } }), { kind: "hit", windowMs: HOUR }, "a hit names its window");
  for (const bad of [0, -1, 1.5, Number.NaN, "3600000", null, MAX_EXACT_WINDOW_MS + 1]) {
    eq(readCounterRequest({ hit: { windowMs: bad } }).kind, "unreadable", `a hit whose window is ${String(bad)} is refused, not guessed`);
  }
  eq(readCounterRequest({ hit: null }).kind, "unreadable", "a hit with no window is refused");
}

// --- what the object does with it ---------------------------------------------
{
  const burst = applyCounterRequest({ windowStartMs: T0, count: 4 }, { kind: "burst", bump: 3 }, T0 + 10);
  eq(burst.next, bumpSharedWindow({ windowStartMs: T0, count: 4 }, 3, T0 + 10), "a burst report is bumpSharedWindow, unchanged");
  eq(burst.alarmAtMs, T0 + 10 + 2 * BURST_WINDOW_MS, "and its object is still deleted two minutes after the last report");
  eq(Object.keys(burst.reply).sort(), ["count", "windowStartMs"], "and its answer is the shape the verification command reads");

  const hit = applyCounterRequest({ windowStartMs: T0, count: 7 }, { kind: "hit", windowMs: HOUR }, T0 + 20);
  eq(hit.next, { windowStartMs: T0, count: 8 }, "a hit is rate_limit_hit's arithmetic");
  eq(hit.reply, { count: 8, windowStartMs: T0, windowMs: HOUR }, "and its answer names the window it counted");
  // Deleting a window that is still open would hand the caller a fresh hour: the alarm must sit
  // past the window's end for every window this write can belong to.
  assert(hit.alarmAtMs >= hit.next.windowStartMs + HOUR, "an hourly count is never deleted while its window is open");
  eq(hit.alarmAtMs, T0 + 20 + 2 * HOUR, "it is deleted two windows after the last hit");
}

// --- what the caller accepts as an answer --------------------------------------
{
  eq(readExactCeilingReply({ count: 3, windowStartMs: T0, windowMs: HOUR }, HOUR), { ok: true, count: 3 }, "a count for the window asked about is read");
  // An object still running the code from before this change counts a hit as a burst report: a
  // one minute window that resets every minute. Read as a count, that is an hourly ceiling of
  // 6000 a MINUTE, so it is refused (and the caller fails open, loudly) rather than believed.
  eq(readExactCeilingReply({ count: 3, windowStartMs: T0 }, HOUR).ok, false, "an answer that names no window is refused");
  eq(readExactCeilingReply({ count: 3, windowStartMs: T0, windowMs: 60_000 }, HOUR).ok, false, "an answer for another window is refused");
  for (const bad of [0, -2, 1.5, "3", null, undefined]) {
    eq(readExactCeilingReply({ count: bad, windowMs: HOUR }, HOUR).ok, false, `a count of ${String(bad)} is refused (a hit counts itself)`);
  }
  eq(readExactCeilingReply(null, HOUR).ok, false, "no object is refused");
}

// --- the Durable Object itself, around a fake storage ---------------------------
async function objectRuns() {
  const stored = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const object = new BurstLimiter({
    storage: {
      get: async <T>(k: string) => stored.get(k) as T | undefined,
      put: async <T>(k: string, v: T) => {
        stored.set(k, v);
      },
      setAlarm: async (t: number) => {
        alarmAt = t;
      },
      deleteAll: async () => {
        stored.clear();
      },
    },
  });
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const ask = async (body: unknown) => {
      const res = await object.fetch(
        new Request("https://burst-limiter.slate/count", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // An exact ceiling, hit by hit.
    const hits: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      now = T0 + i;
      hits.push((await ask({ hit: { windowMs: HOUR } })).body);
    }
    eq(hits.map((h) => (h as { count: number }).count), [1, 2, 3], "the object counts every hit, exactly once each");
    eq((hits[2] as { windowMs: number }).windowMs, HOUR, "and answers which window it counted");
    eq(alarmAt, T0 + 2 + 2 * HOUR, "and holds the hour's count until two hours after the last hit");
    now = T0 + HOUR + 1;
    eq((await ask({ hit: { windowMs: HOUR } })).body.count, 1, "the window resets once strictly older than an hour");

    // A malformed hit is refused and counts nothing.
    stored.clear();
    const refused = await ask({ hit: { windowMs: -5 } });
    eq(refused.status, 400, "a hit with no usable window is answered 400");
    eq(stored.size, 0, "and nothing is stored for it");

    // The burst tracker's report, unchanged.
    now = T0;
    const b1 = await ask({ bump: 21 });
    const b2 = await ask({ bump: 5 });
    eq([b1.body.count, b2.body.count], [21, 26], "the burst tracker's reports add up as they always did");
    eq(Object.keys(b2.body).sort(), ["count", "windowStartMs"], "and are answered in the shape the verification command reads");
    eq(alarmAt, T0 + 2 * BURST_WINDOW_MS, "and the burst object is still deleted two minutes later");
    eq((await ask("not json")).body.count, 27, "an unreadable report still counts as one request");
  } finally {
    Date.now = realNow;
  }
}

// --- nothing else writes the old rows ------------------------------------------
{
  // The authorizer is the only place these rules are spent, and it must spend them on the edge
  // counter. A second `allowRequest` with one of them would put a Supabase round trip back on
  // every booking API call, which is the queue this change exists to remove.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "booking", "route-auth.ts"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert(!/\ballowRequest\b/.test(src), "the booking API authorizer no longer calls allowRequest");
  assert(/\bexactCeilingWithinLimit\b/.test(src), "it asks the exact edge ceiling instead");
}

await objectRuns();
finish();

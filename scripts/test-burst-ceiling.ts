// #1536: the second ceiling, the one a concurrent burst cannot spread across.
//
// Measured against production on 2026-08-17 from one machine: 45 requests down one keep-alive
// socket were blocked exactly at 30, and 60 fired in parallel into the same datacenter in 1.1s
// were blocked ZERO times. Same address, same second, same configured ceiling. That is how
// Cloudflare's native limiter counts, and it means the practical guarantee on the one endpoint
// anybody on the internet can reach is not 30 a minute, it is 30 a minute per isolate, which a
// burst spreads across.
//
// The shape being tested here is deliberately NOT "replace the fast check". The edge binding
// stays first and stays free. What this adds is a counter that is exact within an isolate
// (JavaScript is single threaded, so incrementing a Map is deterministic in a way an
// eventually consistent datacenter counter is not), plus an escalation to a Durable Object
// once an address looks hot, which is the only thing that can hold ONE count across isolates.
//
// The three numbers that decide whether this is safe are the interesting part, and they are
// asserted rather than commented:
//
//   ESCALATE_AT   how busy an address has to look before we spend a round trip on it. Never
//                 blocks anything; it only decides who gets counted properly.
//   CEILING       the real ceiling, deliberately far ABOVE the edge limiter's 30. This is a
//                 backstop against a flood, not a tightening of the normal limit, because a
//                 large office behind one NAT address is a real Pennie lead source and today's
//                 gap is the only reason they are not already being refused.
//   MEMO_MS       how long a verdict may be reused, which bounds both the cost and the leak.
//
// Run: node --experimental-strip-types scripts/test-burst-ceiling.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  BurstTracker,
  BURST_CEILING_PER_MINUTE,
  BURST_ESCALATE_AT,
  BURST_MEMO_MS,
  BURST_TRACKED_KEY_CAP,
  BURST_WINDOW_MS,
  burstWindowCount,
  bumpSharedWindow,
  BURST_LIMITER_BINDING,
  BURST_LIMITER_CLASS,
} from "@/lib/rate-limit-burst";

const T0 = 1_760_000_000_000;

/** A tracker whose clock and DO answers are both injected, so nothing here is timing dependent. */
function tracker(answers: { count: number }[] | ((bump: number) => { count: number })) {
  const asked: { key: string; bump: number }[] = [];
  let i = 0;
  const t = new BurstTracker({
    ask: async (key, bump) => {
      asked.push({ key, bump });
      if (typeof answers === "function") return answers(bump);
      return answers[Math.min(i++, answers.length - 1)] ?? { count: 0 };
    },
  });
  return { t, asked };
}

// --- the numbers themselves ---------------------------------------------------

{
  assert(
    BURST_CEILING_PER_MINUTE > 30,
    "the second ceiling sits ABOVE the edge limiter's 30, so it is a flood backstop and not a " +
      "quiet tightening of the limit real leads are served under",
  );
  assert(
    BURST_ESCALATE_AT < BURST_CEILING_PER_MINUTE,
    "and escalation happens before the ceiling, or the ceiling could never be measured",
  );
  assert(
    BURST_ESCALATE_AT > 5,
    "escalation is well clear of what one lead's page loads cost, so ordinary traffic never " +
      "pays a round trip",
  );
  assert(
    BURST_MEMO_MS <= 2_000,
    "a reused verdict is worth at most a second or two of traffic: that window IS the leak",
  );
  eq(BURST_WINDOW_MS, 60_000, "the window matches the per-minute ceiling it is stated in");
}

// --- counting inside one isolate is exact ------------------------------------

{
  // The property the native limiter does not have. Sixty concurrent requests reach one isolate
  // as sixty synchronous increments, so the count cannot be raced.
  const counts = new Map<string, { windowStartMs: number; count: number }>();
  let last = 0;
  for (let i = 0; i < 60; i++) last = burstWindowCount(counts, "1.2.3.4", T0, BURST_WINDOW_MS);
  eq(last, 60, "sixty requests in one window count as sixty, however they arrived");

  // And the window really rolls rather than accumulating for ever.
  eq(
    burstWindowCount(counts, "1.2.3.4", T0 + BURST_WINDOW_MS, BURST_WINDOW_MS),
    1,
    "a request in the next window starts that window's count again",
  );
  eq(
    burstWindowCount(counts, "5.6.7.8", T0, BURST_WINDOW_MS),
    1,
    "and one address's traffic is never counted against another's",
  );
}

{
  // An attacker rotating addresses must not be able to grow this map without bound: it lives
  // in an isolate that can be reused for a long time.
  const counts = new Map<string, { windowStartMs: number; count: number }>();
  for (let i = 0; i < BURST_TRACKED_KEY_CAP + 50; i++) {
    burstWindowCount(counts, `10.0.0.${i}`, T0, BURST_WINDOW_MS);
  }
  assert(
    counts.size <= BURST_TRACKED_KEY_CAP,
    `tracking is capped at ${BURST_TRACKED_KEY_CAP} addresses, so a rotating flood cannot grow it`,
  );
}

// --- the hot path stays free --------------------------------------------------

{
  const { t, asked } = tracker([{ count: 1 }]);
  let allowed = true;
  for (let i = 0; i < BURST_ESCALATE_AT; i++) {
    allowed = await t.allow("1.2.3.4", T0);
  }
  eq(allowed, true, "an ordinary address is allowed");
  eq(asked.length, 0, "and costs no round trip at all: the whole point of the escalation");
}

// --- escalation, and what it reports ----------------------------------------

{
  const { t, asked } = tracker([{ count: BURST_ESCALATE_AT + 1 }]);
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("1.2.3.4", T0);
  eq(asked.length, 1, "crossing the escalation point asks the shared counter, once");
  eq(
    asked[0]!.bump,
    BURST_ESCALATE_AT + 1,
    "and reports every request this isolate has seen in the window, not just the one that " +
      "crossed: an unreported request is one the shared count never learns about",
  );
}

{
  // The memo. A hot address must not cost a round trip per request, and the requests it
  // covers must still be reported on the NEXT ask, or the shared count silently under-counts
  // exactly the traffic the ceiling exists to measure.
  const { t, asked } = tracker(() => ({ count: 40 }));
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("1.2.3.4", T0);
  eq(asked.length, 1, "one ask so far");
  for (let i = 0; i < 5; i++) await t.allow("1.2.3.4", T0 + 10);
  eq(asked.length, 1, "requests inside the memo window reuse the verdict");
  await t.allow("1.2.3.4", T0 + BURST_MEMO_MS + 1);
  eq(asked.length, 2, "and the memo expires");
  eq(asked[1]!.bump, 6, "the six requests it covered are reported on the next ask, not lost");
}

// --- the ceiling actually refuses -------------------------------------------

{
  const { t } = tracker(() => ({ count: BURST_CEILING_PER_MINUTE + 1 }));
  let allowed = true;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await t.allow("1.2.3.4", T0);
  eq(allowed, false, "past the ceiling the request is refused");

  const { t: t2 } = tracker(() => ({ count: BURST_CEILING_PER_MINUTE }));
  let allowed2 = false;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed2 = await t2.allow("1.2.3.4", T0);
  eq(allowed2, true, "exactly at the ceiling is still served: the ceiling is what is allowed");
}

{
  // A refusal is memoed too, so a flood does not buy a round trip per request by being blocked.
  const { t, asked } = tracker(() => ({ count: BURST_CEILING_PER_MINUTE + 1 }));
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("9.9.9.9", T0);
  const asksAfterFirstBlock = asked.length;
  for (let i = 0; i < 20; i++) {
    eq(await t.allow("9.9.9.9", T0 + 5), false, "still refused");
  }
  eq(asked.length, asksAfterFirstBlock, "and refusing costs nothing more while the memo holds");
}

// --- it fails OPEN, loudly ---------------------------------------------------

{
  // The same contract as every other limiter here: a check we could not make must never turn
  // away a real lead loading the booker. The alerting half lives in rate-limit.ts, which is
  // where the other limiters' fail-open alerting already is.
  const asked: number[] = [];
  const t = new BurstTracker({
    ask: async (_key, bump) => {
      asked.push(bump);
      throw new Error("durable object unreachable");
    },
  });
  let allowed = false;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await t.allow("1.2.3.4", T0);
  eq(allowed, true, "an unreachable shared counter serves the request");
  assert(asked.length > 0, "and it really did try, so this is not passing on a skipped call");
}

{
  // A thrown ask must not silently swallow the requests it was reporting: the next successful
  // ask has to carry them, or an outage becomes a hole in the count.
  let calls = 0;
  const seen: number[] = [];
  const t = new BurstTracker({
    ask: async (_key, bump) => {
      calls += 1;
      seen.push(bump);
      if (calls === 1) throw new Error("transient");
      return { count: 1 };
    },
  });
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("1.2.3.4", T0);
  await t.allow("1.2.3.4", T0 + BURST_MEMO_MS + 1);
  eq(seen.length, 2, "it asked again after the failure");
  eq(
    seen[1],
    seen[0]! + 1,
    "and the failed ask's requests are still carried, so an outage leaves no hole in the count",
  );
}

// --- one flight per key ------------------------------------------------------

{
  // A burst crossing the escalation point arrives concurrently. Without a guard every one of
  // those requests would open its own round trip to the same object, which is both the
  // slowest possible answer and a self inflicted flood on the thing measuring the flood.
  let inFlight = 0;
  let maxInFlight = 0;
  const t = new BurstTracker({
    ask: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { count: 40 };
    },
  });
  await Promise.all(
    Array.from({ length: 30 }, () => t.allow("1.2.3.4", T0)),
  );
  eq(maxInFlight, 1, "concurrent requests for one address share a single round trip");
}

// --- the shared counter's own arithmetic --------------------------------------

{
  eq(
    bumpSharedWindow(null, 21, T0).count,
    21,
    "a first report starts the window at what it reported",
  );
  const first = bumpSharedWindow(null, 21, T0);
  eq(bumpSharedWindow(first, 5, T0 + 10).count, 26, "later reports add to it");
  eq(
    bumpSharedWindow(first, 5, T0 + BURST_WINDOW_MS).count,
    5,
    "and a report in the next window starts that window rather than inheriting the flood",
  );
  // A flood must not be able to talk its own count down, and a caller bug must not either.
  eq(bumpSharedWindow(first, -100, T0 + 10).count, 21, "a negative report adds nothing");
  eq(bumpSharedWindow(first, NaN, T0 + 10).count, 21, "nor does an unreadable one");
  eq(bumpSharedWindow(first, 1.9, T0 + 10).count, 22, "a fractional report is floored, not rounded up");
}

// --- the three places that must name this binding -----------------------------
//
// The binding is declared in wrangler.jsonc, created by a migration there, exported from the
// worker entry wrangler actually loads, and looked up by name in the app. None of those four
// can see the others, and each direction fails silently in its own way (L41): a rename in the
// app makes the ceiling fail open for ever (loudly, but only once a request arrives), a class
// missing from the migrations block makes the deploy itself fail, and an export missing from
// the entry makes wrangler unable to find the class at all.
{
  const raw = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  // Strip line comments before parsing, so a name inside a COMMENT can never answer for a
  // binding that is not declared (L103). Same treatment as test-edge-limiter-bindings.ts.
  const withoutComments = raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx === -1) return line;
      if (line.slice(Math.max(0, idx - 1), idx + 1) === ":/") return line;
      return line.slice(0, idx);
    })
    .join("\n");
  const config = JSON.parse(withoutComments) as {
    durable_objects?: { bindings?: { name: string; class_name: string }[] };
    migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  };

  const bound = config.durable_objects?.bindings ?? [];
  const entry = bound.find((b) => b.name === BURST_LIMITER_BINDING);
  assert(
    entry !== undefined,
    `wrangler.jsonc binds ${BURST_LIMITER_BINDING}, which is the name the app looks up`,
  );
  eq(
    entry?.class_name,
    BURST_LIMITER_CLASS,
    "and binds it to the class the worker entry exports",
  );

  const created = (config.migrations ?? []).flatMap((m) => [
    ...(m.new_sqlite_classes ?? []),
    ...(m.new_classes ?? []),
  ]);
  assert(
    created.includes(BURST_LIMITER_CLASS),
    `a migration creates ${BURST_LIMITER_CLASS}; a Durable Object class that is bound but never ` +
      "created fails the deploy rather than the request, which is the good direction but still " +
      "has to be true",
  );

  const workerEntry = readFileSync(join(import.meta.dirname, "..", "worker", "index.ts"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert(
    workerEntry.includes(BURST_LIMITER_CLASS),
    "the worker entry re-exports the class, because that is the module wrangler loads",
  );
}

finish();

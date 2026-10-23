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
  BURST_ESCALATE_AT,
  BURST_MEMO_MS,
  BURST_TRACKED_KEY_CAP,
  BURST_WINDOW_MS,
  burstWindowCount,
  bumpSharedWindow,
  burstKey,
  BURST_LIMITER_BINDING,
  BURST_LIMITER_CLASS,
  burstEscalateAt,
  MACHINE_ESCALATE_SUSTAINED_MULTIPLE,
  type BurstLimits,
} from "@/lib/rate-limit-burst";
import { EDGE_LIMITERS, BOOKING_API_READ_LIMITER } from "@/lib/rate-limit-core";

const T0 = 1_760_000_000_000;

/** The availability ceiling, used to drive the tracker in the cases below. Read off the
 *  shared table rather than restated, so a test cannot pass against a number the product
 *  no longer enforces (L41). */
const AVAILABILITY = EDGE_LIMITERS.find((l) => l.area === "availability")!;
const CEILING = AVAILABILITY.burstCeilingPerMinute;
/** Availability's ceiling and escalation point, derived the way the product derives them. */
const LIMITS: BurstLimits = {
  ceilingPerMinute: CEILING,
  escalateAt: burstEscalateAt(AVAILABILITY),
};

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
  // #1556: every edge limiter carries a burst ceiling now, not just availability, so the
  // property is asserted for each rather than for the one that happened to have it. The
  // ratio is the whole safety argument: a ceiling AT the sustained limit would make the
  // native limiter's approximate 30 exact, which is a tightening real leads would feel
  // (a large office behind one NAT address is a real Pennie lead source). Ten times it is
  // a flood backstop nothing legitimate reaches.
  assert(EDGE_LIMITERS.length > 0, "there are edge limiters to check");
  for (const spec of EDGE_LIMITERS) {
    assert(
      spec.burstCeilingPerMinute >= spec.perMinute * 10,
      `${spec.binding}'s burst ceiling (${spec.burstCeilingPerMinute}/min) is at least ten times ` +
        `its sustained limit (${spec.perMinute}/min), so it is a flood backstop and never a ` +
        "quiet tightening of the limit real callers are served under",
    );
    assert(
      burstEscalateAt(spec) < spec.burstCeilingPerMinute,
      `${spec.binding} escalates (at ${burstEscalateAt(spec)}) before its ceiling, or the ` +
        "ceiling could never be measured",
    );
  }

  // #1565: the escalation point is derived per limiter now. A lead facing limiter keeps the
  // shared 20, which was sized for a lead's page loads. A machine to machine limiter escalates
  // at its own sustained limit, so an integrator polling inside its allowance never pays a
  // round trip, and one past it is counted exactly.
  for (const spec of EDGE_LIMITERS) {
    assert(
      spec.audience === "lead" || spec.audience === "machine",
      `${spec.binding} says who calls it, which is what decides its escalation point`,
    );
    // Every limiter keyed on an authenticated key, or alerting on a block because its caller
    // is our own bot, is machine to machine. A new one declared "lead" would quietly inherit
    // availability's threshold, which is the defect #1565 is about.
    if (spec.keyKind === "api-key" || spec.alertOnBlock === true) {
      eq(spec.audience, "machine", `${spec.binding} is a machine to machine limiter`);
    }
    if (spec.audience === "machine") {
      eq(
        burstEscalateAt(spec),
        Math.max(BURST_ESCALATE_AT, spec.perMinute * MACHINE_ESCALATE_SUSTAINED_MULTIPLE),
        `${spec.binding} escalates at its own sustained limit, not at availability's 20`,
      );
    } else {
      eq(burstEscalateAt(spec), BURST_ESCALATE_AT, `${spec.binding} keeps the lead threshold`);
    }
  }
  // Not vacuous: the read path really does escalate later than it used to.
  eq(burstEscalateAt(BOOKING_API_READ_LIMITER), 600, "the read path escalates at its 600 a minute");
  eq(
    EDGE_LIMITERS.filter((l) => l.audience === "machine").map((l) => l.area).sort(),
    ["bearer-failure", "booking-api", "booking-api-ip", "booking-api-read"],
    "the three booking API limiters, and the failed credential one beside them on the key authed routes (#3142), are the machine to machine ones",
  );

  // Two limiters sharing an area would share ONE burst counter, so the tighter endpoint's
  // ceiling would be spent by the looser one's traffic: the same defect the unique
  // namespace_id check catches for the native bindings.
  const areas = EDGE_LIMITERS.map((l) => l.area);
  eq(new Set(areas).size, areas.length, "every limiter has its own burst key space");
  // The same holds for the NATIVE counter, which is keyed per binding (#3106): two limiters
  // may share a binding only when one counts under its own key prefix, so the pair that
  // must be unique is the binding and the prefix together.
  const nativeSpaces = EDGE_LIMITERS.map(
    (l) => `${l.binding}|${"nativeKeyPrefix" in l ? l.nativeKeyPrefix : ""}`,
  );
  eq(new Set(nativeSpaces).size, nativeSpaces.length, "and its own native key space");
  // Positive control: two limiters on one binding with no prefix collapse to one space.
  const collided = [EDGE_LIMITERS[0], { ...EDGE_LIMITERS[0], area: "copy" }].map(
    (l) => `${l.binding}|${"nativeKeyPrefix" in l ? l.nativeKeyPrefix : ""}`,
  );
  eq(new Set(collided).size, 1, "a shared binding with no prefix is caught as one key space");
  for (const spec of EDGE_LIMITERS) {
    if (!("nativeKeyPrefix" in spec)) continue;
    const owner = EDGE_LIMITERS.find((l) => l.binding === spec.binding && !("nativeKeyPrefix" in l));
    assert(
      owner !== undefined && owner.perMinute === spec.perMinute,
      `${spec.area} shares ${spec.binding} and states the per minute number that binding enforces`,
    );
  }

  // The key kind decides whether an unidentifiable-caller rule can even apply: a per-key
  // limiter's key is an API key id from auth, which is never the unidentified-address
  // fallback. A limiter that declared the wrong kind would apply an address rule to a key.
  for (const spec of EDGE_LIMITERS) {
    assert(
      spec.keyKind === "ip" || spec.keyKind === "api-key",
      `${spec.binding} says what its key IS, so an address rule cannot be applied to a key id`,
    );
  }
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
    allowed = await t.allow("1.2.3.4", T0, LIMITS);
  }
  eq(allowed, true, "an ordinary address is allowed");
  eq(asked.length, 0, "and costs no round trip at all: the whole point of the escalation");
}

{
  // #1565: a machine caller inside its sustained limit pays nothing, however hard it polls.
  const read = BOOKING_API_READ_LIMITER;
  const readLimits: BurstLimits = {
    ceilingPerMinute: read.burstCeilingPerMinute,
    escalateAt: burstEscalateAt(read),
  };
  const { t, asked } = tracker(() => ({ count: 1 }));
  for (let i = 0; i < read.perMinute; i++) await t.allow("key:regal", T0, readLimits);
  eq(asked.length, 0, "600 reads in a minute from one key cost no round trip");
  await t.allow("key:regal", T0, readLimits);
  eq(asked.length, 1, "the first read past the sustained limit is counted exactly");
  eq(asked[0]!.bump, read.perMinute + 1, "and reports every read the isolate saw");
}

{
  // The log line that lets the escalation rate be measured once real traffic exists. Once
  // per key per window, not once per request, so a hot key cannot flood the logs.
  const escalations: number[] = [];
  const limits: BurstLimits = { ...LIMITS, onEscalate: (count) => escalations.push(count) };
  const { t } = tracker(() => ({ count: 1 }));
  for (let i = 0; i < LIMITS.escalateAt; i++) await t.allow("1.2.3.4", T0, limits);
  eq(escalations.length, 0, "no escalation is reported below the threshold");
  for (let i = 0; i < 10; i++) await t.allow("1.2.3.4", T0 + BURST_MEMO_MS * 2 * i, limits);
  eq(escalations, [LIMITS.escalateAt + 1], "crossing it is reported once, with the count");
  for (let i = 0; i <= LIMITS.escalateAt; i++) {
    await t.allow("1.2.3.4", T0 + BURST_WINDOW_MS, limits);
  }
  eq(escalations.length, 2, "and again in the next window, when the key escalates again");
}

// --- escalation, and what it reports ----------------------------------------

{
  const { t, asked } = tracker([{ count: BURST_ESCALATE_AT + 1 }]);
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("1.2.3.4", T0, LIMITS);
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
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("1.2.3.4", T0, LIMITS);
  eq(asked.length, 1, "one ask so far");
  for (let i = 0; i < 5; i++) await t.allow("1.2.3.4", T0 + 10, LIMITS);
  eq(asked.length, 1, "requests inside the memo window reuse the verdict");
  await t.allow("1.2.3.4", T0 + BURST_MEMO_MS + 1, LIMITS);
  eq(asked.length, 2, "and the memo expires");
  eq(asked[1]!.bump, 6, "the six requests it covered are reported on the next ask, not lost");
}

// --- the ceiling actually refuses -------------------------------------------

{
  const { t } = tracker(() => ({ count: CEILING + 1 }));
  let allowed = true;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await t.allow("1.2.3.4", T0, LIMITS);
  eq(allowed, false, "past the ceiling the request is refused");

  const { t: t2 } = tracker(() => ({ count: CEILING }));
  let allowed2 = false;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed2 = await t2.allow("1.2.3.4", T0, LIMITS);
  eq(allowed2, true, "exactly at the ceiling is still served: the ceiling is what is allowed");
}

{
  // A refusal is memoed too, so a flood does not buy a round trip per request by being blocked.
  const { t, asked } = tracker(() => ({ count: CEILING + 1 }));
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("9.9.9.9", T0, LIMITS);
  const asksAfterFirstBlock = asked.length;
  for (let i = 0; i < 20; i++) {
    eq(await t.allow("9.9.9.9", T0 + 5, LIMITS), false, "still refused");
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
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) allowed = await t.allow("1.2.3.4", T0, LIMITS);
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
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow("1.2.3.4", T0, LIMITS);
  await t.allow("1.2.3.4", T0 + BURST_MEMO_MS + 1, LIMITS);
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
    Array.from({ length: 30 }, () => t.allow("1.2.3.4", T0, LIMITS)),
  );
  eq(maxInFlight, 1, "concurrent requests for one address share a single round trip");
}

// --- one counter per endpoint, not one counter (#1556) ------------------------

{
  // The shape decision behind #1556: ONE Durable Object namespace, with the endpoint in the
  // key, rather than a namespace per endpoint. The object id is derived from this key, so the
  // prefix is what keeps two endpoints' counts apart. Without it a lead's availability reads
  // and their confirm tap would draw on ONE count, and whichever ceiling is lower would be
  // spent by the other endpoint's traffic.
  const a = burstKey("availability", "1.2.3.4");
  const b = burstKey("booking", "1.2.3.4");
  assert(a !== b, "the same address on two endpoints is two counters, never one");
  assert(a.includes("1.2.3.4"), "and the address is still in the key");
  assert(a.includes("availability"), "and so is the endpoint it is counted for");

  // Proven through the tracker, not only through the helper: the in-isolate count is keyed
  // the same way, so a shared prefix would also let one endpoint escalate the other.
  const { t, asked } = tracker(() => ({ count: 1 }));
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) await t.allow(a, T0, LIMITS);
  eq(asked.length, 1, "the availability key escalated");
  await t.allow(b, T0, LIMITS);
  eq(asked.length, 1, "and one request on the booking key has not, so the counts are separate");
}

{
  // The ceiling is per call now, so a limiter with a low one must actually be judged against
  // it. Availability's 300 would have served this.
  const booking = EDGE_LIMITERS.find((l) => l.area === "booking")!;
  assert(
    booking.burstCeilingPerMinute < CEILING,
    "the booking ceiling really is lower than availability's, so this case is not vacuous",
  );
  const { t } = tracker(() => ({ count: booking.burstCeilingPerMinute + 1 }));
  let allowed = true;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
    allowed = await t.allow(burstKey("booking", "1.2.3.4"), T0, { ceilingPerMinute: booking.burstCeilingPerMinute, escalateAt: BURST_ESCALATE_AT });
  }
  eq(allowed, false, "a count over THIS endpoint's ceiling is refused");

  const { t: t2 } = tracker(() => ({ count: booking.burstCeilingPerMinute + 1 }));
  let allowed2 = false;
  for (let i = 0; i <= BURST_ESCALATE_AT; i++) {
    allowed2 = await t2.allow(burstKey("availability", "1.2.3.4"), T0, LIMITS);
  }
  eq(allowed2, true, "and the same count under availability's higher ceiling is served");
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
// The binding is declared in wrangler.jsonc and looked up by name in the app; since #3555 the
// class is created by a migration in, and exported from the entry of, its own small Worker
// (wrangler.burst-limiter.jsonc), which the binding names by script name. Slate's own copy is
// deleted (#4025). None of those places can see the others, and each direction fails silently
// in its own way (L41): a rename in the app makes the ceiling fail open for ever (loudly, but
// only once a request arrives), a class missing from the small Worker's migrations makes its
// deploy fail, and an export missing from its entry makes wrangler unable to find the class.
{
  const stripLineComments = (raw: string) =>
    raw
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        if (idx === -1) return line;
        if (line.slice(Math.max(0, idx - 1), idx + 1) === ":/") return line;
        return line.slice(0, idx);
      })
      .join("\n");
  const raw = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  // Strip line comments before parsing, so a name inside a COMMENT can never answer for a
  // binding that is not declared (L103). Same treatment as test-edge-limiter-bindings.ts.
  const config = JSON.parse(stripLineComments(raw)) as {
    durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
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
    "and binds it to the class the small Worker's entry exports",
  );
  eq(entry?.script_name, "slate-burst-limiter", "served by the small burst limiter Worker, by script name");

  const own = JSON.parse(
    stripLineComments(readFileSync(join(import.meta.dirname, "..", "wrangler.burst-limiter.jsonc"), "utf8")),
  ) as { name?: string; migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[] };
  eq(own.name, entry?.script_name, "the small Worker's config deploys the Worker the binding names");
  const created = (own.migrations ?? []).flatMap((m) => [
    ...(m.new_sqlite_classes ?? []),
    ...(m.new_classes ?? []),
  ]);
  assert(
    created.includes(BURST_LIMITER_CLASS),
    `the small Worker's migration creates ${BURST_LIMITER_CLASS}; a Durable Object class that is bound but never ` +
      "created fails the deploy rather than the request, which is the good direction but still " +
      "has to be true",
  );

  const workerEntry = readFileSync(join(import.meta.dirname, "..", "worker", "burst-limiter", "index.ts"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert(
    new RegExp(`export\\s*\\{\\s*${BURST_LIMITER_CLASS}\\s*\\}`).test(workerEntry),
    "the small Worker's entry exports the class, because that is the module its wrangler config loads",
  );
}

finish();

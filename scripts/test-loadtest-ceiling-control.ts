// What the per address write ceiling control can and cannot prove (#2275, #2339).
//
// Three passes of this control could not conclude, and each time the reason was a
// different one. The history is kept because each fix is only readable next to the
// mistake it answers.
//
//   1. IT SENT `ceiling + 1`, ALL AT ONCE, and required the last to be refused.
//      Cloudflare's own documentation says the Rate Limiting API "is permissive,
//      eventually consistent, and intentionally designed to not be used as an
//      accurate accounting system", with "a unique limit per Cloudflare location".
//      Asking that counter to refuse ONE marginal request out of a simultaneous
//      burst is close to the least likely thing it will do (L1, L172).
//
//   2. THE VERDICT COULD NOT TELL A CEILING REFUSAL FROM AN APPLICATION ONE. Run
//      34658545203 sent 61 and was answered 409 sixty one times, which rendered
//      exactly like a healthy unthrottled control, and the run blamed a ceiling
//      whose own steady pass had refused four times (L11, L98).
//
//   3. THE BAR ASKED FOR SOMETHING THE PLATFORM NEVER PROMISED. Run 34889873261
//      sent 180 writes from ONE measured address in 20 seconds against a 60 a
//      minute ceiling and every one was allowed, with the binding present and
//      answering. That is the documented behaviour of an eventually consistent,
//      per location counter, so a bar built on it fails for a reason nobody should
//      fix, which is how a bar stops being read (L36).
//
// So the control now aims at the bound that IS exact, the per address HOURLY cap,
// and reads WHICH ceiling refused from the deployment's own echo rather than
// inferring it from a 429. Both ceilings answer 429 through one refusal and a
// per key refusal wins over the address one (#3124), so a verdict that assumed a
// 429 was the address one would credit a ceiling whose verdict was not the answer (L70).
//
// Run: node --experimental-strip-types scripts/test-loadtest-ceiling-control.ts
import { readFileSync } from "node:fs";
import {
  CEILING_EXACT_MARGIN,
  CEILING_CONCLUSION,
  CEILING_REFUSED_BY,
  CEILING_TIGHTNESS_FLOOR,
  CONTROL_UNIDENTIFIED_IP,
  CEILING_CONTROL_KEY_SHARE,
  ceilingControlBudget,
  ceilingControlPerMinute,
  ceilingWaveDelayMs,
  ceilingVerdict,
  chooseCeilingTarget,
  exactAddressBound,
  type CeilingAttempt,
} from "./loadtest/preflight-checks.ts";
import {
  clientIp,
  BOOKING_API_WRITE_LIMITER,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "../src/lib/rate-limit-core.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CEILING = 60;
/** Small enough to build fixtures from, and never the real number, which is derived. */
const EXACT = 200;

// --- the bound the control aims at is the app's own, not a number written twice --
{
  const derived = exactAddressBound(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES);
  assert(derived !== null, "the app really states a per address hourly cap");
  eq(
    derived,
    Math.min(...DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES.map((r) => r.max)),
    "and the TIGHTEST rule is the one a budget has to clear, since it refuses first",
  );
  eq(
    exactAddressBound([]),
    null,
    "no rule at all answers null, never a number: a budget derived from nothing would " +
      "send a fixed count and call whatever happened a measurement",
  );
  eq(exactAddressBound([{ max: 0 }]), null, "and a rule that bounds nothing is not a bound");
  eq(
    exactAddressBound([{ max: 900 }, { max: 300 }]),
    300,
    "the smallest max wins whatever order the rules are in",
  );
}

// --- the budget clears that bound, with a margin rather than a multiple ----------
{
  assert(CEILING_EXACT_MARGIN > 1, "the control goes PAST the exact bound, never exactly to it");
  assert(
    ceilingControlBudget(EXACT) > EXACT,
    `the budget clears the bound (${ceilingControlBudget(EXACT)} against ${EXACT})`,
  );
  assert(
    CEILING_EXACT_MARGIN < 2,
    "and it is a margin, not an overshoot: an exact counter needs no multiple, which is " +
      "the whole difference from the approximate ceiling this replaced",
  );
  eq(ceilingControlBudget(0), 1, "a zero bound still sends something rather than nothing");
}

// --- the pace stays under the per KEY ceiling, whose refusal wins -----------------
{
  assert(
    CEILING_CONTROL_KEY_SHARE < 1,
    "the control spends less than the whole per key budget, so it leaves room for drift",
  );
  const pace = ceilingControlPerMinute(BOOKING_API_WRITE_LIMITER.perMinute);
  assert(
    pace < BOOKING_API_WRITE_LIMITER.perMinute,
    `the pace (${pace}) stays under the per key ceiling (${BOOKING_API_WRITE_LIMITER.perMinute}), ` +
      "whose refusal wins over the per address one's (#3124)",
  );
  assert(
    pace > DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES[0]!.max / 60,
    "and it is comfortably above the per address hourly cap's own average rate, or the control " +
      "could never reach that cap inside one hour",
  );
  eq(ceilingControlPerMinute(0), 1, "a zero ceiling still sends something rather than nothing");
}

// --- the pacing is measured against the clock, never against its own sleeps ---------
{
  // A timer built by adding up its own sleeps measures iterations, and every round
  // trip the requests take makes it slower than the rate it believes it holds
  // (L226). So the wait is what is OWED at this point, given real elapsed time.
  eq(ceilingWaveDelayMs(60, 0, 60), 60_000, "sixty writes at sixty a minute owe a minute");
  eq(ceilingWaveDelayMs(60, 30_000, 60), 30_000, "half of which has already passed");
  eq(
    ceilingWaveDelayMs(60, 90_000, 60),
    0,
    "a run already behind its own rate waits not at all, rather than falling further behind",
  );
  eq(ceilingWaveDelayMs(10, 0, 0), 0, "a rate of nothing paces nothing");
}

// --- the wire values are the app's own spellings --------------------------------
{
  // These are strings on the wire, stamped by the deployment, so they cannot be
  // imported (the app modules they live in reach the `@/` alias, which the node
  // suite has none of). Pinning them against the source is what stops a rename
  // leaving this control silently unable to attribute anything (L41).
  const authSrc = readFileSync("src/lib/booking/api-auth.ts", "utf8");
  for (const value of Object.values(CEILING_REFUSED_BY)) {
    assert(
      new RegExp(`"${value}",`).test(authSrc),
      `the app still calls this refusal ${value}`,
    );
  }
  eq(
    new Set(Object.values<string>(CEILING_REFUSED_BY)).size,
    Object.keys(CEILING_REFUSED_BY).length,
    "and the two ceilings are told apart by different values, which is the whole point",
  );
  eq(
    clientIp(new Headers()),
    CONTROL_UNIDENTIFIED_IP,
    "and the unidentified caller is spelled the way the limiter itself spells it",
  );
}

/**
 * Attempts, stated rather than defaulted.
 *
 * Both echoes are REQUIRED on `CeilingAttempt` and both are written out here on
 * purpose (L70): a verdict handed a default would go on assuming the premise it
 * exists to check, and every fixture would agree with it.
 */
function attempts(
  parts: { n: number; status: number; seenIp?: string | null; refusedBy?: string | null }[],
): CeilingAttempt[] {
  return parts.flatMap((p) =>
    Array.from({ length: p.n }, () => ({
      status: p.status,
      seenIp: p.seenIp === undefined ? "203.0.113.9" : p.seenIp,
      refusedBy: p.refusedBy === undefined ? null : p.refusedBy,
    })),
  );
}

/** A run that was refused by the per address ceiling at write `at`. */
function refusedAt(at: number, total: number) {
  return attempts([
    { n: at - 1, status: 200 },
    { n: total - at + 1, status: 429, refusedBy: CEILING_REFUSED_BY.address },
  ]);
}

// --- the pass, refused by a layer tighter than the hourly cap --------------------
{
  const v = ceilingVerdict(refusedAt(90, 120), CEILING, EXACT);
  eq(v.conclusion, CEILING_CONCLUSION.applies, "a refusal the deployment credits to the address ceiling is the pass");
  eq(v.refusedByAddress, 31, "the address refusals are counted");
  eq(v.firstRefusedAt, 90, "with the position of the first one");
  assert(
    /tighter layer/.test(v.detail),
    "and the detail says a layer tighter than the hourly cap refused it, since 89 counted " +
      `is short of ${EXACT}`,
  );
}

// --- the pass, refused only once the exact cap was reached ----------------------
{
  // The reading #2339 exists to make possible. The approximate per minute ceiling
  // refused NOTHING and the hourly cap did all the work, which is a real fact about
  // the deployment and not a fault. Same conclusion, and it must not render the
  // same sentence, or the two readings are one (L11).
  const early = ceilingVerdict(refusedAt(90, 120), CEILING, EXACT);
  const late = ceilingVerdict(refusedAt(EXACT + 1, EXACT + 20), CEILING, EXACT);
  eq(late.conclusion, CEILING_CONCLUSION.applies, "reaching the exact cap is still a pass");
  assert(
    /a minute ceiling refused nothing/.test(late.detail),
    "and it SAYS the approximate per minute ceiling refused nothing",
  );
  assert(early.detail !== late.detail, "the two readings do not share a sentence");
}

// --- refusals far below the configured per minute ceiling ------------------------
{
  const v = ceilingVerdict(refusedAt(12, 120), CEILING, EXACT);
  assert(12 < CEILING * CEILING_TIGHTNESS_FLOOR, "the fixture really is far below the ceiling");
  eq(
    v.conclusion,
    CEILING_CONCLUSION.tighter,
    "refusing far below the configured ceiling is its own finding, since the run paces on that number",
  );
}

// --- the per KEY ceiling refused, and its refusal wins over the address one --------
{
  // The fault the echo exists to catch. Without it these 429s read as proof of the
  // per address ceiling, and the run would pass a bar that ceiling never met: a key
  // refusal is the answer whatever the address check said (#3124).
  const v = ceilingVerdict(
    attempts([
      { n: 40, status: 200 },
      { n: 80, status: 429, refusedBy: CEILING_REFUSED_BY.key },
    ]),
    CEILING,
    EXACT,
  );
  eq(v.conclusion, CEILING_CONCLUSION.keyCeilingOnly, "a per key refusal is never credited to the address ceiling");
  eq(v.refusedByKey, 80, "and the key refusals are counted under their own name");
  eq(v.refusedByAddress, 0, "with none credited to the address ceiling");
  eq(v.firstRefusedAt, null, "and no first ADDRESS refusal to report");
}

// --- a refusal that said nothing about which ceiling made it ----------------------
{
  const v = ceilingVerdict(
    attempts([{ n: 40, status: 200 }, { n: 80, status: 429, refusedBy: null }]),
    CEILING,
    EXACT,
  );
  eq(
    v.conclusion,
    CEILING_CONCLUSION.refusalUnattributed,
    "an unattributed refusal is its own conclusion, never a pass",
  );
  eq(v.refusedUnattributed, 80, "and they are counted apart from either ceiling");
}

// --- an ADDRESS refusal settles it whatever else the run met -----------------------
{
  // The address facts and the key refusals all explain an ABSENCE of refusals, so
  // none of them may override one that happened.
  const v = ceilingVerdict(
    attempts([
      { n: 40, status: 200, seenIp: "203.0.113.1" },
      { n: 20, status: 429, refusedBy: CEILING_REFUSED_BY.key, seenIp: "203.0.113.2" },
      { n: 20, status: 429, refusedBy: null, seenIp: "203.0.113.3" },
      { n: 40, status: 429, refusedBy: CEILING_REFUSED_BY.address, seenIp: "203.0.113.1" },
    ]),
    CEILING,
    EXACT,
  );
  eq(v.conclusion, CEILING_CONCLUSION.applies, "an address refusal is an address refusal");
  eq(v.firstRefusedAt, 81, "and the position skips the refusals the other ceilings made");
}

// --- an application refusal is COUNTED, and is not a reason to stop -----------------
{
  // The reversal #2339 makes explicit. `authorizeBookingApi` is the first statement
  // of the handler, so a 409 was metered exactly like a 200. The old verdict had a
  // whole conclusion for "the app refused everything", because it sent only three
  // times the ceiling and needed those writes to succeed to mean anything. With a
  // budget past an exact cap they drive the counter just as well, so the control no
  // longer depends on the roster offering a bookable time.
  const v = ceilingVerdict(
    attempts([{ n: EXACT, status: 409 }, { n: 20, status: 429, refusedBy: CEILING_REFUSED_BY.address }]),
    CEILING,
    EXACT,
  );
  eq(v.counted, EXACT, "every application refusal counted against the address");
  eq(v.allowed, 0, "and none of them counts as allowed");
  eq(v.appRefused, EXACT, "they are reported under their own name");
  eq(v.conclusion, CEILING_CONCLUSION.applies, "and the ceiling still showed itself");
}

// --- short of the exact bound, with nothing refused ---------------------------------
{
  // NOT the same as the ceiling being off, and this is the distinction the whole
  // change turns on. Below a bound something guarantees, a clean run is a run that
  // never reached one (L98).
  const v = ceilingVerdict(attempts([{ n: EXACT - 1, status: 200 }]), CEILING, EXACT);
  eq(v.conclusion, CEILING_CONCLUSION.underBudget, "short of the exact cap proves nothing either way");
  assert(
    !/not applying/.test(v.detail),
    "and it does not accuse a ceiling of something this never measured",
  );
}

// --- past the exact bound, with nothing refused --------------------------------------
{
  const v = ceilingVerdict(attempts([{ n: EXACT + 20, status: 200 }]), CEILING, EXACT);
  eq(
    v.conclusion,
    CEILING_CONCLUSION.neverRefused,
    "one measured address past the exact cap with no refusal is the only shape that indicts it",
  );
  eq(v.addresses.length, 1, "and the one address it was keyed on is reported");
  assert(/not applying/.test(v.detail), "and it does say so");
}

// --- the deployment could not read the caller's address --------------------------------
{
  // `judgeCaller` serves an unidentified caller UNJUDGED (#1557), so the per
  // address ceiling is structurally unable to refuse this run.
  const v = ceilingVerdict(
    attempts([{ n: EXACT + 20, status: 200, seenIp: CONTROL_UNIDENTIFIED_IP }]),
    CEILING,
    EXACT,
  );
  eq(v.conclusion, CEILING_CONCLUSION.callerUnidentified, "an unidentified caller is its own conclusion");
  eq(v.unidentified, EXACT + 20, "and every attempt is counted as unidentified");
  assert(!/not applying/.test(v.detail), "never `the ceiling is off`");
}

// --- the writes were spread over several addresses ---------------------------------------
{
  const v = ceilingVerdict(
    attempts([
      { n: 100, status: 200, seenIp: "203.0.113.1" },
      { n: 100, status: 200, seenIp: "203.0.113.2" },
      { n: 60, status: 200, seenIp: "203.0.113.3" },
    ]),
    CEILING,
    EXACT,
  );
  eq(v.conclusion, CEILING_CONCLUSION.severalAddresses, "one counter each is not one counter");
  eq(v.addresses.length, 3, "and the distinct addresses are counted");
}

// --- the deployment echoed no address at all ---------------------------------------------
{
  const v = ceilingVerdict(
    attempts([{ n: EXACT + 20, status: 200, seenIp: null }]),
    CEILING,
    EXACT,
  );
  eq(v.conclusion, CEILING_CONCLUSION.addressUnmeasured, "an unmeasured address is its own conclusion");
  eq(v.unreported, EXACT + 20, "and the unreported attempts are counted");
}

// --- never reached the deployment -----------------------------------------------------------
{
  const v = ceilingVerdict(attempts([{ n: 120, status: 0, seenIp: null }]), CEILING, EXACT);
  eq(v.conclusion, CEILING_CONCLUSION.neverReached, "a transport fault is never a refusal");
  eq(v.unreachable, 120, "and is counted as unreachable");
  eq(v.counted, 0, "and counted against nothing");
}

// --- refused at AUTH, before either limiter -------------------------------------------------
{
  const v = ceilingVerdict(attempts([{ n: 120, status: 401 }]), CEILING, EXACT);
  eq(v.conclusion, CEILING_CONCLUSION.notAuthorized, "a rejected key is its own conclusion");
  eq(v.counted, 0, "and a 401 never reached a counter");
}

// --- nothing sent -----------------------------------------------------------------------------
{
  const v = ceilingVerdict([], CEILING, EXACT);
  eq(v.conclusion, CEILING_CONCLUSION.nothingSent, "a control that sent nothing says so");
  eq(v.firstRefusedAt, null, "and refused nothing");
}

// --- a transport fault does not move a later refusal's position ---------------------------------
{
  const v = ceilingVerdict(
    attempts([
      { n: 1, status: 200 },
      { n: 1, status: 0, seenIp: null },
      { n: 1, status: 200 },
      { n: 1, status: 429, refusedBy: CEILING_REFUSED_BY.address },
    ]),
    CEILING,
    EXACT,
  );
  eq(v.firstRefusedAt, 4, "the position is where it happened");
  eq(v.unreachable, 1, "and the fault is still counted");
}

// --- choosing what to aim at ---------------------------------------------------------------------
{
  const target = chooseCeilingTarget([
    { code: "112", slots: [] },
    { code: "212", slots: ["2026-09-20T14:00:00.000Z", "2026-09-20T14:20:00.000Z"] },
    { code: "111", slots: ["2026-09-20T15:00:00.000Z"] },
  ]);
  assert(target !== null, "a code that is offering times is chosen");
  eq(target!.code, "212", "the first code with any offer wins");
  eq(target!.slots.length, 2, "and it keeps EVERY offered slot, since the steady pass can take one");
  eq(chooseCeilingTarget([{ code: "112", slots: [] }]), null, "no offers, no target");
  eq(chooseCeilingTarget([]), null, "nothing asked, no target");
}

// --- no two conclusions saying the same thing (L11) -----------------------------------------------
{
  const cases: CeilingAttempt[][] = [
    refusedAt(90, 120),
    refusedAt(12, 120),
    attempts([{ n: 40, status: 200 }, { n: 80, status: 429, refusedBy: CEILING_REFUSED_BY.key }]),
    attempts([{ n: 40, status: 200 }, { n: 80, status: 429, refusedBy: null }]),
    attempts([{ n: EXACT - 1, status: 200 }]),
    attempts([{ n: EXACT + 20, status: 200 }]),
    attempts([{ n: EXACT + 20, status: 200, seenIp: CONTROL_UNIDENTIFIED_IP }]),
    attempts([
      { n: 150, status: 200, seenIp: "203.0.113.1" },
      { n: 150, status: 200, seenIp: "203.0.113.2" },
    ]),
    attempts([{ n: EXACT + 20, status: 200, seenIp: null }]),
    attempts([{ n: 120, status: 0, seenIp: null }]),
    attempts([{ n: 120, status: 401 }]),
    [],
  ];
  const verdicts = cases.map((c) => ceilingVerdict(c, CEILING, EXACT));
  const details = new Set(verdicts.map((v) => v.detail));
  eq(details.size, verdicts.length, "every case produced a distinct sentence");
  eq(
    new Set(verdicts.map((v) => v.conclusion)).size,
    verdicts.length,
    "and a distinct conclusion, so no two send a reader to the same place",
  );

  // --- every declared conclusion is one some case can actually reach (L151) --------
  const reachable = new Set<string>(verdicts.map((v) => v.conclusion));
  for (const declared of Object.values(CEILING_CONCLUSION)) {
    assert(reachable.has(declared), `a declared conclusion no case can produce: ${declared}`);
  }
}

finish();

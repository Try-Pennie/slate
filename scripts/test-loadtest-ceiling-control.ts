// What the per address write ceiling control can and cannot prove (#2275).
//
// The issue says the control fails because it sends DRY RUNS and "the booking
// route returns from the dry run branch before the write limiter is ever
// consulted". That is not what happens. `authorizeBookingApi` is the FIRST
// statement of the POST handler (`src/app/api/bookings/route.ts`), well above the
// `if (v.dryRun)` branch, and BOTH ceilings live inside it. A dry run is metered
// exactly like a real write, so dropping `dryRun` would have fixed nothing.
//
// What the failed run actually produced, read from its own artifact
// (run 34658545203, `ip-ceiling.json`): 61 sent, **all 61 answered 409**, zero
// refused, zero unreachable. So every request passed the limiter and was then
// refused by the application. Two real defects:
//
//   1. IT SENT EXACTLY `ceiling + 1`, ALL AT ONCE. Cloudflare's own documentation
//      says the Rate Limiting API "is permissive, eventually consistent, and
//      intentionally designed to not be used as an accurate accounting system",
//      and that there is "a unique limit per Cloudflare location". Asking a
//      deliberately permissive, eventually consistent counter to refuse ONE
//      marginal request, from a simultaneous burst, is the least likely thing it
//      will do. The bar could not conclude by construction (L1, L172).
//
//   2. THE VERDICT COULD NOT TELL A CEILING REFUSAL FROM AN APPLICATION REFUSAL.
//      It counted only 429 as a refusal and 0 as unreachable; every other status,
//      including 61 consecutive 409s, read as "allowed". So a control whose every
//      request was being rejected by the app rendered identically to a healthy
//      control that simply was not throttled, and the run blamed the ceiling (L11,
//      L98). A reader sent to find out why the ceiling was off would have found
//      nothing wrong with it: the same run's steady pass was refused four times by
//      that very limiter.
//
// The SECOND pass is below, after the first pass's cases: the fixes above left
// the control still unable to conclude, and the 2026-09-14 run said why.
//
// Run: node --experimental-strip-types scripts/test-loadtest-ceiling-control.ts
import {
  CEILING_CONTROL_OVERSHOOT,
  CEILING_CONCLUSION,
  ceilingControlSize,
  ceilingNoSlot,
  ceilingVerdict,
  chooseCeilingTarget,
} from "./loadtest/preflight-checks.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CEILING = 60;

// --- the control must overshoot, because the counter is permissive by design ---
assert(
  CEILING_CONTROL_OVERSHOOT > 1,
  "the control sends a MULTIPLE of the ceiling, never ceiling + 1",
);
const size = ceilingControlSize(CEILING);
assert(
  size >= CEILING * 2,
  `it sends enough that a permissive counter must refuse (${size} against a ceiling of ${CEILING})`,
);

/**
 * The first pass's cases, restated as ATTEMPTS.
 *
 * Every one of them was written under the premise the second pass makes
 * explicit: one address, identified, for the whole control. Stating it here
 * rather than defaulting it inside `ceilingVerdict` is the point (L70): a
 * verdict that assumed one address when it was handed none would go on reading
 * exactly as it did before this change.
 */
function statuses(parts: { n: number; status: number }[]) {
  return parts.flatMap((p) =>
    Array.from({ length: p.n }, () => ({ status: p.status, seenIp: "203.0.113.9" })),
  );
}

// --- the healthy case ---------------------------------------------------------
{
  // Allowed up to about the ceiling, then refused. The exact crossing point is NOT
  // asserted, and that is the point: an eventually consistent counter does not have
  // one, and demanding it is what made the old bar unsatisfiable.
  const v = ceilingVerdict(
    statuses([{ n: 64, status: 200 }, { n: size - 64, status: 429 }]),
    CEILING,
  );
  eq(v.conclusion, CEILING_CONCLUSION.applies, "refusing after roughly the ceiling is the pass");
  eq(v.allowed, 64, "the allowed count is reported");
  eq(v.refused, size - 64, "and so is the refused count");
  eq(v.firstRefusedAt, 65, "with the position of the first refusal");
}

// --- THE RUN THAT MISLED SOMEBODY --------------------------------------------
// 61 requests, every one a 409 from the application. The old verdict read this as
// "nothing was refused, so the ceiling is not applying".
{
  const v = ceilingVerdict(statuses([{ n: 61, status: 409 }]), CEILING);
  eq(
    v.conclusion,
    CEILING_CONCLUSION.appRefusedEverything,
    "every request refused by the APP is its own conclusion, never `the ceiling is off`",
  );
  eq(v.appRefused, 61, "the application refusals are counted separately");
  eq(v.allowed, 0, "and none of them counts as allowed");
  assert(
    !/ceiling is not applying/.test(v.detail),
    "and the wording does not accuse the ceiling of something this never measured",
  );
}

// --- a genuinely absent ceiling ----------------------------------------------
{
  // Everything ALLOWED, well past the ceiling. This is the only shape that really
  // says the ceiling is not applying, and it is now distinguishable from the case
  // above because the requests succeeded rather than being refused by the app.
  const v = ceilingVerdict(statuses([{ n: size, status: 200 }]), CEILING);
  eq(v.conclusion, CEILING_CONCLUSION.neverRefused, "all allowed past the ceiling is the real fault");
  assert(/ceiling/.test(v.detail), "and it does name the ceiling");
}

// --- tighter than configured --------------------------------------------------
{
  const v = ceilingVerdict(
    statuses([{ n: 12, status: 200 }, { n: size - 12, status: 429 }]),
    CEILING,
  );
  eq(
    v.conclusion,
    CEILING_CONCLUSION.tighter,
    "refusing far below the configured ceiling is its own finding, since the run paces on that number",
  );
}

// --- never reached the deployment ---------------------------------------------
{
  const v = ceilingVerdict(statuses([{ n: size, status: 0 }]), CEILING);
  eq(v.conclusion, CEILING_CONCLUSION.neverReached, "a transport fault is never a refusal");
  eq(v.unreachable, size, "and is counted as unreachable");
}

// --- refused at AUTH, before either limiter ------------------------------------
{
  // A 401 is decided by `authenticateBearer` BEFORE the limiters run, so such a
  // request never reaches the counter at all and proves nothing either way. It is
  // not an application refusal: it means the key is wrong, which is a different
  // person's problem (L11).
  const v = ceilingVerdict(statuses([{ n: size, status: 401 }]), CEILING);
  eq(v.conclusion, CEILING_CONCLUSION.notAuthorized, "a rejected key is its own conclusion");
}

// --- the positions, moved here from test-loadtest-preflight-checks.ts ----------
{
  const never = ceilingVerdict(statuses([{ n: size, status: 200 }]), CEILING);
  eq(never.firstRefusedAt, null, "nothing refused is reported as null, never as a number");

  const early = ceilingVerdict(
    statuses([{ n: 19, status: 200 }, { n: size - 19, status: 429 }]),
    CEILING,
  );
  eq(early.firstRefusedAt, 20, "an early refusal is reported at the position it happened");

  // A transport fault is UNREACHABLE, never a refusal, and it must not move a
  // later refusal's position: a control that never reached the deployment would
  // otherwise report the ceiling working (L98).
  const mixed = ceilingVerdict(
    statuses([{ n: 1, status: 200 }, { n: 1, status: 0 }, { n: 1, status: 200 }, { n: 1, status: 429 }]),
    CEILING,
  );
  eq(mixed.firstRefusedAt, 4, "a fault before a refusal does not move the refusal's position");
  eq(mixed.unreachable, 1, "and is still counted");
}

// --- nothing sent --------------------------------------------------------------
{
  const v = ceilingVerdict([], CEILING);
  eq(v.conclusion, CEILING_CONCLUSION.nothingSent, "a control that sent nothing says so");
  eq(v.firstRefusedAt, null, "and refused nothing");
  eq(v.unreachable, 0, "and none were unreachable");
}

// =============================================================================
// SECOND PASS (#2275, reopened by the 2026-09-14 run)
//
// The first pass fixed the READING and left the control still unable to
// conclude. Run 34862015419 sent 180 writes, every one came back 409, and not
// one 429 was seen anywhere in the whole run. Two separate defects behind that,
// and neither is the dry run the issue originally named:
//
//   1. THE REQUEST SHAPE COULD NEVER BE ALLOWED. The control aimed at a
//      hardcoded code with a start SEVEN days out, against a four day booking
//      horizon (`HORIZON_DEFAULT`), so the application refused every one before
//      the run could learn anything. It now aims at a slot the deployment is
//      actually OFFERING, and refuses to send at all when no code offers one,
//      because sending into a guaranteed refusal is the shape that produced two
//      inconclusive runs in a row (L98).
//
//   2. IT ASSUMED THE PREMISE IT RESTS ON. "N writes from ONE address" was never
//      measured. Three different things make that premise false, and every one
//      of them renders as "the ceiling is not applying" unless it is named:
//      an address the deployment cannot read declines to judge and can NEVER
//      refuse (#1557), a runner behind a NAT pool spreads the writes over
//      several counters, and a deployment echoing nothing leaves the premise
//      unmeasured. The `x-loadtest-seen-ip` echo (#2243) already carries the
//      answer, and nothing read it. Each is its own conclusion now (L11, L70).
// =============================================================================

function attempts(parts: { n: number; status: number; seenIp?: string | null }[]) {
  return parts.flatMap((p) =>
    Array.from({ length: p.n }, () => ({
      status: p.status,
      seenIp: p.seenIp === undefined ? "203.0.113.9" : p.seenIp,
    })),
  );
}

// --- the deployment could not read the caller's address ------------------------
{
  // `judgeCaller` serves an unidentified caller UNJUDGED (#1557), so the per
  // address ceiling is structurally unable to refuse this run. Reporting "the
  // ceiling is not applying" would send somebody to look at a ceiling that was
  // never asked.
  const v = ceilingVerdict(attempts([{ n: size, status: 200, seenIp: "unknown" }]), CEILING);
  eq(
    v.conclusion,
    CEILING_CONCLUSION.callerUnidentified,
    "an unidentified caller is its own conclusion, never `the ceiling is off`",
  );
  eq(v.unidentified, size, "and every attempt is counted as unidentified");
  eq(v.addresses.length, 0, "with no identified address to report");
  assert(
    !/not applying|is off/.test(v.detail),
    "and it does not accuse the ceiling of something this never measured",
  );
}

// --- the writes were spread over several addresses -----------------------------
{
  // A CI runner behind an egress NAT pool. Each address carries its own counter,
  // so N writes over three of them is N/3 against the ceiling and an absence of
  // refusals says nothing at all.
  const v = ceilingVerdict(
    attempts([
      { n: 60, status: 200, seenIp: "203.0.113.1" },
      { n: 60, status: 200, seenIp: "203.0.113.2" },
      { n: size - 120, status: 200, seenIp: "203.0.113.3" },
    ]),
    CEILING,
  );
  eq(
    v.conclusion,
    CEILING_CONCLUSION.severalAddresses,
    "writes spread over several addresses cannot show one address's ceiling",
  );
  eq(v.addresses.length, 3, "and the distinct addresses are counted");
}

// --- the deployment echoed no address at all -----------------------------------
{
  // `SLATE_LOADTEST` unset on the deployment, or the header stripped in front of
  // it. The premise is then unmeasured rather than false, which is a third thing
  // to go and check and not the same as the ceiling being off.
  const v = ceilingVerdict(attempts([{ n: size, status: 200, seenIp: null }]), CEILING);
  eq(
    v.conclusion,
    CEILING_CONCLUSION.addressUnmeasured,
    "an unmeasured address is its own conclusion",
  );
  eq(v.unreported, size, "and the unreported attempts are counted");
}

// --- one identified address, nothing refused: the ceiling really is off ---------
{
  const v = ceilingVerdict(attempts([{ n: size, status: 200 }]), CEILING);
  eq(
    v.conclusion,
    CEILING_CONCLUSION.neverRefused,
    "one measured address and no refusal is the only shape that indicts the ceiling",
  );
  eq(v.addresses.length, 1, "and the one address it was keyed on is reported");
}

// --- a refusal settles it whatever the addresses were ---------------------------
{
  // Several addresses only ever RAISES the effective headroom, so a refusal that
  // happened anyway is still a refusal. The address facts explain an ABSENCE of
  // refusals and must not override a present one.
  const v = ceilingVerdict(
    attempts([
      { n: 64, status: 200, seenIp: "203.0.113.1" },
      { n: size - 64, status: 429, seenIp: "203.0.113.2" },
    ]),
    CEILING,
  );
  eq(v.conclusion, CEILING_CONCLUSION.applies, "a refusal is a refusal");
}

// --- the control could not find a slot to aim at --------------------------------
{
  // Sending into a guaranteed application refusal is what produced two
  // inconclusive runs. Finding nothing to aim at is never a pass (L98), and it is
  // a different thing to fix than a control that sent nothing for another reason.
  const v = ceilingNoSlot(CEILING, ["112", "212", "111"]);
  eq(v.conclusion, CEILING_CONCLUSION.noSlot, "no bookable slot is its own conclusion");
  eq(v.sent, 0, "and nothing was sent");
  assert(/112/.test(v.detail), "and the detail names the codes it asked");
}

// --- choosing what to aim at ----------------------------------------------------
{
  const target = chooseCeilingTarget([
    { code: "112", slots: [] },
    { code: "212", slots: ["2026-09-20T14:00:00.000Z", "2026-09-20T14:20:00.000Z"] },
    { code: "111", slots: ["2026-09-20T15:00:00.000Z"] },
  ]);
  assert(target !== null, "a code that is offering times is chosen");
  eq(target!.code, "212", "the first code with any offer wins");
  eq(target!.slots.length, 2, "and it keeps EVERY offered slot");
}
{
  // Round robin across the offers rather than hammering one. The steady pass is
  // booking at the same time, so a single slot can be taken mid control and turn
  // every remaining request into an application refusal, which is the exact state
  // this whole pass exists to stop happening (L98).
  eq(chooseCeilingTarget([{ code: "112", slots: [] }]), null, "no offers, no target");
  eq(chooseCeilingTarget([]), null, "nothing asked, no target");
}

// --- still no two conclusions saying the same thing (L11) -----------------------
{
  const seen = new Map<string, string>();
  const cases = [
    attempts([{ n: 64, status: 200 }, { n: size - 64, status: 429 }]),
    attempts([{ n: 61, status: 409 }]),
    attempts([{ n: size, status: 200 }]),
    attempts([{ n: 12, status: 200 }, { n: size - 12, status: 429 }]),
    attempts([{ n: size, status: 0, seenIp: null }]),
    attempts([{ n: size, status: 401 }]),
    attempts([{ n: size, status: 200, seenIp: "unknown" }]),
    attempts([
      { n: 90, status: 200, seenIp: "203.0.113.1" },
      { n: size - 90, status: 200, seenIp: "203.0.113.2" },
    ]),
    attempts([{ n: size, status: 200, seenIp: null }]),
    [],
  ];
  const verdicts = cases.map((c) => ceilingVerdict(c, CEILING));
  verdicts.push(ceilingNoSlot(CEILING, ["112"]));
  for (const v of verdicts) {
    assert(!seen.has(v.detail), `each conclusion has its own sentence: ${v.conclusion}`);
    seen.set(v.detail, v.conclusion);
  }
  eq(seen.size, verdicts.length, "every case produced a distinct sentence");
  eq(
    new Set([...seen.values()]).size,
    verdicts.length,
    "and a distinct conclusion, so no two send a reader to the same place",
  );
}

// --- every declared conclusion is one some case can actually reach (L151) -------
{
  const reachable = new Set([
    ceilingVerdict(attempts([{ n: 64, status: 200 }, { n: size - 64, status: 429 }]), CEILING).conclusion,
    ceilingVerdict(attempts([{ n: 61, status: 409 }]), CEILING).conclusion,
    ceilingVerdict(attempts([{ n: size, status: 200 }]), CEILING).conclusion,
    ceilingVerdict(attempts([{ n: 12, status: 200 }, { n: size - 12, status: 429 }]), CEILING).conclusion,
    ceilingVerdict(attempts([{ n: size, status: 0, seenIp: null }]), CEILING).conclusion,
    ceilingVerdict(attempts([{ n: size, status: 401 }]), CEILING).conclusion,
    ceilingVerdict(attempts([{ n: size, status: 200, seenIp: "unknown" }]), CEILING).conclusion,
    ceilingVerdict(
      attempts([
        { n: 90, status: 200, seenIp: "203.0.113.1" },
        { n: size - 90, status: 200, seenIp: "203.0.113.2" },
      ]),
      CEILING,
    ).conclusion,
    ceilingVerdict(attempts([{ n: size, status: 200, seenIp: null }]), CEILING).conclusion,
    ceilingVerdict([], CEILING).conclusion,
    ceilingNoSlot(CEILING, ["112"]).conclusion,
  ]);
  for (const declared of Object.values(CEILING_CONCLUSION)) {
    assert(reachable.has(declared), `a declared conclusion no case can produce: ${declared}`);
  }
}

finish();

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
// Run: node --experimental-strip-types scripts/test-loadtest-ceiling-control.ts
import {
  CEILING_CONTROL_OVERSHOOT,
  CEILING_CONCLUSION,
  ceilingControlSize,
  ceilingVerdict,
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

function statuses(parts: { n: number; status: number }[]): number[] {
  return parts.flatMap((p) => Array(p.n).fill(p.status) as number[]);
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

// --- nothing sent --------------------------------------------------------------
{
  const v = ceilingVerdict([], CEILING);
  eq(v.conclusion, CEILING_CONCLUSION.nothingSent, "a control that sent nothing says so");
  eq(v.firstRefusedAt, null, "and refused nothing");
}

// --- no two conclusions say the same thing (L11) -------------------------------
{
  const seen = new Map<string, string>();
  const cases: number[][] = [
    statuses([{ n: 64, status: 200 }, { n: size - 64, status: 429 }]),
    statuses([{ n: 61, status: 409 }]),
    statuses([{ n: size, status: 200 }]),
    statuses([{ n: 12, status: 200 }, { n: size - 12, status: 429 }]),
    statuses([{ n: size, status: 0 }]),
    statuses([{ n: size, status: 401 }]),
    [],
  ];
  for (const c of cases) {
    const v = ceilingVerdict(c, CEILING);
    assert(!seen.has(v.detail), `each conclusion has its own sentence: ${v.conclusion}`);
    seen.set(v.detail, v.conclusion);
  }
  eq(seen.size, cases.length, "every case produced a distinct sentence");
  eq(
    new Set([...seen.values()]).size,
    cases.length,
    "and a distinct conclusion, so no two send a reader to the same place",
  );
}

// --- exactly one conclusion is a pass (L98) ------------------------------------
{
  const passing = Object.values(CEILING_CONCLUSION).filter((c) => c === CEILING_CONCLUSION.applies);
  eq(passing.length, 1, "only one conclusion means the ceiling was proved");
}

finish();

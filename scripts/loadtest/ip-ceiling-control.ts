// The per address write ceiling, proved rather than assumed (#2244).
//
// The run paces itself at exactly the ceiling (four drivers at fifteen a minute is
// sixty, and `BOOKING_API_IP_LIMITER.perMinute` is sixty), so its 429s are meant to
// be attributable. But "we saw no 429s" and "the ceiling is not applying" are the
// same observation from inside the run, and the second is the one that would make
// every other number about a run that was never actually bounded.
//
// It used to send ONE more than the ceiling, all at once, and require the last to
// be refused. That could not conclude (#2275). Cloudflare's own documentation says
// the Rate Limiting API "is permissive, eventually consistent, and intentionally
// designed to not be used as an accurate accounting system", with "a unique limit
// per Cloudflare location", so asking it to refuse a single marginal request out of
// a simultaneous burst is the least likely thing it will do. Measured: run
// 34658545203 sent 61 and was refused none, and the run blamed a ceiling that the
// same run's steady pass had refused four times.
//
// So it sends a MULTIPLE of the ceiling, in waves rather than in one burst, and
// requires SOME refusal. The exact crossing point is never asserted, because an
// eventually consistent counter does not have one. Refusing far EARLY is still its
// own finding: the run's pacing is built on that number.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BOOKING_WRITES_PER_MINUTE, offeredSlots } from "./book-plan.ts";
import {
  ceilingVerdict,
  ceilingControlSize,
  ceilingNoSlot,
  chooseCeilingTarget,
  CEILING_CONCLUSION,
  type CeilingAttempt,
  type CeilingOffer,
} from "./preflight-checks.ts";
import { MEASURED_CODE_MIX } from "./code-mix.ts";
import { loadtestPhone } from "./book-plan.ts";

const PROD_HOST = "slate.trypennie.app";

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was attempted.`);
    process.exit(1);
  }
  return v;
}

const SLATE_BASE = need("SLATE_BASE").replace(/\/$/, "");
const API_KEY = need("BOOKING_API_KEY");
const OUT = need("OUT");
if (SLATE_BASE.includes(PROD_HOST)) {
  console.error("FAILED: SLATE_BASE points at production.");
  process.exit(1);
}

const SEND = ceilingControlSize(BOOKING_WRITES_PER_MINUTE);

/**
 * Sent in waves, not in one simultaneous burst.
 *
 * Cloudflare counts "very quickly, but not immediately", so a single burst races a
 * counter that has not converged. Waves give it time to catch up while keeping the
 * whole control inside one window: SEND requests at this size is a handful of
 * round trips, far short of the 60 second period.
 */
const WAVE = 20;

/**
 * The requests are DRY RUNS, and that is CORRECT, contrary to what #2275 assumed.
 *
 * The issue says the route "returns from the dry run branch before the write
 * limiter is ever consulted". It does not. `authorizeBookingApi` is the FIRST
 * statement of the POST handler and BOTH ceilings, per key and per address, live
 * inside it; the `if (v.dryRun)` branch is far below. Verified by reading the
 * handler, and by the failed run itself, whose 61 dry runs all reached the
 * application and came back 409, which they could only do having passed the
 * limiter. So a dry run is metered exactly like a real write, and it creates
 * nothing, which is what makes the control safe to repeat at this size.
 *
 * That also answers the product half of the issue: the preview path is NOT
 * unmetered, so there is nothing to decide about making it count.
 *
 * What WAS wrong, and what the 2026-09-14 run proved (#2275 reopened): the start
 * was seven days out against a four day booking horizon and the code was a guess,
 * so every request was refused by the application before the ceiling's answer
 * could be read. It aims at a time the deployment is actually offering now, and
 * rotates through every one of them, because the steady pass is booking against
 * the same roster while this runs.
 */
async function attempt(n: number, code: string, startIso: string): Promise<CeilingAttempt> {
  try {
    const res = await fetch(`${SLATE_BASE}/api/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        bucketCode: code,
        start: startIso,
        timezone: "America/New_York",
        externalId: `ceiling-control-${n}`,
        dryRun: true,
        attendee: {
          name: "Ceiling Control",
          email: `ceiling-control-${n}@loadtest.local`,
          // Its own number like every other caller (#2261). These are dry runs, so
          // the person gate cannot refuse them anyway, but one shared identity
          // across the load machinery is the footgun this whole change removes.
          phone: loadtestPhone(`ceiling-control-${n}`),
        },
      }),
    });
    // The address the DEPLOYMENT says it keyed the ceiling on (#2243), which is
    // the premise the whole control rests on and which nothing measured until
    // now. Three things it can say, and each is its own conclusion: one address,
    // several, or `unknown`, which the ceiling declines to judge at all (#1557).
    return { status: res.status, seenIp: res.headers.get(SEEN_IP_HEADER) };
  } catch {
    // A transport fault is not a refusal, and counting it as one would report the
    // ceiling working when the run never reached the deployment.
    return { status: 0, seenIp: null };
  }
}

/** The header the deployment echoes the keyed address on, under SLATE_LOADTEST only. */
const SEEN_IP_HEADER = "x-loadtest-seen-ip";

/**
 * How many codes the control will ask about before giving up.
 *
 * Bounded because `/api/availability` has its own per address ceiling (30 a
 * minute) and spending it here would refuse the reads this control depends on.
 * The mix is ordered by measured traffic, so the first few are the largest pools
 * and the likeliest to be offering something.
 */
const CODES_TO_ASK = 5;

/** Read what the deployment is offering for a code, or nothing when it cannot be read. */
async function offersFor(code: string): Promise<CeilingOffer> {
  try {
    const res = await fetch(`${SLATE_BASE}/api/availability?bucket=${encodeURIComponent(code)}`);
    if (!res.ok) return { code, slots: [] };
    return { code, slots: offeredSlots(await res.json()) };
  } catch {
    // An unreadable availability answer is not a statement about the ceiling. It
    // leaves this code with nothing to aim at, and the control refuses by name
    // when every code it asked comes back like this.
    return { code, slots: [] };
  }
}

// What to aim at, read from the deployment rather than assumed. Asked one code at
// a time and stopped at the first that is offering, so a healthy roster costs one
// availability read out of a budget this control also has to live inside.
const codesAsked: string[] = [];
const offers: CeilingOffer[] = [];
for (const { code } of MEASURED_CODE_MIX.slice(0, CODES_TO_ASK)) {
  codesAsked.push(code);
  const offer = await offersFor(code);
  offers.push(offer);
  if (offer.slots.length > 0) break;
}
const target = chooseCeilingTarget(offers);

let result: ReturnType<typeof ceilingVerdict>;
if (target === null) {
  // Sending into a guaranteed application refusal is what made two runs in a row
  // conclude nothing. Finding nothing to aim at is never a pass (L98).
  result = ceilingNoSlot(BOOKING_WRITES_PER_MINUTE, codesAsked);
} else {
  // In waves, inside one window. One simultaneous burst races a counter that has not
  // converged; pacing them out over minutes would straddle two windows and the
  // overshoot would be allowed, which reads exactly like a ceiling that is off.
  const attempts: CeilingAttempt[] = [];
  for (let i = 0; i < SEND; i += WAVE) {
    const wave = Array.from({ length: Math.min(WAVE, SEND - i) }, (_, k) =>
      // Rotating through the offered times rather than hammering one. A slot the
      // steady pass books mid control would otherwise turn every remaining write
      // into an application refusal.
      attempt(i + k, target.code, target.slots[(i + k) % target.slots.length]!),
    );
    attempts.push(...(await Promise.all(wave)));
  }
  // The reading lives in `preflight-checks.ts` and is pinned offline. The judge reads
  // `firstRefusedAt` and fails the run when it is null, because then every 429 the
  // run attributed means something else.
  result = ceilingVerdict(attempts, BOOKING_WRITES_PER_MINUTE);
}
const out = {
  ceiling: BOOKING_WRITES_PER_MINUTE,
  code: target?.code ?? null,
  codesAsked,
  ...result,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log(result.detail);
console.log(
  `sent ${result.sent} at ${out.code ?? "no code"} (ceiling ${BOOKING_WRITES_PER_MINUTE}): ` +
    `${result.allowed} allowed, ${result.refused} refused by a ceiling, ` +
    `${result.appRefused} refused by the app, ${result.unauthorized} rejected at auth, ` +
    `${result.unreachable} never reached the deployment`,
);
console.log(
  `addresses the deployment keyed on: ${result.addresses.join(", ") || "none identified"} ` +
    `(${result.unidentified} unidentified, ${result.unreported} not echoed)`,
);
// The control's own step does not fail the run: the judge owns that verdict, and a
// step that failed here would stop the artifact reaching it.
if (result.conclusion !== CEILING_CONCLUSION.applies) {
  console.error(`note: the ceiling control did not prove the ceiling (${result.conclusion})`);
}

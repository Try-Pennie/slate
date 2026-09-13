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
import { BOOKING_WRITES_PER_MINUTE } from "./book-plan.ts";
import { ceilingVerdict, ceilingControlSize, CEILING_CONCLUSION } from "./preflight-checks.ts";
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
 */
async function attempt(n: number): Promise<number> {
  try {
    const res = await fetch(`${SLATE_BASE}/api/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        bucketCode: "112",
        start: new Date(Date.now() + 7 * 86_400_000).toISOString(),
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
    return res.status;
  } catch {
    // A transport fault is not a refusal, and counting it as one would report the
    // ceiling working when the run never reached the deployment.
    return 0;
  }
}

// In waves, inside one window. One simultaneous burst races a counter that has not
// converged; pacing them out over minutes would straddle two windows and the
// overshoot would be allowed, which reads exactly like a ceiling that is off.
const statuses: number[] = [];
for (let i = 0; i < SEND; i += WAVE) {
  const wave = Array.from({ length: Math.min(WAVE, SEND - i) }, (_, k) => attempt(i + k));
  statuses.push(...(await Promise.all(wave)));
}
// The reading lives in `preflight-checks.ts` and is pinned offline. The judge reads
// `firstRefusedAt` and fails the run when it is null, because then every 429 the
// run attributed means something else.
const verdict = ceilingVerdict(statuses, BOOKING_WRITES_PER_MINUTE);
const result = { ceiling: BOOKING_WRITES_PER_MINUTE, ...verdict, statuses };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(result.detail);
console.log(
  `sent ${SEND} (ceiling ${BOOKING_WRITES_PER_MINUTE}): ${result.allowed} allowed, ` +
    `${result.refused} refused by a ceiling, ${result.appRefused} refused by the app, ` +
    `${result.unauthorized} rejected at auth, ${result.unreachable} never reached the deployment`,
);
// The control's own step does not fail the run: the judge owns that verdict, and a
// step that failed here would stop the artifact reaching it.
if (result.conclusion !== CEILING_CONCLUSION.applies) {
  console.error(`note: the ceiling control did not prove the ceiling (${result.conclusion})`);
}

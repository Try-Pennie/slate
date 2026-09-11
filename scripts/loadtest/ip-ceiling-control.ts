// The per address write ceiling, proved rather than assumed (#2244).
//
// The run paces itself at exactly the ceiling (four drivers at fifteen a minute is
// sixty, and `BOOKING_API_IP_LIMITER.perMinute` is sixty), so its 429s are meant to
// be attributable. But "we saw no 429s" and "the ceiling is not applying" are the
// same observation from inside the run, and the second is the one that would make
// every other number about a run that was never actually bounded.
//
// So this sends ONE more than the ceiling from one address in one window and
// requires the last to be refused. Both halves matter: refusing nothing means the
// ceiling is off, and refusing EARLY means it is tighter than the app says and the
// run's pacing was built on a number that is not the real one.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BOOKING_WRITES_PER_MINUTE } from "./book-plan.ts";
import { ceilingVerdict } from "./preflight-checks.ts";
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

const SEND = BOOKING_WRITES_PER_MINUTE + 1;

/**
 * The requests are DRY RUNS, and that is what makes the control safe to repeat.
 *
 * A dry run takes the same authorization and the same rate limit path (the ceiling
 * is applied before the handler ever looks at `dryRun`) and creates nothing, so
 * sixty one of them prove the ceiling without leaving sixty bookings behind for
 * the judge's overlap check to find and blame on the run.
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

// All at once, inside one window. Paced, they would fall into two windows and the
// sixty first would be allowed, which reads exactly like a ceiling that is off.
const statuses = await Promise.all(Array.from({ length: SEND }, (_, i) => attempt(i)));
// The reading lives in `preflight-checks.ts` and is pinned offline. The judge reads
// `firstRefusedAt` and fails the run when it is null, because then every 429 the
// run attributed means something else.
const verdict = ceilingVerdict(statuses);
const result = { sent: SEND, ceiling: BOOKING_WRITES_PER_MINUTE, ...verdict, statuses };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(
  `sent ${SEND} writes from one address in one window; first refusal at ` +
    `${result.firstRefusedAt ?? "(none)"} (ceiling ${BOOKING_WRITES_PER_MINUTE}), ` +
    `${result.unreachable} never reached the deployment`,
);

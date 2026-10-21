// The per address write ceiling, proved against a bound that really refuses (#2339).
//
// The run used to pace itself at the per address ceiling (four drivers at fifteen a
// minute was sixty, and `BOOKING_API_IP_LIMITER.perMinute` is sixty), so its 429s
// were meant to be attributable; since #3124 the steady pass drives the load bar
// instead, each driver on its own runner. Either way "we saw no 429s" and "the ceiling is not
// applying" are the same observation from inside the run, and the second is the
// one that would make every other number about a run that was never bounded.
//
// THREE passes of this control could not conclude. The first sent `ceiling + 1`
// all at once; the second could not tell a ceiling refusal from an application
// one; the third asked the platform for something it never promised. Run
// 34889873261 sent 180 writes from ONE measured address in 20 seconds against a 60
// a minute ceiling and every one was allowed, with the binding present and
// answering `success` every time. Cloudflare's own documentation says the Rate
// Limiting API "is permissive, eventually consistent, and intentionally designed
// to not be used as an accurate accounting system", with "a unique limit per
// Cloudflare location" and each isolate checking "against its locally cached
// value". That is the documented behaviour, not a fault, so a bar built on it
// fails for a reason nobody should fix (L36).
//
// So this aims at the bound that IS exact: the per address HOURLY cap, a Postgres
// counter that refuses at a number it really holds. It stops at the first refusal
// the deployment CREDITS to the per address ceiling, so the ordinary case is a few
// hundred writes and only a deployment where nothing tighter refuses pays the
// whole budget. Where that refusal landed is REPORTED rather than judged: the per
// minute ceiling is approximate and being permissive is now a reading rather than
// a finding.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BOOKING_WRITES_PER_MINUTE, bookingRequestHeaders, offeredSlots } from "./book-plan.ts";
import {
  ceilingVerdict,
  ceilingControlBudget,
  ceilingControlPerMinute,
  ceilingWaveDelayMs,
  chooseCeilingTarget,
  exactAddressBound,
  CEILING_CONCLUSION,
  CEILING_REFUSED_BY,
  type CeilingAttempt,
  type CeilingOffer,
} from "./preflight-checks.ts";
import {
  BOOKING_API_WRITE_LIMITER,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
} from "../../src/lib/rate-limit-core.ts";
import { MEASURED_CODE_MIX } from "./code-mix.ts";
import { ceilingControlBody } from "./book-plan.ts";

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
// #3456: the run its dry runs are counted under, so the per address hourly cap this
// control aims at starts this run at zero rather than wherever the last run left it on
// the kept load test Worker. The workflow sets it for every job.
const RUN_ID = need("RUN_ID");
if (SLATE_BASE.includes(PROD_HOST)) {
  console.error("FAILED: SLATE_BASE points at production.");
  process.exit(1);
}

// The exact bound, read from the app's own rules rather than written here a second
// time (L41). No rule at all is refused outright: a budget derived from nothing
// would send a fixed count and call whatever happened a measurement.
const EXACT_BOUND = exactAddressBound(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES);
if (EXACT_BOUND === null) {
  console.error(
    "FAILED: the app states no per address hourly cap, so there is no bound this control " +
      "could be sure of reaching. Nothing was sent.",
  );
  process.exit(1);
}
const BUDGET = ceilingControlBudget(EXACT_BOUND);
/** Held under the per KEY ceiling, whose refusal wins over this one's (#3124). */
const PER_MINUTE = ceilingControlPerMinute(BOOKING_API_WRITE_LIMITER.perMinute);

/** How many go out together. Small, because the pacing is what decides the rate. */
const WAVE = 10;

/**
 * The requests are DRY RUNS, and that is CORRECT, contrary to what #2275 assumed.
 *
 * The issue said the route "returns from the dry run branch before the write
 * limiter is ever consulted". It does not. `authorizeBookingApi` is the FIRST
 * statement of the POST handler and BOTH ceilings, per key and per address, live
 * inside it; the `if (v.dryRun)` branch is far below. So a dry run is metered
 * exactly like a real write, and it creates nothing, which is what makes the
 * control safe to repeat at this size.
 *
 * The same fact is why an APPLICATION refusal is fine here (#2339). A 409 passed
 * both limiters and was counted against the address exactly like a 200, so the
 * control no longer depends on the roster offering a bookable time. It still aims
 * at one when it can: the requests are more like real traffic and cost the
 * deployment less.
 */
async function attempt(n: number, code: string, startIso: string): Promise<CeilingAttempt> {
  // Built before the try: see `ceilingControlBody` (#3447).
  const body = ceilingControlBody(n, code, startIso);
  try {
    const res = await fetch(`${SLATE_BASE}/api/bookings`, {
      method: "POST",
      // #3354: named, so its dry runs are never counted as another leg's confirms.
      headers: bookingRequestHeaders(API_KEY, "ceiling", RUN_ID),
      body,
    });
    // The two things the deployment says about its own decision (#2243, #2339):
    // the address the ceiling was keyed on, and WHICH ceiling refused. Both are
    // the premise the control rests on, and nothing measured either until they
    // were echoed. A 429 alone says only that something refused, and the per key
    // ceiling is checked first.
    return {
      status: res.status,
      seenIp: res.headers.get(SEEN_IP_HEADER),
      refusedBy: res.headers.get(REFUSED_BY_HEADER),
    };
  } catch {
    // A transport fault is not a refusal, and counting it as one would report the
    // ceiling working when the run never reached the deployment.
    return { status: 0, seenIp: null, refusedBy: null };
  }
}

/** The headers the deployment echoes its own decision on, under SLATE_LOADTEST only. */
const SEEN_IP_HEADER = "x-loadtest-seen-ip";
const REFUSED_BY_HEADER = "x-loadtest-refused-by";

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
    // An unreadable availability answer is not a statement about the ceiling, and
    // it is no longer a reason to stop: the fallback below is metered just the same.
    return { code, slots: [] };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Where to aim when nothing is on offer.
 *
 * A time inside the booking horizon that the deployment will refuse, because it is
 * not one of the times it computed. That refusal is the application's, which means
 * the write passed both limiters and was counted, which is all this control needs.
 * It is REPORTED (`aimedAt`) rather than silent, so a run whose roster was dark
 * still says so instead of looking like one that booked against real times.
 */
const FALLBACK_START = new Date(Date.now() + 26 * 60 * 60_000).toISOString();
const aimCode = target?.code ?? codesAsked[0] ?? MEASURED_CODE_MIX[0]!.code;
const aimSlots = target?.slots ?? [FALLBACK_START];

const attempts: CeilingAttempt[] = [];
const startedAt = Date.now();
// Paced against the clock, not against its own sleeps, and stopped at the first
// refusal the deployment credits to the PER ADDRESS ceiling. The ordinary case
// costs a few hundred writes; only a deployment where nothing tighter refuses pays
// the whole budget, and that is the case worth paying for.
for (let i = 0; i < BUDGET; i += WAVE) {
  const wait = ceilingWaveDelayMs(attempts.length, Date.now() - startedAt, PER_MINUTE);
  if (wait > 0) await sleep(wait);
  const wave = Array.from({ length: Math.min(WAVE, BUDGET - i) }, (_, k) =>
    // Rotating through the offered times rather than hammering one. A slot the
    // steady pass books mid control would otherwise turn every remaining write
    // into an application refusal.
    attempt(i + k, aimCode, aimSlots[(i + k) % aimSlots.length]!),
  );
  attempts.push(...(await Promise.all(wave)));
  if (attempts.some((a) => a.status === 429 && a.refusedBy === CEILING_REFUSED_BY.address)) break;
}

// The reading lives in `preflight-checks.ts` and is pinned offline. The judge reads
// the conclusion and fails the run on anything but `applies`.
const result = ceilingVerdict(attempts, BOOKING_WRITES_PER_MINUTE, EXACT_BOUND);
const out = {
  ceiling: BOOKING_WRITES_PER_MINUTE,
  budget: BUDGET,
  perMinute: PER_MINUTE,
  elapsedMs: Date.now() - startedAt,
  code: aimCode,
  aimedAt: target === null ? "no-offer" : "offered-slot",
  codesAsked,
  ...result,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log(result.detail);
console.log(
  `sent ${result.sent} of a ${BUDGET} budget at ${out.code} (${out.aimedAt}) in ` +
    `${Math.round(out.elapsedMs / 1000)}s: ${result.allowed} allowed, ${result.appRefused} refused ` +
    `by the app, ${result.counted} counted against the ${EXACT_BOUND} an hour cap`,
);
console.log(
  `refusals: ${result.refusedByAddress} by the per address ceiling, ${result.refusedByKey} by the ` +
    `per key one, ${result.refusedUnattributed} unattributed, ${result.unauthorized} rejected at ` +
    `auth, ${result.unreachable} never reached the deployment`,
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

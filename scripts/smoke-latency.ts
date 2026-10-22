// The canary's latency sample (#1047).
//
// The canary proves the funnel works and says nothing about whether it is fast. The
// one number anybody quotes for the availability read (about 39ms warm, #256) is a
// point-in-time measurement from the day the precompute shipped, so a latency
// regression has relied on somebody noticing a page feels slow, which for a lead who
// abandons is nobody.
//
// It measures the read path only, a GET that writes nothing, against TWO buckets
// (#3586): a REAL bucket (public, read with no key, as a lead does) and the isolated
// SMOKE bucket (hidden, read with the canary key). The SMOKE bucket is the one the
// canary books and cancels on every pass, so its slot cache is churned and a cold SMOKE
// read can be slow while a real lead is fine. So PAGING follows the real bucket, and the
// SMOKE reading is kept only as a comparison in the log. The booking confirm is
// deliberately NOT timed here, because timing it means making one, and the canary
// already does that on its own schedule with its own teardown.
//
// Failures are recorded through the SAME failure log the booking smoke uses, so the
// existing Slack alerter names this check alongside the others rather than needing a
// second alerting path (which would be a second thing to keep working, on the surface
// whose whole job is to still work when something else has broken).
//
// A batch over budget is re-measured once, a couple of minutes later, before anybody is
// paged (#2811): in the recorded history a single slow batch was never the start of a
// real regression. And a pass that read a real median, pass or fail, writes
// `measured=1` to the step's outputs, so the workflow can stamp the
// `verdict:availability-latency` heartbeat and a check that has stopped measuring goes
// stale and pages rather than reading as healthy (#1700).
//
// Each sample keeps what its response said about itself (#3653): which cache tier
// answered (`x-slot-cache`) and the Worker's own time (`Server-Timing`). The page is
// worded from those, and the log line prints them per sample, so a slow cached read
// can be told from a cache that stopped serving, and Worker time from transit (#3652).
//
// Each sample also keeps the Cloudflare colo that served it, from `cf-ray` (#3712). The
// runner is sometimes routed through Europe, which no lead is, so a slow run served
// ENTIRELY outside North America is logged with where it went and why, and pages nobody;
// it stamps no verdict either, so a canary stuck on that route goes stale (#1700). Any
// North American, unrecognised or unreadable read in the evidence keeps the old rule.
//
// Run: SLATE_BASE_URL=... node --experimental-strip-types scripts/smoke-latency.ts
import { appendFileSync } from "node:fs";
import {
  measureLatency,
  judgeLatency,
  decideDualLatency,
  formatSamples,
  readSlotCache,
  parseServerTiming,
  readColo,
  LATENCY_SAMPLES,
  AVAILABILITY_P50_BUDGET_MS,
  type LatencySample,
} from "./lib/latency-slo.ts";
import { failureLogPath, recordFailure, recordPass, SMOKE_NAMES } from "./lib/smoke-failure-log.ts";

const base = (process.env.SLATE_BASE_URL || "https://slate.trypennie.app").replace(/\/$/, "");
// env-ok: SMOKE_BUCKET (a local override; CI wants the seeded SMOKE bucket)
const smokeBucket = process.env.SMOKE_BUCKET ?? "SMOKE";
// The REAL bucket probed alongside SMOKE (#3586): the production signal, whose slot
// cache the canary never churns. Defaults to the catch-all "100", which always exists;
// env-ok: LATENCY_REAL_BUCKET lets a different deployment name its own real bucket.
const realBucket = process.env.LATENCY_REAL_BUCKET ?? "100";
const key = process.env.BOOKING_API_KEY_CANARY ?? "";

const io = {
  append: (path: string, line: string) => appendFileSync(path, line),
  read: () => null,
};
const failureLog = failureLogPath(process.env);

/** One timed read of a bucket: the elapsed ms, plus the response's own `x-slot-cache`
 *  and `Server-Timing` (#3653), each null when absent rather than guessed. Null when the
 *  request did not complete or did not answer 200: an error is not a latency
 *  measurement, and averaging one in would report a broken endpoint as a fast one. */
async function sample(bucket: string, authed: boolean): Promise<LatencySample | null> {
  const url = `${base}/api/availability?bucket=${encodeURIComponent(bucket)}`;
  const started = Date.now();
  try {
    // The SMOKE bucket is hidden (#396) and needs the key to be seen at all; the REAL
    // bucket is public, and is read WITHOUT the key, exactly as a lead's browser does.
    const res = await fetch(url, { headers: authed && key ? { authorization: `Bearer ${key}` } : {} });
    const elapsed = Date.now() - started;
    if (!res.ok) {
      console.error(`latency: ${url} answered ${res.status}, not counted as a sample`);
      return null;
    }
    // Drain the body: the response is not complete until it is read, and timing only
    // the headers would report a fraction of what a lead waits for.
    await res.text();
    return {
      ms: elapsed,
      cache: readSlotCache(res.headers.get("x-slot-cache")),
      server: parseServerTiming(res.headers.get("server-timing")),
      // #3712: the colo that served it, which decides whether a slow run timed a lead's
      // route at all.
      colo: readColo(res.headers.get("cf-ray")),
    };
  } catch (err) {
    console.error(`latency: request failed, not counted as a sample: ${String(err)}`);
    return null;
  }
}

/** Take one batch of `LATENCY_SAMPLES` timed reads of `bucket`, errors left out, and
 *  record it in `into` for the log line's `samples=[...]ms` detail. */
async function takeBatch(bucket: string, authed: boolean, into: LatencySample[][]): Promise<LatencySample[]> {
  const samples: LatencySample[] = [];
  into.push(samples);
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const s = await sample(bucket, authed);
    if (s !== null) samples.push(s);
  }
  return samples;
}

// What each sample in `samples=[...]` says, printed on every line so the history reads
// on its own: the canary's wait, the cache tier, and the Worker's own clock.
const SAMPLE_LEGEND =
  "first dropped as cold; each is the wait at the canary, x-slot-cache (nohdr when absent), " +
  "the Cloudflare colo from cf-ray (nocfray when absent, cfray-unreadable when it names none), " +
  "and worker= the Worker's own I/O clock with its limiter, slot read and the slot read's parts when sent";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The REAL bucket is the paging signal: full measurement with the #2811 recheck.
const realBatches: LatencySample[][] = [];
const realRun = await measureLatency({
  takeBatch: () => takeBatch(realBucket, false, realBatches),
  sleep,
});

// The SMOKE bucket is a comparison only: one batch, no recheck, never pages.
const smokeBatches: LatencySample[][] = [];
const smokeVerdict = judgeLatency(await takeBatch(smokeBucket, true, smokeBatches));

const decision = decideDualLatency(realRun, smokeVerdict, realBucket);

// The REAL bucket keeps the canonical `latency: samples=[...]` / `latency recheck:`
// line, unchanged from before #3586, so the history #2811 was measured from reads on
// (it is now the paging signal, which is the right thing for that line to carry). The
// bucket it was read against is appended, so a reader still knows which one.
for (const [i, v] of [realRun.first, realRun.recheck].entries()) {
  if (!v) continue;
  console.log(
    `latency${i === 0 ? "" : " recheck"}: samples=[${formatSamples(realBatches[i] ?? [])}]ms (${SAMPLE_LEGEND}) median=${
      v.medianMs === null ? "none" : `${Math.round(v.medianMs)}ms`
    } budget=${AVAILABILITY_P50_BUDGET_MS}ms bucket=${realBucket}`,
  );
}
// The SMOKE bucket is its own, differently-prefixed line, so it is never read as the
// primary `latency:` sample: it is a comparison only and never pages (#3586).
console.log(
  `latency smoke(${smokeBucket}): samples=[${formatSamples(smokeBatches[0] ?? [])}]ms (comparison only; ${SAMPLE_LEGEND}) ` +
    `median=${smokeVerdict.medianMs === null ? "none" : `${Math.round(smokeVerdict.medianMs)}ms`} budget=${AVAILABILITY_P50_BUDGET_MS}ms`,
);
if (decision.message) console.log(`latency: ${decision.message}`);

// Written BEFORE any exit, because the stamp step reads it on a paging run too: a
// confirmed regression is a measured verdict, and whether the check concluded is a
// different fact from whether the read was fast (L53). Follows the REAL bucket.
if (decision.measured && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, "measured=1\n");
}

if (decision.page && decision.message) {
  const wrote = recordFailure(io, failureLog, `Availability latency: ${decision.message}`);
  if (!wrote) {
    console.error(
      "latency: the regression could not be recorded for the alerter (no SMOKE_FAILURE_FILE), so it is printed here only",
    );
  }
  process.exit(1);
}

// #4062: a measured read inside the budget is a passing check, recorded so the alert
// can count it. Not measuring records nothing, since nothing was checked.
if (decision.measured) recordPass(io, failureLog, SMOKE_NAMES.latency);

// Not measuring is not a failure: a canary that could not reach the endpoint at all
// already fails on the availability check itself, and failing twice for one cause is
// how an alert stops naming its cause. It is caught instead by the verdict stamp going
// stale (#1700).
process.exit(0);

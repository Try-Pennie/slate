// The canary's latency sample (#1047).
//
// The canary proves the funnel works and says nothing about whether it is fast. The
// one number anybody quotes for the availability read (about 39ms warm, #256) is a
// point-in-time measurement from the day the precompute shipped, so a latency
// regression has relied on somebody noticing a page feels slow, which for a lead who
// abandons is nobody.
//
// It measures the read path only: an unauthenticated GET against the isolated SMOKE
// bucket, which writes nothing and costs a cached read. The booking confirm is
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
// Run: SLATE_BASE_URL=... node --experimental-strip-types scripts/smoke-latency.ts
import { appendFileSync } from "node:fs";
import { measureLatency, LATENCY_SAMPLES, AVAILABILITY_P50_BUDGET_MS } from "./lib/latency-slo.ts";
import { failureLogPath, recordFailure } from "./lib/smoke-failure-log.ts";

const base = (process.env.SLATE_BASE_URL || "https://slate.trypennie.app").replace(/\/$/, "");
// env-ok: SMOKE_BUCKET (a local override; CI wants the seeded SMOKE bucket)
const bucket = process.env.SMOKE_BUCKET ?? "SMOKE";
const url = `${base}/api/availability?bucket=${encodeURIComponent(bucket)}`;
const key = process.env.BOOKING_API_KEY_CANARY ?? "";

const io = {
  append: (path: string, line: string) => appendFileSync(path, line),
  read: () => null,
};
const failureLog = failureLogPath(process.env);

/** One timed read. Returns the elapsed ms, or null when the request did not complete
 *  or did not answer 200: an error is not a latency measurement, and averaging one in
 *  would report a broken endpoint as a fast one. */
async function sample(): Promise<number | null> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      // The SMOKE bucket is hidden (#396), so the read needs the key to see it at all.
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    const elapsed = Date.now() - started;
    if (!res.ok) {
      console.error(`latency: ${url} answered ${res.status}, not counted as a sample`);
      return null;
    }
    // Drain the body: the response is not complete until it is read, and timing only
    // the headers would report a fraction of what a lead waits for.
    await res.text();
    return elapsed;
  } catch (err) {
    console.error(`latency: request failed, not counted as a sample: ${String(err)}`);
    return null;
  }
}

// Every batch taken, so the log line keeps its original `latency: samples=[...]` shape.
// That shape is what the history behind #2811 was measured from, 590 runs of it, and
// the next measurement will want the same.
const batches: number[][] = [];

async function takeBatch(): Promise<number[]> {
  const samples: number[] = [];
  batches.push(samples);
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const ms = await sample();
    if (ms !== null) samples.push(ms);
  }
  return samples;
}

const run = await measureLatency({
  takeBatch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
for (const [i, v] of [run.first, run.recheck].entries()) {
  if (!v) continue;
  console.log(
    `latency${i === 0 ? "" : " recheck"}: samples=[${(batches[i] ?? []).join(", ")}]ms (first dropped as cold) median=${
      v.medianMs === null ? "none" : `${Math.round(v.medianMs)}ms`
    } budget=${AVAILABILITY_P50_BUDGET_MS}ms`,
  );
}
if (run.message) console.log(`latency: ${run.message}`);

// Written BEFORE any exit, because the stamp step reads it on a paging run too: a
// confirmed regression is a measured verdict, and whether the check concluded is a
// different fact from whether the read was fast (L53).
if (run.measured && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, "measured=1\n");
}

if (run.page && run.message) {
  const wrote = recordFailure(io, failureLog, `Availability latency: ${run.message}`);
  if (!wrote) {
    console.error(
      "latency: the regression could not be recorded for the alerter (no SMOKE_FAILURE_FILE), so it is printed here only",
    );
  }
  process.exit(1);
}

// Not measuring is not a failure: a canary that could not reach the endpoint at all
// already fails on the availability check itself, and failing twice for one cause is
// how an alert stops naming its cause. It is caught instead by the verdict stamp going
// stale (#1700).
process.exit(0);

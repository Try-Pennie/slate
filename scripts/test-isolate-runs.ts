// #3713: whether a lead's availability read landed on a fresh isolate.
//
// Evening reads cost three to four times their warm CPU, and the leading guess is that
// most of them land on an isolate that has not run Slate recently. That has to be
// measured from each read's own record, not inferred from a difference (L699: #2340
// blamed bundle evaluation and was wrong). So each read logs how many times its isolate
// has run the app, how long since the isolate's first run, and how many requests the
// route's own module has handled, whatever it answered.
//
// The Worker counts every run of the app (#3354) in ONE record on the isolate's global,
// which the app's bundle can read because both run in the same isolate. The record is
// injected here as a plain object, so nothing touches the real global.
//
// Run: node --experimental-strip-types scripts/test-isolate-runs.ts
import { recordIsolateRun, readIsolateRuns, makeFreshnessReader } from "../src/lib/api/isolate-runs.ts";
import { eq, finish } from "./lib/harness.ts";

{
  const host = {};
  eq(readIsolateRuns(host), null, "an isolate the Worker never recorded is unknown, never 0 runs");
  eq(recordIsolateRun(1_000, host), 0, "the first run of the app is index 0");
  eq(recordIsolateRun(5_000, host), 1, "the next is index 1");
  eq(readIsolateRuns(host), { runs: 2, firstRunAtMs: 1_000 }, "the record holds the count and the FIRST run's time");
}

{
  // The route's view: the isolate's runs so far, its age, and the route's own count.
  const host = {};
  const freshness = makeFreshnessReader(host);
  recordIsolateRun(10_000, host);
  eq(
    freshness(10_000),
    { isolateRuns: 1, isolateAgeMs: 0, routeRequests: 1 },
    "a read that is its isolate's first run of the app reads as fresh",
  );
  recordIsolateRun(70_000, host);
  eq(
    freshness(70_000),
    { isolateRuns: 2, isolateAgeMs: 60_000, routeRequests: 2 },
    "a minute later the same isolate has aged and both counts moved",
  );
}

{
  // A cron tick that ran first warmed the isolate: the route's first read is NOT the
  // isolate's first run (#3354's reason for counting at the Worker), and the two counts
  // say so separately.
  const host = {};
  const freshness = makeFreshnessReader(host);
  recordIsolateRun(0, host); // a cron tick
  recordIsolateRun(30_000, host); // this read
  eq(freshness(30_000), { isolateRuns: 2, isolateAgeMs: 30_000, routeRequests: 1 }, "the route's first read on a warm isolate");
}

{
  // Outside the Worker (next dev, a test) nothing records runs. The isolate's facts are
  // unknown, never a guessed 0 or a fresh 1, while the route's own count still moves.
  const freshness = makeFreshnessReader({});
  eq(freshness(5), { isolateRuns: null, isolateAgeMs: null, routeRequests: 1 }, "no Worker record reads as unknown");
}

{
  // Something else wrote the key, or a different build's shape: unreadable is unknown.
  const key = Symbol.for("slate.isolate-runs");
  for (const bad of [{ runs: "3", firstRunAtMs: 1 }, { runs: 0, firstRunAtMs: 1 }, { runs: 2, firstRunAtMs: Number.NaN }, 7, null]) {
    const host = { [key]: bad };
    eq(readIsolateRuns(host), null, `an unreadable record reads as unknown (${JSON.stringify(bad)})`);
  }
}

{
  // A clock that reads earlier than the first run (it cannot on the Worker, whose clock
  // only moves forward, but a host's can) is clamped, never a negative age.
  const host = {};
  recordIsolateRun(1_000, host);
  eq(makeFreshnessReader(host)(900).isolateAgeMs, 0, "a backwards clock gives age 0, not negative");
}

finish();

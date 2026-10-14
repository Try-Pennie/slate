// #3354: a fresh isolate's first request is known by counting the times the isolate
// has run the app, at the Worker, and every way the Worker runs it counts. The first
// version counted HTTP fetches only, so an isolate whose first job was a cron tick
// (scheduled() runs the app's cron routes) or a log shipping receipt had evaluated the
// app already and its first HTTP request still read as index 0 (#3358 review). So the
// count lives in ONE wrapper every call into the app goes through, and a scan fails
// on a call that skips it (L613, L621).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-worker-app-invocations.ts
import { readFileSync } from "node:fs";
import { countedApp, workerAppCallsOutsideWrapper } from "../worker/app-invocations.ts";
import { readEntryMarks } from "../src/lib/booking/wait-marks.ts";
import { readIsolateRuns } from "../src/lib/api/isolate-runs.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const seen: Request[] = [];
const app = countedApp({
  fetch: (request: Request) => {
    seen.push(request);
    return new Response("ok");
  },
});

// --- every run of the app counts, whoever started it ----------------------------
await app.fetch(new Request("https://x.test/api/cron/sync"), {}, {});
await app.fetch(new Request("https://x.test/api/bookings", { method: "POST" }), {}, {}, { loadtest: true, enteredAtMs: 9_000 });
const stamped = readEntryMarks(seen[1]!.headers);
eq(stamped.invocationIndex, 1, "an HTTP request after a cron tick is the isolate's second run of the app, not its first");
eq(stamped.entryAtMs, 9_000, "and it carries the Worker's entry stamp");
eq(readEntryMarks(seen[0]!.headers).invocationIndex, null, "a call with no stamp asked for is passed through unstamped");

// --- off the load test nothing is stamped, and the count still moves -------------
const plain = new Request("https://x.test/api/bookings", { method: "POST" });
await app.fetch(plain, {}, {}, { loadtest: false, enteredAtMs: 1 });
assert(seen[2] === plain, "off the load test the request reaches the app untouched");
await app.fetch(new Request("https://x.test/api/bookings"), {}, {}, { loadtest: true, enteredAtMs: 2 });
eq(readEntryMarks(seen[3]!.headers).invocationIndex, 3, "and the count still counted the unstamped run");

// --- #3713: the count is the one the route reads ------------------------------------
// The route cannot see the Worker's closure, and off the load test nothing is stamped on
// the request, so the count lives in ONE record on the isolate's global (L83). Four runs
// above, the first a cron tick with no entry stamp of its own.
{
  const record = readIsolateRuns();
  eq(record?.runs, 4, "the record the route reads counted every run of the app, cron tick included");
  eq(record?.firstRunAtMs !== undefined && Number.isFinite(record.firstRunAtMs), true, "and when the first one ran");
}

// --- the Worker reaches the app only through the wrapper -------------------------
const entry = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
eq(workerAppCallsOutsideWrapper(entry), [], "worker/index.ts never calls the app's handler directly");
const bypassed = entry.replace("app.fetch(request, env, ctx, {", "handler.fetch(request, env, ctx, {");
assert(bypassed !== entry, "positive control: the bypass was planted in the real source");
assert(
  workerAppCallsOutsideWrapper(bypassed).length === 1,
  "positive control: a direct call to the handler is caught, so the scan is not blind (L1)",
);

finish();

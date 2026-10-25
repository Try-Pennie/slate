/**
 * #4189: the public placement probe. Each scheduled tick that dispatches lanes also sends
 * ONE ordinary public GET to the Worker's own custom domain, so the `lane timings` line
 * shows, per tick, where the SELF lanes ran beside where a public request from the same
 * tick was placed. The decision this measurement feeds (Dan, 2026-10-23): if the public
 * route is placed near the database every time, the lanes move to it.
 *
 * What it must never do is touch the lanes: it starts after they are dispatched, it never
 * throws out of the tick, and the tick's lane time and budget accounting exclude it. And
 * every outcome it can have reads as its own value, because the field it writes is read
 * as "placed" or "not placed", and an absent or empty one would read as either.
 *
 * `worker/index.ts` cannot be imported by a test (it imports the generated
 * `.open-next/worker.js`), so the behaviour lives in `worker/public-probe.ts` and the
 * wiring is checked against the entry's source text, as `test-cron-lane-run.ts` does.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-public-placement-probe.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchWithProbe,
  publicProbeFields,
  startPublicProbe,
  PUBLIC_PROBE_PATH,
  PUBLIC_PROBE_TIMEOUT_MS,
  type PublicProbeDeps,
  type PublicProbeOutcome,
} from "../worker/public-probe.ts";
import { CRON_ORIGIN } from "../worker/lane-run.ts";
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { laneFieldName, laneTimingFields } from "../src/lib/monitor/lane-timing.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const TICK = "0123456789abcdef";

/** A deadline the test fires by hand, so nothing here waits a real timeout out (L524). */
function manualDeadline(): { wait: (ms: number) => Promise<void>; fire: () => void; asked: number[] } {
  const asked: number[] = [];
  const pending: (() => void)[] = [];
  return {
    asked,
    wait: (ms) => {
      asked.push(ms);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    fire: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

function probeDeps(
  answer: (req: Request, signal: AbortSignal) => Promise<Response>,
  wait?: (ms: number) => Promise<void>,
): { deps: PublicProbeDeps; sent: Request[]; signals: AbortSignal[] } {
  const sent: Request[] = [];
  const signals: AbortSignal[] = [];
  let clock = 1000;
  return {
    sent,
    signals,
    deps: {
      fetch: (req, init) => {
        sent.push(req);
        signals.push(init.signal);
        return answer(req, init.signal);
      },
      now: () => (clock += 40),
      ...(wait ? { wait } : {}),
    },
  };
}

// ------------------------------------------------------------ the request

{
  const { deps, sent } = probeDeps(async () => new Response("{}", { status: 401, headers: { "cf-placement": "remote-SEA" } }));
  await startPublicProbe({ loadtest: false, tickId: TICK }, deps);
  eq(sent.length, 1, "one probe request per tick");
  const url = new URL(sent[0]!.url);
  eq(`${url.protocol}//${url.host}`, CRON_ORIGIN, "sent to the production custom domain, as public traffic arrives");
  eq(url.pathname, PUBLIC_PROBE_PATH, "at the smoke version route");
  eq(PUBLIC_PROBE_PATH, "/api/smoke/version", "which answers without touching data");
  eq(sent[0]!.method, "GET", "as a GET");
  eq(sent[0]!.headers.get("authorization"), null, "carrying no credential, so it is refused at the bearer check");
  eq(url.searchParams.get("tick"), TICK, "and naming its tick, so its own invocation can be found in the logs");
}

// ------------------------------------------------------------ the outcomes

{
  // Placed beside the database.
  const { deps } = probeDeps(async () => new Response('{"error":"Missing API key"}', { status: 401, headers: { "cf-placement": "remote-SEA" } }));
  const out = await startPublicProbe({ loadtest: false, tickId: TICK }, deps);
  eq(out.kind, "answered", "a probe the Worker answered is an answer");
  const f = publicProbeFields(out);
  eq(f.public_probe, "remote-SEA", "its cf-placement value is logged raw");
  eq(f.public_probe_status, 401, "with the status it answered");
  eq(f.public_probe_near_db, 1, "and counted as near the database");
  eq(typeof f.public_probe_ms, "number", "and how long the answer took");
  eq(f.public_probe_cf_error, undefined, "an answer from the app carries no Cloudflare error code");
}

{
  // Not placed: ran where the tick fired.
  const { deps } = probeDeps(async () => new Response("{}", { status: 401, headers: { "cf-placement": "local-NRT" } }));
  const f = publicProbeFields(await startPublicProbe({ loadtest: false, tickId: TICK }, deps));
  eq(f.public_probe, "local-NRT", "a probe that ran where the tick fired says so");
  eq(f.public_probe_near_db, 0, "and is not counted near the database");
}

{
  // A Cloudflare refusal of a same zone fetch, which is what the docs predict without
  // `global_fetch_strictly_public` (error 1042 or a 522), answered with no header.
  const { deps } = probeDeps(async () => new Response("error code: 1042", { status: 404, headers: { "content-type": "text/plain" } }));
  const f = publicProbeFields(await startPublicProbe({ loadtest: false, tickId: TICK }, deps));
  eq(f.public_probe, "no_header", "an answer without cf-placement says so in the field, never an empty value");
  eq(f.public_probe_status, 404, "with its status");
  eq(f.public_probe_cf_error, "1042", "and the Cloudflare error code its body names");
  eq(f.public_probe_near_db, 0, "and is not counted near the database");
}

{
  const { deps } = probeDeps(async () => new Response("<h1>Error code 522</h1>", { status: 522 }));
  const f = publicProbeFields(await startPublicProbe({ loadtest: false, tickId: TICK }, deps));
  eq(f.public_probe_cf_error, "522", "an HTML error page's code is read too");
}

{
  const { deps } = probeDeps(async () => new Response("{}", { status: 401, headers: { "cf-placement": "who knows" } }));
  const f = publicProbeFields(await startPublicProbe({ loadtest: false, tickId: TICK }, deps));
  eq(f.public_probe, "unreadable", "a header that does not read as a placement is logged as unreadable");
}

{
  // Times out: the fetch never answers, and the deadline fires.
  const deadline = manualDeadline();
  const { deps, signals } = probeDeps((_req, signal) => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }), deadline.wait);
  const pending = startPublicProbe({ loadtest: false, tickId: TICK }, deps);
  await Promise.resolve();
  eq(deadline.asked[0], PUBLIC_PROBE_TIMEOUT_MS, "the probe waits for headers no longer than its own short deadline");
  assert(PUBLIC_PROBE_TIMEOUT_MS <= 5_000, "a deadline of five seconds at most, so a dead route holds one connection slot briefly");
  deadline.fire();
  const out = await pending;
  eq(out.kind, "timeout", "a probe with no answer by the deadline is a timeout");
  assert(signals[0]!.aborted, "and its fetch is aborted, so it stops holding a connection");
  const f = publicProbeFields(out);
  eq(f.public_probe, "timeout", "logged as timeout, never as an empty placement");
  eq(f.public_probe_status, undefined, "with no status, since nothing answered");
  eq(f.public_probe_near_db, 0, "and not counted near the database");
}

{
  // Throws: a rejected fetch, and a fetch that throws before returning a promise.
  const { deps } = probeDeps(async () => {
    throw new TypeError("Network connection lost.");
  });
  const out = await startPublicProbe({ loadtest: false, tickId: TICK }, deps);
  eq(out.kind, "threw", "a rejected probe is recorded as thrown");
  const f = publicProbeFields(out);
  eq(f.public_probe, "threw", "logged as threw");
  assert(String(f.public_probe_error).includes("Network connection lost"), "with a short reason");
  eq(f.public_probe_near_db, 0, "and not counted near the database");

  const sync = probeDeps(() => {
    throw new Error("fetch is not a function");
  });
  const outSync = await startPublicProbe({ loadtest: false, tickId: TICK }, sync.deps);
  eq(outSync.kind, "threw", "a fetch that throws synchronously is recorded the same way, never thrown on");
}

{
  // A body that stalls after the headers arrived is still an answer: the headers are
  // the measurement, and the body read is bounded on its own.
  const deadline = manualDeadline();
  const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
  const { deps } = probeDeps(async () => new Response(stalled, { status: 404, headers: { "cf-placement": "local-IAD" } }), deadline.wait);
  const pending = startPublicProbe({ loadtest: false, tickId: TICK }, deps);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  deadline.fire();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  deadline.fire();
  const out = await pending;
  eq(out.kind, "answered", "a stalled body does not turn an answer into a timeout");
  eq(publicProbeFields(out).public_probe, "local-IAD", "and its placement is kept");
}

{
  // Skipped on the load test Worker, which has no domain (`routes: []`).
  const { deps, sent } = probeDeps(async () => new Response("{}", { status: 401 }));
  const out = await startPublicProbe({ loadtest: true, tickId: TICK }, deps);
  eq(sent.length, 0, "the load test Worker sends no probe");
  const f = publicProbeFields(out);
  eq(f.public_probe, "skipped_loadtest", "and says on the line that it skipped it");
  eq(f.public_probe_ms, undefined, "with no timing");
  eq(f.public_probe_near_db, undefined, "and no near database count, since nothing was measured");
}

// ------------------------------------------------------------ the field names

{
  // The held #3731 alert (and the #4189 analysis) read every `<lane>_placement` field as a
  // lane, so the probe's placement must not end in `_placement` or it would be counted as
  // a far lane on every tick it timed out.
  const outcomes: PublicProbeOutcome[] = [
    { kind: "answered", status: 401, placement: "local-NRT", ms: 12, cfError: "1042" },
    { kind: "timeout", ms: 5000 },
    { kind: "threw", ms: 3, reason: "boom" },
    { kind: "skipped", why: "loadtest" },
  ];
  for (const o of outcomes) {
    for (const key of Object.keys(publicProbeFields(o))) {
      assert(key.startsWith("public_probe"), `${key} is namespaced under public_probe`);
      assert(!key.endsWith("_placement") && !key.endsWith("_via") && !key.endsWith("_fallback"), `${key} cannot be read as a lane's field`);
    }
  }
  const lanes = Object.values(CRON_ROUTES).flatMap((r) => (Array.isArray(r) ? r : [r])).map(laneFieldName);
  assert(!lanes.some((l) => l.startsWith("public_probe")), "and no lane is named so that its fields collide with the probe's");
  const line = { ...laneTimingFields([{ path: "/api/cron/sync", ms: 10, ok: true, via: "placed", placement: "local-NRT" }], 10), ...publicProbeFields(outcomes[0]!) };
  eq(line.sync_placement, "local-NRT", "the lane's placement and the probe's sit side by side on one line");
  eq(line.public_probe, "local-NRT", "the probe's beside it");
  eq(line.lanes_placed, 1, "and the lane counts are unchanged by the probe");
}

// ------------------------------------------------------------ never delaying or failing the lanes

{
  // The lanes are dispatched before the probe, settle on their own time, and the lane time
  // excludes whatever the probe takes.
  const order: string[] = [];
  let clock = 0;
  let releaseProbe: (o: PublicProbeOutcome) => void = () => {};
  let lanesDone = false;
  const result = dispatchWithProbe(
    async () => {
      order.push("lanes");
      clock = 100;
      return ["sync ok"];
    },
    () => {
      order.push("probe");
      return new Promise<PublicProbeOutcome>((resolve) => (releaseProbe = resolve));
    },
    () => clock,
  );
  const lanesSeen = result.lanesSettled.then((l) => {
    lanesDone = true;
    return l;
  });
  eq(order.join(","), "lanes,probe", "the lanes are dispatched before the probe starts");
  eq((await lanesSeen).join(","), "sync ok", "the lanes settle while the probe is still out");
  assert(lanesDone, "so nothing about the lanes waits on the probe");
  clock = 4_900;
  releaseProbe({ kind: "timeout", ms: 4_800 });
  const done = await result.done;
  eq(done.lanesMs, 100, "the lane time is measured to the lanes' own end, never the probe's");
  eq(done.probe.kind, "timeout", "and the probe's outcome is carried beside them");
}

{
  // A probe that throws while starting, or rejects, never fails the tick.
  const r = dispatchWithProbe(
    async () => ["outbox ok"],
    () => {
      throw new Error("could not start");
    },
    () => 0,
  );
  const done = await r.done;
  eq(done.lanes.join(","), "outbox ok", "a probe that throws at start leaves the lanes' outcomes untouched");
  eq(done.probe.kind, "threw", "and is recorded as thrown");

  const r2 = dispatchWithProbe(async () => ["selfheal ok"], () => Promise.reject(new Error("late")), () => 0);
  const done2 = await r2.done;
  eq(done2.lanes.join(","), "selfheal ok", "a probe that rejects leaves them untouched too");
  eq(done2.probe.kind, "threw", "and is recorded as thrown");
}

// ------------------------------------------------------------ the wiring

{
  const entry = readFileSync(join(ROOT, "worker/index.ts"), "utf8");
  const scheduled = entry.slice(entry.indexOf("async scheduled("), entry.indexOf("export default worker"));
  assert(/\bdispatchWithProbe\s*\(/.test(scheduled), "scheduled() runs the lanes through dispatchWithProbe");
  assert(/\bstartPublicProbe\s*\(/.test(scheduled), "and starts the public probe there");
  assert(
    /startPublicProbe\(\s*\{[^}]*loadtest:\s*env\.SLATE_LOADTEST === "true"/.test(scheduled),
    "telling it whether this is the load test Worker, from the same variable every load test guard reads",
  );
  assert(/\.\.\.publicProbeFields\(/.test(scheduled), "and spreads the probe's fields onto the lane timings line");
  const lineAt = scheduled.indexOf('msg: "lane timings"');
  const budgetAt = scheduled.indexOf("recordCronBudget(");
  assert(lineAt !== -1 && budgetAt > lineAt, "the budget check still runs after the line");
  assert(
    /recordCronBudget\(controller\.cron,\s*totalMs,/.test(scheduled) && /const totalMs = [^;]*lanesMs/.test(scheduled),
    "and is handed the lanes' own time, never one that includes the probe",
  );
}

finish();

/**
 * #3133 and #3139: what the cron dispatcher does with a lane that fails, and the
 * tick id it threads through every lane request and every line it writes.
 *
 * `worker/index.ts` cannot be imported by a test (it imports the generated
 * `.open-next/worker.js`), so the behaviour lives in `worker/lane-run.ts` and is
 * driven here through a hand written fetch, and the wiring is checked against the
 * entry's source text the way `test-lane-timing.ts` checks its own.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-cron-lane-run.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  mintTickId,
  reportLaneFailures,
  runLane,
  LANE_FAILURE_PATH,
  TICK_ID_HEADER,
  type LaneRunDeps,
  type LaneTick,
} from "../worker/lane-run.ts";
import {
  formatLaneFailureAlert,
  laneFailedKey,
  parseLaneFailure,
  parseTickId,
  LANE_ALERTED_HEADER,
} from "../src/lib/monitor/lane-failure.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

interface Seen {
  requests: { url: string; method: string; headers: Headers; body: string }[];
  errors: { tag: string; fields: Record<string, unknown>; err: unknown }[];
}

function harness(answer: (req: Request) => Promise<Response>): { deps: LaneRunDeps; seen: Seen } {
  const seen: Seen = { requests: [], errors: [] };
  let clock = 1000;
  const deps: LaneRunDeps = {
    fetch: async (req) => {
      seen.requests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.method === "POST" ? await req.clone().text() : "",
      });
      return answer(req);
    },
    now: () => (clock += 5),
    log: {
      error: (tag, fields, err) => {
        seen.errors.push({ tag, fields: fields as Record<string, unknown>, err });
      },
    },
  };
  return { deps, seen };
}

const tick: LaneTick = { tickId: "0123456789abcdef", cronSecret: "s3cret" };

// ------------------------------------------------------------ the tick id

{
  const id = mintTickId(() => "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  eq(id, "0f1e2d3c4b5a6978", "a tick id is the uuid's first sixteen hex digits");
  eq(parseTickId(id), id, "and the failure route accepts the id the dispatcher mints");
  eq(parseTickId("not an id; drop table"), null, "but refuses anything it did not mint");
  eq(parseTickId(null), null, "and an absent header");
}

// ------------------------------------------------------------ a healthy lane

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const out = await runLane("/api/cron/recompute", tick, deps);
  eq(out.failure, null, "a lane answering ok is not a failure");
  eq(out.run.ok, true, "and is timed as ok");
  eq(out.run.path, "/api/cron/recompute", "under its own path");
  eq(seen.requests[0]!.headers.get(TICK_ID_HEADER), tick.tickId, "the lane request carries the tick id");
  eq(seen.requests[0]!.headers.get("authorization"), "Bearer s3cret", "and the cron bearer");
  eq(seen.errors.length, 0, "and nothing is logged as an error");
}

// ------------------------------------------------------------ a non-ok lane

{
  const { deps, seen } = harness(async () => new Response("boom detail", { status: 500 }));
  const out = await runLane("/api/cron/bulk-reassign", tick, deps);
  eq(out.run.ok, false, "a 500 is timed as failed");
  eq(out.failure, { lane: "bulk_reassign", status: 500, reason: "answered 500" }, "and reported by lane name and status");
  eq(seen.errors.length, 1, "and logged once");
  eq(seen.errors[0]!.fields.tick, tick.tickId, "with the tick id on the line");
  eq(seen.errors[0]!.fields.body, "boom detail", "and the body kept for the LOG");
  assert(!out.failure!.reason.includes("boom"), "but the body never reaches the page");
}

// ------------------------------------------------------------ one failure, one message
//
// Dan, 2026-10-03: "I only want one alert. neither should page two." A lane whose
// response says it already raised its own alert gets no generic page; one whose
// response does not, still does. Both directions, on the same status.

{
  const { deps, seen } = harness(
    async () =>
      new Response("{}", { status: 500, headers: { [LANE_ALERTED_HEADER]: "agent_sync_failures" } }),
  );
  const out = await runLane("/api/cron/agents", tick, deps);
  eq(out.failure, null, "a lane that already raised its own alert is not reported for a generic page");
  eq(out.run.ok, false, "but is still timed as failed");
  eq(seen.errors.length, 1, "and still logged");
  eq(seen.errors[0]!.fields.alerted, "agent_sync_failures", "naming the alert that spoke for it");
}

{
  const { deps } = harness(async () => new Response("{}", { status: 500 }));
  const out = await runLane("/api/cron/agents", tick, deps);
  eq(out.failure?.lane, "agents", "the same lane with no own alert on this failure IS reported");
}

{
  const { deps } = harness(
    async () => new Response("{}", { status: 500, headers: { [LANE_ALERTED_HEADER]: "  " } }),
  );
  const out = await runLane("/api/cron/agents", tick, deps);
  eq(out.failure?.lane, "agents", "an empty header names no alert, so the generic page still fires");
}

// ------------------------------------------------------------ a lane that throws

{
  const thrown = new Error("Worker exceeded CPU time limit");
  const { deps, seen } = harness(async () => {
    throw thrown;
  });
  const out = await runLane("/api/cron/outbox", tick, deps);
  eq(out.run.ok, false, "a thrown lane is still timed, as failed");
  assert(out.run.ms > 0, "and still measured");
  eq(out.failure?.status, null, "it is reported with no status, because there was no response");
  eq(out.failure?.lane, "outbox", "under its lane name");
  assert(out.failure!.reason.includes("CPU time limit"), "with a short reason taken from the error");
  // The fault this fixes: a try/finally with no catch left only failed=<lane>.
  eq(seen.errors.length, 1, "the throw is LOGGED, not merely counted");
  eq(seen.errors[0]!.err, thrown, "with the error itself, so its stack is kept");
  eq(seen.errors[0]!.fields.path, "/api/cron/outbox", "and the path");
  eq(seen.errors[0]!.fields.tick, tick.tickId, "and the tick id");
}

// ------------------------------------------------------------ reporting

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  await reportLaneFailures(
    [{ lane: "outbox", status: null, reason: "fetch failed" }],
    tick,
    deps,
  );
  eq(seen.requests.length, 1, "each failure is reported once");
  const r = seen.requests[0]!;
  eq(new URL(r.url).pathname, LANE_FAILURE_PATH, "to the app's failure route");
  eq(r.method, "POST", "as a POST");
  eq(r.headers.get(TICK_ID_HEADER), tick.tickId, "carrying the tick id");
  eq(r.headers.get("authorization"), "Bearer s3cret", "and the cron bearer");
  eq(
    parseLaneFailure(JSON.parse(r.body)),
    { lane: "outbox", status: null, reason: "fetch failed" },
    "with a body the route reads back exactly",
  );
}

{
  const { deps, seen } = harness(async () => new Response("no", { status: 500 }));
  await reportLaneFailures([{ lane: "sync", status: 503, reason: "answered 503" }], tick, deps);
  eq(seen.errors.length, 1, "a refused report is logged");
  eq(seen.errors[0]!.fields.tick, tick.tickId, "against the tick");
}

{
  const { deps, seen } = harness(async () => {
    throw new Error("isolate gone");
  });
  await reportLaneFailures([{ lane: "sync", status: 503, reason: "answered 503" }], tick, deps);
  eq(seen.errors.length, 1, "a report that throws is logged, and does not throw itself");
}

// ------------------------------------------------------------ the route's reading

eq(parseLaneFailure(null), null, "an empty body is not a report");
eq(parseLaneFailure({ lane: "Outbox/../x", status: 500, reason: "r" }), null, "a lane name it did not mint is refused");
eq(parseLaneFailure({ lane: "outbox", status: "500", reason: "r" }), null, "a status that is not a number is refused");
eq(parseLaneFailure({ lane: "outbox", status: 500, reason: " " }), null, "an empty reason is refused");
eq(laneFailedKey("outbox"), "cron_lane_failed:outbox", "the key the catalog classifies");
eq(laneFailedKey("bulk_reassign"), "cron_lane_failed:bulk_reassign", "a hyphenated lane by its field name");
eq(
  laneFailedKey("invented_lane"),
  "cron_lane_failed:other",
  "a lane nothing schedules is mapped to other, so the family stays bounded",
);

{
  const thrownCopy = formatLaneFailureAlert({ lane: "outbox", status: null, reason: "fetch failed" }, "abc123");
  assert(thrownCopy.includes("tick=abc123"), "the page names the tick id to search for");
  // L440: only the dispatcher's lines carry the id, so the page may claim no more.
  assert(!/every line/.test(thrownCopy), "and does not claim the id finds every line of the run");
  assert(
    /dispatcher's lines/.test(thrownCopy) && /do not\s+carry the id/.test(thrownCopy),
    "it says the search finds the dispatcher's lines, and that the lane's own do not carry the id",
  );
  assert(thrownCopy.includes("fetch failed"), "and says why a thrown lane failed");
  const statusCopy = formatLaneFailureAlert({ lane: "sync", status: 500, reason: "answered 500" }, null);
  assert(statusCopy.includes("answered 500"), "a non-ok lane names its status");
  assert(statusCopy.includes("path=/api/cron/sync"), "and with no tick id, points at the lane's path instead");
  assert(!/[\u2014\u2013]/.test(thrownCopy + statusCopy), "and carries no dash punctuation");
}

// ------------------------------------------------------------ the wiring

const entry = readFileSync(join(ROOT, "worker/index.ts"), "utf8");
assert(/\brunLane\s*\(/.test(entry), "worker/index.ts runs every lane through runLane");
assert(/\breportLaneFailures\s*\(/.test(entry), "and reports the failures it collects");
assert(/\bmintTickId\s*\(/.test(entry), "and mints one tick id per scheduled tick");
assert(/tick:\s*tick\.tickId/.test(entry), "and stamps it on the timings line");
assert(
  !/new Request\(/.test(entry.slice(entry.indexOf("async scheduled("))),
  "and no lane request is built beside runLane, which would carry no tick id",
);
assert(
  existsSync(join(ROOT, "src/app", LANE_FAILURE_PATH, "route.ts")),
  "the failure route the dispatcher posts to exists",
);

finish();

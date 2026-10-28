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
  placedLaneOrigin,
  placedLaneStandbyRefusal,
  placementOf,
  recordCronBudget,
  reportLaneFailures,
  resolveSelfBinding,
  runLane,
  CRON_ORIGIN,
  LANE_FAILURE_PATH,
  LANE_NOT_RUN_HEADER,
  PLACED_LANE_HEADER,
  SELF_BINDING,
  TICK_ID_HEADER,
  type LaneRunDeps,
  type LaneTick,
  type SelfBinding,
  ANSWER_READ_MS,
} from "../worker/lane-run.ts";
import { laneTimingFields } from "../src/lib/monitor/lane-timing.ts";
import { loadtestServingProductionHost } from "../src/lib/loadtest-guard.ts";
import { httpsRedirect } from "../src/lib/http/https-redirect.ts";
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
  warns: { tag: string; fields: Record<string, unknown>; err: unknown }[];
  infos: { tag: string; fields: Record<string, unknown> }[];
}

function harness(answer: (req: Request) => Promise<Response>): { deps: LaneRunDeps; seen: Seen } {
  const seen: Seen = { requests: [], errors: [], warns: [], infos: [] };
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
      warn: (tag, fields, err) => {
        seen.warns.push({ tag, fields: fields as Record<string, unknown>, err });
      },
      info: (tag, fields) => {
        seen.infos.push({ tag, fields: fields as Record<string, unknown> });
      },
    },
  };
  return { deps, seen };
}

/** A fake of the Worker's binding to itself, recording what it was sent (#3693). */
function selfBinding(answer: (req: Request) => Promise<Response>): { binding: SelfBinding; sent: Request[] } {
  const sent: Request[] = [];
  return {
    sent,
    binding: {
      fetch: (req: Request) => {
        sent.push(req);
        return answer(req);
      },
    },
  };
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

// ------------------------------------------------------------ placed lanes (#3693)
//
// Placement moves only a fetch handler, never scheduled(), so each lane is sent over
// the Worker's binding to itself and runs as a fetch the region hint places near the
// database (wrangler.jsonc, pinned by scripts/test-worker-placement.ts). The
// in process path stays as the fallback, and a lane that was SENT is never run twice.

const PLACED_ORIGIN = placedLaneOrigin(false);

{
  const { deps, seen } = harness(async () => new Response("in process", { status: 200 }));
  const self = selfBinding(
    async () => new Response("{}", { status: 200, headers: { "cf-placement": "remote-SEA" } }),
  );
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/recompute", tick, deps);
  eq(self.sent.length, 1, "a lane goes over the self binding once");
  eq(seen.requests.length, 0, "and is not also run in process");
  eq(out.failure, null, "an ok placed lane is not a failure");
  eq(out.run.ok, true, "and is timed as ok");
  eq(out.run.via, "placed", "and recorded as placed");
  eq(out.run.placement, "remote-SEA", "with the cf-placement value Cloudflare answered with");
  const req = self.sent[0]!;
  eq(req.url, `${PLACED_ORIGIN}/api/cron/recompute`, "to the lane's own path");
  eq(req.headers.get("authorization"), "Bearer s3cret", "carrying the cron bearer exactly as in process");
  eq(req.headers.get(TICK_ID_HEADER), tick.tickId, "and the tick id");
  eq(req.headers.get(PLACED_LANE_HEADER), "1", "and the mark that lets a standby canary refuse it");
  eq(seen.warns.length + seen.errors.length, 0, "and nothing is logged as a fault");
}

{
  const { deps } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async () => new Response("{}", { status: 200 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/sync", tick, deps);
  eq(out.run.via, "placed", "a placed lane with no cf-placement header is still placed");
  eq(out.run.placement, null, "and its placement is unknown rather than invented");
  const fields = laneTimingFields([out.run], out.run.ms);
  eq(fields.sync_via, "placed", "the timings line says which path ran");
  eq(fields.sync_placement, "none", "and says the header was absent, not that the lane ran in process");
}

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  deps.placed = { binding: null, unavailable: "absent", origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/outbox", tick, deps);
  eq(seen.requests.length, 1, "with no binding the lane runs in process, as before");
  eq(seen.requests[0]!.url, `${CRON_ORIGIN}/api/cron/outbox`, "on the in process origin");
  eq(seen.requests[0]!.headers.get(PLACED_LANE_HEADER), null, "without the placed mark");
  eq(out.run.via, "in_process", "and is recorded as in process");
  eq(out.run.fallback, "binding_absent", "with the reason it fell back");
  eq(out.failure, null, "which is not a lane failure");
  eq(seen.warns.length, 1, "the fallback is logged");
  eq(seen.warns[0]!.tag, "cron", "under the cron tag");
  eq(seen.warns[0]!.fields.why, "binding_absent", "with its reason");
  eq(seen.warns[0]!.fields.tick, tick.tickId, "and the tick id");
  const fields = laneTimingFields([out.run], out.run.ms);
  eq(fields.outbox_via, "in_process", "and the timings line says it ran in process");
  eq(fields.outbox_fallback, "binding_absent", "and why");
  eq(fields.lanes_placed, 0, "and counts no placed lane");
}

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  deps.placed = { binding: null, unavailable: "unusable", origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/selfheal", tick, deps);
  eq(seen.requests.length, 1, "a binding that is not a service binding falls back in process");
  eq(out.run.fallback, "binding_unusable", "under its own reason");
}

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const thrown = new TypeError("Fetcher is not bound");
  deps.placed = {
    binding: {
      fetch: () => {
        throw thrown;
      },
    },
    origin: PLACED_ORIGIN,
  };
  const out = await runLane("/api/cron/recompute", tick, deps);
  eq(seen.requests.length, 1, "a binding call that throws BEFORE sending falls back in process");
  eq(out.run.ok, true, "and the lane still runs");
  eq(out.run.via, "in_process", "in process");
  eq(out.run.fallback, "binding_threw_before_sending", "for that reason");
  eq(seen.warns[0]!.err, thrown, "with the error kept on the log line");
  eq(out.failure, null, "and no lane failure");
}

{
  // A rejection is NOT a throw before sending: the request may have reached the lane
  // and run part of it, so running it again in process could double a write.
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async () => {
    throw new Error("Worker threw exception");
  });
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/outbox", tick, deps);
  eq(self.sent.length, 1, "a placed call that rejects was sent once");
  eq(seen.requests.length, 0, "and is NEVER re-run in process");
  eq(out.run.ok, false, "it is timed as failed");
  eq(out.run.via, "placed", "on the placed path");
  eq(out.failure?.lane, "outbox", "and reported as the lane's failure");
  eq(out.failure?.status, null, "with no status, since there was no response");
  eq(seen.errors.length, 1, "and logged as a thrown lane");
}

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(
    async () => new Response("boom", { status: 500, headers: { "cf-placement": "remote-SEA" } }),
  );
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/sync", tick, deps);
  eq(seen.requests.length, 0, "a lane that answered non-ok over the binding is NOT re-run in process");
  eq(out.failure, { lane: "sync", status: 500, reason: "answered 500" }, "it is reported like any failed lane");
  eq(out.run.via, "placed", "on the placed path");
  eq(out.run.placement, "remote-SEA", "with where it ran");
}

// #4325: a placed lane answered 503 with NO body, and no invocation of the lane was
// ever recorded: Cloudflare answered between the binding and the entry. Every answer
// Slate sends carries text, so an empty 5xx over the binding is reported as such, and
// still never re-run: a lane Cloudflare stopped part way may look the same, after it
// has written.
{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async () => new Response(null, { status: 503 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/watch", tick, deps);
  eq(seen.requests.length, 0, "an empty 503 over the binding is NOT re-run in process");
  eq(
    out.failure,
    { lane: "watch", status: 503, reason: "answered 503", emptyBody: true },
    "it is reported as an empty answer",
  );
}
{
  const { deps } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async () => new Response("  ", { status: 404 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/watch", tick, deps);
  eq(out.failure?.emptyBody, undefined, "an empty answer below 500 is not marked: Cloudflare's own answers are 5xx");
}
{
  const { deps } = harness(async () => new Response(null, { status: 500 }));
  const out = await runLane("/api/cron/watch", tick, deps);
  eq(
    out.failure,
    { lane: "watch", status: 500, reason: "answered 500" },
    "an empty answer from a lane run IN PROCESS is not marked: no Cloudflare hop answered it",
  );
}
{
  // A body that never ends is not known to be empty.
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  });
  const { deps } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async () => new Response(stalled, { status: 503 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  deps.wait = async () => {};
  const out = await runLane("/api/cron/watch", tick, deps);
  eq(out.failure?.emptyBody, undefined, "a body that stalled past the read deadline is not marked empty");
}
{
  eq(
    parseLaneFailure({ lane: "watch", status: 503, reason: "answered 503", emptyBody: true }),
    { lane: "watch", status: 503, reason: "answered 503", emptyBody: true },
    "the failure route keeps the empty answer mark",
  );
  eq(
    parseLaneFailure({ lane: "watch", status: 503, reason: "answered 503", emptyBody: "yes" }),
    null,
    "and refuses a mark that is not a boolean",
  );
  const emptyCopy = formatLaneFailureAlert(
    { lane: "watch", status: 503, reason: "answered 503", emptyBody: true },
    "bd8c4ed95dd04bbb",
  );
  assert(emptyCopy.includes("answered 503 with an empty body"), "the page says the answer was empty");
  assert(/Cloudflare/.test(emptyCopy), "and that it most likely came from Cloudflare");
  assert(/never started/.test(emptyCopy) && /partway/.test(emptyCopy), "naming both things it can mean");
  assert(
    emptyCopy.includes("GET /api/cron/watch"),
    "and the invocation whose absence tells them apart",
  );
  assert(!/did not finish/.test(emptyCopy), "and does not claim the lane started and failed");
  assert(emptyCopy.includes("tick=bd8c4ed95dd04bbb"), "it still names the tick id to search for");
  const dashes = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
  assert(!dashes.test(emptyCopy), "and carries no dash punctuation");
  const fullCopy = formatLaneFailureAlert({ lane: "watch", status: 503, reason: "answered 503" }, null);
  assert(/did not finish/.test(fullCopy) && !/empty body/.test(fullCopy), "a 503 with a body keeps the old wording");
}

{
  // A gradual deploy's canary refuses a placed lane before the app runs it, and says
  // so on the response, so the version that dispatched it runs it in process (#3095).
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async (req) => placedLaneStandbyRefusal(req, "1") ?? new Response("ran"));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/recompute", tick, deps);
  eq(self.sent.length, 1, "the placed request reached the canary");
  eq(seen.requests.length, 1, "which refused it, so it ran in process exactly once");
  eq(out.run.ok, true, "and succeeded");
  eq(out.run.via, "in_process", "in process");
  eq(out.run.fallback, "standby_canary", "because a standby canary refused it");
  eq(seen.warns.length, 0, "an expected deploy split is not a warning");
  eq(seen.infos.length, 1, "but is logged");
}

{
  // A lane that fell back and then threw in process is recorded on the path it took.
  const { deps } = harness(async () => {
    throw new Error("in process blew up");
  });
  deps.placed = { binding: null, unavailable: "absent", origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/sync", tick, deps);
  eq(out.run.via, "in_process", "a fallen back lane that threw is recorded as in process");
  eq(out.run.fallback, "binding_absent", "with why it fell back");
  eq(out.failure?.status, null, "and reported as a thrown lane");
}

{
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(
    async () => new Response("no", { status: 503, headers: { [LANE_NOT_RUN_HEADER]: "something else" } }),
  );
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/recompute", tick, deps);
  eq(seen.requests.length, 0, "only the exact standby answer means the lane did not run");
  eq(out.failure?.status, 503, "anything else is the lane's own failure");
}

{
  // #4222: the lane's claim on its tick. A duplicate answer means the tick's lane already
  // ran once, so it is never run again in process and never paged; a refused claim is the
  // lane's own failure, reported and never re-run.
  for (const [notRun, status] of [["duplicate", 200], ["claim_unreadable", 503], ["tick_unreadable", 400]] as const) {
    const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
    const self = selfBinding(
      async () => new Response("{}", { status, headers: { [LANE_NOT_RUN_HEADER]: notRun } }),
    );
    deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
    const out = await runLane("/api/cron/outbox", tick, deps);
    eq(seen.requests.length, 0, `a ${notRun} answer is never run again in process`);
    eq(out.run.via, "placed", `and is recorded as placed (${notRun})`);
    eq(out.failure?.status ?? null, status === 200 ? null : status, `a ${notRun} answer is ${status === 200 ? "no failure" : "the lane's failure"}`);
  }
}

{
  // The refusal the entry gives a placed lane on a standby canary.
  const req = (mark: boolean) =>
    new Request(`${PLACED_ORIGIN}/api/cron/sync`, { headers: mark ? { [PLACED_LANE_HEADER]: "1" } : {} });
  const refused = placedLaneStandbyRefusal(req(true), "1");
  assert(refused !== null, "a placed lane reaching a standby canary is refused");
  eq(refused?.status, 503, "with a 503");
  eq(refused?.headers.get(LANE_NOT_RUN_HEADER), "standby", "that says the lane did not run");
  assert(placedLaneStandbyRefusal(req(true), "garbled") !== null, "an unreadable standby value refuses too");
  eq(placedLaneStandbyRefusal(req(true), undefined), null, "the serving version runs a placed lane");
  eq(placedLaneStandbyRefusal(req(true), "0"), null, "and so does one with standby off");
  eq(placedLaneStandbyRefusal(req(false), "1"), null, "a request without the mark is untouched on a canary");
}

{
  // The placed request passes the entry's own guards: https, so no redirect, and never
  // the production host under the load test, or the host guard refuses every lane.
  for (const loadtest of [false, true]) {
    const url = `${placedLaneOrigin(loadtest)}/api/cron/sync`;
    eq(httpsRedirect(new Request(url)), null, `the placed origin is https (loadtest ${loadtest})`);
    eq(loadtestServingProductionHost({ loadtest, url }), null, `and passes the host guard (loadtest ${loadtest})`);
  }
  eq(placedLaneOrigin(false), CRON_ORIGIN, "production keeps the origin the lanes always had");
  eq(
    loadtestServingProductionHost({ loadtest: true, url: `${CRON_ORIGIN}/api/cron/sync` }) !== null,
    true,
    "control: the production origin IS refused under the load test, which is why it differs there",
  );
}

{
  eq(resolveSelfBinding(undefined), { binding: null, unavailable: "absent" }, "no binding is absent");
  eq(resolveSelfBinding({}), { binding: null, unavailable: "unusable" }, "an object with no fetch is unusable");
  eq(resolveSelfBinding("SELF"), { binding: null, unavailable: "unusable" }, "a var of the same name is unusable");
  const fetcher = { fetch: async () => new Response("") };
  eq(resolveSelfBinding(fetcher).binding, fetcher, "a fetcher is used as it is");
  eq(SELF_BINDING, "SELF", "the binding name wrangler.jsonc declares");
}

{
  eq(placementOf(new Headers({ "cf-placement": "local-EWR" })), "local-EWR", "a local placement is kept");
  eq(placementOf(new Headers()), null, "an absent header is null");
  eq(placementOf(new Headers({ "cf-placement": "x y=z ".repeat(20) })), "unreadable", "an odd value is not logged raw");
}

{
  // Failure reports and the budget check stay in process: they must not depend on the
  // binding whose absence or fault is one of the things being reported.
  const { deps, seen } = harness(async () => new Response("{}", { status: 200 }));
  const self = selfBinding(async () => new Response("{}", { status: 200 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  await reportLaneFailures([{ lane: "sync", status: 500, reason: "answered 500" }], tick, deps);
  await recordCronBudget("0 * * * *", 10, tick, deps);
  eq(self.sent.length, 0, "a failure report and the budget check never go over the binding");
  eq(seen.requests.length, 2, "they run in process");
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
  /resolveSelfBinding\(\s*env\[SELF_BINDING\]\s*\)/.test(entry),
  "scheduled() resolves the Worker's binding to itself (#3693)",
);
assert(/placed:\s*\{/.test(entry), "and hands it to the lane dispatcher");
{
  const fetchStart = entry.indexOf("fetch: (request: Request");
  const fetchBody = entry.slice(fetchStart, entry.indexOf("async scheduled("));
  const refusalAt = fetchBody.indexOf("placedLaneStandbyRefusal(");
  const appAt = fetchBody.indexOf("app.fetch(");
  assert(
    refusalAt !== -1 && appAt !== -1 && refusalAt < appAt,
    "the fetch handler refuses a placed lane on a standby canary before the app can run it",
  );
}
assert(
  existsSync(join(ROOT, "src/app", LANE_FAILURE_PATH, "route.ts")),
  "the failure route the dispatcher posts to exists",
);

// ------------------------------------------------------------ an ok answer is read through (#3885)
//
// The dispatcher used to read a lane's body only when it was NOT ok. Over a local
// service binding nothing buffers a small body in transit, so a lane whose ok answer
// was never read could not finish delivering it: its invocation stayed open until the
// tick ended and Cloudflare recorded it cancelled (run 39055855051, three lanes of one
// five minute tick that ran at Singapore).

/** A body that records whether it was read to its end. */
function trackedBody(text: string): { body: ReadableStream<Uint8Array>; read: () => boolean } {
  let finished = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(text));
        return;
      }
      finished = true;
      controller.close();
    },
  });
  return { body, read: () => finished };
}

{
  const { deps } = harness(async () => new Response("in process", { status: 200 }));
  const tracked = trackedBody('{"ok":true}');
  const self = selfBinding(async () => new Response(tracked.body, { status: 200, headers: { "cf-placement": "local-SIN" } }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/complete", tick, deps);
  eq(out.run.ok, true, "the placed lane answered ok");
  assert(tracked.read(), "and its ok answer was read to the end, so the lane's invocation can finish");
}

{
  const tracked = trackedBody("{}");
  const { deps } = harness(async () => new Response(tracked.body, { status: 200 }));
  deps.placed = { binding: null, unavailable: "absent", origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/outbox", tick, deps);
  eq(out.run.ok, true, "an in process lane answered ok");
  assert(tracked.read(), "and its answer is read through the same way");
}

{
  // A body that cannot be read does not turn an ok lane into a failure: the status
  // already said what the lane did, and the body carries nothing the dispatcher uses.
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("stream reset"));
    },
  });
  const { deps, seen } = harness(async () => new Response("unused", { status: 200 }));
  const self = selfBinding(async () => new Response(broken, { status: 200 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/watch", tick, deps);
  eq(out.failure, null, "an ok lane whose body broke is not a failure");
  eq(out.run.ok, true, "and is still timed as ok");
  eq(seen.requests.length, 0, "and is never re-run in process, since it ran");
  eq(
    seen.warns.map((w) => [w.fields.msg, w.fields.path, w.fields.answer]),
    [["a lane's ok answer could not be read through", "/api/cron/watch", "unreadable"]],
    "but it is logged, by lane and by what happened to the answer (L11)",
  );
}

{
  // A lane that answered ok and then stalled its body must not hold the tick open: the
  // read is given ANSWER_READ_MS and then the body is let go. The wait is injected, so
  // this runs at once rather than waiting the deadline out (L524).
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const waits: number[] = [];
  const { deps, seen } = harness(async () => new Response("unused", { status: 200 }));
  deps.wait = async (ms) => {
    waits.push(ms);
  };
  const self = selfBinding(async () => new Response(stalled, { status: 200 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/watch", tick, deps);
  eq(waits, [ANSWER_READ_MS], "the read waits at most its deadline");
  eq(out.run.ok, true, "a lane that answered ok and stalled its body is still ok");
  eq(out.failure, null, "and not a failure");
  assert(cancelled, "and its body is let go rather than held for the rest of the tick");
  eq(seen.errors.length, 0, "and nothing is logged as a fault");
  eq(
    seen.warns.map((w) => [w.fields.msg, w.fields.answer]),
    [["a lane's ok answer could not be read through", "deadline"]],
    "but the stall is logged, so a lane cut off at the deadline is never silent",
  );
  // The lane's own time ends when it answered, before the read: the harness clock
  // moves 5 per reading, so a lane timed at its answer reads 5, the same as any lane.
  eq(out.run.ms, 5, "and the read is not counted in the lane's recorded time");
}

{
  // A NON-ok answer is read for the log, under the same deadline, so a lane that
  // failed and then stalled its body cannot hold the tick open either.
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial detail"));
    },
    pull() {
      return new Promise<void>(() => {});
    },
  });
  const waits: number[] = [];
  const { deps, seen } = harness(async () => new Response("unused", { status: 200 }));
  deps.wait = async (ms) => {
    waits.push(ms);
  };
  const self = selfBinding(async () => new Response(stalled, { status: 500 }));
  deps.placed = { binding: self.binding, origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/agents", tick, deps);
  eq(waits, [ANSWER_READ_MS], "the failed answer is read under the same deadline");
  eq(out.failure?.status, 500, "and the lane is still reported failed with its status");
  eq(seen.errors[0]?.fields.body, "partial detail", "with whatever of the body arrived before the deadline");
}

{
  // A body somebody already locked is reported as unreadable, never thrown into the
  // lane's own outcome: the lane answered ok and stays ok.
  const res = new Response("{}", { status: 200 });
  res.body!.getReader();
  const { deps, seen } = harness(async () => res);
  deps.placed = { binding: null, unavailable: "absent", origin: PLACED_ORIGIN };
  const out = await runLane("/api/cron/outbox", tick, deps);
  eq(out.run.ok, true, "a locked ok answer leaves the lane ok");
  eq(out.failure, null, "and not failed");
  eq(
    seen.warns.filter((w) => w.fields.msg === "a lane's ok answer could not be read through").map((w) => w.fields.answer),
    ["unreadable"],
    "and says the answer could not be read",
  );
}

finish();

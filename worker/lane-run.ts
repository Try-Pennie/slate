/**
 * One cron lane's run inside a scheduled tick, and what happens when it fails
 * (#3133), with the tick's correlation id threaded through both (#3139).
 *
 * Lifted out of `worker/index.ts` because that file imports the generated
 * `.open-next/worker.js` and so cannot be loaded by a test; everything here takes
 * its fetch, clock and logger as arguments and is driven by
 * `scripts/test-cron-lane-run.ts`.
 *
 * What it fixes. The dispatcher wrapped each lane in try/finally with no catch, so
 * a lane that THREW reached the logs only as `failed=<lane>` on the timings line,
 * with no message and no stack. And a lane answering non-ok was logged and nothing
 * else, so detection waited on the heartbeat watchdog, which cannot fire at all
 * for a lane that stamped its heartbeat before failing part way. Now both log the
 * cause, and both are handed to `/api/cron/lane-failure`, which sends a throttled
 * `cron_lane_failed:<lane>` page from inside the app, where every other alert is
 * sent from.
 *
 * Why a route rather than a send from here: this entry is bundled separately from
 * the app, so a send here would be a second copy of the Supabase client and the
 * alert dispatcher, reading environment the app's handler fills in on its first
 * request. The route runs in process (the lanes themselves are placed since #3693, see
 * `dispatchLane`), so it adds no network hop and does not depend on the binding.
 *
 * The TICK ID. A cron tick fans out to several lanes, each its own request, and
 * until now the only thing tying a lane's lines to the tick that drove it was the
 * time. Each tick mints one id, sends it on every lane request as
 * `TICK_ID_HEADER`, and stamps it on every line the DISPATCHER writes for that
 * tick and on the failure page. Each scheduled lane reads it for one thing only, to
 * claim its tick before any work, so the same lane sent twice runs once (#4222,
 * `src/lib/monitor/lane-claim.ts`). A lane's own lines still do not carry the id
 * (only the claim's duplicate and refusal lines do) and are still found by time, and
 * the page says so rather than promising more (L440).
 */
import { laneFieldName, type LaneRun } from "@/lib/monitor/lane-timing";
import {
  LANE_ALERTED_HEADER,
  LANE_NOT_RUN_HEADER,
  TICK_ID_HEADER,
  type LaneFailureReport,
} from "@/lib/monitor/lane-failure";
import { shortErrorReason } from "@/lib/notify/error-text";
import type { LogFields } from "@/lib/log";
import { CRON_BUDGET_ROUTE, cronBudgetCallsApp, wallPastLine } from "@/lib/monitor/cron-budget";
import { cronStandby } from "./cron-standby";

export { TICK_ID_HEADER };

/** The app route a failed lane is reported to. */
export const LANE_FAILURE_PATH = "/api/cron/lane-failure";

/** The origin the synthetic requests are addressed to. Never leaves the isolate. */
export const CRON_ORIGIN = "https://slate.trypennie.app";

// ------------------------------------------------------------------ placed lanes (#3693)

/** The service binding the Worker holds to ITSELF (`services` in wrangler.jsonc). */
export const SELF_BINDING = "SELF";

/** Marks a lane request sent over the self binding, so a standby canary can refuse it. */
export const PLACED_LANE_HEADER = "x-slate-placed-lane";

/** Set by the entry on that refusal. Its value `standby` is the one answer that proves the
 *  lane did NOT run, and so the one answer the dispatcher may run it in process after. The
 *  lane's own claim on its tick sets it too (`duplicate` and the rest, #4222), and those
 *  are never run again here: a duplicate already ran, and a refused claim is a failure. */
export { LANE_NOT_RUN_HEADER };

/**
 * Where a placed lane request is addressed. It goes through the entry's own fetch handler,
 * so it must pass that handler's guards: https, so no redirect, and under the load test
 * never the production host, which `loadtestServingProductionHost` refuses (in process the
 * lanes never met that guard). `.invalid` is reserved and never resolves, and the request
 * only ever travels over the binding. Production keeps the origin the lanes always had.
 */
export const LOADTEST_PLACED_ORIGIN = "https://slate-loadtest.invalid";

export function placedLaneOrigin(loadtest: boolean): string {
  return loadtest ? LOADTEST_PLACED_ORIGIN : CRON_ORIGIN;
}

/** As much of a service binding as the dispatcher calls. */
export interface SelfBinding {
  fetch(request: Request): Promise<Response>;
}

export type SelfBindingUnavailable = "absent" | "unusable";

/** The self binding from `env`, or why it cannot be used. Never throws. */
export function resolveSelfBinding(
  value: unknown,
): { binding: SelfBinding } | { binding: null; unavailable: SelfBindingUnavailable } {
  if (value === undefined || value === null) return { binding: null, unavailable: "absent" };
  if (typeof value !== "object" || typeof (value as { fetch?: unknown }).fetch !== "function") {
    return { binding: null, unavailable: "unusable" };
  }
  return { binding: value as SelfBinding };
}

/** What the dispatcher needs to send lanes placed. */
export interface PlacedDispatch {
  binding: SelfBinding | null;
  unavailable?: SelfBindingUnavailable;
  origin: string;
}

/** Why a lane meant to be placed ran in process. */
export type LaneFallback =
  | "binding_absent"
  | "binding_unusable"
  | "binding_threw_before_sending"
  | "standby_canary";

/**
 * The entry's answer to a placed lane on a gradual deploy's canary (#3095), or null.
 *
 * A self binding call is routed by the deployment's split like any request, so during a
 * split a lane the serving version sent can land on the canary, and code that has not
 * passed its probe must never run a lane. The canary refuses it before the app is reached
 * and says so, and the serving version then runs it in process. Only a request carrying
 * the placed mark is refused; anybody can send the mark, and all it buys them is a 503
 * from a canary that exists for a few minutes.
 */
export function placedLaneStandbyRefusal(request: Request, standbyValue: unknown): Response | null {
  if (request.headers.get(PLACED_LANE_HEADER) === null) return null;
  if (!cronStandby(standbyValue).standby) return null;
  return new Response("This version is in cron standby, so it runs no lane.", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", [LANE_NOT_RUN_HEADER]: "standby" },
  });
}

/** The `cf-placement` value, when it reads as one (`remote-SEA`, `local-EWR`). */
export function placementOf(headers: Headers): string | null {
  const raw = headers.get("cf-placement");
  if (raw === null) return null;
  const value = raw.trim();
  return /^[a-z]+-[a-z0-9]{2,8}$/i.test(value) ? value : "unreadable";
}

/** What the failure route is told. `status` is null when the lane THREW, because
 *  then there is no response to have a status. */
export type LaneFailure = LaneFailureReport;

export interface LaneRunDeps {
  /** The app in process: the fallback for a lane, and always the path for a failure
   *  report and the budget check, which must not depend on the binding they may report. */
  fetch(request: Request): Promise<Response>;
  /** Send lanes over the self binding (#3693). Absent, every lane runs in process. */
  placed?: PlacedDispatch;
  now(): number;
  /** Resolves after `ms`; injected so a test never waits a deadline out (L524). */
  wait?: (ms: number) => Promise<void>;
  log: {
    error(tag: string, fields: LogFields, err?: unknown): void;
    warn(tag: string, fields: LogFields, err?: unknown): void;
    info(tag: string, fields: LogFields): void;
  };
}

/**
 * How long the dispatcher reads a lane's ok answer before letting it go (#3885). The
 * answer is a few bytes of JSON, so this only ever ends a body that stalled, and a
 * stalled body must not hold the tick open after its lane already succeeded.
 */
export const ANSWER_READ_MS = 5_000;

/**
 * Read a response's body through within `ms`, then let it go, with the text that
 * arrived. Never throws. Also how the public placement probe reads its answer
 * (worker/public-probe.ts, #4189).
 */
export async function readThrough(
  res: Response,
  ms: number,
  wait?: (ms: number) => Promise<void>,
): Promise<{ outcome: "read" | "unreadable" | "deadline"; text: string }> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = res.body?.getReader();
  } catch {
    // Already locked or read: nothing more can be read from it here.
    return { outcome: "unreadable", text: "" };
  }
  if (!reader) return { outcome: "read", text: "" };
  const decoder = new TextDecoder();
  let text = "";
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "read" as const;
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => "unreadable" as const);
  // The real deadline is a timer cleared once the read ends, so a normal answer
  // leaves nothing pending behind it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = wait ? wait(ms) : new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  const outcome = await Promise.race([drain, deadline.then(() => "deadline" as const)]);
  if (timer !== undefined) clearTimeout(timer);
  // The reader holds the stream's lock, so the stalled body is let go through it.
  if (outcome === "deadline") await reader.cancel().catch(() => undefined);
  return { outcome, text };
}

export interface LaneTick {
  tickId: string;
  cronSecret: string;
}

/** A tick's id: short enough to read off a phone, unique enough to search on. */
export function mintTickId(randomUUID: () => string): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function laneRequest(
  path: string,
  tick: LaneTick,
  init: RequestInit = {},
  origin: string = CRON_ORIGIN,
): Request {
  return new Request(`${origin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tick.cronSecret}`,
      [TICK_ID_HEADER]: tick.tickId,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Run one lane. Never throws: a lane's failure is the finding this reports, and a
 * throw here would take the other lanes on the tick with it.
 */
export async function runLane(
  path: string,
  tick: LaneTick,
  deps: LaneRunDeps,
): Promise<{ run: LaneRun; failure: LaneFailure | null }> {
  const lane = laneFieldName(path);
  const startedAt = deps.now();
  let ok = false;
  let failure: LaneFailure | null = null;
  // When the lane ANSWERED, so reading its answer through is never counted as the
  // lane's own time (L323).
  let answeredAt: number | null = null;
  // Which path ran it, written by the dispatch AS it decides, so a lane that throws on
  // either path is still recorded on the path it took.
  const route: LaneRoute = { via: "in_process", placement: null, fallback: null };
  const via = () => route.via;
  try {
    const res = await dispatchLane(path, tick, deps, route);
    answeredAt = deps.now();
    ok = res.ok;
    if (res.ok) {
      // #3885: read an ok answer through too. Over a local service binding nothing
      // buffers a small body in transit, so a lane whose answer is never read cannot
      // finish delivering it: its invocation stays open until the tick ends and is
      // recorded cancelled. A body that will not read, or stalls past ANSWER_READ_MS,
      // changes nothing: the status already said what the lane did.
      const answer = (await readThrough(res, ANSWER_READ_MS, deps.wait)).outcome;
      if (answer !== "read") {
        deps.log.warn("cron", {
          msg: "a lane's ok answer could not be read through",
          path,
          answer,
          tick: tick.tickId,
          via: via(),
        });
      }
    } else {
      // The body is read for the LOG only; the page carries the status, never a
      // response body, which is whatever the lane chose to put there.
      // Under the same deadline as an ok answer (#3885): a failed lane that stalls its
      // body must not hold the tick open either. What arrived is what is logged.
      const body = (await readThrough(res, ANSWER_READ_MS, deps.wait)).text;
      // One failure, one message (Dan, 2026-10-03): a lane that already raised its
      // own alert about this failure says so on the response, and gets no generic
      // page on top of it. The header is set from what the lane's code actually
      // raised (src/lib/monitor/lane-failure-response.ts), never from a list.
      const alerted = (res.headers.get(LANE_ALERTED_HEADER) ?? "").trim();
      deps.log.error("cron", {
        msg: "lane returned a non-ok response",
        path,
        status: res.status,
        body: body.slice(0, 300),
        tick: tick.tickId,
        via: via(),
        ...(alerted ? { alerted } : {}),
      });
      if (!alerted) failure = { lane, status: res.status, reason: `answered ${res.status}` };
    }
  } catch (err) {
    // The error itself goes to the log as the third argument, so Cloudflare keeps
    // its message and stack; the page gets one short line of it.
    deps.log.error("cron", { msg: "lane threw", path, tick: tick.tickId, via: via() }, err);
    failure = { lane, status: null, reason: shortErrorReason(err) };
  }
  // A thrown lane is still measured and still reported as failed: a lane that dies
  // is usually the FAST one, and leaving it out would quietly shrink the record on
  // exactly the tick worth reading.
  return { run: { path, ms: (answeredAt ?? deps.now()) - startedAt, ok, ...route }, failure };
}

/** The path a lane took, as the dispatch decided it. */
interface LaneRoute {
  via: "placed" | "in_process";
  placement: string | null;
  fallback: LaneFallback | null;
}

/**
 * Send one lane: over the self binding when there is one, in process otherwise (#3693).
 *
 * The rule that keeps this safe is about WHEN the in process fallback may run, because a
 * lane run twice can double a write. It runs only when the lane provably did not: there
 * is no usable binding, the binding call threw synchronously (nothing was sent), or the
 * entry answered with the standby refusal (refused before the app). A binding call that
 * REJECTS is not one of those: the request may have reached the lane and run part of it,
 * so the rejection propagates as the lane's own failure and is reported, never re-run.
 * The same goes for a non-ok answer.
 */
async function dispatchLane(
  path: string,
  tick: LaneTick,
  deps: LaneRunDeps,
  route: LaneRoute,
): Promise<Response> {
  const placed = deps.placed;
  if (placed) {
    let fallbackErr: unknown = undefined;
    if (!placed.binding) {
      route.fallback = placed.unavailable === "unusable" ? "binding_unusable" : "binding_absent";
    } else {
      let pending: Promise<Response> | null = null;
      try {
        pending = placed.binding.fetch(
          laneRequest(path, tick, { headers: { [PLACED_LANE_HEADER]: "1" } }, placed.origin),
        );
      } catch (err) {
        route.fallback = "binding_threw_before_sending";
        fallbackErr = err;
      }
      if (pending) {
        // Sent: from here a rejection is the lane's own failure, recorded as placed.
        route.via = "placed";
        const res = await pending;
        if (res.headers.get(LANE_NOT_RUN_HEADER) !== "standby") {
          route.placement = placementOf(res.headers);
          return res;
        }
        await res.body?.cancel().catch(() => {});
        route.via = "in_process";
        route.fallback = "standby_canary";
      }
    }
    const fields = { msg: "lane ran in process, not placed", path, why: route.fallback, tick: tick.tickId };
    // A standby refusal is a deploy split doing its job, so it is information; every
    // other reason is a configuration fault and reads as one.
    if (route.fallback === "standby_canary") deps.log.info("cron", fields);
    else deps.log.warn("cron", fields, fallbackErr);
  }
  return deps.fetch(laneRequest(path, tick));
}

/**
 * Hand each failure to the app's failure route. Best-effort: a report that cannot
 * be delivered is logged, and never fails the tick, because the lane's own failure
 * is already in the log above it.
 */
export async function reportLaneFailures(
  failures: LaneFailure[],
  tick: LaneTick,
  deps: LaneRunDeps,
): Promise<void> {
  for (const failure of failures) {
    try {
      const res = await deps.fetch(
        laneRequest(LANE_FAILURE_PATH, tick, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(failure),
        }),
      );
      if (!res.ok) {
        deps.log.error("cron", {
          msg: "lane failure report was refused",
          lane: failure.lane,
          status: res.status,
          tick: tick.tickId,
        });
      }
    } catch (err) {
      deps.log.error(
        "cron",
        { msg: "lane failure report threw", lane: failure.lane, tick: tick.tickId },
        err,
      );
    }
  }
}

/**
 * The cron budget's share of a tick (#3141). Wall time is a LOG LINE only: the runtime gives an
 * invocation no reading of its own CPU, wall time is no bound on CPU in either direction, and
 * the page that judged it was switched off on 2026-10-03 (see @/lib/monitor/cron-budget). The
 * hourly tick asks the app to read the real CPU from Cloudflare's analytics, through a request
 * built like every other one this dispatcher makes so it carries the tick id. Every other tick
 * spends nothing. Never throws.
 */
export async function recordCronBudget(
  cron: string,
  totalMs: number,
  tick: LaneTick,
  deps: LaneRunDeps,
): Promise<void> {
  if (wallPastLine(totalMs)) {
    deps.log.warn("cron-budget", {
      msg: "tick past the wall time line, which is not CPU",
      cron,
      wall_ms: Math.round(totalMs),
      tick: tick.tickId,
    });
  }
  if (!cronBudgetCallsApp(cron)) return;
  try {
    const res = await deps.fetch(laneRequest(CRON_BUDGET_ROUTE, tick));
    if (!res.ok) {
      deps.log.error("cron-budget", { msg: "the cron budget check failed", cron, status: res.status, tick: tick.tickId });
    }
  } catch (err) {
    deps.log.error("cron-budget", { msg: "the cron budget check threw", cron, tick: tick.tickId }, err);
  }
}

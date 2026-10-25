/**
 * Custom Worker entry: wraps the OpenNext-generated handler so Cloudflare
 * cron triggers can drive the app's cron routes. scheduled() builds a
 * synthetic authorized Request per lane, and isAuthorizedCron keeps guarding
 * the HTTP surface unchanged.
 *
 * WHERE A LANE RUNS (#3693, reversing the original choice). Each lane used to be
 * handed straight to the app in process, which cost no network hop and needed no
 * binding. It also meant every lane ran wherever Cloudflare ran the cron, because
 * placement (the `placement` block in wrangler.jsonc) moves only a FETCH handler and
 * never scheduled(). Crons run "on underutilized machines": from 2026-10-13 the lanes
 * ran from Mumbai and then Amsterdam at 160 to 260ms per Supabase call, against about
 * 90ms from Newark before and about 21ms for the placed lead requests at Seattle.
 * So each lane is now sent over `SELF`, a service binding to this same Worker, which
 * reaches the default export's fetch handler below and so runs as a placed fetch near
 * the database. The placement is an explicit region hint (`aws:us-west-2`, the
 * database's region), not Smart Placement: under Smart Placement the lanes were sent
 * this way and still ran at Mumbai and Stockholm, because it moves a request only when
 * it judges another location significantly faster. The request passes that handler's
 * guards (https, and under the load test an origin that is not the production host)
 * and carries the same bearer and tick id as before.
 *
 * In process stays as the fallback, used only when the lane provably did not run: no
 * usable binding, a binding call that threw before sending, or a gradual deploy's
 * canary refusing it in cron standby (#3095). A placed call that rejected or answered
 * non-ok is reported and never re-run, because it may have written. worker/lane-run.ts
 * owns all of that; the lane timings line says which path each lane took and its
 * `cf-placement`, so the effect is read off the logs and the Supabase edge colo. Read
 * the header's colo, not only its `remote-`/`local-` prefix: Cloudflare documents
 * those in Smart Placement's terms, and a lane beside Oregon is placed either way.
 *
 * WHAT IT COSTS. Each placed lane is its own invocation of the fetch handler: about
 * 7,500 a day on top of the 2,003 scheduled invocations (13 triggers; the minute
 * trigger's four lanes alone are 5,760). Cloudflare's pricing says requests over a
 * service binding carry no additional request fee and CPU is billed as the total
 * across both, so the cost is log and analytics volume rather than money. Each lane
 * also stops sharing one invocation's CPU ceiling with its neighbours (#760, #2021),
 * and the hourly cron CPU reading (#3141) now sees only the dispatcher plus any lane
 * that fell back, not the placed lanes' own CPU (see src/lib/monitor/cron-budget.ts).
 *
 * This file is bundled by wrangler (see wrangler.jsonc "main") AFTER
 * `opennextjs-cloudflare build` emits .open-next/worker.js; it is excluded
 * from the app tsconfig because that artifact only exists post-build.
 */
// @ts-expect-error - generated at build time by opennextjs-cloudflare build
import handler from "../.open-next/worker.js";
// Also generated at build time: the adapter bakes every `.env*` value in the build
// tree into this file and the runtime fills in each name the bindings did not set,
// which is how a load test deployment came to hold production's Slack token
// (#2335). Read here rather than through `process.env` because the generated
// handler populates that on its FIRST invocation, which is exactly the request a
// guard must not miss.
// @ts-expect-error - generated at build time by opennextjs-cloudflare build
import * as bakedEnv from "../.open-next/cloudflare/next-env.mjs";
import { WorkerEntrypoint } from "cloudflare:workers";
import { routesForCron } from "./cron-routes";
import { cronStandby } from "./cron-standby";
import { forwardReceipt } from "./log-shipping-receipt";
import { forwardBookingCall, type GatewayAnswer } from "./mcp-booking-gateway";
import { internalMcpRefusal, isInternalMcpPath, stripCarrierHeaders } from "@/lib/mcp-booking/carrier";
import { MARCIA_TOKEN_KEY_ENV } from "@/lib/mcp-booking/machine-token";
import { laneDecision } from "./lanes-disabled";
import { loadtestServingProductionHost } from "@/lib/loadtest-guard";
import { loadtestEntryRefusal, loadtestIdle, loadtestIdleBody } from "@/lib/loadtest-secrets";
import { httpsRedirect } from "@/lib/http/https-redirect";
import { countedApp } from "./app-invocations";
import { log } from "@/lib/log";
import { laneTimingFields, type LaneRun } from "@/lib/monitor/lane-timing";
import {
  mintTickId,
  placedLaneOrigin,
  placedLaneStandbyRefusal,
  recordCronBudget,
  reportLaneFailures,
  resolveSelfBinding,
  runLane,
  SELF_BINDING,
  type LaneRunDeps,
  type LaneTick,
} from "./lane-run";
import { dispatchWithProbe, publicProbeFields, startPublicProbe } from "./public-probe";

// The shared per-address burst counter (#1536). A Durable Object is the only
// primitive that can hold ONE count across isolates, which is what the native
// rate limiter cannot do and why a parallel burst sailed through its ceiling.
export { BurstLimiter } from "./burst-limiter";
export { ConfirmLine } from "./confirm-line";

// Durable Object classes the generated worker exports must be re-exported
// from the entry wrangler actually loads.
/** The request's path, or undefined when the URL will not parse.
 *
 *  Undefined is the REFUSING side: the diagnostic exemption is granted by path, so a
 *  URL nobody could read must never be able to claim it. */
function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
  // @ts-expect-error - generated at build time
} from "../.open-next/worker.js";

interface Env {
  CRON_SECRET?: string;
  /** "true" only on `env.loadtest` in wrangler.jsonc (#2242). */
  SLATE_LOADTEST?: string;
  /** Comma separated lane names this deployment must not run (#2242). */
  SLATE_LANES_DISABLED?: string;
  /** "1" only on a gradual deploy's canary, which runs no lane (#3095). */
  SLATE_CRON_STANDBY?: string;
  [key: string]: unknown;
}

/**
 * #3354: every run of the app goes through this, so the isolate's first one can be
 * told apart whichever way it came (HTTP, a cron tick, a log shipping receipt).
 */
const app = countedApp(handler);

const worker = {
  // #1024: bounce plaintext to https BEFORE the app sees the request, so a lead
  // following an http:// link never transmits name/email/phone in the clear.
  // This lives here rather than in Cloudflare config because the hostname is a
  // Workers Custom Domain, which makes this Worker the origin and leaves zone
  // Redirect Rules out of the path entirely (see @/lib/http/https-redirect).
  // Returns null for anything not positively established as plaintext, so the
  // common secure case is untouched and can never loop.
  //
  // The load test refusal in front of both (#2242) answers a DIFFERENT question
  // from the one in `publicSupabaseUrl`: that one asks which database this build
  // would write to, this one asks which address it is answering on. `routes: []`
  // on `env.loadtest` is what should make this unreachable, and this is what
  // happens when somebody deploys a load test build over production by hand.
  // Judged on the request's own host, which is the only thing available here.
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
    // #3354: taken first, before anything else this handler does, so the route can
    // tell how long the request spent before Next reached it. The run is counted, and
    // under the load test stamped onto the request, by the counted wrapper below.
    const enteredAtMs = Date.now();
    const loadtest = env.SLATE_LOADTEST === "true";
    const refusal =
      loadtestServingProductionHost({ loadtest, url: request.url }) ??
      // The CREDENTIAL refusal (#2335), which the address one cannot see: a
      // contaminated build answers on exactly the address it should. It is asked
      // here rather than in the app because this is the only place that sees both
      // the bindings and the baked file, sees them from the first request, and is
      // never bundled for the browser (the app-side version published all twenty
      // three names in a public chunk).
      loadtestEntryRefusal({
        loadtest,
        pathname: safePathname(request.url),
        bindings: env as unknown as Record<string, unknown>,
        baked: bakedEnv,
      });
    if (refusal) {
      log.error("loadtest-guard", { msg: "refusing every request", why: refusal });
      return new Response("This deployment is not serving here.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    // #3310: the load test Worker lives on between runs holding none of its secrets,
    // and answers nothing until a run has put all three. JSON, so the preflight's own
    // read of /api/smoke/version can name the missing ones rather than a bare 503. No
    // log line: the Worker is public, so a line per request is volume any caller
    // controls (L498), and the answer already says it. A cron tick logs instead.
    const idle = loadtestIdle({ loadtest, bindings: env as unknown as Record<string, unknown>, baked: bakedEnv, pathname: safePathname(request.url) });
    if (idle) return Response.json(loadtestIdleBody(idle), { status: 503 });
    // #3693: a lane the serving version sent over its binding to itself can land on a
    // gradual deploy's canary, which must run no lane (#3095). It is refused here, before
    // the app, with the answer that tells the sender to run it in process. No log line:
    // the mark is a header anybody can send, and the sender logs the fallback.
    const standbyRefusal = placedLaneStandbyRefusal(request, env.SLATE_CRON_STANDBY);
    if (standbyRefusal) return standbyRefusal;
    // #3543: an internal MCP path is reachable only through its gateway entrypoint's
    // in process request, never from the internet, so a public request for one gets
    // the same 404 an unknown path gets. And no public request reaches the app
    // carrying the carrier's headers (the lead token, the gateway secret): they are
    // stripped here, so the internal route's own secret check is a second, independent
    // wall rather than the only one (L345).
    if (isInternalMcpPath(request.url)) return internalMcpRefusal();
    request = stripCarrierHeaders(request);
    return httpsRedirect(request) ?? app.fetch(request, env, ctx, { loadtest, enteredAtMs });
  },

  async scheduled(
    controller: { cron: string },
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Before any lane runs (#2335). The cron lanes are what actually paged the real
    // alerts channel about a synthetic roster, so a guard on `fetch` alone would
    // have missed the incident it exists for. No path here: a tick is not a request,
    // and nothing about it is diagnostic.
    const credentials = loadtestEntryRefusal({
      loadtest: env.SLATE_LOADTEST === "true",
      pathname: undefined,
      bindings: env as unknown as Record<string, unknown>,
      baked: bakedEnv,
    });
    if (credentials) {
      log.error("loadtest-guard", { msg: "refusing every lane", why: credentials });
      return;
    }
    // #3310: an idle load test Worker runs no lane. One line per tick, so a
    // `wrangler tail` between runs shows Cloudflare still delivering the crons, which
    // is the whole reason the Worker is kept.
    const idle = loadtestIdle({ loadtest: env.SLATE_LOADTEST === "true", bindings: env as unknown as Record<string, unknown>, baked: bakedEnv });
    if (idle) {
      log.info("loadtest-idle", { msg: "idle between runs, so no lane ran", cron: controller.cron, missing: idle.join(",") });
      return;
    }
    // #3095: a canary of a gradual deploy runs no lane. Two versions serve during the
    // split and Cloudflare does not document which one a tick is handed to, so the
    // canary stands down and only the version that was already serving runs lanes.
    // Before the lanes are even resolved, so nothing below can reach a route.
    const standby = cronStandby(env.SLATE_CRON_STANDBY);
    if (standby.standby) {
      const fields = { cron: controller.cron, value: String(env.SLATE_CRON_STANDBY) };
      if (standby.why === "unreadable") {
        log.error("cron", { msg: "SLATE_CRON_STANDBY is unreadable, so this version runs no lane", ...fields });
      } else {
        log.info("cron", { msg: "canary in cron standby, so this tick ran no lane; the serving version runs the next one", ...fields });
      }
      return;
    }
    const scheduledPaths = routesForCron(controller.cron);
    if (scheduledPaths.length === 0) {
      log.error("cron", { msg: "no route for cron expression", cron: controller.cron });
      return;
    }
    // A load test deployment inherits every cron trigger on purpose (the run
    // measures recompute and the outbox UNDER the booking load) and must not run
    // the lanes that reach outside its isolated branch. An unrecognised name in
    // the setting refuses the WHOLE tick rather than letting the lane somebody
    // meant to hold back run unannounced (worker/lanes-disabled.ts).
    const decision = laneDecision(scheduledPaths, env.SLATE_LANES_DISABLED);
    if (decision.unknown.length > 0) {
      log.error("cron", {
        msg: "SLATE_LANES_DISABLED names no such lane, so no lane ran",
        cron: controller.cron,
        unknown: decision.unknown.join(","),
      });
      return;
    }
    if (decision.skipped.length > 0) {
      log.info("cron", {
        msg: "lanes held back by SLATE_LANES_DISABLED",
        cron: controller.cron,
        skipped: decision.skipped.join(","),
      });
    }
    const paths = decision.run;
    if (paths.length === 0) return;
    // Fire each lane as an independent request so a co-scheduled lane's failure
    // (or slow run) can't abort the others; each route guards itself with its
    // own lock. settle all before returning so cron tail captures every result
    // (`runLane` never throws, so Promise.all waits for every lane).
    //
    // #1245: each lane is timed individually, because the lanes on one expression
    // shared this invocation's budget (until #3693 placed them, and still do for a lane
    // that falls back) and nothing recorded what each of them cost.
    // When that budget tripled in four days the only symptom was a page from the
    // recompute lane, which is the lane that noticed rather than necessarily the
    // one that spent it. A single timer around the Promise.all below would
    // attribute nothing, so the measurement brackets each lane's own request.
    //
    // #3133: a lane that throws or answers non-ok is logged with its cause and
    // reported to the app, which pages `cron_lane_failed:<lane>` (worker/lane-run.ts).
    // #3139: one id per tick, sent to every lane as a header and stamped on every
    // line the dispatcher writes for the tick. No lane reads the header yet, so the
    // lanes' own lines do not carry it.
    const tick: LaneTick = {
      tickId: mintTickId(() => crypto.randomUUID()),
      cronSecret: env.CRON_SECRET ?? "",
    };
    // #3693: each lane goes over the Worker's binding to itself, so it runs as a placed
    // fetch near the database; failure reports and the budget check stay in process.
    const self = resolveSelfBinding(env[SELF_BINDING]);
    const deps: LaneRunDeps = {
      fetch: (request) => app.fetch(request, env, ctx),
      placed: { ...self, origin: placedLaneOrigin(env.SLATE_LOADTEST === "true") },
      now: () => performance.now(),
      log,
    };
    // #4189: one public request to the Worker's own custom domain beside the lanes, so the
    // timings line shows where a public request from this tick was placed next to where the
    // SELF lanes ran. Started only after every lane is dispatched, never thrown, and outside
    // the lane time the budget line reads (worker/public-probe.ts).
    const dispatched = dispatchWithProbe(
      () => Promise.all(paths.map((path) => runLane(path, tick, deps))),
      () =>
        startPublicProbe(
          { loadtest: env.SLATE_LOADTEST === "true", tickId: tick.tickId },
          // deadline-ok: startPublicProbe aborts it at PUBLIC_PROBE_TIMEOUT_MS (worker/public-probe.ts)
          { fetch: (request, init) => fetch(request, init), now: () => performance.now() },
        ),
      () => performance.now(),
    );
    const { lanes: outcomes, lanesMs, probe } = await dispatched.done;
    const runs: LaneRun[] = outcomes.map((o) => o.run);
    const totalMs = lanesMs;
    log.info("cron", {
      msg: "lane timings",
      cron: controller.cron,
      tick: tick.tickId,
      ...laneTimingFields(runs, totalMs),
      ...publicProbeFields(probe),
    });
    const failures = outcomes.flatMap((o) => (o.failure ? [o.failure] : []));
    if (failures.length > 0) await reportLaneFailures(failures, tick, deps);
    // #3141: a slow tick's wall time is logged, and the hourly tick asks the app to read the
    // real cron CPU from Cloudflare's analytics (worker/lane-run.ts).
    await recordCronBudget(controller.cron, totalMs, tick, deps);
  },
};

export default worker;

/**
 * The load test stand downs every named entrypoint applies before it forwards anything
 * to the app, in one place so a new entrypoint cannot apply one and forget the other:
 * the credential refusal (#2335: a load test build holding production's credentials
 * must not write to production) and the idle one (#3310: an idle load test Worker
 * holds no secrets between runs, so it forwards nothing, the same as its lanes).
 * Null when it may go on; each refusal is logged with what it stood down.
 */
function entrypointStandDown(env: Env, what: string): "refused" | "idle" | null {
  const loadtest = env.SLATE_LOADTEST === "true";
  const bindings = env as unknown as Record<string, unknown>;
  const refusal = loadtestEntryRefusal({ loadtest, pathname: undefined, bindings, baked: bakedEnv });
  if (refusal) {
    log.error("loadtest-guard", { msg: `refusing the ${what}`, why: refusal });
    return "refused";
  }
  const idle = loadtestIdle({ loadtest, bindings, baked: bakedEnv });
  if (idle) {
    log.info("loadtest-idle", { msg: `idle between runs, so the ${what} was not forwarded`, missing: idle.join(",") });
    return "idle";
  }
  return null;
}

/**
 * The log shipping receipt (#3182). The tail worker (`worker/log-tail/index.ts`)
 * calls `shipped()` over its `SLATE` service binding each time Better Stack accepted
 * a cron tick's records, and this stamps the `log-shipping` heartbeat the lane
 * watchdog pages on. A named entrypoint is reachable only through a binding in this
 * account, never over HTTP, so the receipt needs no key of its own.
 *
 * Defined after the default export so the fetch handler stays the first `fetch:` in
 * this file, which scripts/test-https-redirect-wiring.ts reads the redirect order from.
 *
 * The same credential refusal the cron lanes get comes first (#2335): a load test
 * build holding production's credentials must not write to production's heartbeats.
 */
export class LogShippingReceipt extends WorkerEntrypoint<Env> {
  async shipped(): Promise<{ stamped: boolean }> {
    if (entrypointStandDown(this.env, "log shipping receipt")) return { stamped: false };
    return forwardReceipt({
      fetch: (request) => app.fetch(request, this.env, this.ctx),
      cronSecret: this.env.CRON_SECRET ?? "",
      log,
    });
  }
}

/**
 * Marcia's booking gateway (#3543, plan locked decisions 1, 9 and 15). Bound by the
 * booking MCP Worker alone (`wrangler.mcp-booking.jsonc`), and holding exactly one
 * method, because a service binding to a named entrypoint exposes every public method
 * of its class (#3544 pins that no other entrypoint has a `booking` method and that
 * this one has nothing else).
 *
 * WHO MAY CALL: the booking MCP Worker, through its binding; a named entrypoint is
 * never reachable over HTTP. WHOSE DATA: the one lead Marcia's signed token names,
 * verified by the internal route with the key only this Worker holds.
 *
 * The load test refusals come first, as on every other way in (#2335, #3310).
 */
export class McpBookingGateway extends WorkerEntrypoint<Env> {
  /** `admit` is the booking MCP Worker's limit check, an RPC stub called only for a verified token (#3879). */
  async booking(signedToken: string, operation: string, args: unknown, admit?: unknown): Promise<GatewayAnswer> {
    if (entrypointStandDown(this.env, "booking gateway")) {
      return { status: 503, body: { ok: false, code: "unavailable", class: "unexpected", message: "This deployment is not serving Marcia." } };
    }
    const slot = (v: unknown) => (typeof v === "string" ? v : "");
    return forwardBookingCall(
      {
        fetch: (request) => app.fetch(request, this.env, this.ctx),
        gatewaySecret: slot(this.env.MCP_BOOKING_GATEWAY_SECRET),
        tokenKeySlots: MARCIA_TOKEN_KEY_ENV.map((name) => slot(this.env[name])),
        nowMs: () => Date.now(),
        log,
      },
      signedToken,
      operation,
      args,
      admit,
    );
  }
}

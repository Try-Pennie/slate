/**
 * Custom Worker entry: wraps the OpenNext-generated handler so Cloudflare
 * cron triggers can drive the app's cron routes. scheduled() builds a
 * synthetic authorized Request and calls the SAME in-process fetch handler -
 * no network hop, no self-fetch restriction, and isAuthorizedCron keeps
 * guarding the HTTP surface unchanged.
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
import { laneDecision } from "./lanes-disabled";
import { loadtestServingProductionHost } from "@/lib/loadtest-guard";
import { loadtestEntryRefusal, loadtestIdle, loadtestIdleBody } from "@/lib/loadtest-secrets";
import { httpsRedirect } from "@/lib/http/https-redirect";
import { countedApp } from "./app-invocations";
import { log } from "@/lib/log";
import { laneTimingFields, type LaneRun } from "@/lib/monitor/lane-timing";
import {
  mintTickId,
  recordCronBudget,
  reportLaneFailures,
  runLane,
  type LaneRunDeps,
  type LaneTick,
} from "./lane-run";

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
    // SHARE this invocation's budget and nothing recorded what each of them cost.
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
    const deps: LaneRunDeps = {
      fetch: (request) => app.fetch(request, env, ctx),
      now: () => performance.now(),
      log,
    };
    const startedAt = performance.now();
    const outcomes = await Promise.all(paths.map((path) => runLane(path, tick, deps)));
    const runs: LaneRun[] = outcomes.map((o) => o.run);
    const totalMs = performance.now() - startedAt;
    log.info("cron", {
      msg: "lane timings",
      cron: controller.cron,
      tick: tick.tickId,
      ...laneTimingFields(runs, totalMs),
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
    const refusal = loadtestEntryRefusal({
      loadtest: this.env.SLATE_LOADTEST === "true",
      pathname: undefined,
      bindings: this.env as unknown as Record<string, unknown>,
      baked: bakedEnv,
    });
    if (refusal) {
      log.error("loadtest-guard", { msg: "refusing the log shipping receipt", why: refusal });
      return { stamped: false };
    }
    // #3310: an idle load test Worker holds no secrets between runs, so it forwards
    // nothing to the app, the same as its lanes.
    const idle = loadtestIdle({ loadtest: this.env.SLATE_LOADTEST === "true", bindings: this.env as unknown as Record<string, unknown>, baked: bakedEnv });
    if (idle) {
      log.info("loadtest-idle", { msg: "idle between runs, so the log shipping receipt was not forwarded", missing: idle.join(",") });
      return { stamped: false };
    }
    return forwardReceipt({
      fetch: (request) => app.fetch(request, this.env, this.ctx),
      cronSecret: this.env.CRON_SECRET ?? "",
      log,
    });
  }
}

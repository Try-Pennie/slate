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
import { routesForCron } from "./cron-routes";
import { httpsRedirect } from "@/lib/http/https-redirect";
import { log } from "@/lib/log";
import { laneTimingFields, type LaneRun } from "@/lib/monitor/lane-timing";

// The shared per-address burst counter (#1536). A Durable Object is the only
// primitive that can hold ONE count across isolates, which is what the native
// rate limiter cannot do and why a parallel burst sailed through its ceiling.
export { BurstLimiter } from "./burst-limiter";

// Durable Object classes the generated worker exports must be re-exported
// from the entry wrangler actually loads.
export {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
  // @ts-expect-error - generated at build time
} from "../.open-next/worker.js";

interface Env {
  CRON_SECRET?: string;
  [key: string]: unknown;
}

const worker = {
  // #1024: bounce plaintext to https BEFORE the app sees the request, so a lead
  // following an http:// link never transmits name/email/phone in the clear.
  // This lives here rather than in Cloudflare config because the hostname is a
  // Workers Custom Domain, which makes this Worker the origin and leaves zone
  // Redirect Rules out of the path entirely (see @/lib/http/https-redirect).
  // Returns null for anything not positively established as plaintext, so the
  // common secure case is untouched and can never loop.
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    httpsRedirect(request) ?? handler.fetch(request, env, ctx),

  async scheduled(
    controller: { cron: string },
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const paths = routesForCron(controller.cron);
    if (paths.length === 0) {
      log.error("cron", { msg: "no route for cron expression", cron: controller.cron });
      return;
    }
    // Fire each lane as an independent request so a co-scheduled lane's failure
    // (or slow run) can't abort the others; each route guards itself with its
    // own lock. settle all before returning so cron tail captures every result.
    //
    // #1245: each lane is timed individually, because the lanes on one expression
    // SHARE this invocation's budget and nothing recorded what each of them cost.
    // When that budget tripled in four days the only symptom was a page from the
    // recompute lane, which is the lane that noticed rather than necessarily the
    // one that spent it. A single timer around the allSettled below would
    // attribute nothing, so the measurement brackets each lane's own request.
    const startedAt = performance.now();
    const runs: LaneRun[] = [];
    await Promise.allSettled(
      paths.map(async (path) => {
        const request = new Request(`https://slate.trypennie.app${path}`, {
          headers: { authorization: `Bearer ${env.CRON_SECRET ?? ""}` },
        });
        const laneStartedAt = performance.now();
        let ok = false;
        try {
          const res: Response = await handler.fetch(request, env, ctx);
          ok = res.ok;
          // Surface failures in the Workers dashboard/tail; cron has no retries.
          if (!res.ok) {
            log.error("cron", {
              msg: "lane returned a non-ok response",
              path,
              status: res.status,
              body: (await res.text()).slice(0, 300),
            });
          }
        } finally {
          // In `finally` so a thrown lane is still measured and still reported as
          // failed: a lane that dies is usually the FAST one, and leaving it out
          // would quietly shrink the record on exactly the tick worth reading.
          runs.push({ path, ms: performance.now() - laneStartedAt, ok });
        }
      }),
    );
    log.info("cron", {
      msg: "lane timings",
      cron: controller.cron,
      ...laneTimingFields(runs, performance.now() - startedAt),
    });
  },
};

export default worker;

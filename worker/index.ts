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
    await Promise.allSettled(
      paths.map(async (path) => {
        const request = new Request(`https://slate.trypennie.app${path}`, {
          headers: { authorization: `Bearer ${env.CRON_SECRET ?? ""}` },
        });
        const res: Response = await handler.fetch(request, env, ctx);
        // Surface failures in the Workers dashboard/tail; cron has no retries.
        if (!res.ok) {
          log.error("cron", {
            msg: "lane returned a non-ok response",
            path,
            status: res.status,
            body: (await res.text()).slice(0, 300),
          });
        }
      }),
    );
  },
};

export default worker;

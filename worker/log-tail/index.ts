/**
 * The tail worker that ships Slate's logs to Better Stack (#3105, #3138).
 *
 * Cloudflare keeps a Worker's logs for 7 days. This Worker is named in Slate's
 * `tail_consumers` (wrangler.jsonc), so Cloudflare invokes it after every Slate
 * invocation with that invocation's console lines, uncaught exceptions and
 * outcome. It redacts them (`src/lib/log-shipping/records.ts`) and forwards them
 * to a Better Stack HTTP source, whose retention is whatever plan Slate is on.
 *
 * Its own configuration is `wrangler.log-tail.jsonc`, deployed by hand with
 * `npx wrangler deploy -c wrangler.log-tail.jsonc`; DEPLOY.md has the order, which
 * matters: this Worker and its secret first, Slate's reference to it second.
 *
 * It can never affect a Slate request: it runs in its own invocation, after
 * Slate's has finished. It still never throws, because a throw would lose the
 * one thing worth knowing when shipping fails, which is how much was lost. A
 * missing token, a refused POST or a log storm past the per invocation budget is
 * counted and written to THIS Worker's own Cloudflare logs (observability is on in
 * its config), where `tag=log-tail` finds it.
 *
 * Relative imports only: this entry is bundled from its own config, and the
 * modules it reaches import nothing outside `src/lib/log-shipping` and the shared
 * scrubber.
 */
import { recordsFromTraces, type TraceItemLike } from "../../src/lib/log-shipping/records.ts";
import { droppedCount, shipRecords } from "../../src/lib/log-shipping/ship.ts";
import { log } from "../../src/lib/log.ts";

interface Env {
  /** The Better Stack source token. A secret on THIS Worker only; Slate holds none. */
  BETTERSTACK_SOURCE_TOKEN?: string;
  /** The source's ingesting host, a bare hostname (a committed var). */
  BETTERSTACK_INGEST_HOST?: string;
}

const tailWorker = {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    try {
      const records = recordsFromTraces(events as unknown as TraceItemLike[]);
      const outcome = await shipRecords(
        records,
        { token: env.BETTERSTACK_SOURCE_TOKEN, host: env.BETTERSTACK_INGEST_HOST },
        fetch,
      );
      const dropped = droppedCount(outcome);
      if (dropped > 0) {
        log.warn("log-tail", {
          msg: "records did not reach Better Stack",
          sent: outcome.sent,
          dropped,
          ...Object.fromEntries(Object.entries(outcome.dropped).map(([k, v]) => [`dropped_${k.replace(/-/g, "_")}`, v])),
          refused_status: outcome.refusedStatus,
        });
      }
    } catch (err) {
      // Nothing above is meant to throw; this is the backstop that keeps a fault in
      // the redaction from turning into a silent loss with no count at all.
      log.error("log-tail", { msg: "tail handler failed, this invocation's records were lost", traces: events.length }, err);
    }
  },
};

export default tailWorker;

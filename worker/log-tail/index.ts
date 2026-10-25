/**
 * The tail worker that ships Slate's logs to Better Stack (#3105, #3138).
 *
 * Cloudflare keeps a Worker's logs for 7 days. This Worker is named in Slate's
 * `tail_consumers` (wrangler.jsonc), so Cloudflare invokes it after every Slate
 * invocation with that invocation's console lines, uncaught exceptions and
 * outcome. It redacts them (`src/lib/log-shipping/records.ts`) and forwards them
 * to a Better Stack HTTP source, whose retention is whatever plan Slate is on.
 *
 * Its own configuration is `wrangler.log-tail.jsonc`, deployed by CI on every
 * production deploy (`wrangler deploy -c wrangler.log-tail.jsonc`), LAST, once Slate
 * is promoted and healthy (scripts/deploy-gradual.ts, #3165); DEPLOY.md has the order, which
 * matters and runs BOTH ways now. Slate names this Worker in `tail_consumers`, so
 * this Worker had to exist first (done 2026-10-03). This Worker binds Slate's
 * `LogShippingReceipt` entrypoint (#3182), so a Slate that exports it must be live
 * before this Worker is deployed with the binding: Slate first, this Worker second,
 * for the change that adds the entrypoint and for any that renames or removes it.
 *
 * It can never affect a Slate request: it runs in its own invocation, after
 * Slate's has finished. It still never throws, because a throw would lose the
 * one thing worth knowing when shipping fails, which is how much was lost. A
 * missing token, a refused POST or a log storm past the per invocation budget is
 * counted and written to THIS Worker's own Cloudflare logs (observability is on in
 * its config), where `tag=log-tail` finds it.
 *
 * Each time Better Stack takes every record of a cron tick, it hands Slate a
 * receipt over the `SLATE` service binding (#3182), and the lane watchdog pages when
 * those stop: the drop counts above can only say what a RUNNING worker lost, and a
 * worker that is not running, or whose token was revoked, must not read as a quiet
 * day. `src/lib/log-shipping/receipt.ts` has the design.
 *
 * Relative imports only: this entry is bundled from its own config, and the
 * modules it reaches import nothing outside `src/lib/log-shipping` and the shared
 * scrubber.
 */
import { recordsFromTraces, type TraceItemLike } from "../../src/lib/log-shipping/records.ts";
import { droppedCount, shipRecords } from "../../src/lib/log-shipping/ship.ts";
import { confirmReceipt, shipmentConfirmsDelivery, type ReceiptBinding } from "../../src/lib/log-shipping/receipt.ts";
import { log } from "../../src/lib/log.ts";

interface Env {
  /** The Better Stack source token. A secret on THIS Worker only; Slate holds none. */
  BETTERSTACK_SOURCE_TOKEN?: string;
  /** The source's ingesting host, a bare hostname (a committed var). */
  BETTERSTACK_INGEST_HOST?: string;
  /** Slate's `LogShippingReceipt` entrypoint, over a service binding (#3182). Each
   *  receipt stamps the heartbeat the lane watchdog pages on when shipping stops. */
  SLATE?: ReceiptBinding;
}

const tailWorker = {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    try {
      const records = recordsFromTraces(events as unknown as TraceItemLike[]);
      const outcome = await shipRecords(
        records,
        { token: env.BETTERSTACK_SOURCE_TOKEN, host: env.BETTERSTACK_INGEST_HOST },
        // deadline-ok: shipRecords gives every POST its own AbortSignal.timeout
        fetch,
      );
      const dropped = droppedCount(outcome);
      if (dropped > 0) {
        log.warn("log-tail", {
          msg: "records did not reach Better Stack",
          sent: outcome.sent,
          dropped,
          ...Object.fromEntries(Object.entries(outcome.dropped).map(([k, v]) => [`dropped_${k.replace(/-/g, "_")}`, v])),
          refused_statuses: outcome.refusedStatuses?.join(","),
        });
      }
      // #3182: proof the pipe works, handed to Slate only when Better Stack took
      // every record of a cron tick. Its absence is what pages, so a receipt that
      // did not land is logged here and nothing more.
      if (shipmentConfirmsDelivery(records, outcome)) {
        const receipt = await confirmReceipt(env.SLATE);
        if (receipt !== "stamped") log.warn("log-tail", { msg: "log shipping receipt did not land", receipt });
      }
    } catch (err) {
      // Nothing above is meant to throw; this is the backstop that keeps a fault in
      // the redaction from turning into a silent loss with no count at all.
      log.error("log-tail", { msg: "tail handler failed, this invocation's records were lost", traces: events.length }, err);
    }
  },
};

export default tailWorker;

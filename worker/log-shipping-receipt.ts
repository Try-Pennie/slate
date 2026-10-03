/**
 * Slate's half of the log shipping receipt (#3182).
 *
 * The tail worker calls the `LogShippingReceipt` entrypoint (`worker/index.ts`) over
 * a service binding each time Better Stack accepted a cron tick's records
 * (`src/lib/log-shipping/receipt.ts` has the why). A named entrypoint is reachable
 * only through a binding in this account, never from the internet, which is what
 * lets the receipt carry no key of its own: nobody outside can stamp it and keep a
 * broken pipe looking alive.
 *
 * The stamp itself is written by an app route, reached on the SAME in process fetch
 * the cron lanes use and authorised by the same cron bearer, for the reason
 * `worker/lane-run.ts` gives for its failure route: this entry is bundled apart from
 * the app, so writing here would be a second Supabase client reading environment the
 * app's handler fills in on its first request.
 *
 * Lifted out of `worker/index.ts` because that file imports the generated
 * `.open-next/worker.js` and so cannot be loaded by a test; this takes its fetch and
 * logger as arguments and is driven by `scripts/test-log-shipping-receipt.ts`.
 */
import { CRON_ORIGIN } from "./lane-run";
import type { LogFields } from "@/lib/log";

/** The app route that stamps the `log-shipping` heartbeat. */
export const LOG_SHIPPING_RECEIPT_PATH = "/api/cron/log-shipping-receipt";

export interface ReceiptForwardDeps {
  fetch(request: Request): Promise<Response>;
  cronSecret: string;
  log: { error(tag: string, fields: LogFields, err?: unknown): void };
}

/** Forward one receipt to the stamping route. Never throws: the answer is whether it
 *  stamped, and the tail worker logs a receipt that did not land. */
export async function forwardReceipt(deps: ReceiptForwardDeps): Promise<{ stamped: boolean }> {
  if (!deps.cronSecret) {
    // The route would refuse it anyway. Said here, once, rather than as a 401.
    deps.log.error("log-shipping", { msg: "no CRON_SECRET on this deployment, so the receipt cannot be stamped" });
    return { stamped: false };
  }
  try {
    const res = await deps.fetch(
      new Request(`${CRON_ORIGIN}${LOG_SHIPPING_RECEIPT_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.cronSecret}` },
      }),
    );
    if (!res.ok) {
      deps.log.error("log-shipping", { msg: "receipt route refused the stamp", status: res.status });
      return { stamped: false };
    }
    return { stamped: true };
  } catch (err) {
    deps.log.error("log-shipping", { msg: "receipt route threw" }, err);
    return { stamped: false };
  }
}

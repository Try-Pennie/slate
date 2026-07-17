import { after } from "next/server";
import { log } from "@/lib/log";

/**
 * Schedule best-effort background work that must OUTLIVE the response.
 *
 * On Cloudflare/OpenNext a promise still pending when the handler's Response
 * resolves is not guaranteed to run: the isolate can be torn down and the work
 * silently dropped (#191/#503). Next's `after()` (which OpenNext maps to
 * `ctx.waitUntil`) keeps the isolate alive until the callback settles, so the
 * side effect actually lands.
 *
 * Two hazards this helper handles so call sites don't each have to:
 *
 *   1. `after()` THROWS synchronously when there is no request scope
 *      (next/dist/server/after/after.js). The sites this replaces are only ever
 *      reached inside a request in production, but a bare-node script or a
 *      future caller could invoke the real code path outside one. Rather than
 *      turn a today-safe silent drop into a crash, we catch that throw and fall
 *      back to a plain float, exactly the old `void fn().catch()` behavior. The
 *      work is best-effort and cron-backstopped, so degrading is correct.
 *   2. A failing background job used to vanish into `.catch(() => {})`. Here it
 *      is logged (fail-loud) at `warn` (not error) because every caller
 *      has a cron backstop that self-heals a miss, so a single failure is not
 *      page-worthy. We never rethrow: background failure must not reach the
 *      response.
 *
 * `context` is a short label for the log line (e.g. "ooo-recompute").
 */
export function afterResponse(
  context: string,
  work: () => Promise<unknown>,
): void {
  const run = () =>
    Promise.resolve()
      .then(work)
      .catch((err) =>
        log.warn("after-response", {
          msg: "background work failed",
          context,
          error: String(err),
        }),
      );
  try {
    after(run);
  } catch {
    // No request scope (or no waitUntil): degrade to the old safe float instead
    // of crashing the caller. The cron backstop still reconverges the work.
    void run();
  }
}

/**
 * The webhook-send scheduler (#884) the user-facing booking paths inject into
 * their deps so `emitWebhook`'s outbound POST lands post-response under
 * waitUntil, off the confirm/cancel/reschedule critical path. A dropped send is
 * still recoverable: emitWebhook writes the durable pending row synchronously and
 * the retry sweep redelivers it. The cron drains inject nothing and send inline,
 * so their bounded fan-out keeps capping simultaneous connections.
 *
 * Lives here (not in orchestration) so the node-tested domain code never imports
 * `next/server`: the capability is passed in from this Next-runtime layer.
 */
export function deferWebhookSend(work: () => Promise<void>): void {
  afterResponse("booking-webhook", work);
}

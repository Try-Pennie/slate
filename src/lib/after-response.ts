import { after } from "next/server";
import { log } from "@/lib/log";
import { isLoadtest } from "@/lib/loadtest-guard";
import { outsideCallBudget } from "@/lib/call-budget";

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
  const run = () => {
    // Under the load test flag ONLY, exactly like the confirm profile and the
    // Google stub, each deferred job reports its own span (#2353). Run
    // 34980777198 measured warm confirms spending about 3.5 seconds AFTER the
    // response had gone, on a path whose CPU the request bar still counts; that
    // was ONE number, inferred by subtracting the confirm's log line from the
    // invocation's wall, so nothing could say whether it was the webhook send or
    // the tally beside it.
    //
    // WALL, not CPU, and the distinction is not ours to remove: `Date.now()` in a
    // Worker returns the time of the LAST I/O and does not advance during
    // execution, and no other timer is provided (Cloudflare's security model
    // page, and the Workers tracing limitation that a non I/O span reports 0ms).
    // So no in process measurement can apportion CPU by stage, here or anywhere,
    // and anything drawn from this has to say which it is.
    const profiling = isLoadtest();
    // Read once and only when profiling: with the flag unset no clock is read at
    // all, so a production confirm pays nothing rather than paying a little.
    const startedAt = profiling ? Date.now() : 0;
    const report = (failed: boolean) => {
      if (!profiling) return;
      log.info("after-response-profile", {
        msg: "deferred work finished",
        context,
        // Never negative: the clock can only fail to advance, never go back, and
        // a negative beside real numbers is something a reader has to decode.
        ms: Math.max(0, Date.now() - startedAt),
        // Kept apart from the warning below, which says a job FAILED and is read
        // by somebody deciding whether to act. This says what it cost, and a
        // failed job is exactly the one worth profiling, so it is recorded too
        // rather than being reported as free (L515).
        failed,
      });
    };
    return Promise.resolve()
      // #3102: outside any call budget. The work runs after the lead has their
      // answer, and a confirm's budget may be spent by then, which would fail
      // every Supabase and Google call in it at once for no reason of its own.
      .then(() => outsideCallBudget(work))
      .then(
        () => report(false),
        (err) => {
          report(true);
          log.warn("after-response", {
            msg: "background work failed",
            context,
            error: String(err),
          });
        },
      );
  };
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

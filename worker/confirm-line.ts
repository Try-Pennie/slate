/**
 * The confirm line shared across isolates (#3325): one object per line group, a
 * line per instant inside it.
 *
 * Deliberately a shell, like `burst-limiter.ts`: every decision lives in
 * `@/lib/booking/confirm-line-object`, which the node tests drive. What is left here
 * is the request envelope, the real clock and timers, and the log a traced call is
 * written to, which `scripts/test-confirm-line-binding.ts` drives through this class. Nothing is written to storage: the line is memory
 * only, so no input gate closes and held polls interleave at every await.
 */
import { makeConfirmLineHost, CONFIRM_LINE_TRACE_TAG, TRACED_CALL_MSG } from "@/lib/booking/confirm-line-object";
import { log } from "@/lib/log";

const realTimer = (ms: number, fire: () => void): (() => void) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

export class ConfirmLine {
  private readonly host = makeConfirmLineHost({
    now: () => Date.now(),
    timer: realTimer,
    leaseTimer: realTimer,
    newId: () => crypto.randomUUID(),
    // #3354: a traced call (sent by the load test's client only) is logged, so the
    // run can join this object's side of a confirm to the confirm's own line.
    onTrace: (call) => log.info(CONFIRM_LINE_TRACE_TAG, { msg: TRACED_CALL_MSG, ...call }),
  });

  async fetch(request: Request): Promise<Response> {
    let message: unknown = null;
    try {
      message = await request.json();
    } catch {
      // An unreadable body is answered as a malformed message by the host, by name.
      message = null;
    }
    return new Response(await this.host.handle(message), { headers: { "content-type": "application/json" } });
  }
}

/**
 * The confirm line shared across isolates (#3325): one object per line group, a
 * line per instant inside it.
 *
 * Deliberately a shell, like `burst-limiter.ts`: every decision lives in
 * `@/lib/booking/confirm-line-object`, which the node tests drive, because `worker/`
 * is reachable from neither test harness. What is left here is the request envelope
 * and the real clock and timers. Nothing is written to storage: the line is memory
 * only, so no input gate closes and held polls interleave at every await.
 */
import { makeConfirmLineHost } from "@/lib/booking/confirm-line-object";

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

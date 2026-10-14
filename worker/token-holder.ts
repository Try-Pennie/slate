/**
 * The shared Google token holder (#3512). Deliberately a shell, like `burst-limiter.ts` and
 * `confirm-line.ts`: every decision lives in `@/lib/google/token-holder-object`, which the
 * node suite drives. What is left here is the request envelope and the real clock and
 * timer, and `scripts/test-token-holder-worker.ts` drives this class itself.
 *
 * Tokens are held in this instance's MEMORY only. Nothing here touches `ctx.storage`, by
 * design: a bearer token is never written anywhere at rest, and the object loses them when
 * it is restarted, which costs only the mints the holder exists to save. The reasoning,
 * and why the trust boundary does not widen, is in the object's module.
 *
 * It logs nothing. Every answer can carry a token, so nothing an answer holds is ever
 * written to a log; the app's side logs what it was told (`dwd.ts`).
 */
import { makeTokenHolderObject } from "@/lib/google/token-holder-object";

const realTimer = (ms: number, fire: () => void): (() => void) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

export class TokenHolder {
  private readonly object = makeTokenHolderObject({ now: () => Date.now(), timer: realTimer });

  async fetch(request: Request): Promise<Response> {
    let message: unknown = null;
    try {
      message = await request.json();
    } catch {
      // An unreadable body is answered as a malformed message by the object, by name.
      message = null;
    }
    return new Response(JSON.stringify(this.object.handle(message)), { headers: { "content-type": "application/json" } });
  }
}

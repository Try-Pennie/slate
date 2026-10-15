/**
 * The app's side of the shared Google token holder (#3512): one bounded read and one
 * bounded put, over the `TOKEN_HOLDER` binding. Pure apart from what is handed in (the
 * namespace, the timer, the clock), so `scripts/test-token-holder-client.ts` drives every
 * outcome with no network and no real time. What the object itself does is
 * `token-holder-object.ts`; where the tiers meet is `dwd.ts`.
 */
import type { ScheduleTimer } from "../read-within-deadline.ts";
import { OBJECT_LOCATION_HINT } from "../object-placement.ts";
import {
  TOKEN_HOLDER_INSTANCE,
  TOKEN_HOLDER_PROTOCOL,
  TOKEN_USABLE_MARGIN_MS,
  type HolderAnswer,
} from "./token-holder-object.ts";

/**
 * How long a token read on the lead's path waits for the holder before minting itself.
 *
 * 150ms, sized from the mint it replaces (#3680, read on #3298 and #3512): confirm path
 * mints ran a p50 of 170ms (2026-10-13 afternoon) to about 270ms (2026-10-14, midnight to
 * 4 AM ET), with a p90 near 500ms and a tail of seconds. So a holder that answers costs a
 * fraction of an ordinary mint and none of the tail, and a holder that does NOT answer
 * costs at most 150ms on top of the mint the caller then makes, less than one ordinary
 * mint, which is the bound a slow holder has to stay under. A warm call to a small object
 * Worker measured about 40ms (#3555), so 150ms leaves room for an ordinary wake.
 */
export const TOKEN_HOLDER_READ_MS = 150;
/** How long a read or a put OFF the lead's path (after the response) may wait. Nobody is
 *  waiting on it, but a hung call would still hold the invocation open. */
export const TOKEN_HOLDER_BACKGROUND_MS = 2_000;

/** What the binding looks like, as much of it as this client uses. */
export interface TokenHolderNamespace {
  idFromName(name: string): unknown;
  get(
    id: unknown,
    opts?: { locationHint?: string },
  ): { fetch(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> };
}

/** How a read ended. Only a hit carries a token; every other outcome means "mint". */
export type HolderRead =
  | { kind: "hit"; token: string; expMs: number; refresh: boolean }
  | { kind: "miss" }
  /** The holder answered a token with no usable time left, which is refused here too. */
  | { kind: "expired" }
  | { kind: "timeout"; waitedMs: number }
  | { kind: "error"; reason: string }
  /** No binding in this runtime: `next dev`, a script, or a broken deployment. */
  | { kind: "unbound" };

export type HolderReadKind = HolderRead["kind"];

export interface TokenHolderClient {
  /** Never rejects: a holder that cannot answer is named, and the caller mints. */
  read(key: string, waitMs: number): Promise<HolderRead>;
  /** Rejects when the holder did not take it, so a background job reports the failure. */
  put(key: string, token: string, expMs: number, waitMs?: number): Promise<"stored" | "kept">;
}

class HolderTimeout extends Error {}

function isAnswer(body: unknown): body is HolderAnswer {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  switch (b.kind) {
    case "hit":
      return typeof b.token === "string" && typeof b.expMs === "number" && Number.isFinite(b.expMs) && typeof b.refresh === "boolean";
    case "miss":
    case "stored":
    case "kept":
      return true;
    case "bad":
      return typeof b.reason === "string";
    default:
      return false;
  }
}

export function makeTokenHolderClient(deps: {
  namespace: TokenHolderNamespace | null;
  timer: ScheduleTimer;
  now: () => number;
}): TokenHolderClient {
  /** One message to the one instance, answered within `waitMs` or rejected. */
  async function send(message: Record<string, unknown>, waitMs: number): Promise<HolderAnswer> {
    const ns = deps.namespace;
    if (!ns) throw new Error("no TOKEN_HOLDER binding");
    const stub = ns.get(ns.idFromName(TOKEN_HOLDER_INSTANCE), { locationHint: OBJECT_LOCATION_HINT });
    let cancel: () => void = () => {};
    const expired = new Promise<never>((_, reject) => {
      cancel = deps.timer(waitMs, () => reject(new HolderTimeout()));
    });
    const call = (async () => {
      const res = await stub.fetch("https://token-holder/", {
        method: "POST",
        body: JSON.stringify({ v: TOKEN_HOLDER_PROTOCOL, ...message }),
        headers: { "content-type": "application/json" },
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      // Never the body itself in the message: an answer can carry a token.
      if (!isAnswer(body)) throw new Error(`the holder answered ${res.status} with something that is not the holder's answer`);
      return body;
    })();
    // swallow-ok: only the call that LOST the race to the deadline lands here; the race
    // below already reported it as a timeout, and an unobserved rejection would crash a
    // node process for an answer nobody is waiting on.
    call.catch(() => {});
    try {
      return await Promise.race([call, expired]);
    } finally {
      cancel();
    }
  }

  return {
    async read(key, waitMs) {
      if (!deps.namespace) return { kind: "unbound" };
      let answer: HolderAnswer;
      try {
        answer = await send({ op: "get", key }, waitMs);
      } catch (err) {
        if (err instanceof HolderTimeout) return { kind: "timeout", waitedMs: waitMs };
        return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
      }
      if (answer.kind === "miss") return { kind: "miss" };
      if (answer.kind === "bad") return { kind: "error", reason: `the holder refused the read: ${answer.reason}` };
      if (answer.kind !== "hit") return { kind: "error", reason: `the holder answered a read with ${answer.kind}` };
      // Judged here as well as in the object: a token the clocks disagree about is minted
      // fresh rather than handed to a call it might expire under.
      if (answer.expMs - deps.now() <= TOKEN_USABLE_MARGIN_MS) return { kind: "expired" };
      return { kind: "hit", token: answer.token, expMs: answer.expMs, refresh: answer.refresh };
    },

    async put(key, token, expMs, waitMs = TOKEN_HOLDER_BACKGROUND_MS) {
      let answer: HolderAnswer;
      try {
        answer = await send({ op: "put", key, token, expMs }, waitMs);
      } catch (err) {
        if (err instanceof HolderTimeout) throw new Error(`the holder did not take the token within ${waitMs}ms`);
        throw err;
      }
      if (answer.kind === "stored" || answer.kind === "kept") return answer.kind;
      throw new Error(answer.kind === "bad" ? `the holder refused the put: ${answer.reason}` : `the holder answered a put with ${answer.kind}`);
    },
  };
}

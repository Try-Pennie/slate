/**
 * The shared Google token holder (#3512): everything the object does, pure, so the node
 * suite drives it with an injected clock and timer (`scripts/test-token-holder-object.ts`).
 * The shell that hosts it is `worker/token-holder.ts`, served by its own small Worker
 * (`wrangler.token-holder.jsonc`) the way the confirm line and the burst limiter are.
 *
 * WHY IT EXISTS. Delegated tokens were cached per isolate only (`dwd.ts`), and overnight
 * almost every booking confirm and reschedule landed on an isolate holding no token for
 * its advisor, so it minted one on the lead's path: 40 confirms and 41 confirm path mints
 * from midnight to 4 AM ET on 2026-10-14. When Google's token endpoint stalled (3.8s,
 * 4.6s and an 8s timeout that night) the lead got a retryable error. One object holds each
 * advisor's token for every isolate, so a confirm reads it in milliseconds instead.
 *
 * WHAT IT DOES NOT DO. It never mints, so it never needs the service account key. The app
 * mints exactly as it always has and PUTS the token here; readers GET it. A token inside
 * `TOKEN_REFRESH_AHEAD_MS` of expiry is still served, and ONE reader at a time is told to
 * refresh it, which that reader does after its response, off the lead's path. A crowd of
 * readers therefore mints once, not once each, and a refresh that never lands frees its
 * claim after `TOKEN_REFRESH_CLAIM_MS` so the next reader is asked instead.
 *
 * MEMORY ONLY, never storage, and that is the security decision, not an economy. Tokens
 * are bearer credentials for an advisor's calendar; nothing here writes one to the
 * object's storage, so none outlives the process holding it and none is ever at rest
 * anywhere. The trust boundary does not widen: the object is reachable only through
 * Slate's own `TOKEN_HOLDER` binding (its Worker has no route, no workers.dev address and a
 * fetch handler that only refuses), and the Slate Worker that reaches it already holds the
 * key that can mint every one of these tokens and more. A refusal never echoes a token.
 *
 * Memory only also means memory can vanish: a deploy of the holder's Worker, a runtime
 * restart, or eviction. The platform hibernates an idle object after ten seconds unless a
 * timer is pending, and evicts one after 70 to 140 idle seconds unless a pending operation
 * (a timer counts, for up to 15 minutes from when it was set) holds it
 * (developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). So while
 * anything is held, ONE timer is kept armed (`TOKEN_HOLDER_KEEPALIVE_MS`), which sweeps
 * what has expired and re-arms; an empty holder lets it go. A holder that lost its memory
 * answers misses, and every caller then mints exactly as before and refills it. Nothing
 * correct ever rests on this object: it only decides whether a mint is needed.
 */
import type { ScheduleTimer } from "../read-within-deadline.ts";

/** The Worker binding the holder is reached through, and the class behind it. */
export const TOKEN_HOLDER_BINDING = "TOKEN_HOLDER";
export const TOKEN_HOLDER_CLASS = "TokenHolder";
/** The one instance every isolate asks. One object, not one per advisor: the keys are
 *  bounded by the roster (a few hundred at the design target of 200 advisors), each call
 *  is a map lookup, and one object kept warm costs one object's duration, where one per
 *  advisor would cost hundreds. */
export const TOKEN_HOLDER_INSTANCE = "google-delegated-tokens";
/** The message protocol's version; a message of any other is refused. */
export const TOKEN_HOLDER_PROTOCOL = 1;

/** A token with no more than this left is never served or stored: the same margin the
 *  per isolate cache keeps (`dwd.ts`), so a call started on it cannot outlive it. */
export const TOKEN_USABLE_MARGIN_MS = 60_000;
/** Inside this much of expiry a token is still served and one reader is asked to refresh
 *  it. Ten minutes: the sync lanes read every advisor at least every five, so a token is
 *  refreshed by a lane long before a lead could find it unusable. */
export const TOKEN_REFRESH_AHEAD_MS = 10 * 60_000;
/** How long one reader's refresh claim stands before the next reader is asked. A mint
 *  off the lead's path is held to the 8 second mint deadline, so a minute covers any
 *  refresh that is going to land and frees the claim soon after one that will not. */
export const TOKEN_REFRESH_CLAIM_MS = 60_000;
/** The keep alive sweep. Must stay under the 15 minutes a pending timer holds an object
 *  in memory; five minutes also drops expired tokens promptly. */
export const TOKEN_HOLDER_KEEPALIVE_MS = 5 * 60_000;
/** A ceiling on what is held, far above the roster, so a fault can never grow memory
 *  without bound. Past it the token soonest to expire makes room. */
export const TOKEN_HOLDER_MAX_HELD = 2_000;

const MAX_KEY_LENGTH = 512;
const MAX_TOKEN_LENGTH = 8_192;

export type HolderAnswer =
  | { kind: "hit"; token: string; expMs: number; refresh: boolean }
  | { kind: "miss" }
  | { kind: "stored" }
  | { kind: "kept" }
  | { kind: "bad"; reason: string };

export type HolderMessage =
  | { v: number; op: "get"; key: string }
  | { v: number; op: "put"; key: string; token: string; expMs: number };

interface Held {
  token: string;
  expMs: number;
  /** Until when the reader last asked to refresh this token holds the claim. */
  claimUntilMs: number;
}

export interface TokenHolderDeps {
  now: () => number;
  timer: ScheduleTimer;
}

/** Why a message is malformed, or null when it is a message this protocol speaks. */
function malformed(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "not a message";
  const m = message as Record<string, unknown>;
  if (m.v !== TOKEN_HOLDER_PROTOCOL) return `not protocol ${TOKEN_HOLDER_PROTOCOL}`;
  if (m.op !== "get" && m.op !== "put") return "an unknown op";
  if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > MAX_KEY_LENGTH) return "no readable key";
  if (m.op === "put") {
    if (typeof m.token !== "string" || m.token.length === 0 || m.token.length > MAX_TOKEN_LENGTH) return "no readable token";
    if (typeof m.expMs !== "number" || !Number.isFinite(m.expMs)) return "no readable expiry";
  }
  return null;
}

export function makeTokenHolderObject(deps: TokenHolderDeps) {
  const held = new Map<string, Held>();
  let disarm: (() => void) | null = null;

  const usable = (h: Held, now: number) => h.expMs - now > TOKEN_USABLE_MARGIN_MS;

  function sweep(): void {
    disarm = null;
    const now = deps.now();
    for (const [key, h] of held) if (!usable(h, now)) held.delete(key);
    arm();
  }

  /** One timer while anything is held, none once empty. */
  function arm(): void {
    if (held.size === 0) {
      disarm?.();
      disarm = null;
      return;
    }
    if (!disarm) disarm = deps.timer(TOKEN_HOLDER_KEEPALIVE_MS, sweep);
  }

  /** Make room for one more by dropping the token soonest to expire. */
  function evictSoonest(): void {
    let soonestKey: string | null = null;
    let soonestExp = Infinity;
    for (const [key, h] of held) {
      if (h.expMs < soonestExp) {
        soonestExp = h.expMs;
        soonestKey = key;
      }
    }
    if (soonestKey !== null) held.delete(soonestKey);
  }

  function get(key: string): HolderAnswer {
    const now = deps.now();
    const h = held.get(key);
    if (!h) return { kind: "miss" };
    if (!usable(h, now)) {
      held.delete(key);
      arm();
      return { kind: "miss" };
    }
    let refresh = false;
    if (h.expMs - now <= TOKEN_REFRESH_AHEAD_MS && h.claimUntilMs <= now) {
      h.claimUntilMs = now + TOKEN_REFRESH_CLAIM_MS;
      refresh = true;
    }
    return { kind: "hit", token: h.token, expMs: h.expMs, refresh };
  }

  function put(key: string, token: string, expMs: number): HolderAnswer {
    const now = deps.now();
    if (expMs - now <= TOKEN_USABLE_MARGIN_MS) return { kind: "kept" };
    const existing = held.get(key);
    // A later expiry wins: a put that arrives late with an older token (a slow mint, a
    // retried put) never replaces the newer one somebody else already stored.
    if (existing && usable(existing, now) && existing.expMs >= expMs) return { kind: "kept" };
    if (!existing && held.size >= TOKEN_HOLDER_MAX_HELD) evictSoonest();
    held.set(key, { token, expMs, claimUntilMs: 0 });
    arm();
    return { kind: "stored" };
  }

  return {
    handle(message: unknown): HolderAnswer {
      const reason = malformed(message);
      if (reason) return { kind: "bad", reason };
      const m = message as HolderMessage;
      return m.op === "get" ? get(m.key) : put(m.key, m.token, m.expMs);
    },
    /** How many tokens are held, for the suite. */
    size: () => held.size,
  };
}

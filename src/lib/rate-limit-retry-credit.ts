/**
 * A bounded retry past the public booking's edge minute window, earned only by being refused
 * a taken time (#3364).
 *
 * WHY. The confirm's edge window allows 3 a minute per address, through Cloudflare's native
 * limiter, which has no refund. On 2026-10-06 two real leads had their picked time refused as
 * `slot_unavailable` three or four times each inside a minute, each picking the next time
 * along, and were then refused with a 429: a dead end at exactly the moment they needed another
 * time. The hourly and contact caps were handed back on every one of those 409s (#1089); the
 * minute window went on counting them at full weight because it could not do otherwise.
 *
 * HOW. Each taken time refusal EARNS one credit for the address. A request the native window
 * refuses is let through only by SPENDING one. Both are counts in `rate_limits` under
 * `BOOKING_RETRY_CREDIT_RULES`, each through `rate_limit_hit`, so they are one exact count across
 * every isolate (L748) and are pruned with the other limiter rows.
 *
 * THE BOUND, and why an attacker cannot use refusals to get around the limit:
 *
 *   - A credit is earned only by a confirm that reached the route and was refused for a taken
 *     time, which is the one refusal the lead did not cause and can fix by picking again.
 *   - At most `RETRY_CREDIT_CAP` credits are spent per address per spend window (a minute,
 *     anchored at its first spend), however many were earned, and never more than were earned.
 *     So a flood of confirms for a time that is already taken reaches the route at most
 *     3 + 3 = 6 times a minute per address instead of 3: twice the verify-on-book work, still a
 *     fifth of the burst ceiling (30) behind it, and every one of them still a refusal. A
 *     request that is NOT a taken time refusal earns nothing, so a flood of anything else is
 *     exactly as limited as before.
 *   - The spend is ONE atomic `rate_limit_hit` whose ceiling is `min(earned, cap)`, so
 *     concurrent retries across isolates draw distinct counts and cannot overspend.
 *   - Before touching the store, each isolate gates itself: an address may ask at most the cap
 *     times per isolate per minute. Without it, a flood the native window is shedding would buy
 *     a database read per request, which is the very thing the edge window exists to prevent
 *     ("shed before we touch Postgres"). With it, a flood costs at most `cap` reads per isolate
 *     per minute, whatever it sends.
 *
 * What it costs, stated so nobody rediscovers it. A spend that was refused still counts toward
 * the spend window, which errs toward the limit: a lead who keeps retrying while out of
 * credits uses up retries a later refusal would have earned. Earned is judged live against the
 * worker's clock while its window was stamped by the database's; a skew of a second moves when
 * one credit expires by a second and cannot move the cap, which the spend enforces on the
 * database's own clock.
 *
 * Fails CLOSED on the exemption: a store that cannot be read or written throws, and the caller
 * keeps the 429 the native window gave, which is precisely the behaviour before this existed.
 * Being loud about it is the caller's job (`rate-limit.ts`).
 */
import { burstWindowCount } from "./rate-limit-burst";
import { BOOKING_RETRY_CREDIT_RULES } from "./rate-limit-core";

/** Retries a refused address may spend per spend window. Three, because the incident's leads
 *  were refused three and four times, and because it never exceeds the minute window it
 *  extends, so the worst case is that window doubled. */
export const RETRY_CREDIT_CAP = 3;

const WINDOW_MS = 60_000;
const [EARNED, SPENT] = BOOKING_RETRY_CREDIT_RULES;

/** The two `rate_limits` operations this needs. Each THROWS on a database error: an error read
 *  as "no credit" would be indistinguishable from a healthy answer (#1165). */
export interface RetryCreditStore {
  /** `rate_limit_hit` on the earned key: one more taken time refusal for this address. */
  earn(key: string): Promise<void>;
  /** The earned key's row as stored, or null when there is none. */
  readEarned(key: string): Promise<{ count: number; windowStartMs: number } | null>;
  /** `rate_limit_hit` on the spent key with this ceiling; true when the count stayed inside it. */
  spend(key: string, max: number): Promise<boolean>;
}

/** Why a retry was or was not let through, each its own answer so a log can say which (L11). */
export type RetryCreditVerdict =
  /** A credit was spent: let the request through. */
  | "allowed"
  /** No taken time refusal for this address inside the window. */
  | "no-credit"
  /** Refused here, but every credit for the window is spent. */
  | "spent"
  /** This isolate has already asked the cap times this minute for this address. */
  | "isolate-gate";

export class RetryCredits {
  private readonly store: RetryCreditStore;
  /** Per isolate, per address, how often the store has been asked this minute. */
  private readonly asked = new Map<string, { windowStartMs: number; count: number }>();

  constructor(store: RetryCreditStore) {
    this.store = store;
  }

  /** A confirm from this address was refused for a taken time. */
  async earn(address: string): Promise<void> {
    await this.store.earn(`${EARNED.prefix}:${address}`);
  }

  /** The native window refused this address: may one earned credit carry it through? */
  async judge(address: string, nowMs: number): Promise<RetryCreditVerdict> {
    if (burstWindowCount(this.asked, address, nowMs, WINDOW_MS) > RETRY_CREDIT_CAP) {
      return "isolate-gate";
    }
    const row = await this.store.readEarned(`${EARNED.prefix}:${address}`);
    const earned = row && nowMs - row.windowStartMs < WINDOW_MS ? row.count : 0;
    if (earned <= 0) return "no-credit";
    const allowed = await this.store.spend(`${SPENT.prefix}:${address}`, Math.min(earned, RETRY_CREDIT_CAP));
    return allowed ? "allowed" : "spent";
  }
}

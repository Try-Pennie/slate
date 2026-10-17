/**
 * The pure half of the locked out key count (#1727): which `rate_limits` rows mean
 * "this key is being refused right now". Kept free of imports beyond a type so
 * scripts/test-embed-refusal-signals.ts can pin it node-natively.
 *
 * A row is `{ key: "<prefix>:<caller>", window_start, count }`, reset IN PLACE when a
 * hit lands after its window has expired, and the count keeps rising on refused
 * hits. So a key is locked out now exactly when its window started less than one
 * window length ago (it is live) and its count is above the rule's maximum (a hit
 * inside that live window was refused).
 */
import type { RateLimitRule } from "../rate-limit-core.ts";

export interface LockedOutFilter {
  /** A LIKE pattern matching every key of this rule and no other rule's. */
  keyPattern: string;
  /** Rows whose count is ABOVE this were refused at least once in the window. */
  countAbove: number;
  /** Rows whose window started AFTER this instant are live. */
  windowStartAfterIso: string;
}

/** LIKE treats `%` and `_` as wildcards and `\` as its escape. A prefix carrying
 *  one would otherwise match another rule's keys. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function lockedOutFilter(rule: RateLimitRule, nowMs: number): LockedOutFilter {
  return {
    // The trailing colon is load bearing: `book:h` must not match `book:hx:...`.
    keyPattern: `${escapeLike(rule.prefix)}:%`,
    countAbove: rule.max,
    windowStartAfterIso: new Date(nowMs - rule.windowSeconds * 1000).toISOString(),
  };
}

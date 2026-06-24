/**
 * Pure pieces of the per-IP rate limiting (#31): key derivation and the
 * booking policy. No imports, so scripts/test-rate-limit.ts can run it
 * node-native; the DB-backed check lives in rate-limit.ts.
 */

export interface RateLimitRule {
  /** Key prefix; the client ip is appended. */
  prefix: string;
  windowSeconds: number;
  max: number;
}

/** Booking endpoint policy: a short burst window plus an hourly cap. */
export const BOOKING_RATE_RULES: RateLimitRule[] = [
  { prefix: "book:m", windowSeconds: 60, max: 3 },
  { prefix: "book:h", windowSeconds: 3600, max: 10 },
];

/**
 * Direct booking API (#355) ceiling, keyed per API KEY rather than per IP — one
 * bot behind one IP legitimately does ~2000/day, which would instantly blow the
 * per-IP BOOKING_RATE_RULES. Sized well above expected volume so it only ever
 * trips on a runaway loop or a leaked key; fails open like the per-IP rules.
 */
export const DIRECT_BOOKING_API_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:m", windowSeconds: 60, max: 120 },
  { prefix: "bookapi:h", windowSeconds: 3600, max: 6000 },
];

/**
 * Read endpoints (lookup/list, #386/#392) get their OWN ceiling, with distinct
 * key prefixes so they draw from a separate bucket than writes (#393). Status
 * polling is cheap and bursty — frequent reads must never eat into the write
 * budget and throttle the booking path they exist to support. Sized ~5x the
 * write ceiling; fails open like the rest.
 */
export const DIRECT_BOOKING_API_READ_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:read:m", windowSeconds: 60, max: 600 },
  { prefix: "bookapi:read:h", windowSeconds: 3600, max: 30000 },
];

// Availability (#56) no longer uses a DB rule: it's throttled at the edge by
// the AVAIL_RATE_LIMITER Workers binding (wrangler.jsonc, 30/min per datacenter)
// so the slot-cache hot path never makes a DB round-trip just to rate-limit. The
// old hourly cap was dropped (low-and-slow scraping of public, cached slot data
// is cheap); the per-minute edge limit is the protection.

/**
 * The client IP for rate-limit keying. Cloudflare sets cf-connecting-ip on
 * every request; x-forwarded-for's FIRST hop is the client elsewhere (dev).
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}

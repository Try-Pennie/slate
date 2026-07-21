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
  /**
   * Alert when this rule BLOCKS a request (#796). Opt-in, because for most rules a block
   * is the system working: the public booking limiter turns away spammy visitors all day
   * and paging on that would be noise. Set it only where a block is itself suspicious,
   * i.e. the machine-to-machine ceilings, where the caller is supposed to be our own bot
   * staying well inside its budget, so a rejection means either the ceiling is too tight
   * or the key has leaked. Both are things we want to hear about immediately.
   */
  alertOnBlock?: boolean;
}

/**
 * Public booking hourly cap. The short per-minute burst window (3/min) moved to
 * the Cloudflare edge rate limiter (BOOKING_RATE_LIMITER, #237) so it no longer
 * costs a DB round-trip on the lead's Confirm tap; the strict hourly anti-spam
 * cap stays in Postgres because the native binding can't express a 1-hour window.
 */
export const BOOKING_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "book:h", windowSeconds: 3600, max: 10 },
];

/**
 * Direct booking API (#355) ceiling, keyed per API KEY rather than per IP — one
 * bot behind one IP legitimately does ~2000/day, which would instantly blow the
 * per-IP public-booking limits. Sized well above expected volume so it only ever
 * trips on a runaway loop or a leaked key; fails open like the per-IP rules.
 */
export const DIRECT_BOOKING_API_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:m", windowSeconds: 60, max: 120 },
  { prefix: "bookapi:h", windowSeconds: 3600, max: 6000 },
];

/**
 * #597: a coarse per-IP backstop for the direct booking API, checked ALONGSIDE the
 * per-key ceiling above (separate prefixes, so the two counters never draw on each
 * other). Per-key alone meant a leaked integrator key had a 6000/hr ceiling and no
 * second bound: one machine could spend the whole budget.
 *
 * Sized to bound a single flooding host well below the key ceiling while leaving the
 * real auto-booker (~2000/day, roughly 83/hr) about 5x headroom for bursts. Too tight
 * here and a legitimate backlog run starts 429ing real bookings, which is worse than
 * the abuse it prevents. Fails open like the rest, but no longer silently (rate-limit.ts).
 */
export const DIRECT_BOOKING_API_IP_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:ip:m", windowSeconds: 60, max: 60, alertOnBlock: true },
  { prefix: "bookapi:ip:h", windowSeconds: 3600, max: 1200, alertOnBlock: true },
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

/**
 * Routing preview API (#596) ceiling, keyed per IP. The standalone /api/routing
 * endpoint is unauthenticated and does a DB-backed resolve per call, so it needs
 * its own throttle to bound anonymous enumeration and DB load. It has no
 * frontend caller (a diagnostic/preview surface), so it's sized modestly — well
 * above real debugging use but far below abuse. Distinct prefixes so it never
 * shares a counter with the booking paths; fails open like the rest.
 */
export const ROUTING_RATE_RULES: RateLimitRule[] = [
  { prefix: "routing:m", windowSeconds: 60, max: 20 },
  { prefix: "routing:h", windowSeconds: 3600, max: 200 },
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

/**
 * Human-readable alert copy for the rate-limit alerts. A limiter alert lands in
 * Slack in front of a non-technical on-call, so it must describe the impact in
 * plain language and NEVER carry a code identifier or a raw Error object; that
 * detail stays in the server logs (`log.error` with `tag=rate-limit`). The
 * availability fail-open alert used to interpolate `String(err)`, which in dev is
 * a Next.js config stack trace that nobody on-call can read. These builders keep
 * the wording testable and code-free.
 */

/** A plain-language area name for an internal key prefix. */
export function friendlyRateArea(prefix: string): string {
  if (prefix.startsWith("bookapi")) return "booking API";
  if (prefix.startsWith("book")) return "public booking";
  if (prefix.startsWith("routing")) return "routing lookup";
  return "a Slate endpoint";
}

/** A rate window in words ("minute", "hour", "N minutes"). */
export function humanWindow(seconds: number): string {
  if (seconds === 60) return "minute";
  if (seconds === 3600) return "hour";
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** The limiter stopped working and is allowing requests through uncapped. */
export function limiterFailOpenAlert(area: string): string {
  return (
    `Slate: the rate limit for ${area} has stopped working, so those requests are ` +
    `being allowed through with no cap right now. Requests still succeed; this is a ` +
    `safeguard, not an outage. An engineer should check the rate limiter (the cause ` +
    `is in the logs).`
  );
}

/** A machine-to-machine ceiling turned a request away (itself worth hearing). */
export function limiterBlockedAlert(
  area: string,
  ip: string,
  max: number,
  windowSeconds: number,
): string {
  return (
    `Slate: the ${area} rate limit turned away a request from ${ip} for going over ` +
    `${max} requests per ${humanWindow(windowSeconds)}. If that is our own automated ` +
    `booker, its limit is set too low and real bookings are being rejected. If it is ` +
    `not, an access key may have leaked.`
  );
}

/** A rate-limit refund failed, so a customer may keep losing allowance unfairly. */
export function refundFailedAlert(area: string): string {
  return (
    `Slate: could not restore the ${area} booking allowance for a customer whose ` +
    `booking failed through no fault of their own, so they may be left with less ` +
    `allowance than they should have. An engineer should check the rate-limit refund ` +
    `(the cause is in the logs).`
  );
}

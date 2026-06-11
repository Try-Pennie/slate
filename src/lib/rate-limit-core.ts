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
 * Availability endpoint policy (#56): looser than bookings - the Booker
 * legitimately refetches on every month navigation - but it still caps the
 * compute a single IP can demand (member loads + slot computation per call).
 */
export const AVAILABILITY_RATE_RULES: RateLimitRule[] = [
  { prefix: "avail:m", windowSeconds: 60, max: 30 },
  { prefix: "avail:h", windowSeconds: 3600, max: 400 },
];

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

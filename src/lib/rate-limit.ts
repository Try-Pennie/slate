import { getCloudflareContext } from "@opennextjs/cloudflare";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { RateLimitRule } from "@/lib/rate-limit-core";

export { clientIp, BOOKING_RATE_RULES } from "@/lib/rate-limit-core";
export type { RateLimitRule } from "@/lib/rate-limit-core";

/**
 * Availability throttle (#56) via the AVAIL_RATE_LIMITER Workers binding —
 * enforced in-datacenter with no DB round-trip, so the cached slot hot path
 * stays fast. Per-datacenter + intentionally permissive (Cloudflare's design).
 * Fails OPEN: a limiter hiccup must never block a legitimate Booker load.
 */
export async function availabilityWithinLimit(ip: string): Promise<boolean> {
  try {
    const limiter = getCloudflareContext().env.AVAIL_RATE_LIMITER;
    if (!limiter) return true;
    const { success } = await limiter.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

/**
 * Per-IP rate limiting for public endpoints (#31), backed by the
 * rate_limit_hit Postgres function (atomic fixed-window counter, one row per
 * key). Fails OPEN: a limiter hiccup must never block a real booking - the
 * verify-on-book and unique-slot index still bound the damage.
 */

/** True when the request is allowed under every rule. */
export async function allowRequest(
  ip: string,
  rules: RateLimitRule[],
): Promise<boolean> {
  const db = supabaseAdmin();
  for (const rule of rules) {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: `${rule.prefix}:${ip}`,
      p_window_seconds: rule.windowSeconds,
      p_max: rule.max,
    });
    if (error) {
      console.error(`rate_limit_hit failed (${rule.prefix}): ${error.message}`);
      continue; // fail open
    }
    if (data === false) return false;
  }
  return true;
}

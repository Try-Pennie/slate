import { getCloudflareContext } from "@opennextjs/cloudflare";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { RateLimitRule } from "@/lib/rate-limit-core";

export { clientIp, BOOKING_RATE_RULES, ROUTING_RATE_RULES } from "@/lib/rate-limit-core";
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

/** How often a broken limiter may re-alert. Long enough not to spam a channel during
 *  a sustained outage, short enough that nobody sits blind for a shift. */
const LIMITER_BROKEN_COOLDOWN_MS = 30 * 60_000;

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
      // #597: still fail open (a limiter hiccup must never block a real booking), but
      // never fail SILENTLY. This used to be a bare console.error, which Cloudflare does
      // not capture for this project, so the limiter could switch itself off across every
      // endpoint and nothing would say so.
      //
      // Best effort: the alert writes to alert_state, so the outage that broke the limiter
      // can break the alert too. Swallow that. A failed alert must not turn a limiter
      // failure into a BOOKING failure, which would be the exact opposite of failing open.
      console.error(`rate_limit_hit failed (${rule.prefix}): ${error.message}`);
      await sendThrottledAlert(
        `rate_limit_broken:${rule.prefix}`,
        LIMITER_BROKEN_COOLDOWN_MS,
        `Slate: the rate limiter is FAILING OPEN. rate_limit_hit errored on '${rule.prefix}': ${error.message}. Requests are being allowed through unthrottled until this is fixed.`,
      ).catch((err) => {
        console.error(`rate-limit alert failed (${rule.prefix}): ${String(err)}`);
      });
      continue; // fail open
    }
    if (data === false) return false;
  }
  return true;
}

/**
 * Give back a counted hit for every rule when the request failed for a reason
 * that ISN'T the customer's doing (e.g. a verify-on-book outage → 503), so a
 * server fault can't consume their booking budget (#319). Best-effort: a refund
 * error is logged and ignored — never fails the response.
 */
export async function refundRequest(
  ip: string,
  rules: RateLimitRule[],
): Promise<void> {
  const db = supabaseAdmin();
  for (const rule of rules) {
    const { error } = await db.rpc("rate_limit_refund", {
      p_key: `${rule.prefix}:${ip}`,
    });
    if (error) {
      console.error(`rate_limit_refund failed (${rule.prefix}): ${error.message}`);
    }
  }
}

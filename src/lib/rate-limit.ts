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
 *
 * #796: it used to fail open in TOTAL silence, on both of the paths that turn the throttle
 * off. It now says so. A missing binding is treated as an outage rather than as "no limiter
 * configured", because in this project there is no such thing: wrangler.jsonc always binds
 * it, so absent means broken.
 */
export async function availabilityWithinLimit(ip: string): Promise<boolean> {
  try {
    const limiter = getCloudflareContext().env.AVAIL_RATE_LIMITER;
    if (!limiter) {
      await alertAvailabilityLimiterDown(
        "the AVAIL_RATE_LIMITER binding is missing, so /api/availability has no throttle at all",
      );
      return true;
    }
    const { success } = await limiter.limit({ key: ip });
    return success;
  } catch (err) {
    await alertAvailabilityLimiterDown(`the limiter threw: ${String(err)}`);
    return true; // fail open
  }
}

/** Last time THIS isolate tried to alert about the availability limiter.
 *
 *  The alert's real throttle is alert_state, in Postgres, which means attempting it costs a
 *  DB round-trip. Everywhere else that is fine; here it is not. This is the Booker's slot hot
 *  path, and the limiter is likeliest to fail under exactly the traffic flood it exists to
 *  absorb, so alerting per request would answer a dead limiter by adding a database query to
 *  every one of those requests. This gate keeps that bounded. It is per-isolate and
 *  best-effort by design (a few duplicate attempts across isolates are harmless); alert_state
 *  is still what makes the alert itself correct. */
let lastAvailAlertAttemptMs = 0;

async function alertAvailabilityLimiterDown(reason: string): Promise<void> {
  const now = Date.now();
  if (now - lastAvailAlertAttemptMs < LIMITER_BROKEN_COOLDOWN_MS) return;
  lastAvailAlertAttemptMs = now;
  console.error(`availability rate limiter is failing open: ${reason}`);
  await alertBestEffort(
    "rate_limit_broken:availability",
    `Slate: the availability rate limiter is FAILING OPEN, so ${reason}. Every /api/availability request is being served unthrottled until this is fixed.`,
    "availability",
  );
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
      await alertBestEffort(
        `rate_limit_broken:${rule.prefix}`,
        `Slate: the rate limiter is FAILING OPEN. rate_limit_hit errored on '${rule.prefix}': ${error.message}. Requests are being allowed through unthrottled until this is fixed.`,
        rule.prefix,
      );
      continue; // fail open
    }
    if (data === false) {
      // #796: a block on a machine-to-machine ceiling is itself news. The caller is meant to
      // be our own auto-booker sitting well inside its budget, so a rejection means either the
      // ceiling is too tight (we are now failing real bookings that used to succeed) or the key
      // has leaked. Until #418 lands there is no other way to see this. Best-effort, as above.
      if (rule.alertOnBlock) {
        await alertBestEffort(
          `rate_limit_blocked:${rule.prefix}`,
          `Slate: the booking API rate limit BLOCKED a request from ${ip} (rule '${rule.prefix}', ${rule.max} per ${rule.windowSeconds}s). If that is our own auto-booker, the ceiling is too tight and real bookings are being rejected. If it is not, a key may have leaked.`,
          rule.prefix,
        );
      }
      return false;
    }
  }
  return true;
}

/** Alert without ever letting the alert's own failure escape. The alert writes to
 *  alert_state, so whatever broke the limiter can break the alert too, and a monitoring
 *  failure must never become a booking failure. */
async function alertBestEffort(key: string, text: string, label: string): Promise<void> {
  await sendThrottledAlert(key, LIMITER_BROKEN_COOLDOWN_MS, text).catch((err) => {
    console.error(`rate-limit alert failed (${label}): ${String(err)}`);
  });
}

/**
 * Give back a counted hit for every rule when the request failed for a reason
 * that ISN'T the customer's doing (e.g. a verify-on-book outage → 503), so a
 * server fault can't consume their booking budget (#319). Never fails the response.
 *
 * #796: it used to only console.error on failure, which Cloudflare does not capture, so a
 * broken refund was invisible. The customer then quietly loses booking allowance because of
 * OUR fault, a bad enough outcome that it has to be heard. Still swallowed either way: a
 * failed refund must not turn a server fault into a second failure for the same customer.
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
      await alertBestEffort(
        `rate_limit_refund_broken:${rule.prefix}`,
        `Slate: a rate-limit REFUND failed on '${rule.prefix}': ${error.message}. Customers whose booking failed through no fault of their own are losing budget from their limit.`,
        rule.prefix,
      );
    }
  }
}

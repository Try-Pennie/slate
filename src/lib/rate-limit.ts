import { getCloudflareContext } from "@opennextjs/cloudflare";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { RateLimitRule } from "@/lib/rate-limit-core";
import { log } from "@/lib/log";

export { clientIp, BOOKING_HOURLY_RATE_RULES, ROUTING_HOURLY_RATE_RULES } from "@/lib/rate-limit-core";
export type { RateLimitRule } from "@/lib/rate-limit-core";
import {
  friendlyRateArea,
  limiterFailOpenAlert,
  limiterBlockedAlert,
  refundFailedAlert,
} from "@/lib/rate-limit-core";

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
  return edgeWithinLimit(ip, {
    binding: "AVAIL_RATE_LIMITER",
    area: "availability",
    friendly: "booking availability",
  });
}

/**
 * Public booking per-minute burst throttle (#237) via the BOOKING_RATE_LIMITER
 * Workers binding, enforced in-datacenter with no DB round-trip, so it no longer
 * adds ~75-150ms to the lead's Confirm tap. The strict hourly cap stays in the DB
 * (allowRequest + BOOKING_HOURLY_RATE_RULES). Fails OPEN like availability: a
 * limiter hiccup must never block a real booking (verify-on-book and the
 * unique-slot index still bound the damage), but it fails LOUD (#796).
 */
export async function bookingWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, {
    binding: "BOOKING_RATE_LIMITER",
    area: "booking",
    friendly: "public booking",
  });
}

/**
 * Routing preview per-minute burst throttle (#961) via ROUTING_RATE_LIMITER,
 * keyed per IP. Replaces the old DB per-minute rule (routing:m); the hourly cap
 * (ROUTING_HOURLY_RATE_RULES) stays in the DB. Fails OPEN + LOUD like the rest.
 */
export async function routingWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, {
    binding: "ROUTING_RATE_LIMITER",
    area: "routing",
    friendly: "routing lookup",
  });
}

/**
 * Direct booking API per-minute burst windows at the edge (#961), replacing the
 * old DB per-minute rules; the hourly ceilings stay in the DB. Three separate
 * bindings because the native limiter fixes one limit per binding and these are
 * intentionally different sizes and keys:
 *   - write path, keyed per API key (120/min): bookingApiWriteWithinLimit
 *   - per-IP write backstop, keyed per IP (60/min): bookingApiIpWithinLimit,
 *     which alerts on block (a block means the ceiling is too tight or a key
 *     leaked, #597/#796)
 *   - read path, keyed per API key (600/min): bookingApiReadWithinLimit
 */
export async function bookingApiWriteWithinLimit(keyId: string): Promise<boolean> {
  return edgeWithinLimit(keyId, {
    binding: "BOOKINGAPI_RATE_LIMITER",
    area: "booking-api",
    friendly: "booking API",
  });
}

export async function bookingApiIpWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, {
    binding: "BOOKINGAPI_IP_RATE_LIMITER",
    area: "booking-api-ip",
    friendly: "booking API",
    alertOnBlock: { max: 60, windowSeconds: 60 },
  });
}

export async function bookingApiReadWithinLimit(keyId: string): Promise<boolean> {
  return edgeWithinLimit(keyId, {
    binding: "BOOKINGAPI_READ_RATE_LIMITER",
    area: "booking-api-read",
    friendly: "booking API",
  });
}

/** The Cloudflare edge rate-limit binding shape (`.limit({ key }) -> { success }`). */
interface EdgeLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

type EdgeLimiterBinding =
  | "AVAIL_RATE_LIMITER"
  | "BOOKING_RATE_LIMITER"
  | "ROUTING_RATE_LIMITER"
  | "BOOKINGAPI_RATE_LIMITER"
  | "BOOKINGAPI_IP_RATE_LIMITER"
  | "BOOKINGAPI_READ_RATE_LIMITER";

interface EdgeLimiterConfig {
  binding: EdgeLimiterBinding;
  /** Token-safe area name; used to key the fail-open / block alert throttle. */
  area: string;
  /** Plain-language area name for the human-facing Slack alert. */
  friendly: string;
  /**
   * When set, a BLOCK (not just an outage) is itself news, mirroring the DB
   * path's `alertOnBlock` rule (#796): the caller is meant to be our own bot well
   * inside budget, so a rejection means the ceiling is too tight or a key leaked.
   * The window is passed through only so the alert copy names the real limit.
   */
  alertOnBlock?: { max: number; windowSeconds: number };
}

/**
 * Shared edge-limiter check for every hot path that uses one (#237, #961):
 * resolve the named Workers rate-limit binding, count this key (an IP, or an API
 * key id for the per-key ceilings), and fail OPEN + LOUD if the binding is missing
 * or throws. Kept as one implementation so the fail-open and alerting contract
 * can't drift between endpoints. `alertOnBlock` also fires a best-effort alert
 * when the limiter turns a request away, for the machine-to-machine backstops
 * where a block is itself a signal.
 */
async function edgeWithinLimit(key: string, cfg: EdgeLimiterConfig): Promise<boolean> {
  try {
    const env = getCloudflareContext().env as unknown as Record<
      string,
      EdgeLimiter | undefined
    >;
    const limiter = env[cfg.binding];
    if (!limiter) {
      await alertEdgeLimiterDown(
        cfg,
        `the ${cfg.binding} binding is missing, so the ${cfg.area} throttle is OFF`,
      );
      return true;
    }
    const { success } = await limiter.limit({ key });
    if (!success && cfg.alertOnBlock) {
      // Best-effort, like the DB path: the alert writes to alert_state, so a
      // failed alert must never turn a block into a thrown error for the caller.
      await alertBestEffort(
        `rate_limit_blocked:${cfg.area}`,
        limiterBlockedAlert(cfg.friendly, key, cfg.alertOnBlock.max, cfg.alertOnBlock.windowSeconds),
        cfg.area,
      );
    }
    return success;
  } catch (err) {
    await alertEdgeLimiterDown(cfg, `the limiter threw: ${String(err)}`);
    return true; // fail open
  }
}

/** Last time THIS isolate tried to alert about a given edge limiter, keyed by area.
 *
 *  The alert's real throttle is alert_state, in Postgres, which means attempting it costs a
 *  DB round-trip. Everywhere else that is fine; here it is not. These are hot paths, and the
 *  limiter is likeliest to fail under exactly the traffic flood it exists to absorb, so alerting
 *  per request would answer a dead limiter by adding a database query to every one of those
 *  requests. This gate keeps that bounded. It is per-isolate and best-effort by design (a few
 *  duplicate attempts across isolates are harmless); alert_state still makes the alert correct. */
const lastEdgeAlertAttemptMs = new Map<string, number>();

async function alertEdgeLimiterDown(
  cfg: { area: string; friendly: string },
  reason: string,
): Promise<void> {
  const now = Date.now();
  if (now - (lastEdgeAlertAttemptMs.get(cfg.area) ?? 0) < LIMITER_BROKEN_COOLDOWN_MS) return;
  lastEdgeAlertAttemptMs.set(cfg.area, now);
  // The raw reason (a missing binding, or String(err) that in dev is a Next.js
  // config stack trace) goes to the LOGS, never to the human-facing Slack line.
  log.error("rate-limit", { msg: "limiter failing open", area: cfg.area, reason });
  await alertBestEffort(
    `rate_limit_broken:${cfg.area}`,
    limiterFailOpenAlert(cfg.friendly),
    cfg.area,
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
      // never fail SILENTLY. This used to be a bare log line, and nothing watches a 7-day
      // log with no alerting on it, so the limiter could switch itself off across every
      // endpoint and nobody would hear about it. (Cloudflare DOES capture the log, #801;
      // the problem was that no one is reading it, not that it vanished.)
      //
      // Best effort: the alert writes to alert_state, so the outage that broke the limiter
      // can break the alert too. Swallow that. A failed alert must not turn a limiter
      // failure into a BOOKING failure, which would be the exact opposite of failing open.
      log.error("rate-limit", { msg: "rate_limit_hit failed", rule: rule.prefix }, error);
      await alertBestEffort(
        `rate_limit_broken:${rule.prefix}`,
        limiterFailOpenAlert(friendlyRateArea(rule.prefix)),
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
          limiterBlockedAlert(friendlyRateArea(rule.prefix), ip, rule.max, rule.windowSeconds),
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
    log.error("rate-limit", { msg: "alert failed", label }, err);
  });
}

/**
 * Give back a counted hit for every rule when the request failed for a reason
 * that ISN'T the customer's doing (e.g. a verify-on-book outage → 503), so a
 * server fault can't consume their booking budget (#319). Never fails the response.
 *
 * #796: it used to only log on failure, and nothing watches the logs, so a broken refund
 * went unheard. The customer then quietly loses booking allowance because of
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
      log.error("rate-limit", { msg: "rate_limit_refund failed", rule: rule.prefix }, error);
      await alertBestEffort(
        `rate_limit_refund_broken:${rule.prefix}`,
        refundFailedAlert(friendlyRateArea(rule.prefix)),
        rule.prefix,
      );
    }
  }
}

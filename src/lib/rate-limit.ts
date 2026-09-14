import { getCloudflareContext } from "@opennextjs/cloudflare";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { RateLimitRule, EdgeLimiterSpec } from "@/lib/rate-limit-core";
import { log } from "@/lib/log";
import { isWorkersRuntime, workersRuntimeMarker } from "@/lib/platform/runtime";
import { BurstTracker, BURST_LIMITER_BINDING, burstKey } from "@/lib/rate-limit-burst";
import {
  judgeCaller,
  rateLimitKey,
  callerPolicy,
  unidentifiedCallerAlert,
  type AddressLimitPolicy,
  type CallerKey,
  AVAILABILITY_LIMITER,
  BOOKING_LIMITER,
  ROUTING_LIMITER,
  BOOKING_API_WRITE_LIMITER,
  BOOKING_API_IP_LIMITER,
  BOOKING_API_READ_LIMITER,
  MANAGE_LIMITER,
} from "@/lib/rate-limit-core";

export {
  clientIp,
  BOOKING_HOURLY_RATE_RULES,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
  contactRateKeys,
  ROUTING_HOURLY_RATE_RULES,
  CLIENT_ERROR_RATE_RULES,
} from "@/lib/rate-limit-core";
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
 *
 * #1556: the burst ceiling behind it is no longer wired here. It is part of `edgeWithinLimit`,
 * so every endpoint gets it rather than only this one, and this function is now exactly what
 * its four siblings below are.
 */
export async function availabilityWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, AVAILABILITY_LIMITER);
}

/** The Durable Object namespace shape this uses, named locally because
 *  `@cloudflare/workers-types` is not a dependency here. */
interface DurableObjectishNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

/** One tracker per isolate. The in-isolate counts ARE the cheap half of the ceiling, so they
 *  have to outlive a single request; a tracker built per call would count every request as the
 *  first and never escalate, which is a limiter that looks wired and enforces nothing (L3). */
let sharedBurstTracker: BurstTracker | null = null;

/** The CURRENT binding, re-read on every request rather than captured when the tracker was
 *  built. The tracker's state has to persist and the transport must not: closing over the
 *  first namespace ever seen means a tracker that keeps talking to a stale binding, and
 *  nothing downstream could tell, because it answers perfectly well. */
let currentBurstNamespace: DurableObjectishNamespace | null = null;

function burstTracker(ns: DurableObjectishNamespace): BurstTracker {
  currentBurstNamespace = ns;
  sharedBurstTracker ??= new BurstTracker({
    ask: async (key, bump) => {
      const namespace = currentBurstNamespace;
      if (!namespace) throw new Error("no burst limiter namespace bound");
      const stub = namespace.get(namespace.idFromName(key));
      const res = await stub.fetch("https://burst-limiter.slate/count", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bump }),
      });
      if (!res.ok) throw new Error(`burst limiter answered ${res.status}`);
      return (await res.json()) as { count: number };
    },
  });
  return sharedBurstTracker;
}

/**
 * The second ceiling, the one a concurrent burst cannot spread across (#1536, #1556).
 *
 * The native check is enforced per datacenter and counted approximately, which is Cloudflare's
 * design and was already described here as permissive. Measured against production on
 * 2026-08-17 from one machine, though, the gap is much larger than permissive suggests: 45
 * sequential requests down one socket were blocked at exactly 30, and 60 fired in parallel into
 * the same datacenter in 1.1 seconds were blocked ZERO times. Same address, same second, same
 * configured ceiling. So the practical guarantee on the one endpoint anybody on the internet can
 * reach without authentication was 30 a minute PER ISOLATE.
 *
 * #1536 closed that on availability alone. #1556 is the same gap on the other five, which was
 * never a different defect, only a smaller blast radius: the booking confirm is the one that
 * would hurt, because a confirm creates a record and sends a calendar invite rather than reading
 * a cache.
 *
 * This runs after the fast check and behind an escalation threshold, so an ordinary request pays
 * nothing for it: see `@/lib/rate-limit-burst` for the numbers and why each ceiling is a large
 * multiple of the sustained limit rather than equal to it.
 *
 * Fails OPEN and LOUD, exactly like the check in front of it. The whole reason these endpoints
 * are worth protecting is that leads reach them, so a counter we cannot reach must never be the
 * thing that stops one.
 */
async function withinBurstCeiling(
  env: Record<string, unknown>,
  key: string,
  spec: EdgeLimiterSpec,
): Promise<boolean> {
  const area = `${spec.area}-burst`;
  // The unidentified caller is decided once, in `edgeWithinLimit`, before either counter is
  // touched (#1557). It used to be decided here, which spared this ceiling and left the fast
  // one counting every such request into one shared bucket.
  const ns = env[BURST_LIMITER_BINDING] as DurableObjectishNamespace | undefined;
  if (!ns) {
    // Same reading as a missing rate-limit binding: wrangler.jsonc always binds it, so
    // absent means broken rather than "not configured".
    await alertEdgeLimiterDown(
      { area, friendly: spec.friendly },
      `the ${BURST_LIMITER_BINDING} binding is missing, so the burst ceiling is OFF`,
    );
    return true;
  }
  try {
    return await burstTracker(ns).allow(
      burstKey(spec.area, key),
      Date.now(),
      spec.burstCeilingPerMinute,
      // Fail LOUD while the tracker fails open, and say WHICH endpoint's ceiling stopped
      // counting: one tracker serves them all, so a report that just said "the burst ceiling"
      // would send the reader to the wrong endpoint. Routed through the same alerting the edge
      // limiters use, so a burst ceiling that has quietly stopped counting reads the same way
      // as an edge limiter that has (#796).
      (err) => {
        void alertEdgeLimiterDown(
          { area, friendly: spec.friendly },
          `the burst ceiling could not be reached: ${String(err)}`,
        );
      },
    );
  } catch (err) {
    await alertEdgeLimiterDown(
      { area, friendly: spec.friendly },
      `the burst ceiling threw: ${String(err)}`,
    );
    return true;
  }
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
  return edgeWithinLimit(ip, BOOKING_LIMITER);
}

/**
 * Routing preview per-minute burst throttle (#961) via ROUTING_RATE_LIMITER,
 * keyed per IP. Replaces the old DB per-minute rule (routing:m); the hourly cap
 * (ROUTING_HOURLY_RATE_RULES) stays in the DB. Fails OPEN + LOUD like the rest.
 */
export async function routingWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, ROUTING_LIMITER);
}

/**
 * Direct booking API per-minute burst windows at the edge (#961), replacing the
 * old DB per-minute rules; the hourly ceilings stay in the DB. Three separate
 * bindings because the native limiter fixes one limit per binding and these are
 * intentionally different sizes and keys:
 *   - write path, keyed per API key (120/min): bookingApiWriteWithinLimit
 *   - per-IP write backstop, keyed per IP (60/min): bookingApiIpWithinLimit,
 *     which alerts on block (a block means the ceiling is too tight or a key
 *     leaked, #597/#796). That 60 is APPROXIMATE and per location, and measured
 *     allowing 180 in 20 seconds; the exact bounds on one address are named on
 *     BOOKING_API_IP_LIMITER (#2339)
 *   - read path, keyed per API key (600/min): bookingApiReadWithinLimit
 */
export async function bookingApiWriteWithinLimit(keyId: string): Promise<boolean> {
  return edgeWithinLimit(keyId, BOOKING_API_WRITE_LIMITER);
}

export async function bookingApiIpWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, BOOKING_API_IP_LIMITER);
}

export async function bookingApiReadWithinLimit(keyId: string): Promise<boolean> {
  return edgeWithinLimit(keyId, BOOKING_API_READ_LIMITER);
}

/**
 * The customer's manage link (#1046), keyed per address: cancel, reschedule and the
 * phone edit. Edge only, with no hourly cap behind it, because the cost being bounded
 * IS the database round trip an unthrottled garbage token bought. Fails OPEN + LOUD
 * like the rest: a limiter hiccup must never stop a real customer cancelling.
 */
export async function manageWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, MANAGE_LIMITER);
}

/** The Cloudflare edge rate-limit binding shape (`.limit({ key }) -> { success }`). */
interface EdgeLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Shared edge-limiter check for every hot path that uses one (#237, #961, #1556).
 *
 * Resolve the named Workers rate-limit binding, count this key (an IP, or an API key id for the
 * per-key ceilings), and fail OPEN + LOUD if the binding is missing or throws. Kept as one
 * implementation so the fail-open and alerting contract can't drift between endpoints, and since
 * #1556 so that the BURST ceiling cannot either: it used to hang off `availabilityWithinLimit`,
 * which is how five endpoints ended up without one.
 *
 * The two ceilings are INDEPENDENT. A missing native binding no longer switches the burst
 * ceiling off with it, because they are separate controls that happen to share a context read
 * (L53: two checks must never share one status). A native BLOCK does skip the burst step, which
 * is not the same thing: the request is already refused, so paying a round trip to count it more
 * precisely would buy nothing.
 *
 * `spec.alertOnBlock` also fires a best-effort alert when the limiter turns a request away, for
 * the machine-to-machine backstops where a block is itself a signal.
 */
async function edgeWithinLimit(key: string, spec: EdgeLimiterSpec): Promise<boolean> {
  // #1557: decided BEFORE either counter, not inside one of them. An address we could not
  // identify is a shared bucket, so counting it at all is the defect; a check that ran the
  // fast counter first and only spared the burst one would still have turned the per address
  // ceiling into a global one for every isolate in the datacenter.
  if (spec.keyKind === "ip") {
    const verdict = judgeCaller(spec, key);
    if (verdict !== "identified") {
      await reportUnidentifiedCaller(spec);
      return verdict === "serve-unjudged";
    }
  }
  let env: Record<string, unknown>;
  try {
    env = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch (err) {
    // ONE report, not one per ceiling: the context is what both checks need, so an unreadable
    // one is a single fact about this request rather than two independent failures.
    await alertEdgeLimiterDown(spec, `the limiter threw: ${String(err)}`);
    return true; // fail open
  }

  const nativeOk = await nativeWithinLimit(env, key, spec);
  if (!nativeOk) return false;
  return withinBurstCeiling(env, key, spec);
}

/** The fast, free half: Cloudflare's own in-datacenter counter. */
async function nativeWithinLimit(
  env: Record<string, unknown>,
  key: string,
  spec: EdgeLimiterSpec,
): Promise<boolean> {
  try {
    const limiter = env[spec.binding] as EdgeLimiter | undefined;
    if (!limiter) {
      await alertEdgeLimiterDown(
        spec,
        `the ${spec.binding} binding is missing, so the ${spec.area} throttle is OFF`,
      );
      return true;
    }
    const { success } = await limiter.limit({ key });
    if (!success && spec.alertOnBlock) {
      // Best-effort, like the DB path: the alert writes to alert_state, so a
      // failed alert must never turn a block into a thrown error for the caller.
      await alertBestEffort(
        `rate_limit_blocked:${spec.area}`,
        // The window is the spec's own `perMinute` rather than a literal passed in beside it,
        // so the copy can never name a limit the binding does not enforce.
        limiterBlockedAlert(spec.friendly, key, spec.perMinute, 60),
        spec.area,
      );
    }
    return success;
  } catch (err) {
    await alertEdgeLimiterDown(spec, `the limiter threw: ${String(err)}`);
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

/** Last time THIS isolate LOGGED a fail-open, keyed by area. Deliberately a separate,
 *  far looser gate than the alert's (#1525).
 *
 *  The log used to sit BELOW the alert gate above, so a sustained outage recorded one line
 *  per isolate per 30 minutes. #1525's own direction was "check the Cloudflare logs for
 *  tag=rate-limit", and against that record an outage lasting a shift is indistinguishable
 *  from a single request having a bad moment. What needed bounding on a hot path was the
 *  DB round-trip, not a console line, so the two are bounded separately: the log often
 *  enough to show the outage's shape, and still bounded, because a limiter failing under
 *  the flood it exists to absorb would otherwise write a line per unbounded request. */
const lastEdgeLogMs = new Map<string, number>();
const LIMITER_LOG_COOLDOWN_MS = 10_000;

/** Why a limiter check could not be answered. The two are NOT the same news (L11). */
type EdgeLimiterFailure =
  /** On Cloudflare, but the binding is absent or the limiter threw: the throttle is
   *  genuinely off for requests we are genuinely serving. */
  | "outage"
  /** Not on the Workers runtime at all (`next dev`, a node script): there is no limiter
   *  here to be broken and no production request being served. */
  | "no-platform";

async function alertEdgeLimiterDown(
  cfg: { area: string; friendly: string },
  reason: string,
): Promise<void> {
  // #1525: decide FIRST whether this is even about production. Off the Workers runtime
  // the fail-open is expected and says nothing about the deployed limiter, so paging on
  // it is a false alarm sent from a laptop to a real on-call, and the live alert store is
  // what a dev server writes to. Silent to Slack, never silent full stop, and under its
  // own wording rather than borrowed outage copy.
  const failure: EdgeLimiterFailure = isWorkersRuntime() ? "outage" : "no-platform";
  const now = Date.now();

  // The raw reason (a missing binding, or String(err) that off-platform is a Next.js
  // config stack trace) goes to the LOGS, never to the human-facing Slack line.
  if (now - (lastEdgeLogMs.get(cfg.area) ?? 0) >= LIMITER_LOG_COOLDOWN_MS) {
    lastEdgeLogMs.set(cfg.area, now);
    if (failure === "no-platform") {
      log.error("rate-limit", {
        msg: "not running on the Cloudflare runtime, so the throttle is not enforced here",
        area: cfg.area,
        runtime: workersRuntimeMarker(),
        reason,
      });
    } else {
      log.error("rate-limit", { msg: "limiter failing open", area: cfg.area, reason });
    }
  }

  if (failure === "no-platform") return;
  if (now - (lastEdgeAlertAttemptMs.get(cfg.area) ?? 0) < LIMITER_BROKEN_COOLDOWN_MS) return;
  lastEdgeAlertAttemptMs.set(cfg.area, now);
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
  caller: CallerKey,
  rules: RateLimitRule[],
): Promise<boolean> {
  // #1557: an address we could not identify is a shared bucket, so the decision is made at the
  // KEY, before any rule counts anything. Which way it goes is the limit's own stated answer,
  // never a default applied here: refusing an unidentifiable caller is right for the client
  // error beacon and wrong for the booking confirm.
  const verdict = judgeCaller(callerPolicy(caller), rateLimitKey(caller));
  if (verdict !== "identified") {
    const policy = callerPolicy(caller);
    if (policy) await reportUnidentifiedCaller(policy);
    return verdict === "serve-unjudged";
  }
  const key = rateLimitKey(caller);
  const db = supabaseAdmin();
  for (const rule of rules) {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: `${rule.prefix}:${key}`,
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
          limiterBlockedAlert(friendlyRateArea(rule.prefix), key, rule.max, rule.windowSeconds),
          rule.prefix,
        );
      }
      return false;
    }
  }
  return true;
}

/**
 * Say that a request arrived with no client address, once per limit per cooldown (#1557).
 *
 * Reported rather than silently handled: behind Cloudflare this cannot happen, so it means
 * something is in front of us that should not be, and a ceiling that has quietly stopped
 * applying looks exactly like a ceiling nobody is hitting. Best effort like every other alert
 * on these paths, because a monitoring failure must never become a booking failure.
 */
async function reportUnidentifiedCaller(policy: AddressLimitPolicy): Promise<void> {
  // alert-key: rate_limit_unidentified:*
  await sendThrottledAlert(
    `rate_limit_unidentified:${policy.area}`,
    LIMITER_BROKEN_COOLDOWN_MS,
    unidentifiedCallerAlert(policy),
  ).catch((err) => {
    log.error("rate-limit", { msg: "unidentified-caller report failed", area: policy.area }, err);
  });
}

/** Alert without ever letting the alert's own failure escape. The alert writes to
 *  alert_state, so whatever broke the limiter can break the alert too, and a monitoring
 *  failure must never become a booking failure. */
async function alertBestEffort(key: string, text: string, label: string): Promise<void> {
  // alert-key: rate_limit_blocked:*
  // alert-key: rate_limit_broken:*
  // alert-key: rate_limit_refund_broken:*
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
  caller: CallerKey,
  rules: RateLimitRule[],
): Promise<void> {
  // Nothing was counted for a caller we declined to judge, so there is nothing to give back,
  // and issuing the refund anyway would credit the shared bucket this whole rule exists to
  // keep empty.
  if (judgeCaller(callerPolicy(caller), rateLimitKey(caller)) !== "identified") return;
  const key = rateLimitKey(caller);
  const db = supabaseAdmin();
  for (const rule of rules) {
    const { error } = await db.rpc("rate_limit_refund", {
      p_key: `${rule.prefix}:${key}`,
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

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { RateLimitRule, EdgeLimiterSpec } from "@/lib/rate-limit-core";
import { log } from "@/lib/log";
import { afterResponse } from "@/lib/after-response";
import { isWorkersRuntime, workersRuntimeMarker } from "@/lib/platform/runtime";
import {
  BurstTracker,
  BURST_LIMITER_BINDING,
  burstKey,
  burstEscalateAt,
  exactCeilingAllows,
  exactCeilingKey,
  readExactCeilingReply,
} from "@/lib/rate-limit-burst";
import { fetchWithinBudget } from "@/lib/call-budget";
import { SUPABASE_FETCH_TIMEOUT_MS } from "@/lib/supabase/fetch-deadline";
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
  LANDING_LIMITER,
  LANDING_IDENTITY_HOURLY_RATE_RULES,
  CALL_ME_NOW_LIMITER,
  CALL_ME_NOW_HOURLY_RATE_RULES,
  BEARER_FAILURE_LIMITER,
  BOOKING_RETRY_CREDIT_RULES,
} from "@/lib/rate-limit-core";
import { RetryCredits, type RetryCreditVerdict } from "@/lib/rate-limit-retry-credit";
import { parseStampMs } from "@/lib/date/stamp";

export {
  clientIp,
  BOOKING_HOURLY_RATE_RULES,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
  contactRateKeys,
  ROUTING_HOURLY_RATE_RULES,
  CLIENT_ERROR_RATE_RULES,
  CSP_REPORT_RATE_RULES,
} from "@/lib/rate-limit-core";
export type { RateLimitRule } from "@/lib/rate-limit-core";
import {
  friendlyRateArea,
  limiterFailOpenAlert,
  limiterBlockedAlert,
  refundFailedAlert,
  LIMITER_FAIL_OPEN_PAGE_AFTER,
  LIMITER_FAIL_OPEN_WINDOW_MS,
  type MeasuredFailures,
} from "@/lib/rate-limit-core";
import { makeSustainedFailureGate } from "@/lib/notify/sustained-failure";

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
    alertEdgeLimiterDown(
      { area, friendly: spec.friendly },
      `the ${BURST_LIMITER_BINDING} binding is missing, so the burst ceiling is OFF`,
    );
    return true;
  }
  try {
    const escalateAt = burstEscalateAt(spec);
    return await burstTracker(ns).allow(
      burstKey(spec.area, key),
      Date.now(),
      {
        ceilingPerMinute: spec.burstCeilingPerMinute,
        escalateAt,
        // #1565: one line per key per window, so the escalation rate per lane can be measured
        // from the logs once real integrator traffic exists. The caller is named only for a
        // key limiter, where it is an integrator name from authentication; an address is
        // never logged.
        onEscalate: (count) => {
          log.info("rate-limit-burst", {
            msg: "escalated",
            area: spec.area,
            audience: spec.audience,
            escalate_at: escalateAt,
            ceiling: spec.burstCeilingPerMinute,
            count,
            ...(spec.keyKind === "api-key" ? { caller: key } : {}),
          });
        },
      },
      // Fail LOUD while the tracker fails open, and say WHICH endpoint's ceiling stopped
      // counting: one tracker serves them all, so a report that just said "the burst ceiling"
      // would send the reader to the wrong endpoint. Routed through the same alerting the edge
      // limiters use, so a burst ceiling that has quietly stopped counting reads the same way
      // as an edge limiter that has (#796).
      (err) => {
        alertEdgeLimiterDown(
          { area, friendly: spec.friendly },
          `the burst ceiling could not be reached: ${String(err)}`,
        );
      },
    );
  } catch (err) {
    alertEdgeLimiterDown(
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
 * The retry credit behind the booking confirm's edge minute window (#3364). The decision and
 * the bound it keeps (at most three retries a minute per address, each earned by a taken time
 * refusal) live in `@/lib/rate-limit-retry-credit`; this is its store and its failure handling.
 *
 * One instance per isolate, because its in-memory gate is what stops a flood the native window
 * is shedding from buying a database read per request.
 */
const retryCredits = new RetryCredits({
  earn: async (key) => {
    const { error } = await supabaseAdmin().rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: BOOKING_RETRY_CREDIT_RULES[0].windowSeconds,
      p_max: BOOKING_RETRY_CREDIT_RULES[0].max,
    });
    if (error) throw new Error(`rate_limit_hit failed: ${error.message}`);
  },
  readEarned: async (key) => {
    const { data, error } = await supabaseAdmin()
      .from("rate_limits")
      .select("count, window_start")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(`rate_limits read failed: ${error.message}`);
    if (!data) return null;
    const row = data as { count: unknown; window_start: unknown };
    const windowStartMs = parseStampMs(typeof row.window_start === "string" ? row.window_start : null);
    // An unreadable stamp is neither live nor expired, so it is refused by name rather than
    // guessed at (#1169): the caller keeps the 429, which is the safe side for an exemption.
    if (windowStartMs === null || typeof row.count !== "number") {
      throw new Error("rate_limits row for a retry credit is unreadable");
    }
    return { count: row.count, windowStartMs };
  },
  spend: async (key, max) => {
    const { data, error } = await supabaseAdmin().rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: BOOKING_RETRY_CREDIT_RULES[1].windowSeconds,
      p_max: max,
    });
    if (error) throw new Error(`rate_limit_hit failed: ${error.message}`);
    if (typeof data !== "boolean") throw new Error("rate_limit_hit answered with no verdict");
    return data;
  },
});

/** Report a credit we could not earn or check, raw cause to the logs, paged only on a sustained
 *  run (#3670). Under the refund alert, because to the lead it is the same loss: allowance they
 *  were owed. */
function retryCreditBroken(prefix: string, msg: string, err: unknown): void {
  log.error("rate-limit", { msg, rule: prefix }, err);
  pageIfSustained(`rate_limit_refund_broken:${prefix}`, prefix, (m) =>
    refundFailedAlert(friendlyRateArea(prefix), m),
  );
}

/**
 * A confirm from this address was refused because the time was taken: earn it one retry past
 * the edge minute window. Never throws, because the lead's 409 must reach them whatever this
 * does; a failure is logged and paged instead, and leaves them exactly where they were before.
 */
export async function grantBookingRetryCredit(ip: string): Promise<void> {
  // Never counted, so never credited: crediting the fallback would share one credit among
  // every caller we could not identify (#1557).
  if (judgeCaller(BOOKING_LIMITER, ip) !== "identified") return;
  try {
    await retryCredits.earn(ip);
  } catch (err) {
    retryCreditBroken(BOOKING_RETRY_CREDIT_RULES[0].prefix, "retry credit not earned", err);
  }
}

/**
 * The native minute window refused this address: may an earned credit carry it through?
 * Only `"allowed"` lets it through. Every other answer keeps the 429, including a store we
 * could not read (`"unreadable"`), because an exemption we cannot check is not granted.
 */
export async function bookingRetryCredit(
  ip: string,
): Promise<RetryCreditVerdict | "unreadable" | "unjudged"> {
  if (judgeCaller(BOOKING_LIMITER, ip) !== "identified") return "unjudged";
  try {
    return await retryCredits.judge(ip, Date.now());
  } catch (err) {
    retryCreditBroken(BOOKING_RETRY_CREDIT_RULES[1].prefix, "retry credit unreadable", err);
    return "unreadable";
  }
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
 * old DB per-minute rules; the hourly ceilings behind them are `exactCeilingWithinLimit`
 * (#3416), in the same Durable Object rather than the DB. Three separate
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

/**
 * Whether a lead landing page may look up the identity in its link (#3106): the per minute
 * edge window, then the exact hourly cap. A false answer is never a refusal of the page; the
 * caller draws the ordinary booker with nothing prefilled and no existing call named.
 */
export async function landingIdentityAllowed(ip: string): Promise<boolean> {
  if (!(await edgeWithinLimit(ip, LANDING_LIMITER))) return false;
  return allowRequest(
    { kind: "address", ip, policy: LANDING_LIMITER },
    LANDING_IDENTITY_HOURLY_RATE_RULES,
  );
}

/**
 * Whether a lead may check or press Call me now (#3718): the per minute edge window, then
 * the exact hourly cap. A false answer hides the button; booking a time is untouched.
 */
export async function callMeNowAllowed(ip: string): Promise<boolean> {
  if (!(await edgeWithinLimit(ip, CALL_ME_NOW_LIMITER))) return false;
  return allowRequest({ kind: "address", ip, policy: CALL_ME_NOW_LIMITER }, CALL_ME_NOW_HOURLY_RATE_RULES);
}

/**
 * Failed credentials on the key authenticated routes (#3142), per address. Asked ONLY once a
 * credential has been refused, so a caller with a good key never spends it. Fails OPEN + LOUD
 * like the rest; the request it judges is refused either way.
 */
export async function bearerFailureWithinLimit(ip: string): Promise<boolean> {
  return edgeWithinLimit(ip, BEARER_FAILURE_LIMITER);
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
      reportUnidentifiedCaller(spec);
      return verdict === "serve-unjudged";
    }
  }
  let env: Record<string, unknown>;
  try {
    env = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch (err) {
    // ONE report, not one per ceiling: the context is what both checks need, so an unreadable
    // one is a single fact about this request rather than two independent failures.
    alertEdgeLimiterDown(spec, `the limiter threw: ${String(err)}`);
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
      alertEdgeLimiterDown(
        spec,
        `the ${spec.binding} binding is missing, so the ${spec.area} throttle is OFF`,
      );
      return true;
    }
    const { success } = await limiter.limit({ key: `${spec.nativeKeyPrefix ?? ""}${key}` });
    if (!success && spec.alertOnBlock) {
      // Best-effort, like the DB path: the alert writes to alert_state, so a
      // failed alert must never turn a block into a thrown error for the caller.
      alertBestEffort(
        `rate_limit_blocked:${spec.area}`,
        // The window is the spec's own `perMinute` rather than a literal passed in beside it,
        // so the copy can never name a limit the binding does not enforce.
        limiterBlockedAlert(spec.friendly, key, spec.perMinute, 60),
        spec.area,
      );
    }
    return success;
  } catch (err) {
    alertEdgeLimiterDown(spec, `the limiter threw: ${String(err)}`);
    return true; // fail open
  }
}

/** How often a broken limiter may re-alert. Long enough not to spam a channel during
 *  a sustained outage, short enough that nobody sits blind for a shift. Declared above the
 *  gate below, which reads it when the module loads. */
const LIMITER_BROKEN_COOLDOWN_MS = 30 * 60_000;

/** Every fail open and failed refund on THIS isolate, counted per alert key (#3670).
 *
 *  A page goes out only once `LIMITER_FAIL_OPEN_PAGE_AFTER` of them land on one key inside
 *  `LIMITER_FAIL_OPEN_WINDOW_MS`, and then at most once per `LIMITER_BROKEN_COOLDOWN_MS`. One
 *  failed count used to page on its own (`rate_limit_broken:landing:h`, 2026-10-13, with the
 *  counter answering again minutes later), and "we probably shouldn't alert on one instance".
 *
 *  Counted in memory, never in a shared store, for two reasons. The alert's real throttle is
 *  alert_state, in Postgres, so even ATTEMPTING a page costs a DB round-trip; these are hot
 *  paths, and the limiter is likeliest to fail under exactly the traffic flood it exists to
 *  absorb, so anything per request would answer a dead limiter with a database query on every
 *  one of those requests. And the store most likely to be failing is the one that would hold
 *  the count (L345): the Durable Object behind the exact ceilings, or the database behind
 *  `rate_limit_hit`. So this gate also keeps the alert's round trips bounded, as the per area
 *  attempt gate it replaces did; alert_state still throttles the page across isolates. */
const newFailOpenGate = () =>
  makeSustainedFailureGate<true>({
    pageAfter: LIMITER_FAIL_OPEN_PAGE_AFTER,
    windowMs: LIMITER_FAIL_OPEN_WINDOW_MS,
    cooldownMs: LIMITER_BROKEN_COOLDOWN_MS,
  });
let failOpenGate = newFailOpenGate();

/** Tests only: forget every count and log stamp this isolate holds, so a case cannot inherit a
 *  run, a cooldown or a log gate from the one before it. */
export function resetLimiterAlertGatesForTests(): void {
  failOpenGate = newFailOpenGate();
  lastEdgeLogMs.clear();
}

/** Count one failure under `key`, and page, worded from what was counted, only when that makes
 *  the run sustained. Returns how many failures this isolate holds for the key in the window, so
 *  the log line can carry it. */
function pageIfSustained(key: string, label: string, text: (m: MeasuredFailures) => string): number {
  const verdict = failOpenGate.record(key, Date.now(), true);
  if (verdict.page) {
    alertBestEffort(
      key,
      text({ count: verdict.inWindow, windowMs: LIMITER_FAIL_OPEN_WINDOW_MS, atLeast: verdict.truncated }),
      label,
    );
  }
  return verdict.inWindow;
}

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

function alertEdgeLimiterDown(
  cfg: { area: string; friendly: string },
  reason: string,
): void {
  // #1525: decide FIRST whether this is even about production. Off the Workers runtime
  // the fail-open is expected and says nothing about the deployed limiter, so paging on
  // it is a false alarm sent from a laptop to a real on-call, and the live alert store is
  // what a dev server writes to. Silent to Slack, never silent full stop, and under its
  // own wording rather than borrowed outage copy.
  const failure: EdgeLimiterFailure = isWorkersRuntime() ? "outage" : "no-platform";
  const now = Date.now();

  // #3670: counted on every failure, paged only on a sustained run, and never off the
  // runtime, where nothing is counted at all because nothing is about production.
  const inWindow =
    failure === "outage"
      ? pageIfSustained(`rate_limit_broken:${cfg.area}`, cfg.area, (m) => limiterFailOpenAlert(cfg.friendly, m))
      : null;

  // The raw reason (a missing binding, or String(err) that off-platform is a Next.js
  // config stack trace) goes to the LOGS, never to the human-facing Slack line. A single
  // fail open is ONLY this line now (#3670), so it carries how many this isolate has seen
  // in the paging window.
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
      log.error("rate-limit", { msg: "limiter failing open", area: cfg.area, reason, in_window: inWindow });
    }
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
    if (policy) reportUnidentifiedCaller(policy);
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
      //
      // #3670: and paged only on a sustained run, counted on this isolate, so one failed
      // count is this log line and nothing more. This path used to attempt a page (an
      // alert_state round trip) on EVERY failure; the gate bounds that too.
      const inWindow = pageIfSustained(`rate_limit_broken:${rule.prefix}`, rule.prefix, (m) =>
        limiterFailOpenAlert(friendlyRateArea(rule.prefix), m),
      );
      log.error("rate-limit", { msg: "rate_limit_hit failed", rule: rule.prefix, in_window: inWindow }, error);
      continue; // fail open
    }
    if (data === false) {
      // #796: a block on a machine-to-machine ceiling is itself news. The caller is meant to
      // be our own auto-booker sitting well inside its budget, so a rejection means either the
      // ceiling is too tight (we are now failing real bookings that used to succeed) or the key
      // has leaked. Until #418 lands there is no other way to see this. Best-effort, as above.
      if (rule.alertOnBlock) {
        alertBestEffort(
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
 * How long one hit may wait for the edge counter (#3416): the same deadline the Supabase request
 * it replaced had, inside the same call budget, so the moment an unanswering counter fails open
 * is the moment the Postgres one did.
 */
export const EXACT_CEILING_DEADLINE_MS = SUPABASE_FETCH_TIMEOUT_MS;

/**
 * The label a hit is charged under in a confirm's profile (#3300). Its own dependency, so a run
 * reads the counter's time apart from Supabase's rather than inside it.
 */
const EXACT_CEILING_CALL_LABEL = "edge-counter";

/**
 * The booking API's EXACT ceilings (#3416): the hourly per caller and per address limits, counted
 * per request in the `BURST_LIMITER` Durable Object that already holds the per minute burst
 * windows, instead of in a `rate_limit_hit` row.
 *
 * A drop in replacement for `allowRequest` on these rules, and deliberately nothing more. A burst
 * of a hundred confirms used to make two hundred Supabase round trips here before reaching the
 * confirm line, and those queued in front of the one confirm that would book (load run
 * 37547143303, upstream p95 4 to 9 seconds while every statement took milliseconds). Everything
 * the security control decides is kept as it was:
 *
 *  - the limits, the window and its arithmetic (`hitAnchoredWindow`, `rate_limit_hit`'s own);
 *  - the key, `${rule.prefix}:${callerKey}`, so a count is shared exactly where a row was;
 *  - a caller with no address, decided at the key by the limit's own policy (#1557), uncounted;
 *  - a refusal is `false`, a refused hit still counts, and a rule with `alertOnBlock` pages on
 *    the block under the same key and words;
 *  - and the FAILURE DIRECTION: a count that cannot be made (no context, no binding, an object
 *    that errors, does not answer inside the deadline, or answers for another window) fails
 *    OPEN, exactly as `allowRequest` continues past an unreadable row, and LOUD, under the same
 *    `rate_limit_broken:<prefix>` key and the same plain words. The page is gated per isolate
 *    like every edge limiter's (`alertEdgeLimiterDown`): a single failure is a log line, a
 *    sustained run pages (#3670), an outage costs one alert read per half hour rather than one
 *    per request, and off the Workers runtime it is logged, never paged (#1525).
 */
export async function exactCeilingWithinLimit(caller: CallerKey, rules: RateLimitRule[]): Promise<boolean> {
  const verdict = judgeCaller(callerPolicy(caller), rateLimitKey(caller));
  if (verdict !== "identified") {
    const policy = callerPolicy(caller);
    if (policy) reportUnidentifiedCaller(policy);
    return verdict === "serve-unjudged";
  }
  const key = rateLimitKey(caller);
  for (const rule of rules) {
    const count = await countExactHit(rule, key);
    // Fail open, as `allowRequest` does on an unreadable row; the failure was reported inside.
    if (count === null) continue;
    if (!exactCeilingAllows(count, rule.max)) {
      if (rule.alertOnBlock) {
        alertBestEffort(
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
 * One hit against one exact ceiling, answered with the count INCLUDING it, or null when the count
 * could not be made, which the caller reads as fail open. Never throws: every failure is reported
 * here under the rule's own area, once per isolate per cooldown.
 */
async function countExactHit(rule: RateLimitRule, key: string): Promise<number | null> {
  const cfg = { area: rule.prefix, friendly: friendlyRateArea(rule.prefix) };
  let env: Record<string, unknown>;
  try {
    env = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch (err) {
    alertEdgeLimiterDown(cfg, `the limiter threw: ${String(err)}`);
    return null;
  }
  const ns = env[BURST_LIMITER_BINDING] as DurableObjectishNamespace | undefined;
  if (!ns) {
    alertEdgeLimiterDown(cfg, `the ${BURST_LIMITER_BINDING} binding is missing, so the ${rule.prefix} ceiling is OFF`);
    return null;
  }
  const windowMs = rule.windowSeconds * 1000;
  try {
    const stub = ns.get(ns.idFromName(exactCeilingKey(rule.prefix, key)));
    // The signal the deadline adds is not handed to the stub: the race below ends the wait
    // whether or not the object honours it, and nothing here depends on the stub accepting one.
    const res = await fetchWithinBudget(
      (input, init) =>
        stub.fetch(String(input), { method: init?.method, headers: init?.headers, body: init?.body }),
      "https://burst-limiter.slate/count",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hit: { windowMs } }),
      },
      EXACT_CEILING_DEADLINE_MS,
      EXACT_CEILING_CALL_LABEL,
    );
    if (!res.ok) throw new Error(`the counter answered ${res.status}`);
    const reply = readExactCeilingReply(await res.json(), windowMs);
    if (!reply.ok) throw new Error(reply.detail);
    return reply.count;
  } catch (err) {
    alertEdgeLimiterDown(cfg, `the exact ceiling could not be counted: ${String(err)}`);
    return null;
  }
}

/**
 * Say that a request arrived with no client address, once per limit per cooldown (#1557).
 *
 * Reported rather than silently handled: behind Cloudflare this cannot happen, so it means
 * something is in front of us that should not be, and a ceiling that has quietly stopped
 * applying looks exactly like a ceiling nobody is hitting. Best effort like every other alert
 * on these paths, because a monitoring failure must never become a booking failure.
 */
function reportUnidentifiedCaller(policy: AddressLimitPolicy): void {
  // Sent after the response, outside the call budget, for the reason on `alertBestEffort`.
  afterResponse("rate-limit-alert", () =>
    // alert-key: rate_limit_unidentified:*
    sendThrottledAlert(
      `rate_limit_unidentified:${policy.area}`,
      LIMITER_BROKEN_COOLDOWN_MS,
      unidentifiedCallerAlert(policy),
    ).catch((err) => {
      log.error("rate-limit", { msg: "unidentified-caller report failed", area: policy.area }, err);
    }),
  );
}

/** Alert without ever letting the alert's own failure escape. The alert writes to
 *  alert_state, so whatever broke the limiter can break the alert too, and a monitoring
 *  failure must never become a booking failure.
 *
 *  #3145 (L1017): sent AFTER the response and outside the call budget, never from inside
 *  the request. Every limiter fact is noticed inside one, and on the booking confirm,
 *  reschedule and manage routes that is the lead's budget: a page sent from there inherits
 *  it, so a budget already spent (a limiter slow to fail spends it) refuses the page's own
 *  alert_state read and the outage is never said, and an awaited page holds the lead's
 *  response for a Slack send. Every page in this module passes through here or
 *  `reportUnidentifiedCaller`, so deciding it here covers each site, present and future.
 *  The same reasoning as the Google breaker's page (#3134). */
function alertBestEffort(key: string, text: string, label: string): void {
  afterResponse("rate-limit-alert", () =>
    // alert-key: rate_limit_blocked:*
    // alert-key: rate_limit_broken:*
    // alert-key: rate_limit_refund_broken:*
    sendThrottledAlert(key, LIMITER_BROKEN_COOLDOWN_MS, text).catch((err) => {
      log.error("rate-limit", { msg: "alert failed", label }, err);
    }),
  );
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
      // #3670: one failed refund is this log line; a sustained run pages with its count.
      const inWindow = pageIfSustained(`rate_limit_refund_broken:${rule.prefix}`, rule.prefix, (m) =>
        refundFailedAlert(friendlyRateArea(rule.prefix), m),
      );
      log.error("rate-limit", { msg: "rate_limit_refund failed", rule: rule.prefix, in_window: inWindow }, error);
    }
  }
}

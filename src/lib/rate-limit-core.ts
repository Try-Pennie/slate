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
 * Per-contact public-booking hourly cap (#1033). A second bound alongside the
 * per-IP cap above, keyed on the attendee's contact (email, phone) instead of
 * their IP. The per-IP cap alone can't stop a distributed bot that spreads fake
 * bookings across many IPs; keying on the identity it REUSES catches that, and a
 * genuine lead books once (the odd retry after a taken-slot 409 is rare), so 5/hr
 * leaves comfortable headroom while blocking identity reuse. A block here is an
 * expected event (a spammy visitor), so it does NOT alert, exactly like the
 * per-IP cap. Distinct prefix so it never shares a counter with the per-IP rule.
 */
export const BOOKING_CONTACT_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "book:contact:h", windowSeconds: 3600, max: 5 },
];

/**
 * Normalize an attendee into stable, discriminated rate-limit keys so the SAME
 * person maps to one counter regardless of formatting: email lowercased+trimmed,
 * phone reduced to digits (mirroring how numbers are normalized for webhooks, so
 * "(203) 561-5295" and "+1 203 561 5295" don't count as two identities (a
 * leading country code is kept, never dropped). Blank/missing fields are skipped
 * so a bot submitting an empty field can't share one global blank-keyed counter.
 * The "email:"/"phone:" discriminator keeps an email from ever colliding with a
 * phone under the shared rule prefix.
 */
export function contactRateKeys(attendee: {
  email?: string | null;
  phone?: string | null;
}): string[] {
  const keys: string[] = [];
  const email = (attendee.email ?? "").trim().toLowerCase();
  if (email) keys.push(`email:${email}`);
  const phoneDigits = (attendee.phone ?? "").replace(/\D/g, "");
  if (phoneDigits) keys.push(`phone:${phoneDigits}`);
  return keys;
}

/**
 * Direct booking API (#355) hourly ceiling, keyed per API KEY rather than per IP
 * (one bot behind one IP legitimately does ~2000/day, which would instantly blow
 * the per-IP public-booking limits). Sized well above expected volume so it only
 * ever trips on a runaway loop or a leaked key; fails open like the per-IP rules.
 *
 * The per-minute burst window (120/min) moved to the Cloudflare edge limiter
 * (BOOKINGAPI_RATE_LIMITER, #961) so it no longer costs a DB round-trip on each
 * call; only the strict hourly cap stays here (the native binding can't express a
 * 1-hour window).
 */
export const DIRECT_BOOKING_API_HOURLY_RATE_RULES: RateLimitRule[] = [
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
 *
 * The per-minute backstop (60/min) moved to the edge limiter (BOOKINGAPI_IP_RATE_LIMITER,
 * #961), which keeps the alert-on-block signal (a block means the ceiling is too tight
 * or a key leaked); only the hourly backstop stays here.
 */
export const DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:ip:h", windowSeconds: 3600, max: 1200, alertOnBlock: true },
];

/**
 * Read endpoints (lookup/list, #386/#392) get their OWN hourly ceiling, with
 * distinct key prefixes so they draw from a separate bucket than writes (#393).
 * Status polling is cheap and bursty, so frequent reads must never eat into the
 * write budget and throttle the booking path they exist to support. Sized ~5x the
 * write ceiling; fails open like the rest. The per-minute window (600/min) moved
 * to the edge limiter (BOOKINGAPI_READ_RATE_LIMITER, #961).
 */
export const DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:read:h", windowSeconds: 3600, max: 30000 },
];

/**
 * The validate-only bookable check (#541/#1017) gets its OWN modest hourly
 * ceiling, deliberately NOT the ~30k/hr status-poll read budget: each call runs
 * the real per-slot routing (round-robin + verify-on-book), so it is far heavier
 * than a status poll and must not be able to hammer that path at poll rates.
 * Sized like /api/routing (~200/hr), with its own prefix so it shares no counter
 * with the write/read/lookup budgets; the per-IP backstop still applies on top.
 */
export const BOOKABLE_CHECK_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "bookapi:bookable:h", windowSeconds: 3600, max: 200 },
];

/**
 * Routing preview API (#596) hourly ceiling, keyed per IP. The standalone
 * /api/routing endpoint is unauthenticated and does a DB-backed resolve per call,
 * so it needs its own throttle to bound anonymous enumeration and DB load. It has
 * no frontend caller (a diagnostic/preview surface), so it's sized modestly, well
 * above real debugging use but far below abuse. Distinct prefixes so it never
 * shares a counter with the booking paths; fails open like the rest. The
 * per-minute burst window (20/min) moved to the edge limiter (ROUTING_RATE_LIMITER,
 * #961).
 */
/**
 * Client error beacon ceiling (#1368), per IP. Deliberately generous per hour
 * (a genuinely broken page can throw on several interactions before the person
 * gives up) but low enough that one caller cannot drive the endpoint. Unlike the
 * booking rules this one fails CLOSED at the call site: dropping a beacon report
 * costs a log line, while an unmetered public path to Slack costs the pager.
 */
export const CLIENT_ERROR_RATE_RULES: RateLimitRule[] = [
  { prefix: "clienterr:m", windowSeconds: 60, max: 10 },
  { prefix: "clienterr:h", windowSeconds: 3600, max: 60 },
];

export const ROUTING_HOURLY_RATE_RULES: RateLimitRule[] = [
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
  return UNIDENTIFIED_IP;
}

/**
 * The key `clientIp` returns when it cannot identify the caller.
 *
 * Named, and exported, because it is not just a label: it is a SHARED bucket. Behind Cloudflare
 * `cf-connecting-ip` is always set, so this should never occur in production, but any
 * enforcement keyed on it counts unrelated callers against one counter, so a per-address ceiling
 * becomes a global one. `availabilityWithinBurstCeiling` declines to judge it for exactly that
 * reason (#1536, L75): refusing a real lead because we could not tell who they were is worse
 * than serving one, and the per-datacenter check above still applies.
 */
export const UNIDENTIFIED_IP = "unknown";

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
    `The rate limit for ${area} has stopped working, so those requests are ` +
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
    `The ${area} rate limit turned away a request from ${ip} for going over ` +
    `${max} requests per ${humanWindow(windowSeconds)}. If that is our own automated ` +
    `booker, its limit is set too low and real bookings are being rejected. If it is ` +
    `not, an access key may have leaked.`
  );
}

/** A rate-limit refund failed, so a customer may keep losing allowance unfairly. */
export function refundFailedAlert(area: string): string {
  return (
    `Could not restore the ${area} booking allowance for a customer whose ` +
    `booking failed through no fault of their own, so they may be left with less ` +
    `allowance than they should have. An engineer should check the rate-limit refund ` +
    `(the cause is in the logs).`
  );
}

/**
 * Everything Slate knows about one Workers rate-limit binding, in ONE place (#1525, #1556).
 *
 * It started as a bare list of binding names. It is a table now because five facts about each
 * limiter were living apart from each other, and every pair of them could disagree in silence:
 * the sustained limit was in `wrangler.jsonc` and restated in prose comments here, the
 * plain-language area name was at the call site, the block-alert window was hand-passed as a
 * literal beside a binding whose limit it was supposed to describe, and after #1556 there is a
 * burst ceiling per endpoint that only means anything relative to the sustained limit it backs
 * up. A ceiling stated ten lines away from the number it is a multiple of is a number nobody
 * can check (L41).
 *
 * `scripts/test-edge-limiter-bindings.ts` compares this table against `wrangler.jsonc` in both
 * directions, names included and `perMinute` against the real `simple.limit`, so the copy here
 * cannot drift from the thing that actually creates the binding.
 *
 * It lives in this file rather than beside the limiter calls because this half has no
 * Cloudflare imports, so a node test can read it without pulling the runtime in behind it.
 */
interface EdgeLimiterBase {
  /** The binding name in `wrangler.jsonc`, and the key the Worker env is looked up by. */
  binding: string;
  /**
   * Token-safe name for this limiter's own key space. It keys the alert throttle AND, since
   * #1556, the burst counter, so two limiters sharing an area would share one count and the
   * tighter ceiling would be spent by the looser endpoint's traffic.
   */
  area: string;
  /** Plain-language area name for the human-facing Slack alert. Never a binding name. */
  friendly: string;
  /** The sustained ceiling `wrangler.jsonc` configures, per minute, per datacenter. */
  perMinute: number;
  /**
   * The burst ceiling (#1556): the count across every isolate and datacenter that a
   * concurrent burst cannot spread across, per key per minute.
   *
   * Always a large multiple of `perMinute`, never equal to it. The native limiter counts
   * approximately, so making its number exact would be a TIGHTENING that real callers feel:
   * a large office behind one NAT address is a real Pennie lead source, and today's gap is
   * the only reason those leads are not already being turned away. This is the backstop
   * against a flood shaped like a flood, which passes ten times the sustained limit in its
   * first second. `scripts/test-burst-ceiling.ts` asserts the ratio for every entry.
   */
  burstCeilingPerMinute: number;
  /**
   * When true, a BLOCK (not just an outage) is itself news, mirroring the DB path's
   * `alertOnBlock` rule (#796): the caller is meant to be our own bot well inside budget, so
   * a rejection means the ceiling is too tight or a key leaked. The alert copy states
   * `perMinute` above rather than a hand-passed literal.
   */
  alertOnBlock?: boolean;
}

/**
 * What a ceiling does when it cannot tell WHO is calling (#1557).
 *
 * `clientIp` returns `UNIDENTIFIED_IP` when no address header is present, and that value is a
 * SHARED BUCKET rather than an address: every limit keyed on it counts unrelated callers
 * against one counter, so a per-address ceiling silently becomes a global one, and the first
 * thing a global-by-accident ceiling refuses is a real lead (L75).
 *
 *  - `serve`  do not judge this request at all. No counter is touched, so nothing else is
 *             refused on its account. Correct wherever a refusal costs a customer, and only
 *             honest when something ELSE still bounds the caller, which is why the reason
 *             below has to name what that is.
 *  - `refuse` turn it away. Correct where the request is cheap to lose and expensive to
 *             serve unmetered.
 *
 * There is no third answer that counts them together: that IS the defect.
 */
export type UnidentifiedCallerPolicy = "serve" | "refuse";

/**
 * One ceiling keyed on the caller's ADDRESS, and its answer for a caller it cannot identify.
 *
 * Every `keyKind: "ip"` edge limiter satisfies this, and the limits that live only in the
 * database (the client error beacon) declare one directly, so the decision is stated once per
 * ceiling in the same shape wherever the ceiling is enforced.
 */
export interface AddressLimitPolicy {
  /** Token-safe id; keys the report throttle. */
  area: string;
  /** Plain-language name for the human facing Slack line. Never a binding name. */
  friendly: string;
  onUnidentified: UnidentifiedCallerPolicy;
  /** Why that is the right answer HERE, and what still bounds the caller. */
  unidentifiedWhy: string;
}

/**
 * A limiter's key, and whether an address rule applies to it (#1557).
 *
 * An `opaque` key came out of authentication (an API key id, a contact hash), so it can never
 * be the address fallback and the address rule must not be applied to it: an integrator who
 * happened to name a key "unknown" would otherwise be the one caller never counted at all.
 */
export type CallerKey =
  | { kind: "address"; ip: string; policy: AddressLimitPolicy; keyPrefix?: string }
  | { kind: "opaque"; key: string };

/**
 * What an edge limiter is keyed on. `ip` limiters must state their answer for a caller they
 * cannot identify; `api-key` ones cannot meet that case at all (see `CallerKey`).
 */
export type EdgeLimiterSpec =
  | (EdgeLimiterBase & { keyKind: "ip" } & AddressLimitPolicy)
  | (EdgeLimiterBase & { keyKind: "api-key" });

/**
 * How to treat this caller: judge them normally, serve them without judging, or refuse.
 *
 * PURE, and the only place the fallback value is compared against anything. `policy` is null
 * for an opaque key, which is always `identified`.
 */
export type CallerVerdict = "identified" | "serve-unjudged" | "refuse";

export function judgeCaller(policy: AddressLimitPolicy | null, key: string): CallerVerdict {
  if (!policy) return "identified";
  if (key !== UNIDENTIFIED_IP) return "identified";
  return policy.onUnidentified === "serve" ? "serve-unjudged" : "refuse";
}

/** The string a caller descriptor counts under. Never reached for an unjudged caller. */
export function rateLimitKey(caller: CallerKey): string {
  return caller.kind === "opaque" ? caller.key : `${caller.keyPrefix ?? ""}${caller.ip}`;
}

/** The address policy a caller descriptor carries, or null for an opaque key. */
export function callerPolicy(caller: CallerKey): AddressLimitPolicy | null {
  return caller.kind === "address" ? caller.policy : null;
}

/**
 * The client error beacon's ceiling (#1368), which lives only in the database and so has no
 * edge limiter to hang its answer off.
 */
export const CLIENT_ERROR_ADDRESS_POLICY: AddressLimitPolicy = {
  area: "client-error",
  friendly: "client error reports",
  onUnidentified: "refuse",
  unidentifiedWhy:
    "dropping one report costs a log line, while an unmetered public path to Slack costs the pager, so this limit fails closed on a caller it cannot identify exactly as it already fails closed on a limiter it cannot reach",
};

/**
 * The Slack line for a request that arrived with no client address (#1557).
 *
 * Behind Cloudflare `cf-connecting-ip` is always set, so reaching this at all means something
 * is in front of us that should not be. It is reported rather than quietly handled, because a
 * ceiling that has stopped applying looks exactly like a ceiling nobody is hitting.
 *
 * The two policies say different things on purpose: the reader has to know whether anything
 * was actually turned away.
 */
export function unidentifiedCallerAlert(policy: AddressLimitPolicy): string {
  const opener =
    `A request reached ${policy.friendly} with no client address, which should not be ` +
    `possible behind Cloudflare, so something may be in front of us that should not be. `;
  if (policy.onUnidentified === "refuse") {
    return (
      `${opener}It was refused, because ${policy.unidentifiedWhy}. If this repeats, real ` +
      `reports are being lost: check what is terminating requests before the app.`
    );
  }
  return (
    `${opener}Its ceiling was not applied to it, because ${policy.unidentifiedWhy}. Nothing ` +
    `was refused. If this repeats, check what is terminating requests before the app.`
  );
}

/** Availability (#56). The one endpoint anybody on the internet can reach unauthenticated. */
export const AVAILABILITY_LIMITER = {
  binding: "AVAIL_RATE_LIMITER",
  area: "availability",
  friendly: "booking availability",
  keyKind: "ip",
  onUnidentified: "serve",
  unidentifiedWhy:
    "this is a cached read that sits in front of a lead choosing a time, and the slot payload is public data that is cheap to serve; the burst ceiling behind it is per key too, so the compensating bound is that nothing here creates or sends anything",
  perMinute: 30,
  burstCeilingPerMinute: 300,
} as const satisfies EdgeLimiterSpec;

/**
 * The public booking confirm (#237).
 *
 * The burst ceiling is the least load-bearing of the six, and deliberately so: the strict
 * hourly cap behind it (10/hour per address, `BOOKING_HOURLY_RATE_RULES`) lives in Postgres
 * and IS exact, so a burst has never been able to create more than ten bookings from one
 * address in an hour. What the gap did allow was the WORK: sixty confirms in a second each
 * running verify-on-book against Google before the exact cap turned them away. 30/min bounds
 * that, and sits three times above the hourly cap, so it can never be the thing that refuses
 * a lead the exact cap would have allowed.
 */
export const BOOKING_LIMITER = {
  binding: "BOOKING_RATE_LIMITER",
  area: "booking",
  friendly: "public booking",
  keyKind: "ip",
  onUnidentified: "serve",
  unidentifiedWhy:
    "refusing a caller we cannot identify refuses a customer at the last step of the funnel, and the per contact hourly cap still bounds this endpoint without needing an address at all",
  perMinute: 3,
  burstCeilingPerMinute: 30,
} as const satisfies EdgeLimiterSpec;

/** The routing preview (#596/#961): unauthenticated, a DB resolve per call, no lead behind it. */
export const ROUTING_LIMITER = {
  binding: "ROUTING_RATE_LIMITER",
  area: "routing",
  friendly: "routing lookup",
  keyKind: "ip",
  onUnidentified: "serve",
  unidentifiedWhy:
    "this resolves the bucket a landing page books into, so a refusal here stops a lead before the booker ever loads, and the work behind it is one cached database resolve rather than anything that writes",
  perMinute: 20,
  burstCeilingPerMinute: 200,
} as const satisfies EdgeLimiterSpec;

/** Direct booking API writes (#961), keyed per API key. */
export const BOOKING_API_WRITE_LIMITER = {
  binding: "BOOKINGAPI_RATE_LIMITER",
  area: "booking-api",
  friendly: "booking API",
  keyKind: "api-key",
  perMinute: 120,
  burstCeilingPerMinute: 1200,
} as const satisfies EdgeLimiterSpec;

/** The per-address backstop under the per-key ceiling (#597), so one leaked key on one host
 *  cannot spend the whole key budget. A block here is itself a signal. */
export const BOOKING_API_IP_LIMITER = {
  binding: "BOOKINGAPI_IP_RATE_LIMITER",
  area: "booking-api-ip",
  friendly: "booking API",
  keyKind: "ip",
  onUnidentified: "serve",
  unidentifiedWhy:
    "this is a backstop UNDER the per key ceiling, and that ceiling is keyed on an id that came from authentication, so an integrator whose address we cannot read is still bounded by their key's own budget",
  perMinute: 60,
  burstCeilingPerMinute: 600,
  alertOnBlock: true,
} as const satisfies EdgeLimiterSpec;

/** Direct booking API reads (#393), keyed per API key. Status polling is cheap and bursty, so
 *  this window is ~5x the write one and must never starve the booking path. */
export const BOOKING_API_READ_LIMITER = {
  binding: "BOOKINGAPI_READ_RATE_LIMITER",
  area: "booking-api-read",
  friendly: "booking API",
  keyKind: "api-key",
  perMinute: 600,
  burstCeilingPerMinute: 6000,
} as const satisfies EdgeLimiterSpec;

/** Every edge limiter, in the one list the tests and the monitor lane walk. */
export const EDGE_LIMITERS = [
  AVAILABILITY_LIMITER,
  BOOKING_LIMITER,
  ROUTING_LIMITER,
  BOOKING_API_WRITE_LIMITER,
  BOOKING_API_IP_LIMITER,
  BOOKING_API_READ_LIMITER,
] as const;

export type EdgeLimiterBinding = (typeof EDGE_LIMITERS)[number]["binding"];

/** The binding names alone, which is what the monitor lane's health check walks (#1525). */
export const EDGE_LIMITER_BINDINGS: readonly EdgeLimiterBinding[] = EDGE_LIMITERS.map(
  (l) => l.binding,
);

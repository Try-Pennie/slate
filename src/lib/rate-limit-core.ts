/**
 * Pure pieces of the per-IP rate limiting (#31): key derivation and the
 * booking policy. No imports, so scripts/test-rate-limit.ts can run it
 * node-native; the DB-backed check lives in rate-limit.ts.
 */
// A type only import: erased when this runs, so the module still loads with no imports.
import type { LimiterAudience } from "./rate-limit-burst";

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
 * The retry credit behind the public booking's edge minute window (#3364), as two
 * `rate_limits` keys per address: what a taken time refusal EARNED, and what a request
 * the native window refused has SPENT. `src/lib/rate-limit-retry-credit.ts` holds the
 * decision and the reasoning for the bound; these are here so the prune derives them like
 * every other limiter row (L41). Earned first, spent second, which the module relies on.
 *
 * The `max` on both is the cap (`RETRY_CREDIT_CAP`, three), restated as a literal because
 * this module imports nothing at runtime; scripts/test-booking-retry-credit.ts pins them
 * equal.
 */
export const BOOKING_RETRY_CREDIT_RULES: RateLimitRule[] = [
  { prefix: "book:retry:earned", windowSeconds: 60, max: 3 },
  { prefix: "book:retry:spent", windowSeconds: 60, max: 3 },
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
 * call. The native binding can't express a 1-hour window, so this strict hourly cap
 * stayed in Postgres until #3416, which moved it into the edge counter's Durable
 * Object (`exactCeilingWithinLimit`): counted exactly, per request, under the same
 * key, with the same limit and the same fail open direction. It is still declared
 * here, beside the other limits, and the authorizer is the only place it is spent.
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
 * or a key leaked). The hourly backstop is this rule, counted exactly in the edge
 * counter's Durable Object since #3416 (it was a Postgres row before), still paging
 * on a block.
 *
 * **This is the tightest bound on one address that is EXACT** (#2339). The per-minute
 * edge ceiling in front of it is approximate and per location, so it can allow several
 * times its own number inside one window, and the Durable Object ceiling behind that is
 * exact but sits at ten times the sustained limit. So this number, and not the 60, is
 * what a single flooding host really meets, and it is what the load run's ceiling control
 * aims at (`scripts/loadtest/ip-ceiling-control.ts`).
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

/**
 * The CSP violation report ceiling (#2565). Higher than the client error beacon's
 * because one broken page legitimately produces one report per blocked resource
 * per load rather than one per person, and low enough that a flood cannot turn a
 * public unauthenticated path into unbounded log volume.
 */
export const CSP_REPORT_RATE_RULES: RateLimitRule[] = [
  { prefix: "cspreport:m", windowSeconds: 60, max: 30 },
  { prefix: "cspreport:h", windowSeconds: 3600, max: 300 },
];

export const ROUTING_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "routing:h", windowSeconds: 3600, max: 200 },
];

/**
 * The admin's webhook test send (#1951), keyed on the admin who pressed it.
 *
 * It is an outbound fetch to an address the caller typed, so it needs a ceiling
 * like every other outbound path. The numbers are set for a person pressing a
 * button while reading the response: a handful in a minute is normal use, and
 * fifty in an hour is nobody debugging a payload shape. Both windows exist
 * because the minute alone lets a script sustain 600 an hour, and the hour alone
 * lets all fifty go out in one second.
 *
 * DB rules rather than an edge limiter, because an edge limiter is a wrangler
 * binding and a deploy config change, and this path is a few requests a week
 * rather than a hot one.
 */
export const WEBHOOK_TEST_SEND_RATE_RULES: RateLimitRule[] = [
  { prefix: "whtest:m", windowSeconds: 60, max: 6 },
  { prefix: "whtest:h", windowSeconds: 3600, max: 50 },
];

/**
 * The exact hourly cap on landing identity lookups per address (#3106), behind the per minute
 * edge window (`LANDING_LIMITER`, below). It counts LOOKUPS rather than distinct ids: that
 * bounds distinct ids at the same number, needs no new table, and the only cost of counting a
 * lead's own reloads is that a lead past thirty in an hour types their details in, since over
 * the cap is a page with no prefill rather than a refusal.
 */
export const LANDING_IDENTITY_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "landing:h", windowSeconds: 3600, max: 30 },
];

/**
 * Call me now on the inline booker (#3718), per address per hour. Each ask costs up to
 * three Salesforce calls (a token, the lead, the switch) against the org's daily API
 * allowance, and the contact check behind it should not be guessable at speed. A real
 * lead checks once when the card draws and presses once, so twenty an hour is far past
 * anybody genuine; over it the button is hidden and booking a time is untouched.
 */
export const CALL_ME_NOW_HOURLY_RATE_RULES: RateLimitRule[] = [
  { prefix: "cmn:h", windowSeconds: 3600, max: 20 },
];

/**
 * The coordinator booking page (#4205), per signed in coordinator. A lookup costs up to
 * four Salesforce calls (a token, the Lead, the submission, the score's history) against
 * the org's daily API allowance, and a placement re-reads the Lead before it books. A
 * coordinator on the phone handles a call every few minutes, so these are far past
 * anybody genuine and bound a script or a stuck page. DB rules, keyed on the user, like
 * the webhook test send: an admin action that is not a hot path.
 */
export const COORDINATOR_LOOKUP_RATE_RULES: RateLimitRule[] = [
  { prefix: "coord-lookup:m", windowSeconds: 60, max: 20 },
  { prefix: "coord-lookup:h", windowSeconds: 3600, max: 300 },
];
export const COORDINATOR_PLACE_RATE_RULES: RateLimitRule[] = [
  { prefix: "coord-place:m", windowSeconds: 60, max: 10 },
  { prefix: "coord-place:h", windowSeconds: 3600, max: 120 },
];

/**
 * Every DB limiter rule above, in one list, so the prune below covers each one by
 * construction (#3109). scripts/test-rate-limit-prune.ts reads this module's
 * exports and fails when a rule set exists that this list leaves out.
 *
 * The four booking API sets (the per caller, per address, read and bookable check
 * hourly ceilings) are counted in the edge counter since #3416 and write no row any
 * more. They stay listed so the rows written before that move age out through the
 * same prune as everything else, rather than sitting in the table for ever.
 */
const DB_RATE_LIMIT_RULE_SETS: readonly RateLimitRule[][] = [
  BOOKING_HOURLY_RATE_RULES,
  BOOKING_CONTACT_HOURLY_RATE_RULES,
  BOOKING_RETRY_CREDIT_RULES,
  DIRECT_BOOKING_API_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES,
  DIRECT_BOOKING_API_READ_HOURLY_RATE_RULES,
  BOOKABLE_CHECK_HOURLY_RATE_RULES,
  CLIENT_ERROR_RATE_RULES,
  CSP_REPORT_RATE_RULES,
  ROUTING_HOURLY_RATE_RULES,
  WEBHOOK_TEST_SEND_RATE_RULES,
  LANDING_IDENTITY_HOURLY_RATE_RULES,
  CALL_ME_NOW_HOURLY_RATE_RULES,
  COORDINATOR_LOOKUP_RATE_RULES,
  COORDINATOR_PLACE_RATE_RULES,
];

/**
 * How far past the longest limiter window a row must be before the prune takes it
 * (#3109). A row older than its own window is already dead: the next hit resets
 * it in place, exactly as a fresh insert would. The margin is there so a row is
 * never judged on the edge of its window, and it is far wider than any clock
 * difference, since the age is measured on the database's own clock anyway.
 */
export const RATE_LIMIT_PRUNE_MARGIN_SECONDS = 3600;

/**
 * A count kept in `rate_limits` under `${prefix}:${signature}` that decides nothing
 * about a caller (#3176): the error boundary's catch count (#1974) and the count of
 * reports from pages Slate does not serve (#2755), and the opaque cross origin
 * script error burst count with its per address row (#3323). They borrow `rate_limit_hit`
 * for its atomic rolling window, so they need pruning like a limiter row, but they
 * are not limiter rules and their window is their own.
 *
 * Declared here rather than beside their writer (`src/lib/api/boundary-count.ts`)
 * so the prune and the writer read one list: a prefix renamed in one place and not
 * the other would leave the old key space growing with nothing to say so.
 * scripts/test-rate-limit-prune.ts fails when any other file names one of these
 * prefixes itself.
 */
export interface WindowCounter {
  prefix: string;
  windowSeconds: number;
}

/** The window the boundary counters count over: 30 minutes, equal to the
 *  boundary alert's cooldown (see `BOUNDARY_WINDOW_MS`). */
export const BOUNDARY_COUNT_WINDOW_SECONDS = 30 * 60;

export const BOUNDARY_CATCH_COUNTER: WindowCounter = {
  prefix: "boundary_count",
  windowSeconds: BOUNDARY_COUNT_WINDOW_SECONDS,
};

export const UNRECOGNISED_PAGE_COUNTER: WindowCounter = {
  prefix: "unrecognised_page_count",
  windowSeconds: BOUNDARY_COUNT_WINDOW_SECONDS,
};

/** The window opaque cross origin script errors are counted over (#3323): 15
 *  minutes. How it was sized is beside `OPAQUE_BURST_THRESHOLD`. */
export const OPAQUE_SCRIPT_ERROR_WINDOW_SECONDS = 15 * 60;

/** One row per surface and ADDRESS that sent an opaque report in the window
 *  (#3323), so a browser reloading is counted once. The address is already held
 *  for the same caller by the beacon's own limiter rows (`clienterr:*`), for longer. */
export const OPAQUE_SCRIPT_ERROR_ADDRESS_COUNTER: WindowCounter = {
  prefix: "opaque_script_error_address",
  windowSeconds: OPAQUE_SCRIPT_ERROR_WINDOW_SECONDS,
};

/** How many distinct addresses sent an opaque report on one surface in the window
 *  (#3323): the figure the burst page is decided on. */
export const OPAQUE_SCRIPT_ERROR_BURST_COUNTER: WindowCounter = {
  prefix: "opaque_script_error_count",
  windowSeconds: OPAQUE_SCRIPT_ERROR_WINDOW_SECONDS,
};

/** Every window counter, which is exactly what the counter group of the prune covers. */
export const WINDOW_COUNTERS: readonly WindowCounter[] = [
  BOUNDARY_CATCH_COUNTER,
  UNRECOGNISED_PAGE_COUNTER,
  OPAQUE_SCRIPT_ERROR_ADDRESS_COUNTER,
  OPAQUE_SCRIPT_ERROR_BURST_COUNTER,
];

/** `prune_rate_limits` refuses an age under an hour, so no group is planned below it. */
const PRUNE_FLOOR_SECONDS = 3600;

export interface RateLimitPruneGroup {
  name: "limiter" | "window-counter";
  prefixes: string[];
  olderThanSeconds: number;
}

/**
 * What the `rate_limits` prune may delete (#3109, #3176): rows under a LIMITER
 * prefix or a WINDOW COUNTER prefix whose window opened more than that group's
 * `olderThanSeconds` ago.
 *
 * Scoped by prefix, never by age alone, because the same table holds the cron
 * lanes' streak counters (`recordConsecutiveStreak`), whose windows run to hours
 * and are not listed anywhere a prune could read. Deleting one mid streak would
 * reset the count and hold back a page. Every key here is `${prefix}:${key}`,
 * which is the whole of what this relies on.
 *
 * Each group is aged from its OWN longest window, so the counters are not held for
 * the limiters' hour and a limiter row is never judged on a counter's half hour.
 */
export function rateLimitPrunePlan(): RateLimitPruneGroup[] {
  const group = (
    name: RateLimitPruneGroup["name"],
    windows: readonly { prefix: string; windowSeconds: number }[],
  ): RateLimitPruneGroup => ({
    name,
    prefixes: [...new Set(windows.map((w) => w.prefix))],
    olderThanSeconds: Math.max(
      Math.max(...windows.map((w) => w.windowSeconds)) + RATE_LIMIT_PRUNE_MARGIN_SECONDS,
      PRUNE_FLOOR_SECONDS,
    ),
  });
  return [group("limiter", DB_RATE_LIMIT_RULE_SETS.flat()), group("window-counter", WINDOW_COUNTERS)];
}

export interface RateLimitPruneDeps {
  /** Deletes the planned rows and returns how many. THROWS on a database error:
   *  a failed delete scored as zero reads as nothing needing cleanup (#1165). */
  prune: (prefixes: string[], olderThanSeconds: number) => Promise<number>;
}

/**
 * One delete statement per group, sized by `rateLimitPrunePlan`. Each group runs
 * whether or not the other failed, and any failure is thrown after both have had
 * their turn, so one refused delete still fails the lane without costing the
 * other group its night.
 */
export async function pruneRateLimits(deps: RateLimitPruneDeps): Promise<{
  deleted: number;
  groups: Array<{ name: RateLimitPruneGroup["name"]; deleted: number; olderThanSeconds: number }>;
}> {
  const plan = rateLimitPrunePlan();
  const settled = await Promise.allSettled(plan.map((g) => deps.prune(g.prefixes, g.olderThanSeconds)));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  const groups = plan.map((g, i) => ({
    name: g.name,
    deleted: (settled[i] as PromiseFulfilledResult<number>).value,
    olderThanSeconds: g.olderThanSeconds,
  }));
  return { deleted: groups.reduce((sum, g) => sum + g.deleted, 0), groups };
}

// Availability (#56) no longer uses a DB rule: it's throttled at the edge by
// the AVAIL_RATE_LIMITER Workers binding (wrangler.jsonc, 30/min per datacenter)
// so the slot-cache hot path never makes a DB round-trip just to rate-limit. The
// old hourly cap was dropped (low-and-slow scraping of public, cached slot data
// is cheap); the per-minute edge limit is the protection.

/**
 * The client IP for rate-limit keying. Cloudflare sets cf-connecting-ip on
 * every request; x-forwarded-for's FIRST hop is the client elsewhere (dev).
 *
 * An IPv6 address comes back as its /64 (#3107): see `rateLimitAddress`.
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return rateLimitAddress(cf.trim());
  const xff = headers.get("x-forwarded-for");
  if (xff) return rateLimitAddress(xff.split(",")[0]!.trim());
  return UNIDENTIFIED_IP;
}

/**
 * The address a per address ceiling counts under (#3107).
 *
 * IPv4 is returned as is. IPv6 is reduced to its /64 (`2001:db8:1:2::/64`), because an
 * ordinary allocation to one subscriber is a whole /64, so a counter on the full /128 handed
 * any caller 2^64 fresh counters for the price of changing the address on each request. An
 * IPv4 mapped address (`::ffff:a.b.c.d`) is its IPv4. Anything that does not parse is
 * returned unchanged: it is still one stable key for whoever sent it, which is what the
 * counter needs, and dropping it to the shared fallback would merge unrelated callers.
 */
export function rateLimitAddress(raw: string): string {
  let addr = raw.trim().toLowerCase();
  if (!addr.includes(":")) return raw.trim();
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) return mapped[1]!;
  // The same address written in hex (`::ffff:cb00:7107`). Its top 64 bits are all zero, so
  // left to the /64 reduction below it would put every mapped caller in ONE counter.
  const mappedHex = /^(?:::|(?:0{1,4}:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return raw.trim();
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // A trailing embedded IPv4 counts as two groups; it can only ever sit in the low 64 bits.
  const groupsIn = (gs: string[]) => gs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const missing = 8 - groupsIn(head) - groupsIn(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return raw.trim();
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const prefix = groups.slice(0, 4);
  if (!prefix.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw.trim();
  return `${prefix.map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
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
  if (prefix.startsWith("landing")) return "lead landing pages";
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

/**
 * How many fail opens, in one area on one server, inside `LIMITER_FAIL_OPEN_WINDOW_MS`, before
 * a person is paged (#3670). One failed count is a finished event: the request was served, the
 * next one is counted again, and on 2026-10-13 the counter answered minutes after the single
 * failure that paged. An outage reaches every request on the server, so it crosses five quickly
 * wherever there is traffic; the ongoing state of the deployment is the monitor lane's own
 * condition (`edge_limiter_unusable`), and the burst counter answering is proved daily
 * (`verify:burst-counter`). Per server because a count across servers would need a shared
 * write on the request path during the very outage it reports.
 */
export const LIMITER_FAIL_OPEN_PAGE_AFTER = 5;
/** The window those fail opens must fall in. */
export const LIMITER_FAIL_OPEN_WINDOW_MS = 10 * 60_000;

/** What a fail open page measured: how many, over what window, and whether that is a floor. */
export interface MeasuredFailures {
  count: number;
  windowMs: number;
  /** True when older failures inside the window were not kept, so `count` is a floor. */
  atLeast: boolean;
}

function measuredCount({ count, atLeast }: MeasuredFailures, noun: string, plural: string): string {
  return `${atLeast ? "At least " : ""}${count} ${count === 1 ? noun : plural}`;
}

/**
 * Requests that could not be counted against their limit and were served anyway (#3670). Says
 * the count, the window and that it is one server, which is all it measured; never that the
 * limit "has stopped working right now", an ongoing state only the monitor lane measures (L11).
 */
export function limiterFailOpenAlert(area: string, m: MeasuredFailures): string {
  const one = m.count === 1 && !m.atLeast;
  return (
    `${measuredCount(m, "request", "requests")} could not be counted against the rate limit for ` +
    `${area} in the last ${humanWindow(m.windowMs / 1000)} on one server, so ` +
    `${one ? "it was" : "they were"} let through with no cap. Requests still succeed; this is a ` +
    `safeguard, not an outage. An engineer should check the rate limiter (the cause is in the ` +
    `logs under tag=rate-limit).`
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

/** Rate-limit refunds that failed, so customers may keep losing allowance unfairly (#3670: the
 *  count it measured, paged on the same sustained rule as a fail open). */
export function refundFailedAlert(area: string, m: MeasuredFailures): string {
  const one = m.count === 1 && !m.atLeast;
  return (
    `${measuredCount(m, "attempt", "attempts")} to give back booking allowance for ${area} could ` +
    `not be made in the last ${humanWindow(m.windowMs / 1000)} on one server. ` +
    `${one ? "It was" : "Each was"} owed to a customer whose booking failed through no fault of ` +
    `their own, so they may be left with less allowance than they should have. An engineer ` +
    `should check the rate-limit refund (the cause is in the logs under tag=rate-limit).`
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
   * Set only on a limiter that SHARES its binding with another (#3106). The native counter is
   * keyed per binding, so a second endpoint on one binding counts under this prefix and never
   * spends the first endpoint's allowance. Its burst count is already separate, by `area`.
   */
  nativeKeyPrefix?: string;
  /**
   * Who calls this endpoint (#1565): a lead's browser, or a machine (an integrator, or our own
   * bot). It decides where the burst ceiling starts counting precisely: a lead facing limiter
   * escalates at the shared `BURST_ESCALATE_AT`, a machine one at its own sustained limit
   * (`burstEscalateAt` in `@/lib/rate-limit-burst`, which holds the reasoning).
   */
  audience: LimiterAudience;
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
 * The CSP report endpoint's answer for a caller it cannot identify (#2565), the
 * same one the client error beacon gives and for the same reason.
 */
export const CSP_REPORT_ADDRESS_POLICY: AddressLimitPolicy = {
  area: "csp-report",
  friendly: "CSP violation reports",
  onUnidentified: "refuse",
  unidentifiedWhy:
    "dropping one report costs a line in a log nobody is waiting on, while an unmetered public path that writes costs more, so this limit fails closed on a caller it cannot identify exactly as it already fails closed on a limiter it cannot reach",
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
  audience: "lead",
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
  audience: "lead",
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
  audience: "lead",
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
  audience: "machine",
  perMinute: 120,
  burstCeilingPerMinute: 1200,
} as const satisfies EdgeLimiterSpec;

/**
 * The per-address backstop under the per-key ceiling (#597), so one leaked key on one host
 * cannot spend the whole key budget. A block here is itself a signal.
 *
 * **`perMinute` is APPROXIMATE, per Cloudflare location, and eventually consistent (#2339).**
 * Measured on 2026-09-14: 180 writes from one address in 20 seconds, with the binding present
 * and answering, were ALL allowed against this 60. That is the documented behaviour of the
 * native binding, not a fault, so nothing may treat this number as a bound. The two bounds on
 * one address that really refuse are `burstCeilingPerMinute` below (a Durable Object, exact
 * across isolates) and `DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES` (exact, counted per request
 * in the same Durable Object since #3416, in Postgres before). Raising or
 * lowering this shapes a well behaved caller and does not bound abuse.
 */
export const BOOKING_API_IP_LIMITER = {
  binding: "BOOKINGAPI_IP_RATE_LIMITER",
  area: "booking-api-ip",
  friendly: "booking API",
  keyKind: "ip",
  audience: "machine",
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
  audience: "machine",
  perMinute: 600,
  burstCeilingPerMinute: 6000,
} as const satisfies EdgeLimiterSpec;

/**
 * The customer's own manage link (#1046): cancel, reschedule, and the phone edit.
 *
 * These are the only unauthenticated WRITE paths that had no throttle at all. Guessing
 * a manage token is infeasible (nanoid(24), about 143 bits) and the reschedule lock
 * bounds hammering one real booking, so this is not about a caller getting in; it is
 * about what a caller who is not getting in costs. Every garbage token was a database
 * round trip nothing counted.
 *
 * 20 a minute is far above any real customer: cancelling or moving one appointment is a
 * handful of requests, and the phone edit one. It is deliberately edge only, with no
 * hourly cap in the database behind it, because the whole point is to refuse before the
 * request reaches Postgres and an hourly cap would put the round trip back.
 */
export const MANAGE_LIMITER = {
  binding: "MANAGE_RATE_LIMITER",
  area: "manage",
  friendly: "booking manage links",
  keyKind: "ip",
  audience: "lead",
  onUnidentified: "serve",
  unidentifiedWhy:
    "the only way to reach a booking here is to already hold its unguessable manage token, so a caller we cannot identify can still act only on the one appointment somebody sent them the link for, and the reschedule lock bounds repeat attempts on it",
  perMinute: 20,
  burstCeilingPerMinute: 200,
} as const satisfies EdgeLimiterSpec;

/**
 * The lead landing pages' identity lookup (#3106): `/book?external_id=` and `/booking/{id}`.
 *
 * Those pages read the stored name, email and phone for the Salesforce id in the link and
 * prefill the form with them, and a lead id has a fixed `00Q` prefix and is not a secret, so
 * an unthrottled page is an enumeration oracle for contact details, and every guess bought
 * several database reads. This ceiling never refuses a lead: a caller over it gets the
 * ordinary booker with nothing prefilled and no existing call named, which a real lead can
 * still book through and an enumerator learns nothing from.
 *
 * It shares `MANAGE_RATE_LIMITER` rather than adding a binding, because a binding is a deploy
 * time change and the two endpoints want the same per minute number; `nativeKeyPrefix` keeps
 * the two counts apart. The exact hourly cap is `LANDING_IDENTITY_HOURLY_RATE_RULES` (above).
 */
export const LANDING_LIMITER = {
  binding: "MANAGE_RATE_LIMITER",
  nativeKeyPrefix: "landing:",
  area: "landing",
  friendly: "lead landing pages",
  keyKind: "ip",
  audience: "lead",
  onUnidentified: "refuse",
  unidentifiedWhy:
    "a refusal here costs the lead only the prefill, never the booker, so a caller we cannot identify is shown the ordinary form rather than counted into a bucket every such caller shares",
  perMinute: 20,
  burstCeilingPerMinute: 200,
} as const satisfies EdgeLimiterSpec;

/**
 * Call me now on the inline booker (#3718), keyed per address. Shares
 * `MANAGE_RATE_LIMITER` under its own key prefix, as the landing lookup does, rather than
 * adding a binding (a deploy time change). The exact hourly cap is
 * `CALL_ME_NOW_HOURLY_RATE_RULES`.
 */
export const CALL_ME_NOW_LIMITER = {
  binding: "MANAGE_RATE_LIMITER",
  nativeKeyPrefix: "cmn:",
  area: "call-me-now",
  friendly: "Call me now",
  keyKind: "ip",
  audience: "lead",
  onUnidentified: "refuse",
  unidentifiedWhy:
    "a refusal here costs the lead only the Call me now button, never booking a time, so a caller we cannot identify is not counted into a bucket every such caller shares",
  perMinute: 20,
  burstCeilingPerMinute: 200,
} as const satisfies EdgeLimiterSpec;

/**
 * Failed credentials on the key authenticated routes (#3142), keyed per address and counted
 * only on the failure path, so a caller holding a good key never spends it.
 *
 * Guessing a key is not the concern; the cost of a flood is. A refused booking API request
 * still schedules the retired key watch and records an outcome, and every refusal writes a
 * log line, so a stream of garbage tokens bought unmetered work. Past this ceiling the
 * caller is answered 429 and none of that work runs.
 *
 * It shares `BOOKINGAPI_IP_RATE_LIMITER` under its own key prefix rather than adding a
 * binding (a deploy time change), and does not alert on a block: a flood of bad tokens is
 * the thing being shaped, not news about our own bot.
 */
export const BEARER_FAILURE_LIMITER = {
  binding: "BOOKINGAPI_IP_RATE_LIMITER",
  nativeKeyPrefix: "authfail:",
  area: "bearer-failure",
  friendly: "failed API credentials",
  keyKind: "ip",
  audience: "machine",
  onUnidentified: "serve",
  unidentifiedWhy:
    "the request is refused for its credential either way, so declining to count a caller we cannot identify changes nothing it is told and only skips a throttle on work that is already a refusal",
  perMinute: 60,
  burstCeilingPerMinute: 600,
} as const satisfies EdgeLimiterSpec;

/** Every edge limiter, in the one list the tests and the monitor lane walk. */
export const EDGE_LIMITERS = [
  AVAILABILITY_LIMITER,
  BOOKING_LIMITER,
  ROUTING_LIMITER,
  BOOKING_API_WRITE_LIMITER,
  BOOKING_API_IP_LIMITER,
  BOOKING_API_READ_LIMITER,
  MANAGE_LIMITER,
  LANDING_LIMITER,
  CALL_ME_NOW_LIMITER,
  BEARER_FAILURE_LIMITER,
] as const;

export type EdgeLimiterBinding = (typeof EDGE_LIMITERS)[number]["binding"];

/** The binding names alone, once each, which is what the monitor lane's health check walks
 *  (#1525). Deduplicated because a limiter may share a binding (`nativeKeyPrefix`). */
export const EDGE_LIMITER_BINDINGS: readonly EdgeLimiterBinding[] = [
  ...new Set<EdgeLimiterBinding>(EDGE_LIMITERS.map((l) => l.binding)),
];

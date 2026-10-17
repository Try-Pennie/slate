/**
 * The booking API is turning its own caller away, and nothing says so
 * (#1442, #1450, #1709).
 *
 * Three refusals, one shape. Slate refuses the integration, the refusal is
 * deliberately kept OUT of the booking-failure share, and until now the only
 * trace was a log line with seven days of retention and no alerting on top.
 *
 * ## Why they stay out of the share, and what that costs
 *
 * `attempts` in the #1313 window is every recorded outcome summed, so counting a
 * noisy caller's refusals would put that caller's volume in the DENOMINATOR a
 * real outage has to move, making the outage look proportionally smaller exactly
 * while it is happening. That decision is right and is recorded per path in
 * `src/lib/booking/refusal-catalog.ts`.
 *
 * What it costs is this: one benign refusal and a systemic one arrive on the
 * identical path and are indistinguishable (L77), which is the 2026-08-06 cal.com
 * shape with a different cause. So each is measured against its OWN total here,
 * never against the share.
 *
 * ## Three signals, judged three different ways
 *
 * They are not one check with three inputs, because "one of these happened" means
 * something different in each case:
 *
 *  - **ceiling**: one trip is the control working. A sustained SHARE of write
 *    attempts refused by our own limit means the ceiling is wrong for the bot's
 *    real volume, so leads are being turned away by us. Judged as a share, with a
 *    floor, like the failure rate beside it.
 *  - **credential**: a rejected key has no benign explanation from OUR
 *    integration. But the endpoint is public, so a single 401 is as likely to be
 *    an internet scanner with a junk bearer, and paging on that would teach
 *    everyone to ignore the key (L36). Judged on PERSISTENCE across intervals
 *    instead: a scanner's probe lands in one, a locked-out integration refuses in
 *    every one. A MISSING secret is a different fact with a different repair and
 *    pages on the first, because only our own deploy can produce it.
 *  - **list**: one unreadable page is a blip the caller's retry clears; a run of
 *    them is the bookings table unreadable, which nothing else sees until the
 *    automated booker goes live and the write path starts failing beside it.
 *
 * All three are **conditions** in `alert-catalog.ts`, so each owes an all-clear,
 * and each all-clear hangs off a MEASURED clear verdict rather than off "we did
 * not page this run" (#1134, #1152). That is why `unmeasured` exists as its own
 * status and is neither: a window with nothing in it has not found the ceiling
 * healthy, it has failed to look.
 *
 * No `@/` imports, so scripts/test-api-refusal-signals.ts drives every branch
 * node-natively.
 *
 * #1727 adds the EMBED booker's three refusals at the end of the file, on the same
 * window and the same rules: conditions, measured clears only, `unmeasured` apart.
 */
import type { EmbedRefusalThresholds } from "./embed-refusal-thresholds.ts";

/** One alert_state key per signal, shared by the page and its all-clear, so the
 *  two can never drift onto different keys and leave a page nothing can clear. */
export const CEILING_ALERT_KEY = "booking_api_ceiling";
export const CREDENTIAL_ALERT_KEY = "booking_api_credential";
export const LIST_ALERT_KEY = "booking_api_list_read";

/**
 * One interval's measured DELTAS, the same 5-minute samples the failure-rate
 * window already accumulates. Deltas rather than totals for the same reason as
 * #1313: the underlying tally is cumulative per ET day, so only the difference
 * between two consecutive readings measures an interval.
 */
export interface RefusalSample {
  atMs: number;
  /** Booking write attempts recorded in this interval: the failure share's own
   *  denominator, reused here so the ceiling share is of everything the caller
   *  actually sent. */
  attempts: number;
  /** Write-path trips of the per-key ceiling, which bounds total volume. */
  ceilingKey: number;
  /** Write-path trips of the per-IP backstop, which bounds any ONE host. Kept
   *  apart from the key ceiling because the repair is a different number. */
  ceilingIp: number;
  /** Bookings list reads refused with LIST_UNAVAILABLE. */
  listRead: number;
  /** Write-path API_KEY_REJECTED refusals. */
  credentialRejected: number;
  /** Write-path API_NOT_CONFIGURED refusals. */
  credentialNotConfigured: number;
  /** #1727: the embed booker's hourly address cap trips. */
  embedIpHour: number;
  /** #1727: the embed booker's per contact cap trips. */
  embedContactHour: number;
  /** #1727: the embed booker's hidden bot trap trips. */
  embedHoneypot: number;
}

/**
 * The limits the page NAMES, passed in rather than written here (L41).
 *
 * The repair for a ceiling page is a number in `src/lib/rate-limit-core.ts`, so
 * the message has to say which number. Copying the values into this file would
 * make the alert quietly lie the first time somebody changed one, and a message
 * with a stale figure is worse than one with none: a reader who checks it once
 * and finds it right stops checking (L316). The caller derives them from the real
 * rules, and this module keeps no `@/` imports.
 */
export interface CeilingLimits {
  /** Requests per hour the per-key ceiling allows. */
  keyPerHour: number;
  /** Requests per minute the per-key edge burst window allows. */
  keyPerMinute: number;
  /** Requests per hour the per-IP backstop allows. */
  ipPerHour: number;
  /** Requests per minute the per-IP edge burst window allows. */
  ipPerMinute: number;
}

export interface RefusalThresholds {
  /** How far back each signal reaches. */
  windowMs: number;
  /** Below this many ceiling refusals in the window, the share is not judged. */
  ceilingMinRefusals: number;
  /** Share of everything the caller sent that must be EXCEEDED to page. */
  ceilingPct: number;
  /** How many DISTINCT intervals must carry a rejected key before it is a
   *  lockout rather than a passing scanner. */
  credentialMinSamples: number;
  /** The same, for an unreadable bookings page. */
  listMinSamples: number;
}

/** Which of the two ceilings is doing the refusing. */
export type CeilingScope = "key" | "ip";

export type CeilingVerdict =
  | { status: "unmeasured" }
  | { status: "clear"; refusals: number; sent: number }
  | { status: "paging"; dominant: CeilingScope; key: number; ip: number; sent: number; pct: number };

/** Which credential fact is being reported. They have different repairs, so they
 *  are different causes rather than one with a longer sentence (L11). */
export type CredentialCause = "rejected" | "not_configured";

export type CredentialVerdict =
  | { status: "unmeasured" }
  | { status: "clear" }
  | { status: "paging"; cause: CredentialCause; total: number; intervals: number };

export type ListVerdict =
  | { status: "unmeasured" }
  | { status: "clear" }
  | { status: "paging"; total: number; intervals: number };

export interface RefusalVerdicts {
  ceiling: CeilingVerdict;
  credential: CredentialVerdict;
  list: ListVerdict;
}

/**
 * Turn the failure-rate window's own samples into this check's shape.
 *
 * The two checks read ONE window on purpose: it is already advanced, already
 * persisted, and already rebased correctly at the ET day rollover, and a second
 * copy of that machinery would be two things that must agree about what "an
 * hour" means (L53). Nothing here touches `attempts` or `failures`, so the
 * failure share is exactly what it was.
 *
 * A sample written before migration 0113 carries no `refusals` key. That reads as
 * "not measured in that interval" rather than as zero refusals, which is the
 * honest reading: the persistence checks count INTERVALS that carried a refusal,
 * and an absent key contributes no interval in either direction.
 */
export function samplesFromWindow(
  samples: { atMs: number; attempts: number; refusals?: Record<string, number> }[],
): RefusalSample[] {
  return samples.map((s) => ({
    atMs: s.atMs,
    attempts: s.attempts,
    ceilingKey: s.refusals?.refused_ceiling_key ?? 0,
    ceilingIp: s.refusals?.refused_ceiling_ip ?? 0,
    listRead: s.refusals?.refused_list_read ?? 0,
    credentialRejected: s.refusals?.refused_key_wrong ?? 0,
    credentialNotConfigured: s.refusals?.refused_not_configured ?? 0,
    embedIpHour: s.refusals?.refused_embed_ip_hour ?? 0,
    embedContactHour: s.refusals?.refused_embed_contact_hour ?? 0,
    embedHoneypot: s.refusals?.refused_embed_honeypot ?? 0,
  }));
}

/** Samples still inside the window. Strictly older than the cutoff goes; one
 *  exactly on the boundary is still inside, matching `prune` in the failure-rate
 *  window so two checks in one lane cannot disagree about what "an hour" means. */
function within(samples: RefusalSample[], atMs: number, windowMs: number): RefusalSample[] {
  const cutoff = atMs - windowMs;
  return samples.filter((s) => s.atMs > cutoff);
}

const sum = (rows: RefusalSample[], pick: (s: RefusalSample) => number): number =>
  rows.reduce((n, s) => n + pick(s), 0);

/** How many DISTINCT intervals carried at least one of something. This is the
 *  measurement that separates a scanner from a lockout, and a blip from an
 *  outage: both can produce the same TOTAL. */
const intervalsWith = (rows: RefusalSample[], pick: (s: RefusalSample) => number): number =>
  rows.filter((s) => pick(s) > 0).length;

function judgeCeiling(rows: RefusalSample[], t: RefusalThresholds): CeilingVerdict {
  if (rows.length === 0) return { status: "unmeasured" };
  const key = sum(rows, (s) => s.ceilingKey);
  const ip = sum(rows, (s) => s.ceilingIp);
  const refusals = key + ip;
  // Everything the caller SENT, not everything we let through. The refusals are
  // deliberately absent from `attempts`, so a share taken against attempts alone
  // would climb past 100% in exactly the case this exists to catch: a ceiling
  // refusing more than it admits.
  const sent = sum(rows, (s) => s.attempts) + refusals;
  if (refusals < t.ceilingMinRefusals || sent === 0) {
    return { status: "clear", refusals, sent };
  }
  const pct = Math.round((refusals / sent) * 100);
  // EXCEEDED, not merely met, matching the failure share's own convention so two
  // thresholds in one lane cannot mean different things.
  if (pct <= t.ceilingPct) return { status: "clear", refusals, sent };
  return { status: "paging", dominant: key >= ip ? "key" : "ip", key, ip, sent, pct };
}

function judgeCredential(rows: RefusalSample[], t: RefusalThresholds): CredentialVerdict {
  if (rows.length === 0) return { status: "unmeasured" };
  const missing = sum(rows, (s) => s.credentialNotConfigured);
  // The missing secret is checked FIRST and pages on one, because it is the fact
  // that explains every call failing and the only one nobody outside Pennie could
  // have caused. Reaching the rejected branch first would answer for it with a
  // sentence naming the wrong repair.
  if (missing > 0) {
    return {
      status: "paging",
      cause: "not_configured",
      total: missing,
      intervals: intervalsWith(rows, (s) => s.credentialNotConfigured),
    };
  }
  const rejectedIntervals = intervalsWith(rows, (s) => s.credentialRejected);
  if (rejectedIntervals >= t.credentialMinSamples) {
    return {
      status: "paging",
      cause: "rejected",
      total: sum(rows, (s) => s.credentialRejected),
      intervals: rejectedIntervals,
    };
  }
  return { status: "clear" };
}

function judgeList(rows: RefusalSample[], t: RefusalThresholds): ListVerdict {
  if (rows.length === 0) return { status: "unmeasured" };
  const intervals = intervalsWith(rows, (s) => s.listRead);
  if (intervals < t.listMinSamples) return { status: "clear" };
  return { status: "paging", total: sum(rows, (s) => s.listRead), intervals };
}

/**
 * All three verdicts from one window. Judged independently: a ceiling page must
 * not drag the other two with it, or one condition would clear three alerts and
 * a reader could not tell what had actually ended.
 */
export function judgeRefusalSignals(
  samples: RefusalSample[],
  atMs: number,
  thresholds: RefusalThresholds,
): RefusalVerdicts {
  const rows = within(samples, atMs, thresholds.windowMs);
  return {
    ceiling: judgeCeiling(rows, thresholds),
    credential: judgeCredential(rows, thresholds),
    list: judgeList(rows, thresholds),
  };
}

const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m === 1 ? "1 minute" : `${m} minutes`;
};

/**
 * The page copy, one builder per signal, returning null for anything that is not
 * paging so a caller cannot accidentally send an all-clear worded as a page.
 *
 * Each names the repair, because the repair for each of these is a different
 * number in a different place and "rate limited" is not something a reader
 * holding a phone can act on. None opens with the word Slate: in Slack these
 * arrive under Slate's own app name, so the label repeats the header and pushes
 * the one useful fact further along the line.
 */
export const refusalSignalCopy = {
  ceiling(v: CeilingVerdict, windowMs = 60 * 60_000, limits?: CeilingLimits): string | null {
    if (v.status !== "paging") return null;
    // No limits supplied means no numbers claimed. Naming the ceiling without its
    // figure is still actionable; naming a WRONG figure is not (L11).
    const figures = (perHour: number, perMinute: number) =>
      ` (${perHour} an hour, plus a ${perMinute} a minute burst window)`;
    const which =
      v.dominant === "key"
        ? `the per key hourly ceiling${limits ? figures(limits.keyPerHour, limits.keyPerMinute) : ""}`
        : `the per IP backstop${limits ? figures(limits.ipPerHour, limits.ipPerMinute) : ""}`;
    return (
      `The booking API is refusing ${v.pct}% of what its caller sends, using our own rate ceiling. ` +
      `Over the last ${minutes(windowMs)}: ${v.key} refused by the per key ceiling and ${v.ip} by the ` +
      `per IP backstop, out of ${v.sent} requests. The one doing most of it is ${which}. ` +
      `If this is the real booker rather than abuse, every lead in those requests was turned away by us: ` +
      `raise the limit in src/lib/rate-limit-core.ts. Diagnose via tag=booking-api reason=throttled_key.`
    );
  },
  credential(v: CredentialVerdict, windowMs = 60 * 60_000): string | null {
    if (v.status !== "paging") return null;
    if (v.cause === "not_configured") {
      return (
        `The booking API has no key configured, so it is refusing every call. ` +
        `${v.total} refused in the last ${minutes(windowMs)}. This is a deployment gap rather than a ` +
        `caller holding a stale key: set each caller's booking API key on the Worker (BOOKING_API_KEY_REGAL, _TRYPENNIE, _CANARY, _MARCIA) and redeploy. ` +
        `Diagnose via tag=booking-api reason=not_configured.`
      );
    }
    return (
      `The booking API is rejecting its caller's key. ${v.total} refused across ${v.intervals} separate ` +
      `intervals in the last ${minutes(windowMs)}, which is a rotated or wrong key at the integration ` +
      `rather than a passing scanner. Every lead it handles is being refused until the key is fixed. ` +
      `Check the key the caller holds against the one the Worker has. ` +
      `Diagnose via tag=booking-api reason=bad_credential.`
    );
  },
  list(v: ListVerdict, windowMs = 60 * 60_000): string | null {
    if (v.status !== "paging") return null;
    return (
      `The bookings list could not be read ${v.total} times across ${v.intervals} separate intervals in ` +
      `the last ${minutes(windowMs)}. The caller is refused and retries the same cursor, so nothing is ` +
      `lost, but its sync has stalled. The same table is on the booking write path. ` +
      `Diagnose via tag=booking-api msg="list read failed".`
    );
  },
};

/** The all-clear for each signal, sent only off a MEASURED clear verdict. */
export const refusalAllClear = {
  ceiling: "The booking API is no longer refusing a meaningful share of what its caller sends.",
  credential: "The booking API is accepting its caller's key again.",
  list: "The bookings list is readable again.",
};

// ============================================================================
// The EMBED BOOKER's own refusals (#1727)
// ============================================================================
//
// The surface real leads arrive on, so more important than the API path above, not
// less. Three refusals of the same shape: the hourly address cap, the per contact
// cap, and the hidden bot trap. Each stays out of the failure share and is judged
// here on the same rolling window, from samples the failure rate step already
// advanced and persisted.
//
// The two caps are judged on how many DISTINCT addresses or contact keys the
// limiter is refusing right now, not on how many requests it refused, because one
// bot hammering one identity and forty leads each tripping once produce the same
// volume. That count is read from the limiter's own rows by the caller, and only
// when the window holds a trip at all, so a quiet tick costs no read. Why, and what
// the count cannot see, is in `embed-refusal-thresholds.ts`.

export type { EmbedRefusalThresholds };

/** One alert_state key per signal, shared by the page and its all-clear. */
export const EMBED_IP_CAP_ALERT_KEY = "booking_embed_ip_cap";
export const EMBED_CONTACT_CAP_ALERT_KEY = "booking_embed_contact_cap";
export const EMBED_HONEYPOT_ALERT_KEY = "booking_embed_honeypot";

/** The trip volume in the window, and whether the window holds any interval at all.
 *  `measured: false` is a window with nothing in it, which has not found the booker
 *  healthy, it has failed to look. */
export interface EmbedTrips {
  measured: boolean;
  ipHour: number;
  contactHour: number;
  honeypot: number;
  /** Booking attempts in the same window, for the honeypot page's comparison. */
  attempts: number;
}

export function embedTripsInWindow(samples: RefusalSample[], atMs: number, windowMs: number): EmbedTrips {
  const rows = within(samples, atMs, windowMs);
  return {
    measured: rows.length > 0,
    ipHour: sum(rows, (s) => s.embedIpHour),
    contactHour: sum(rows, (s) => s.embedContactHour),
    honeypot: sum(rows, (s) => s.embedHoneypot),
    attempts: sum(rows, (s) => s.attempts),
  };
}

/**
 * Which locked out counts the caller must read before judging. Only a cap that
 * recorded a trip in the window can be locking anybody out: a key over its limit in
 * a live window was refused inside the last window length, and every refusal is
 * recorded, so a window with none needs no read. That keeps the quiet tick, which
 * is nearly every tick (none in the 167 hours measured), at zero extra subrequests
 * on the invocation four lanes share.
 */
export function lockoutReadsNeeded(trips: EmbedTrips): { addresses: boolean; contactKeys: boolean } {
  return { addresses: trips.measured && trips.ipHour > 0, contactKeys: trips.measured && trips.contactHour > 0 };
}

export type EmbedCapVerdict =
  | { status: "unmeasured" }
  | { status: "clear"; trips: number; lockedOut: number }
  | { status: "paging"; trips: number; lockedOut: number; floor: number };

export type HoneypotVerdict =
  | { status: "unmeasured" }
  | { status: "clear"; trips: number; intervals: number }
  | { status: "paging"; trips: number; intervals: number; attempts: number };

export interface EmbedRefusalVerdicts {
  ipCap: EmbedCapVerdict;
  contactCap: EmbedCapVerdict;
  honeypot: HoneypotVerdict;
}

/** The locked out counts the caller read, or null for one it did not need to read.
 *  A null where a read WAS needed is `unmeasured`, never clear. */
export interface EmbedLockouts {
  addresses: number | null;
  contactKeys: number | null;
}

function judgeCap(measured: boolean, trips: number, lockedOut: number | null, floor: number): EmbedCapVerdict {
  if (!measured) return { status: "unmeasured" };
  // No trip in the window: nobody can be locked out, so this is a measured clear
  // without the read (see `lockoutReadsNeeded`).
  if (trips === 0) return { status: "clear", trips: 0, lockedOut: 0 };
  if (lockedOut === null || !Number.isFinite(lockedOut)) return { status: "unmeasured" };
  if (lockedOut >= floor) return { status: "paging", trips, lockedOut, floor };
  return { status: "clear", trips, lockedOut };
}

/** All three verdicts from one window. Judged independently, so one condition
 *  ending can never clear another. */
export function judgeEmbedRefusalSignals(
  samples: RefusalSample[],
  atMs: number,
  t: EmbedRefusalThresholds,
  lockouts: EmbedLockouts,
): EmbedRefusalVerdicts {
  const rows = within(samples, atMs, t.windowMs);
  const trips = embedTripsInWindow(samples, atMs, t.windowMs);
  let honeypot: HoneypotVerdict;
  if (!trips.measured) honeypot = { status: "unmeasured" };
  else {
    const intervals = intervalsWith(rows, (s) => s.embedHoneypot);
    honeypot =
      trips.honeypot >= t.honeypotMinTrips && intervals >= t.honeypotMinIntervals
        ? { status: "paging", trips: trips.honeypot, intervals, attempts: trips.attempts }
        : { status: "clear", trips: trips.honeypot, intervals };
  }
  return {
    ipCap: judgeCap(trips.measured, trips.ipHour, lockouts.addresses, t.addressLockoutFloor),
    contactCap: judgeCap(trips.measured, trips.contactHour, lockouts.contactKeys, t.contactLockoutFloor),
    honeypot,
  };
}

/** The limits each cap page NAMES, derived by the caller from the rules that
 *  actually refuse, never copied here (L41). */
export interface EmbedCapLimits {
  /** Confirms an hour the address cap allows one address. */
  addressPerHour: number;
  /** Confirms an hour the contact cap allows one email or one phone. */
  contactPerHour: number;
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The page copy, null for anything that is not paging. Each names the repair (the
 * rule in `src/lib/rate-limit-core.ts`) and the log tag that tells real leads from a
 * bot, because the page cannot: that is a judgement about WHO the keys belong to,
 * and only the log lines carry enough to make it.
 */
export const embedRefusalCopy = {
  ipCap(v: EmbedCapVerdict, windowMs = 60 * 60_000, limits?: EmbedCapLimits): string | null {
    if (v.status !== "paging") return null;
    const limit = limits ? ` (${limits.addressPerHour} confirms an hour per address)` : "";
    return (
      `The booker's hourly address limit${limit} is refusing ${counted(v.lockedOut, "address", "addresses")} ` +
      `at once, with ${counted(v.trips, "refusal", "refusals")} in the last ${minutes(windowMs)}. One address ` +
      `over the limit is the limit doing its job; this many at once is either a bot spread across many ` +
      `addresses or the limit being wrong for real traffic, in which case leads on those addresses are ` +
      `being turned away by us. If the addresses in tag=booking-rate-limit scope="hourly" look like ordinary ` +
      `visitors, raise BOOKING_HOURLY_RATE_RULES in src/lib/rate-limit-core.ts.`
    );
  },
  contactCap(v: EmbedCapVerdict, windowMs = 60 * 60_000, limits?: EmbedCapLimits): string | null {
    if (v.status !== "paging") return null;
    const limit = limits ? ` (${limits.contactPerHour} confirms an hour per email or phone)` : "";
    return (
      `The booker's per contact limit${limit} is locking out ${counted(v.lockedOut, "email or phone", "emails and phones")} ` +
      `at once, with ${counted(v.trips, "refusal", "refusals")} in the last ${minutes(windowMs)}. One bot ` +
      `reusing an identity locks out one or two; this many means real leads may be retrying and being ` +
      `turned away by us. If the attempts in tag=booking-rate-limit scope="contact" come from many unrelated ` +
      `addresses, raise BOOKING_CONTACT_HOURLY_RATE_RULES in src/lib/rate-limit-core.ts.`
    );
  },
  honeypot(v: HoneypotVerdict, windowMs = 60 * 60_000): string | null {
    if (v.status !== "paging") return null;
    return (
      `The booker's hidden bot trap was filled ${counted(v.trips, "time", "times")} across ${v.intervals} ` +
      `separate intervals in the last ${minutes(windowMs)}, against ${counted(v.attempts, "booking attempt", "booking attempts")}. ` +
      `Nobody can see that field, so either a script is working through the booker, which the trap is ` +
      `absorbing, or the field has become visible or autofillable and real leads are being refused with a ` +
      `generic error. Check whether bookings dropped in the same hour. Diagnose via tag=booking-honeypot.`
    );
  },
};

/** The all-clear for each, sent only off a MEASURED clear verdict. */
export const embedRefusalAllClear = {
  ipCap: "The booker's hourly address limit is no longer refusing several addresses at once.",
  contactCap: "The booker's per contact limit is no longer locking out several people at once.",
  honeypot: "The booker's hidden bot trap is quiet again.",
};

export interface EmbedAlertPlan {
  /** Pages to send, each on its own key. */
  pages: { key: string; text: string }[];
  /** All-clears to settle in one batch, each off a measured clear verdict only. */
  recovered: { key: string; text: string }[];
}

/**
 * What the monitor lane sends for one tick's verdicts, decided here rather than in
 * the route so the rule that matters most is testable node-natively: a paging
 * verdict pages, a CLEAR verdict is offered as an all-clear, and an UNMEASURED one
 * sends nothing in either direction (#1134, #1152).
 */
export function planEmbedRefusalAlerts(
  v: EmbedRefusalVerdicts,
  windowMs: number,
  limits: EmbedCapLimits,
): EmbedAlertPlan {
  const plan: EmbedAlertPlan = { pages: [], recovered: [] };
  const signals = [
    { key: EMBED_IP_CAP_ALERT_KEY, status: v.ipCap.status, text: embedRefusalCopy.ipCap(v.ipCap, windowMs, limits), clear: embedRefusalAllClear.ipCap },
    { key: EMBED_CONTACT_CAP_ALERT_KEY, status: v.contactCap.status, text: embedRefusalCopy.contactCap(v.contactCap, windowMs, limits), clear: embedRefusalAllClear.contactCap },
    { key: EMBED_HONEYPOT_ALERT_KEY, status: v.honeypot.status, text: embedRefusalCopy.honeypot(v.honeypot, windowMs), clear: embedRefusalAllClear.honeypot },
  ];
  for (const s of signals) {
    if (s.text) plan.pages.push({ key: s.key, text: s.text });
    else if (s.status === "clear") plan.recovered.push({ key: s.key, text: s.clear });
  }
  return plan;
}

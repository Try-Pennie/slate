/**
 * A booking whose pool sits BELOW the lead's Salesforce tier (#2593).
 *
 * Slate sends a lead with a blank or unreadable `xbc` to the Low pool (the
 * catch-all, `src/lib/routing/catchall.ts`), and records that it did. The RATE is
 * watched (`catchall_rate`), and a rate cannot see the case the business cares
 * about: one Ultra High lead booked with the Low team does not move a share. The
 * 2026-09-21 incident was 2 bookings in roughly 1,200.
 *
 * WHAT IS COMPARED. Every upcoming, active booking in a real (non test) bucket,
 * NOT only the ones the catch-all chose. The 2026-09-22 correction on the issue
 * showed the incident's bookings never touched a routing form: a booking below
 * the lead's tier can arrive through the catch-all or through a path that never
 * consulted a routing code, so keying on `catchall_applied` would miss half the
 * class. Whether the catch-all chose the pool is carried in the page as context.
 *
 * AGAINST WHAT. The lead's CURRENT `XBC__c`, read from Salesforce each run and
 * decoded through `xbc.ts` (never a second decoder). Reading the current value is
 * what answers the issue's second half: a lead re-scored AFTER booking (422 to 512,
 * four minutes after the first booking) is, from that moment, a booking below the
 * lead's tier, and the same comparison reports it.
 *
 * DIRECTION. Only a lead HIGHER than the pool pages. Equal is the healthy case,
 * and lower is a lead served by a team above their tier, which is not a fault.
 *
 * WHAT IS NOT A COMPARISON. A booking with no lead id, an id that is not a Lead
 * id, a lead Salesforce did not return, a lead with no XBC (`xbc-absent`), a value
 * that does not decode (`xbc-unreadable`), or a pool with no tier. Each is counted
 * under its own reason and none of them is agreement (L11). `absent` and
 * `unreadable` send somebody to two different places: the first is a lead nobody
 * scored, the second is a score written in a shape Slate does not know.
 *
 * WHAT IS NOT LOOKED AT. A booking made from a known test source
 * (`isTestSourceBooking`, #2737): a host page that is not the production site,
 * whether the host declared it or, since #2728, the browser reported framing it. On
 * 2026-09-25 four test bookings on XBC 100 and 112 each carried a real looking
 * `00Q` lead id, so they were compared, and a single one of them was the verdict
 * that un-parked this check and paged "real leads are booking in Slate now". They
 * are excluded before anything is asked of Salesforce, counted as `testSource`,
 * and never cleared as gone. The predicate is the one the off site page uses, but
 * that page reads only bookings MADE in its recent lookback while this reads every
 * upcoming one, so an excluded booking was paged there only if that check was
 * running when it was made (it was not for bookings older than #2715).
 *
 * Pure apart from dependency free helpers, so scripts/test-below-lead-tier.ts
 * drives it directly.
 */
import { DEBT_TIER, bucketSpecForXbc } from "@/lib/xbc";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { isLeadId, leadIdKey } from "@/lib/salesforce/lead-xbc";
import { bookingLeadId } from "@/lib/booking/lookup-identity";
import type { Criteria } from "@/lib/db/types";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { isTestSourceBooking, type BookingOriginFacts } from "./offsite-origin";
import { tierLadder } from "@/lib/routing/tiers";

/** The alert family: one condition per booking, `booking_below_lead_tier:<id>`. */
export const BELOW_LEAD_TIER_KEY = "booking_below_lead_tier";

export function belowLeadTierKey(bookingId: string): string {
  return `${BELOW_LEAD_TIER_KEY}:${bookingId}`;
}

/** The zone the page renders a call's time in, named in the text as ET. */
const ALERT_ZONE = "America/New_York";

/** The columns this check needs off a `bookings` row. */
/** `prefill` and `referrer_origin` are read for the host page the booking was made
 *  from (#2737, #2728), nothing else. */
export interface UpcomingBooking extends BookingOriginFacts {
  id: string;
  bucket_id: string;
  starts_at: string;
  salesforce_id: string | null;
  external_id: string | null;
  agent_name: string | null;
  agent_email: string | null;
}

/** The columns this check needs off a `buckets` row. */
export interface PoolBucket {
  id: string;
  code: string;
  name: string;
  criteria: Criteria;
}

/** A debt tier by its xbc.ts digit: 1 is Low, 5 is Ultra High. */
export interface PoolTier {
  rank: number;
  label: string;
}

export type LeadTier =
  | { kind: "tier"; rank: number; key: string; label: string; code: string }
  | { kind: "absent" }
  | { kind: "unreadable"; value: string };

/**
 * What a lead's XBC decodes to, through `bucketSpecForXbc`.
 *
 * Measured 2026-09-24 over the newest 2,000 leads: 54 percent decode, and 45
 * percent carry a first digit of 0 (`011`, `012`, `000`), which xbc.ts does not
 * know. Those are UNREADABLE, never absent: they are values somebody wrote, and a
 * guess at what tier 0 means would be a second decoder.
 */
export function leadTierOf(xbc: string | null): LeadTier {
  const value = (xbc ?? "").trim();
  if (value === "") return { kind: "absent" };
  if (!bucketSpecForXbc(value)) return { kind: "unreadable", value };
  const digit = value[0];
  const tier = DEBT_TIER[digit];
  return { kind: "tier", rank: Number(digit), key: tier.key, label: tier.label, code: value };
}

/** The xbc.ts digit for a debt_team key, derived from the one table. */
const RANK_BY_KEY = new Map(Object.entries(DEBT_TIER).map(([digit, t]) => [t.key, Number(digit)]));

/**
 * The tier a bucket's pool serves.
 *
 * A seeded bucket's own code says it (the sixty XBC codes). A hand made bucket
 * falls back to the `debt_team` its criteria route on, and a pool spanning tiers
 * is judged by its HIGHEST, because a lead is below the pool only when nobody in
 * it works their tier. No code and no tier is unknown, and unmeasured.
 */
export function poolTierOf(bucket: PoolBucket): PoolTier | null {
  if (bucketSpecForXbc(bucket.code)) {
    const digit = bucket.code[0];
    return { rank: Number(digit), label: DEBT_TIER[digit].label };
  }
  const team = bucket.criteria.debt_team;
  const keys = Array.isArray(team) ? team : typeof team === "string" ? [team] : [];
  let best: number | null = null;
  for (const k of keys) {
    const r = RANK_BY_KEY.get(k);
    if (r !== undefined && (best === null || r > best)) best = r;
  }
  return best === null ? null : { rank: best, label: DEBT_TIER[String(best)].label };
}

// `isLeadId` lives beside the Lead reader now (#2638), since the booking path asks
// the same question; re-exported so this module's callers are unchanged.
export { isLeadId };

/**
 * The lead id a booking carries. The embed writes it to `salesforce_id` and the
 * booking API to `external_id` (defaulting `salesforce_id` from it), so either
 * column can hold it (`lookup-identity.ts`). The first NON-BLANK one wins, by the
 * same rule the lookup API uses (`strongIdsOf`), so a stored "" in
 * `salesforce_id` cannot hide a real `external_id`. The rule lives once, in
 * `bookingLeadId`, which the calling number reads use too (#1334).
 */
export function leadIdOf(b: Pick<UpcomingBooking, "salesforce_id" | "external_id">): string | null {
  return bookingLeadId(b);
}

export type UnmeasuredReason =
  | "no-lead-id"
  | "not-a-lead-id"
  | "pool-tier-unknown"
  | "lead-not-found"
  | "xbc-absent"
  | "xbc-unreadable";

/** Every reason, in the order a summary lists them. */
export const UNMEASURED_REASONS: UnmeasuredReason[] = [
  "no-lead-id",
  "not-a-lead-id",
  "pool-tier-unknown",
  "lead-not-found",
  "xbc-absent",
  "xbc-unreadable",
];

export interface BelowFinding {
  kind: "below";
  booking: UpcomingBooking;
  bucket: PoolBucket;
  pool: PoolTier;
  lead: Extract<LeadTier, { kind: "tier" }>;
}

export type TierComparison =
  | BelowFinding
  | { kind: "agrees"; booking: UpcomingBooking }
  | { kind: "unmeasured"; booking: UpcomingBooking; reason: UnmeasuredReason };

/**
 * Judge each booking. `leads` is keyed by `leadIdKey`, holding what Salesforce
 * returned: a value, null for an empty field, or no entry for no such lead.
 */
export function compareBookingsToLeadTier(
  bookings: UpcomingBooking[],
  buckets: PoolBucket[],
  leads: Map<string, string | null>,
): TierComparison[] {
  const bucketById = new Map(buckets.map((b) => [b.id, b]));
  return bookings.map((booking): TierComparison => {
    const leadId = leadIdOf(booking);
    if (leadId === null) return { kind: "unmeasured", booking, reason: "no-lead-id" };
    if (!isLeadId(leadId)) return { kind: "unmeasured", booking, reason: "not-a-lead-id" };
    const bucket = bucketById.get(booking.bucket_id);
    const pool = bucket ? poolTierOf(bucket) : null;
    if (!bucket || !pool) return { kind: "unmeasured", booking, reason: "pool-tier-unknown" };
    const key = leadIdKey(leadId);
    if (!leads.has(key)) return { kind: "unmeasured", booking, reason: "lead-not-found" };
    const lead = leadTierOf(leads.get(key) ?? null);
    if (lead.kind === "absent") return { kind: "unmeasured", booking, reason: "xbc-absent" };
    if (lead.kind === "unreadable") return { kind: "unmeasured", booking, reason: "xbc-unreadable" };
    if (lead.rank > pool.rank) return { kind: "below", booking, bucket, pool, lead };
    return { kind: "agrees", booking };
  });
}

// --------------------------------------------------------------- the copy

/** One booking's routing record: whether the catch-all chose the pool, the
 *  `xbc` the lead's link arrived with (`routing_decisions.requested_code`), and
 *  whether confirm walked down the tier ladder, and how far. */
export interface RoutingRecord {
  catchall: boolean;
  requestedCode: string | null;
  tierFallback: boolean;
  rungsDropped: number;
}

/**
 * Whether a recorded tier drop at confirm fully explains why the call sits below
 * the lead's tier, which makes it the ladder working as designed rather than a
 * fault.
 *
 * Sales ops decided on 2026-10-02 (Slack, Sam: "For an edge case I'll always
 * choose less friction") that a lead who loses their tier's last opening keeps
 * the time they picked and drops a tier. Booking d6d216f6 was exactly that: a
 * cal.com booking took the last High 10:30 three minutes before the lead
 * confirmed, and this check paged it as "the routing placed the call below the
 * code it was given".
 *
 * Every fact has to line up, or it is not this case and it pages as before:
 *  - the catch-all did not choose the pool, and confirm recorded a drop;
 *  - the lead's tier today is the tier of the code they arrived with, so a lead
 *    re-scored upward since is still paged (#2594);
 *  - the call's team is EXACTLY the rung that many drops below the arrival code,
 *    asked of `tierLadder` so the two cannot disagree about what a rung is (L107).
 */
export function explainedByTierDrop(f: BelowFinding, r: RoutingRecord): boolean {
  if (r.catchall || !r.tierFallback || r.rungsDropped < 1) return false;
  const arrived = leadTierOf(r.requestedCode);
  if (arrived.kind !== "tier" || arrived.rank !== f.lead.rank) return false;
  return tierLadder(arrived.code)[r.rungsDropped] === f.bucket.code;
}

/** What the routing record says for one booking: the record, none at all, or a
 *  read that failed. */
export type RoutingContext = RoutingRecord | null | "unreadable";

/**
 * The sentence saying WHY the call sits below the lead, from what was measured.
 *
 * #2594 is the reason the arrival code is read. A lead re-scored AFTER booking
 * (422 to 512 four minutes after the call was made) and a lead routed below the
 * code it arrived with look identical from the pool and today's score alone, and
 * they send somebody to two different places: the first is a call to move, the
 * second is a routing fault. So when the arrival code decodes, the page names it
 * and its tier and states which one this is. When it does not, it names both
 * possibilities and claims neither (L11).
 */
function routingLine(f: BelowFinding, c: RoutingContext): string {
  if (c === "unreadable") return "Whether the routing catch-all chose this pool could not be read this time.";
  if (c === null) {
    return "Whether the routing catch-all chose this pool is not recorded, which is usual for a booking made without a routing code.";
  }
  if (c.catchall) {
    return "The routing catch-all chose this pool, because the lead's link carried a blank or unreadable code.";
  }
  const arrived = leadTierOf(c.requestedCode);
  // Both causes at once: re-scored since, AND placed below the arrival code too.
  // Naming only the re-score would hide the routing fault.
  if (arrived.kind === "tier" && arrived.rank < f.lead.rank && f.pool.rank < arrived.rank) {
    return (
      `The lead arrived with XBC ${arrived.code} (${arrived.label}) and Salesforce has re-scored ` +
      `them to ${f.lead.label} since, but the routing also placed the call below the code it was given.`
    );
  }
  if (arrived.kind === "tier" && arrived.rank < f.lead.rank) {
    return (
      `The lead arrived with XBC ${arrived.code} (${arrived.label}) and was routed on it, so ` +
      `Salesforce re-scored them to ${f.lead.label} after that link was made.`
    );
  }
  if (arrived.kind === "tier") {
    return (
      `The lead arrived with XBC ${arrived.code} (${arrived.label}), so the score has not risen ` +
      `since: the routing placed the call below the code it was given.`
    );
  }
  return (
    "The routing catch-all did not pick this pool: it was routed on the code the lead arrived " +
    "with, so either that code was lower than Salesforce's score or the lead was scored higher after booking."
  );
}

/**
 * The page for one booking: who the lead is to Salesforce, which team holds the
 * call, when, and what to do. It names the XBC Salesforce holds NOW, because that
 * is what was measured, and, when the routing record holds the code the lead
 * arrived with, names that too, so a lead re-scored after booking (#2594) no
 * longer reads the same as one routed wrongly. Lead contact data is never in it:
 * the booking is named by its link, the lead only by tier and score.
 */
export function formatBelowLeadTierAlert(
  f: BelowFinding,
  routing: RoutingContext,
  bookingUrl: string,
): string {
  const when = `${formatSlotDay(f.booking.starts_at, ALERT_ZONE)} at ${formatSlotTime(f.booking.starts_at, ALERT_ZONE)} ET`;
  const agent = f.booking.agent_name?.trim() || f.booking.agent_email || "an unassigned agent";
  const article = /^[AEIOU]/.test(f.lead.label) ? "An" : "A";
  return (
    `${article} ${f.lead.label} lead is booked with the ${f.pool.label} team: Salesforce scores them ` +
    `XBC ${f.lead.code} today, and the call on ${when} is with ${agent} in bucket ` +
    `${f.bucket.code} (${f.bucket.name}). ${routingLine(f, routing)} ` +
    `Reassign the call to somebody who works ${f.lead.label} leads, or correct the score in ` +
    `Salesforce if it is wrong.\n${bookingUrl}`
  );
}

/**
 * The all clear for one booking, hung off a MEASURED fact: the booking was read
 * this run and now agrees, or the read of upcoming bookings no longer holds it.
 */
export function formatBelowLeadTierRecovery(
  bookingId: string,
  why: "agrees" | "gone",
  bookingUrl: string,
): string {
  if (why === "agrees") {
    return (
      `The call paged about earlier is no longer below the lead's Salesforce tier: it is now ` +
      `with a team that works their tier, either because it moved or because their score came ` +
      `down.\n${bookingUrl}`
    );
  }
  return (
    `The call paged about earlier is no longer upcoming (it was cancelled or its time has ` +
    `passed), so it is no longer with the wrong team.\n${bookingUrl}`
  );
}

// ------------------------------------------------------------- the runner

export type BelowLeadTierResult =
  /** Not measured, so nothing may be claimed in either direction. */
  | { status: "unreadable"; stage: "bookings" | "salesforce"; error: string }
  /**
   * Measured. `compared` counts bookings judged in either direction, which is the
   * number a verdict rests on: unmeasured bookings are counted separately.
   * `paged` is false while disarmed, so an observed run is never read as a sent one.
   */
  | {
      status: "measured";
      compared: number;
      /** Made from a known test source, so neither compared nor unmeasured (#2737). */
      testSource: number;
      /** Findings that page: below the lead's tier and not explained by a drop. */
      below: BelowFinding[];
      /** Below the lead's tier because confirm dropped a tier as designed: counted, not paged. */
      explainedByTierDrop: BelowFinding[];
      unmeasured: Record<UnmeasuredReason, number>;
      paged: boolean;
      cleared: number;
    };

export interface BelowLeadTierDeps {
  /** Upcoming active bookings in real buckets. THROWS on a read error, never answers empty. */
  loadBookings: () => Promise<UpcomingBooking[]>;
  /** The real buckets, for their tiers. */
  buckets: PoolBucket[];
  /** The current XBC per lead, keyed by `leadIdKey`. THROWS when Salesforce refuses. */
  readLeadXbcs: (leadIds: string[]) => Promise<Map<string, string | null>>;
  /** The routing record per booking id, from `routing_decisions`: the catch-all
   *  flag and the arrival code (#2594). Context only, so a failure costs no page. */
  loadRoutingContext: (bookingIds: string[]) => Promise<Map<string, RoutingRecord>>;
  /** Booking ids with an outstanding page in this family. */
  listFiring: () => Promise<Set<string>>;
  bookingUrl: (bookingId: string) => string;
  /** False until somebody has read a few ordinary days: measure and log, send nothing. */
  armed: boolean;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site (#1151, #1400). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
}

/**
 * The monitor lane step: read both sides, judge, page per booking, clear per booking.
 *
 * A read that fails on either side measured nothing: no page, no all clear, and
 * the verdict predicate refuses it. Salesforce is never asked when there is
 * nothing to ask about, so a quiet roster costs no Salesforce call at all.
 *
 * A notify, resolve or context failure is swallowed, because a flaky Slack or a
 * missing routing record must never fail the tick or take out the checks after it.
 */
export async function runBelowLeadTierCheck(deps: BelowLeadTierDeps): Promise<BelowLeadTierResult> {
  let read: UpcomingBooking[];
  try {
    read = await deps.loadBookings();
  } catch (err) {
    return { status: "unreadable", stage: "bookings", error: err instanceof Error ? err.message : String(err) };
  }
  // A test booking is not a lead, so it is not asked about, compared, or cleared.
  const bookings = read.filter((b) => !isTestSourceBooking(b));
  const testSourceIds = new Set(read.filter((b) => isTestSourceBooking(b)).map((b) => b.id));

  // One question per lead, whichever spelling the bookings stored.
  const idsByKey = new Map<string, string>();
  for (const b of bookings) {
    const id = leadIdOf(b);
    if (id !== null && isLeadId(id) && !idsByKey.has(leadIdKey(id))) idsByKey.set(leadIdKey(id), id);
  }

  let leads = new Map<string, string | null>();
  if (idsByKey.size > 0) {
    try {
      leads = await deps.readLeadXbcs([...idsByKey.values()]);
    } catch (err) {
      return { status: "unreadable", stage: "salesforce", error: err instanceof Error ? err.message : String(err) };
    }
  }

  const comparisons = compareBookingsToLeadTier(bookings, deps.buckets, leads);
  const findings: BelowFinding[] = [];
  const unmeasured = Object.fromEntries(UNMEASURED_REASONS.map((r) => [r, 0])) as Record<UnmeasuredReason, number>;
  let compared = 0;
  for (const c of comparisons) {
    if (c.kind === "unmeasured") unmeasured[c.reason]++;
    else compared++;
    if (c.kind === "below") findings.push(c);
  }

  // Read whether or not the check is armed, so a disarmed run counts the same
  // explained findings an armed one would leave unpaged. An unreadable record
  // explains nothing, so every finding still pages (fail toward the page).
  let routing: Map<string, RoutingRecord> | null = null;
  if (findings.length > 0) {
    try {
      routing = await deps.loadRoutingContext(findings.map((f) => f.booking.id));
    } catch {
      routing = null;
    }
  }
  const contextOf = (f: BelowFinding): RoutingContext =>
    routing === null ? "unreadable" : routing.get(f.booking.id) ?? null;
  const below: BelowFinding[] = [];
  const explained: BelowFinding[] = [];
  for (const f of findings) {
    const c = contextOf(f);
    if (c !== null && c !== "unreadable" && explainedByTierDrop(f, c)) explained.push(f);
    else below.push(f);
  }

  let cleared = 0;
  if (deps.armed) {
    if (below.length > 0) {
      for (const f of below) {
        const context = contextOf(f);
        await deps
          .notify(
            belowLeadTierKey(f.booking.id),
            deps.cooldownMs,
            formatBelowLeadTierAlert(f, context, deps.bookingUrl(f.booking.id)),
          )
          .catch(() => {});
      }
    }

    // Driven by what THIS run measured about each paged booking, never by "we did
    // not page it": a booking that became unmeasurable keeps its page (#1134, #1152).
    const firing = await deps.listFiring().catch(() => null);
    if (firing !== null) {
      const byId = new Map(comparisons.map((c) => [c.booking.id, c]));
      for (const id of firing) {
        // Excluded, so not measured this run: it keeps whatever it has (#1134).
        if (testSourceIds.has(id)) continue;
        const c = byId.get(id);
        const why = c === undefined ? "gone" : c.kind === "agrees" ? "agrees" : null;
        if (why === null) continue;
        const sent = await deps
          .resolve(belowLeadTierKey(id), formatBelowLeadTierRecovery(id, why, deps.bookingUrl(id)))
          .catch(() => false);
        if (sent) cleared++;
      }
    }
  }

  return {
    status: "measured",
    compared,
    testSource: testSourceIds.size,
    below,
    explainedByTierDrop: explained,
    unmeasured,
    paged: deps.armed && below.length > 0,
    cleared,
  };
}

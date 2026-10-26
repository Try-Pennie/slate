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
 * AGAINST WHAT. The lead's CURRENT score, read from Salesforce each run and
 * decoded through `xbc.ts` (never a second decoder). Reading the current value is
 * what answers the issue's second half: a lead re-scored AFTER booking (422 to 512,
 * four minutes after the first booking) is, from that moment, a booking below the
 * lead's tier, and the same comparison reports it. Since #3501 that score is the
 * one on the lead's current submission, which is what the booking link carries,
 * and not the Lead record's copy of it, which lagged on two of the first three
 * pages and paged correctly routed calls as re-scores (`readLeadScores`).
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
import { logAlertSendFailure } from "../notify/send-failure.ts";
import { DEBT_TIER, bucketSpecForXbc } from "@/lib/xbc";
import { formatSlotDay, formatSlotTime } from "@/lib/booking/slot-label";
import { isLeadId, leadIdKey, type LeadScore } from "@/lib/salesforce/lead-xbc";
import { partnerKeysFrom } from "@/lib/booking/partner-keys";
import { bookingLeadId } from "@/lib/booking/lookup-identity";
import type { Criteria } from "@/lib/db/types";
import type { ThrottledNotify } from "./alert-deps";
import { isTestSourceBooking, type BookingOriginFacts } from "./offsite-origin";
import { tierLadder } from "@/lib/routing/tiers";
import { parseStampMs } from "@/lib/date/stamp";
import { CHANGE_ONLY_HOLD_MS, type AlertRepeat } from "@/lib/notify/repeat-policy";
import { DateTime } from "luxon";

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
  /** Where the lead's score came from (#3501), when the runner read it; it decides
   *  whether the page may say the booking's own submission was re-scored. */
  score?: LeadScore;
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

// ------------------------------------- is the lead's own team free then (#3665)

/**
 * What the lead's OWN tier pool is offering, as the booker serves it.
 *
 * `offeredMs` and `computedAtMs` are the monitor lane's `SlotHealth` for that code
 * (`slotHealthByCode`): the stored `bucket_slots` row through the org's current
 * hours, the same served list the availability and debt tier checks read, so this
 * page can never disagree with them about what is offered (L107), and it costs no
 * read of its own. `minNoticeMin` is the row's own event type, null when the row
 * does not say.
 */
export interface LeadTierOffer {
  /** null: the row could not be judged (`SlotHealth.offeredMs`). */
  offeredMs: number[] | null;
  /** 0 when the row's stamp could not be read (`SlotHealth.computedAtMs`). */
  computedAtMs: number;
  minNoticeMin: number | null;
}

export type TeamAtTime =
  /** The pool offers the booked start, so somebody on it is free then. */
  | { kind: "free" }
  /** The pool's row covers the start and does not offer it. `nearestMs` is the
   *  offered time closest to it on the same ET day, still ahead, or null for none. */
  | { kind: "not-free"; nearestMs: number | null }
  /** The row cannot answer, and says nothing either way. */
  | { kind: "unchecked"; why: "no-row" | "unreadable" | "inside-notice" | "past-horizon" };

/** The ET calendar day of an instant, for "that day". */
function etDay(ms: number): string | null {
  return DateTime.fromMillis(ms, { zone: ALERT_ZONE }).toISODate();
}

/**
 * Whether anybody on the lead's own team is free at the booked start (#3665).
 *
 * On 2026-10-13 the page asked a manager to reassign booking 899afc25 to the High
 * team at 3:00 PM ET while the 312 pool offered no 3:00 PM at all. So the page is
 * now told what the pool offers.
 *
 * OFFERED is positive evidence and needs nothing else. NOT offered is evidence only
 * where the row could have offered it, so each place it could not is UNCHECKED, never
 * "nobody is free" (L11): no row (`null`), a read that failed (`"unreadable"`), a row
 * or start that cannot be read, a start inside the row's minimum notice when it was
 * computed (the row could never hold it, and a manager's reassign keeps no notice),
 * and a start later than every time offered, which may be past the row's horizon.
 *
 * The nearest alternative is named only from the same list, on the call's own ET day
 * and not yet past at `nowMs`, so every time the page names was measured.
 */
export function teamAtTime(
  offer: LeadTierOffer | null | "unreadable",
  startsAt: string,
  nowMs: number,
): TeamAtTime {
  if (offer === null) return { kind: "unchecked", why: "no-row" };
  if (offer === "unreadable" || offer.offeredMs === null) return { kind: "unchecked", why: "unreadable" };
  const startMs = parseStampMs(startsAt);
  if (startMs === null) return { kind: "unchecked", why: "unreadable" };
  const offered = offer.offeredMs;
  if (offered.includes(startMs)) return { kind: "free" };
  if (offer.computedAtMs <= 0 || offer.minNoticeMin === null) return { kind: "unchecked", why: "unreadable" };
  if (startMs < offer.computedAtMs + offer.minNoticeMin * 60_000) return { kind: "unchecked", why: "inside-notice" };
  if (offered.length === 0 || startMs > Math.max(...offered)) return { kind: "unchecked", why: "past-horizon" };
  const day = etDay(startMs);
  // A day that cannot be named would make every time "that day", so a time named as
  // the nearest would be one nobody measured as being on it.
  if (day === null) return { kind: "unchecked", why: "unreadable" };
  let nearestMs: number | null = null;
  for (const ms of offered) {
    if (ms < nowMs || etDay(ms) !== day) continue;
    const better =
      nearestMs === null ||
      Math.abs(ms - startMs) < Math.abs(nearestMs - startMs) ||
      (Math.abs(ms - startMs) === Math.abs(nearestMs - startMs) && ms < nearestMs);
    if (better) nearestMs = ms;
  }
  return { kind: "not-free", nearestMs };
}

// ------------------------------------- do the lead's submissions agree (#3665)

export type SubmissionHistory =
  /** One tier across what was read, or nothing read: the page adds nothing. */
  | { kind: "steady" }
  /** More than one tier. `read` counts every submission read, `tiers` only those
   *  that decode, most first, the higher tier first on a tie. */
  | { kind: "disagree"; read: number; tiers: { label: string; count: number }[] }
  /** The history read failed. */
  | { kind: "unreadable" }
  /** Not asked: the check is disarmed, so nothing pages. */
  | { kind: "not-read" };

/**
 * Whether a lead's recent submission scores disagree on the TIER (#3665), decoded
 * through `leadTierOf`, never a second decoder. The 899afc25 lead's ten alternated
 * 212 and 312 because the credit report's debt sat at about $50,000, on the line
 * between Medium and High. A score that never decodes counts toward what was read
 * and toward no tier.
 */
export function submissionAgreement(codes: string[] | undefined): SubmissionHistory {
  if (!codes || codes.length === 0) return { kind: "steady" };
  const byRank = new Map<number, { label: string; count: number }>();
  for (const code of codes) {
    const t = leadTierOf(code);
    if (t.kind !== "tier") continue;
    const seen = byRank.get(t.rank) ?? { label: t.label, count: 0 };
    seen.count++;
    byRank.set(t.rank, seen);
  }
  if (byRank.size < 2) return { kind: "steady" };
  const tiers = [...byRank.entries()]
    .sort(([ra, a], [rb, b]) => b.count - a.count || rb - ra)
    .map(([, t]) => t);
  return { kind: "disagree", read: codes.length, tiers };
}

/** What the page says beyond the routing record: the team's time, and the history. */
export interface PageFacts {
  team: TeamAtTime;
  history: SubmissionHistory;
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
  if (arrived.kind === "tier" && arrived.rank < f.lead.rank) {
    const rose = `The lead arrived with XBC ${arrived.code} (${arrived.label})`;
    // Both causes at once: scored higher since, AND placed below the arrival code
    // too. Naming only the rise would hide the routing fault.
    if (f.pool.rank < arrived.rank) {
      return `${rose} and ${riseClause(f)}, but the routing also placed the call below the code it was given.`;
    }
    return `${rose} and was routed on it, and ${riseClause(f)}.`;
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
 * Why the lead scores higher now than the code they arrived with (#3501).
 *
 * Only what was measured is said as fact (L11). A Lead edit after the latest
 * submission is measured, by `LeadHistory`. A newer current submission than the one
 * booked from is measured, by the Lead's pointer. But when the booked submission IS
 * the latest and scores higher than the link's code, Slate cannot tell a re-score
 * after booking from a page that sent an older score, because Salesforce keeps no
 * history of `XBC_SO__c`: #3501 said "re-scored" there, and the three pages of
 * 2026-10-07 15:41 ET were all trypennie pages sending the Lead's stale copy (#3508).
 * So that case names both. Anything else (a booking that recorded no submission, or
 * a score read off the Lead's copy) says the check could not tell.
 */
function riseClause(f: BelowFinding): string {
  // A Lead score edited after the submission (newest wins, `readLeadScores`): the
  // history read says when, so the cause is measured.
  if (f.score?.source === "lead-edit") return `the Lead record was re-scored to ${f.lead.label} after their latest submission`;
  const booked = partnerKeysFrom(f.booking.prefill).submissionId;
  const current = f.score?.source === "submission" ? f.score.submissionId : null;
  if (booked !== null && current !== null) {
    if (leadIdKey(booked) === leadIdKey(current)) {
      return (
        `the submission they booked from scores ${f.lead.label} now, so either the link carried an ` +
        `older score or Salesforce re-scored that submission since`
      );
    }
    return `their latest submission, newer than the one they booked from, scores ${f.lead.label}`;
  }
  return (
    `Salesforce scores them ${f.lead.label} now, from a re-score or a newer submission ` +
    `that this check could not tell apart`
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
  facts: PageFacts,
): string {
  const when = `${formatSlotDay(f.booking.starts_at, ALERT_ZONE)} at ${formatSlotTime(f.booking.starts_at, ALERT_ZONE)} ET`;
  const named = f.booking.agent_name?.trim() || f.booking.agent_email || null;
  const agent = named ?? "an unassigned agent";
  const article = /^[AEIOU]/.test(f.lead.label) ? "An" : "A";
  const history = historyLine(facts.history);
  return (
    `${article} ${f.lead.label} lead is booked with the ${f.pool.label} team: Salesforce scores them ` +
    `XBC ${f.lead.code} today, and the call on ${when} is with ${agent} in bucket ` +
    `${f.bucket.code} (${f.bucket.name}). ${routingLine(f, routing)} ` +
    (history === "" ? "" : `${history} `) +
    `${actionLine(f, facts.team, named)}\n${bookingUrl}`
  );
}

/**
 * What to do, from what the lead's own team is offering at the call's time (#3665).
 * A reassignment is asked for only where one was measured to exist, a move is named
 * only at a time the team was measured to offer, and a pool the row could not speak
 * for says so, whatever the reason, because the manager's next step is the same.
 */
function actionLine(f: BelowFinding, team: TeamAtTime, agent: string | null): string {
  const time = `${formatSlotTime(f.booking.starts_at, ALERT_ZONE)} ET`;
  const tier = f.lead.label;
  const correct = "correct the score in Salesforce if it is wrong.";
  const keep = agent === null ? "keep the call where it is" : `keep the call with ${agent}`;
  switch (team.kind) {
    case "free":
      return `Somebody on the ${tier} team is free at ${time}: reassign the call to them, or ${correct}`;
    case "not-free": {
      if (team.nearestMs === null) {
        return (
          `Nobody on the ${tier} team is free at ${time} or at any other time that day, so ${keep}, ` +
          `or move it to another day. Or ${correct}`
        );
      }
      const nearest = `${formatSlotTime(new Date(team.nearestMs).toISOString(), ALERT_ZONE)} ET`;
      return (
        `Nobody on the ${tier} team is free at ${time}, so ${keep}, or move it to ${nearest}, ` +
        `the ${tier} team's nearest free time that day. Or ${correct}`
      );
    }
    case "unchecked":
      return (
        `Whether anybody on the ${tier} team is free at ${time} could not be checked this time, so ` +
        `look before reassigning the call to somebody who works ${tier} leads, or ${correct}`
      );
  }
}

// ------------------------------------------- when the page posts again (2026-10-26)

/**
 * What one booking's page names, for the dispatcher's change rule: the facts whose
 * change is a reason to post again. Dan, 2026-10-26: "I got a ton of this alert and
 * they were all the same. Just page once per call." The family is change only
 * (`CHANGE_ONLY_KEYS`), so the page posts once and again only when one of these is
 * not what the last post said:
 *
 *   - the call itself: its time (a reschedule), its advisor, its bucket;
 *   - the lead's TIER, never the raw XBC, so 312 becoming 322 is the same High lead;
 *   - what the manager can do about it: somebody on the lead's own team free at the
 *     call's time, free only at another time that day, or free at no time that day.
 *
 * Everything else the page says is left out on purpose, because it varies without
 * the situation changing: the nearest free time walking as the day fills, the
 * submission history and routing sentences on a tick whose read failed, and a team
 * this tick could not check. An unchecked team names nothing, so it is never a
 * change, and the answer it could not give is not forgotten: the dispatcher compares
 * against the last POST, so a measured answer that matches what was posted stays
 * quiet when the check can read again.
 */
export function belowLeadTierRepeat(f: BelowFinding, team: TeamAtTime): AlertRepeat {
  const startMs = parseStampMs(f.booking.starts_at);
  const advisor =
    f.booking.agent_email?.trim().toLowerCase() || f.booking.agent_name?.trim().toLowerCase() || "unassigned";
  const subjects = [
    `call:${startMs === null ? f.booking.starts_at : new Date(startMs).toISOString()}`,
    `advisor:${advisor}`,
    `bucket:${f.bucket.code}`,
    `tier:${f.lead.key}`,
  ];
  if (team.kind === "free") subjects.push("team:free-at-call");
  else if (team.kind === "not-free") subjects.push(team.nearestMs === null ? "team:free-no-time-that-day" : "team:free-later-that-day");
  return { subjects };
}

/** "6 scored High and 4 Medium", "5 scored High, 3 Medium and 2 Low". */
function tierCounts(tiers: { label: string; count: number }[]): string {
  const parts = tiers.map((t, i) => (i === 0 ? `${t.count} scored ${t.label}` : `${t.count} ${t.label}`));
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Whether the lead's score is settled (#3665). Said only when the submissions were
 * read and disagree; a steady or unasked history adds nothing, since the page never
 * claimed it was settled, and a failed read says so rather than going quiet (L11).
 */
function historyLine(h: SubmissionHistory): string {
  if (h.kind === "disagree") {
    return `Of their last ${h.read} submissions, ${tierCounts(h.tiers)}, so the score itself is not settled.`;
  }
  if (h.kind === "unreadable") return "Whether their earlier submissions agree on the tier could not be read this time.";
  return "";
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
      /** #3665: what each paging finding's own tier pool offered at its call's time. */
      teamAtTime: Record<TeamAtTime["kind"], number>;
      /** #3665: paging findings whose submissions disagree on the tier; null when the
       *  history was not read (disarmed, nothing to page, or the read failed). */
      submissionsDisagree: number | null;
    };

export interface BelowLeadTierDeps {
  /** Upcoming active bookings in real buckets. THROWS on a read error, never answers empty. */
  loadBookings: () => Promise<UpcomingBooking[]>;
  /** The real buckets, for their tiers. */
  buckets: PoolBucket[];
  /** The current score per lead, keyed by `leadIdKey` (#3501: the current
   *  submission's, falling back to the Lead's copy). THROWS when Salesforce refuses. */
  readLeadScores: (leadIds: string[]) => Promise<Map<string, LeadScore>>;
  /** The routing record per booking id, from `routing_decisions`: the catch-all
   *  flag and the arrival code (#2594). Context only, so a failure costs no page. */
  loadRoutingContext: (bookingIds: string[]) => Promise<Map<string, RoutingRecord>>;
  /** Booking ids with an outstanding page in this family. */
  listFiring: () => Promise<Set<string>>;
  bookingUrl: (bookingId: string) => string;
  /** False until somebody has read a few ordinary days: measure and log, send nothing. */
  armed: boolean;
  notify: ThrottledNotify;
  /**
   * Drops the page state for bookings measured as fixed, WITHOUT posting anything.
   * Nobody wanted an all clear per booking (Dan, 2026-10-07): the page asks for one
   * action on one call, and whoever took it already knows. Settling still matters,
   * so a booking that goes below again later pages at once rather than waiting out
   * the old cooldown. Best effort and never throws.
   */
  settle: (keys: string[]) => Promise<void>;
  /** The tick's clock, so a nearest free time already past is never named. */
  nowMs: number;
  /**
   * #3665: what the pool for a lead's XBC code is offering, from the lane's shared
   * slot rows (no read of its own): the offer, null for no row, or "unreadable" when
   * the shared read failed this tick. May throw, which reads as unreadable.
   */
  leadTierOffer: (code: string) => LeadTierOffer | null | "unreadable";
  /**
   * #3665: each lead's newest submission scores, keyed by `leadIdKey`
   * (`readRecentSubmissionScores`). Asked only when armed, and only for the leads
   * about to be paged, so a quiet or disarmed tick costs no Salesforce call. THROWS
   * on a refusal, which the page then says it could not read.
   */
  readSubmissionHistory: (leadIds: string[]) => Promise<Map<string, string[]>>;
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

  let scores = new Map<string, LeadScore>();
  if (idsByKey.size > 0) {
    try {
      scores = await deps.readLeadScores([...idsByKey.values()]);
    } catch (err) {
      return { status: "unreadable", stage: "salesforce", error: err instanceof Error ? err.message : String(err) };
    }
  }

  const leads = new Map([...scores].map(([key, score]) => [key, score.code]));
  const comparisons = compareBookingsToLeadTier(bookings, deps.buckets, leads);
  const findings: BelowFinding[] = [];
  const unmeasured = Object.fromEntries(UNMEASURED_REASONS.map((r) => [r, 0])) as Record<UnmeasuredReason, number>;
  let compared = 0;
  for (const c of comparisons) {
    if (c.kind === "unmeasured") unmeasured[c.reason]++;
    else compared++;
    if (c.kind === "below") {
      const id = leadIdOf(c.booking);
      findings.push({ ...c, score: id === null ? undefined : scores.get(leadIdKey(id)) });
    }
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

  // #3665: the lead's own team at the call's time, from rows the lane already read,
  // so it is judged whether or not the check is armed. A lookup that throws is a
  // read this tick could not make, never an answer.
  const teamCounts: Record<TeamAtTime["kind"], number> = { free: 0, "not-free": 0, unchecked: 0 };
  const teamOf = new Map<BelowFinding, TeamAtTime>();
  for (const f of below) {
    let offer: LeadTierOffer | null | "unreadable";
    try {
      offer = deps.leadTierOffer(f.lead.code);
    } catch {
      offer = "unreadable";
    }
    const team = teamAtTime(offer, f.booking.starts_at, deps.nowMs);
    teamOf.set(f, team);
    teamCounts[team.kind]++;
  }

  // #3665: the submission history costs a Salesforce read, so it is asked only for
  // what is about to page, once per tick, one question per lead.
  let history: Map<string, string[]> | "unreadable" | null = null;
  if (deps.armed && below.length > 0) {
    const ids = new Map<string, string>();
    for (const f of below) {
      const id = leadIdOf(f.booking);
      if (id !== null && !ids.has(leadIdKey(id))) ids.set(leadIdKey(id), id);
    }
    try {
      history = await deps.readSubmissionHistory([...ids.values()]);
    } catch {
      history = "unreadable";
    }
  }
  const historyOf = (f: BelowFinding): SubmissionHistory => {
    if (history === null) return { kind: "not-read" };
    if (history === "unreadable") return { kind: "unreadable" };
    const id = leadIdOf(f.booking);
    return submissionAgreement(id === null ? undefined : history.get(leadIdKey(id)));
  };
  const submissionsDisagree =
    history === null || history === "unreadable" ? null : below.filter((f) => historyOf(f).kind === "disagree").length;

  let cleared = 0;
  if (deps.armed) {
    if (below.length > 0) {
      for (const f of below) {
        const context = contextOf(f);
        const facts: PageFacts = { team: teamOf.get(f) ?? { kind: "unchecked", why: "unreadable" }, history: historyOf(f) };
        // Once per call, and again only on a change (`belowLeadTierRepeat`). The hold is
        // the change only interval, not a setting, so nothing can tune a repeat back in;
        // it is what the dispatcher falls back to if the repeat columns are missing.
        await deps
          .notify(
            belowLeadTierKey(f.booking.id),
            CHANGE_ONLY_HOLD_MS,
            formatBelowLeadTierAlert(f, context, deps.bookingUrl(f.booking.id), facts),
            belowLeadTierRepeat(f, facts.team),
          )
          .catch(logAlertSendFailure(belowLeadTierKey(f.booking.id)));
      }
    }

    // Driven by what THIS run measured about each paged booking, never by "we did
    // not page it": a booking that became unmeasurable keeps its page (#1134, #1152).
    const firing = await deps.listFiring().catch(() => null);
    if (firing !== null) {
      const byId = new Map(comparisons.map((c) => [c.booking.id, c]));
      const settled: string[] = [];
      for (const id of firing) {
        // Excluded, so not measured this run: it keeps whatever it has (#1134).
        if (testSourceIds.has(id)) continue;
        const c = byId.get(id);
        // Fixed (now agrees) or gone (cancelled, or its time has passed).
        if (c === undefined || c.kind === "agrees") settled.push(belowLeadTierKey(id));
      }
      if (settled.length > 0) {
        await deps.settle(settled).catch(() => undefined);
        cleared = settled.length;
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
    teamAtTime: teamCounts,
    submissionsDisagree,
  };
}

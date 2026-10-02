/**
 * The Ultra High and Very High cascade, counted once a day instead of paged once a
 * booking (#2843).
 *
 * WHAT IT REPLACED. `tierFallbackAlert` paged `tier_fallback_deep:<code>` on a five
 * minute cooldown whenever a booking dropped two or more debt tiers, with the copy
 * "This should almost never happen", and sent `tier_fallback:<code>` hourly for a
 * one tier drop.
 *
 * THE DECISION BEHIND IT. Sales ops, 2026-09-28 (Slack #C091G6LEQ80,
 * p1790609176877419): an Ultra High or Very High lead with nothing in their own tier
 * inside the booking window is cascaded rather than booked days out. Sam: "We never
 * really want to book out further than 3 days if we can help it", with the cascade
 * stopping at Medium and never reaching an advisor who also carries Low (#2842).
 * There are six Ultra advisors, so an Ultra lead taken by Very High or High is the
 * rule working, and a page per booking reporting it is the alert nobody reads by
 * the second week (L36). The number is PUBLISHED here rather than judged, and the
 * copy says outright that no action is being asked for.
 *
 * What is genuinely wrong for these leads, every allowed tier full, is a different
 * event with its own signal (#2841), so this never pages and never double counts it.
 *
 * NO VERDICT STAMP and NO ALL CLEAR. It is `info` in the alert catalog and there is
 * no condition to end: ask what the all-clear would SAY and the answer is that the
 * expected thing did not happen for a day, which is not news. Before cutover it reads
 * `unmeasured` every tick because no lead reaches Slate, which is the correct answer
 * rather than a blindness to page about (L129).
 *
 * Imports only relative modules, so `scripts/test-top-tier-cascade.ts` drives every
 * branch node-natively; the counting and the sending are injected by the caller.
 */
import { allXbcCodes } from "../xbc.ts";

/** alert_state row key for the notice. ONE constant for the sender, catalog and preview. */
export const TOP_TIER_CASCADE_NOTICE_KEY = "top_tier_cascade_rate";

/** How far back a report counts: a day, the unit somebody compares against yesterday. */
export const TOP_TIER_CASCADE_WINDOW_HOURS = 24;

/** Pinned to the window, so two reports can never both describe the same bookings. */
export const TOP_TIER_CASCADE_COOLDOWN_MS = TOP_TIER_CASCADE_WINDOW_HOURS * 60 * 60 * 1000;

type TopTier = "ultra_high" | "very_high";
const TIER_DIGIT: Record<TopTier, number> = { ultra_high: 5, very_high: 4 };
const TIER_LABEL: Record<TopTier, string> = { ultra_high: "Ultra High", very_high: "Very High" };

/** Every bucket code a lead of each top tier can ask for, derived from the XBC
 *  vocabulary the seeder uses rather than typed out (L41). */
export const TOP_TIER_CODES: Record<TopTier, string[]> = {
  ultra_high: allXbcCodes().filter((c) => Number(c[0]) === TIER_DIGIT.ultra_high),
  very_high: allXbcCodes().filter((c) => Number(c[0]) === TIER_DIGIT.very_high),
};

/**
 * The codes a booking counts as CASCADED onto: every code in a lower debt tier.
 * Defined by the tier digit rather than by the ladder's floor, so a ladder that ever
 * reached lower than it should would still be counted rather than silently missed.
 * `scripts/test-top-tier-cascade.ts` holds it against the real ladder in both
 * directions, so a sideways move inside the lead's own tier is never counted here.
 */
export const CASCADE_CODES_BELOW: Record<TopTier, string[]> = {
  ultra_high: allXbcCodes().filter((c) => Number(c[0]) < TIER_DIGIT.ultra_high),
  very_high: allXbcCodes().filter((c) => Number(c[0]) < TIER_DIGIT.very_high),
};

export interface TopTierCascadeWindow {
  ultraBooked: number;
  ultraCascaded: number;
  veryHighBooked: number;
  veryHighCascaded: number;
  windowHours: number;
}

export type TopTierCascadeVerdict =
  /** Nothing countable. NOT healthy: judging nothing is never a pass (L98). */
  | { kind: "unmeasured"; reason: string }
  /** Measured, and no top tier lead left their tier. Nothing to say. */
  | { kind: "quiet" }
  /** Measured, and some did. One line, once a window. */
  | { kind: "report"; tiers: { tier: TopTier; booked: number; cascaded: number }[] };

const readable = (n: number) => Number.isFinite(n) && n >= 0;

/** Judge one window. No threshold, because every cascade is ordinary by decision. */
export function topTierCascadeVerdict(w: TopTierCascadeWindow): TopTierCascadeVerdict {
  const pairs: { tier: TopTier; booked: number; cascaded: number }[] = [
    { tier: "ultra_high", booked: w.ultraBooked, cascaded: w.ultraCascaded },
    { tier: "very_high", booked: w.veryHighBooked, cascaded: w.veryHighCascaded },
  ];
  if (pairs.some((p) => !readable(p.booked) || !readable(p.cascaded))) {
    return { kind: "unmeasured", reason: "a top tier count could not be read" };
  }
  // More cascades than bookings is not a very high rate, it is a broken read.
  const impossible = pairs.find((p) => p.cascaded > p.booked);
  if (impossible) {
    return {
      kind: "unmeasured",
      reason: `counted ${impossible.cascaded} ${TIER_LABEL[impossible.tier]} cascades out of ${impossible.booked} bookings, which cannot be right`,
    };
  }
  if (pairs.every((p) => p.booked === 0)) {
    return {
      kind: "unmeasured",
      reason: `nothing was booked on an Ultra High or Very High code in the last ${w.windowHours}h, so there is nothing to count`,
    };
  }
  if (pairs.every((p) => p.cascaded === 0)) return { kind: "quiet" };
  return { kind: "report", tiers: pairs.filter((p) => p.booked > 0) };
}

/** What the notice says: the numbers, then the rule, then permission not to act. */
export function topTierCascadeNoticeText(
  v: Extract<TopTierCascadeVerdict, { kind: "report" }>,
  windowHours: number,
): string {
  const lines = v.tiers.map((t) => {
    // The noun agrees with the TOTAL: "1 of 1 booking", "3 of 8 bookings".
    const noun = t.booked === 1 ? "booking" : "bookings";
    return `${TIER_LABEL[t.tier]}: ${t.cascaded} of ${t.booked} ${noun} went to a lower tier`;
  });
  return (
    `Top tier cascade, last ${windowHours}h. ${lines.join("; ")}. ` +
    `This is the routing rule sales ops set on 2026-09-28: an Ultra High or Very High lead ` +
    `with nothing in their own tier inside the booking window is offered the tiers below, as ` +
    `far as Medium and never an advisor who also carries Low, rather than a time days out. ` +
    `No action is needed for a share that holds steady. A share that keeps climbing week on ` +
    `week means the top tier pools are small for the leads they are getting.`
  );
}

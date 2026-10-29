/**
 * An Ultra High or Very High lead booked where the routing rule forbids (#2842).
 *
 * THE RULE. Sales ops, 2026-09-28 (Slack #C091G6LEQ80, p1790609176877419): an Ultra
 * High or Very High lead with nothing in their own tier inside the booking window is
 * cascaded rather than booked days out, "only cascade down to a medium", and "as long
 * as the person who is on Medium isn't also on Low". `tierLadder` and
 * `rungExcludesLow` (src/lib/routing/tiers.ts) enforce it at booking time.
 *
 * WHAT PAGES. Only a booking that breaks it: the call landed below Medium, or below
 * the lead's own tier with an advisor who also carries Low. A cascade inside the rule
 * is routing working and posts nothing. This replaced a daily info count of every
 * cascade (`top_tier_cascade_rate`, #2843), removed on Dan's word on 2026-10-29: "I
 * don't need this notification. It only matters if it goes to a tier it's not
 * supposed to."
 *
 * WRITTEN OUT, NOT ASKED OF THE LADDER (L721). The check states the rule by tier
 * digit and by the Low team itself, rather than calling the predicates that enforce
 * it, so a fault in those predicates cannot also blind the check.
 * `scripts/test-top-tier-placement.ts` holds the two together against the real
 * ladder.
 *
 * WHICH ADVISOR. `routing_decisions.chosen_user_id`, the advisor the routing picked,
 * judged by their teams as read on this tick. A later hand reassign is a person's
 * choice and not what the rule governs.
 *
 * AN INCIDENT, once per booking. The booking already happened, and whoever moves the
 * call knows it is done, so there is no all clear. The cooldown outlasts the lookback,
 * so a booking leaves the read before its key could post again.
 *
 * Imports only relative modules, so the node suite drives every branch; the reads and
 * the send are injected by the caller.
 */
import { allXbcCodes, DEBT_TIER } from "../xbc.ts";
import { carriesLow } from "../availability/low-exclusion.ts";
import type { Attributes } from "../db/types.ts";
import type { ThrottledNotify } from "./alert-deps.ts";

/** The alert family: one incident per booking, `top_tier_forbidden_placement:<id>`. */
export const TOP_TIER_PLACEMENT_KEY = "top_tier_forbidden_placement";

export function topTierPlacementKey(bookingId: string): string {
  return `${TOP_TIER_PLACEMENT_KEY}:${bookingId}`;
}

/** How far back each tick reads. A day, so a lane that stalls for hours still sees
 *  every booking made while it was down. */
export const TOP_TIER_PLACEMENT_LOOKBACK_HOURS = 24;

/** Longer than the lookback, so each forbidden placement posts once. */
export const TOP_TIER_PLACEMENT_COOLDOWN_MS = (TOP_TIER_PLACEMENT_LOOKBACK_HOURS + 1) * 60 * 60 * 1000;

type TopTier = "ultra_high" | "very_high";
const TIER_DIGIT: Record<TopTier, number> = { ultra_high: 5, very_high: 4 };

/** The lowest tier a top tier lead may be booked on, found by its key in the one
 *  table rather than typed as a digit. */
const MEDIUM = Number(Object.entries(DEBT_TIER).find(([, t]) => t.key === "medium")![0]);

const XBC = /^[1-5][0-3][0-2]$/;

/** Every bucket code a lead of each top tier can ask for, from the XBC vocabulary. */
export const TOP_TIER_CODES: Record<TopTier, string[]> = {
  ultra_high: allXbcCodes().filter((c) => Number(c[0]) === TIER_DIGIT.ultra_high),
  very_high: allXbcCodes().filter((c) => Number(c[0]) === TIER_DIGIT.very_high),
};

/**
 * The codes the read treats as a cascade: every code in a lower debt tier, Low
 * included. Low is unreachable by the ladder, which is exactly why it is read: a
 * booking there is the floor breaking, and a list stopping at Medium would miss it.
 */
export const CASCADE_CODES_BELOW: Record<TopTier, string[]> = {
  ultra_high: allXbcCodes().filter((c) => Number(c[0]) < TIER_DIGIT.ultra_high),
  very_high: allXbcCodes().filter((c) => Number(c[0]) < TIER_DIGIT.very_high),
};

/** The `routing_decisions` columns the check reads, for a booked top tier cascade. */
export interface PlacementRow {
  booking_id: string | null;
  requested_code: string | null;
  bucket_code: string;
  chosen_user_id: string | null;
}

/** The `users` columns the check reads for each chosen advisor. */
export interface PlacementAdvisor {
  id: string;
  name: string | null;
  email: string | null;
  attributes: Attributes | null;
}

export type PlacementBreach = "below-medium" | "low-carrier";

export interface ForbiddenPlacement {
  row: PlacementRow & { booking_id: string };
  breach: PlacementBreach;
  requestedLabel: string;
  bookedLabel: string;
  /** null when the advisor could not be read; only a below Medium breach gets here
   *  without one, because that half is judged from the codes alone. */
  advisor: PlacementAdvisor | null;
}

export type UnmeasuredPlacement = "no-booking-id" | "code-unreadable" | "advisor-unread";

export interface PlacementJudgement {
  forbidden: ForbiddenPlacement[];
  /** Cascades measured and inside the rule. */
  allowed: number;
  /** Rows the check could not judge, each under its own reason, never counted as allowed. */
  unmeasured: { row: PlacementRow; reason: UnmeasuredPlacement }[];
}

const tierLabel = (digit: number): string => DEBT_TIER[String(digit)]!.label;

/** Judge each booked cascade against the rule. Pure. */
export function judgeTopTierPlacements(
  rows: PlacementRow[],
  advisors: Map<string, PlacementAdvisor>,
): PlacementJudgement {
  const out: PlacementJudgement = { forbidden: [], allowed: 0, unmeasured: [] };
  for (const row of rows) {
    const bookingId = row.booking_id;
    if (bookingId === null) {
      out.unmeasured.push({ row, reason: "no-booking-id" });
      continue;
    }
    const requested = row.requested_code ?? "";
    if (!XBC.test(requested) || !XBC.test(row.bucket_code) || Number(requested[0]) < TIER_DIGIT.very_high) {
      out.unmeasured.push({ row, reason: "code-unreadable" });
      continue;
    }
    const asked = Number(requested[0]);
    const booked = Number(row.bucket_code[0]);
    if (booked >= asked) {
      // Not a cascade: the lead was booked in their own tier, where every advisor,
      // Low carriers included, is their own advisor.
      out.allowed++;
      continue;
    }
    const advisor = row.chosen_user_id === null ? undefined : advisors.get(row.chosen_user_id);
    const found = { row: { ...row, booking_id: bookingId }, requestedLabel: tierLabel(asked), bookedLabel: tierLabel(booked) };
    if (booked < MEDIUM) {
      out.forbidden.push({ ...found, breach: "below-medium", advisor: advisor ?? null });
      continue;
    }
    if (advisor === undefined) {
      out.unmeasured.push({ row, reason: "advisor-unread" });
      continue;
    }
    if (carriesLow(advisor.attributes)) {
      out.forbidden.push({ ...found, breach: "low-carrier", advisor });
      continue;
    }
    out.allowed++;
  }
  return out;
}

const article = (label: string): string => (/^[AEIOU]/.test(label) ? "An" : "A");

/**
 * The page for one forbidden placement: who the lead is, who has the call, which half
 * of the rule broke, and what to do. Lead contact data is never in it; the booking is
 * named by its link.
 */
export function formatForbiddenPlacementAlert(f: ForbiddenPlacement, bookingUrl: string): string {
  const name = f.advisor?.name?.trim() || f.advisor?.email?.trim() || null;
  const lead = `${article(f.requestedLabel)} ${f.requestedLabel} lead`;
  if (f.breach === "below-medium") {
    return (
      `${lead} was booked with ${name ?? "an advisor"} on the ${f.bookedLabel} team. ` +
      `${f.requestedLabel} leads should go no lower than Medium, so this is a routing bug. ` +
      `Move the call to an advisor on Medium or above.\n${bookingUrl}`
    );
  }
  // A Low carrier is judged on the advisor's own teams, so the advisor was read.
  return (
    `${lead} was booked with ${name ?? "an advisor"}, a ${f.bookedLabel} advisor who is also on the Low team. ` +
    `${f.requestedLabel} leads sent to a lower tier should never get an advisor who is on the Low team, so this is a routing bug. ` +
    `Move the call to an advisor who is not on the Low team.\n${bookingUrl}`
  );
}

export interface TopTierPlacementResult {
  allowed: number;
  forbidden: number;
  paged: number;
  unmeasured: Record<UnmeasuredPlacement, number>;
}

/**
 * One tick: read the day's booked top tier cascades, read the advisors they went to,
 * and page each forbidden one. Every read THROWS on failure, so the monitor lane
 * records the step as failing rather than as a day with nothing wrong, and nothing is
 * posted from a half read.
 */
export async function checkTopTierPlacements(deps: {
  loadPlacements: () => Promise<PlacementRow[]>;
  loadAdvisors: (ids: string[]) => Promise<PlacementAdvisor[]>;
  bookingUrl: (bookingId: string) => string;
  notify: ThrottledNotify;
}): Promise<TopTierPlacementResult> {
  const rows = await deps.loadPlacements();
  const ids = [...new Set(rows.map((r) => r.chosen_user_id).filter((id): id is string => id !== null))];
  const advisors = ids.length === 0 ? [] : await deps.loadAdvisors(ids);
  const judged = judgeTopTierPlacements(rows, new Map(advisors.map((a) => [a.id, a])));
  let paged = 0;
  for (const f of judged.forbidden) {
    await deps.notify(
      topTierPlacementKey(f.row.booking_id),
      TOP_TIER_PLACEMENT_COOLDOWN_MS,
      formatForbiddenPlacementAlert(f, deps.bookingUrl(f.row.booking_id)),
    );
    paged++;
  }
  const unmeasured: Record<UnmeasuredPlacement, number> = { "no-booking-id": 0, "code-unreadable": 0, "advisor-unread": 0 };
  for (const u of judged.unmeasured) unmeasured[u.reason]++;
  return { allowed: judged.allowed, forbidden: judged.forbidden.length, paged, unmeasured };
}

import { DEBT_TIER } from "../xbc.ts";
import { parseStampMs } from "../date/stamp.ts";
import type { RoutingTrace } from "../db/types.ts";

/**
 * How often a lead drops a debt tier at confirm, and why (2026-10-02).
 *
 * Sales ops decided that a lead who loses their tier's last opening keeps the
 * time they picked and drops a tier (Slack, Sam: "For an edge case I'll always
 * choose less friction"), so a drop no longer pages. It is counted on
 * /admin/routing instead, split by what the booker was showing when the lead
 * confirmed, because the two causes send somebody to different places:
 *
 *  - `lost-at-confirm`: the lead's own tier had times on show and the last one
 *    was taken before they confirmed. While cal.com books the same calendars this
 *    is mostly a cal.com booking landing first, and it fades at cutover.
 *  - `nothing-on-show`: the booker was already showing a lower tier, so the
 *    lead's own tier had no times in the window at all. That is a staffing fact.
 *  - `not-recorded`: the tier on show was not saved, because the booking predates
 *    `routing_trace.displayed_tier` or the display read failed. Never guessed.
 *
 * Pure, so scripts/test-tier-drop-counts.ts drives it with an injected clock.
 */

export type TierDropCause = "lost-at-confirm" | "nothing-on-show" | "not-recorded";

/** Every cause, in the order the page lists them. */
export const TIER_DROP_CAUSES: TierDropCause[] = ["lost-at-confirm", "nothing-on-show", "not-recorded"];

export type TierDropTrace = Pick<
  RoutingTrace,
  "tier_fallback" | "requested_tier" | "booked_tier" | "displayed_tier" | "bucket_code"
>;

export interface TierDropRow {
  id: string;
  created_at: string;
  routing_trace: TierDropTrace | null;
}

const RANK_BY_KEY = new Map(Object.entries(DEBT_TIER).map(([digit, t]) => [t.key, Number(digit)]));

/** A debt tier's label from the one tier table, or null for a key it does not know. */
export function tierLabel(key: string | null | undefined): string | null {
  const rank = key ? RANK_BY_KEY.get(key) : undefined;
  return rank === undefined ? null : DEBT_TIER[String(rank)].label;
}

/**
 * The cause of one booking's drop, or null when the booking did not drop a debt
 * tier: no drop recorded, a sideways overflow inside one tier, an upward move, or
 * a tier this cannot read.
 */
export function tierDropCause(t: TierDropTrace | null): TierDropCause | null {
  if (!t?.tier_fallback) return null;
  const requested = t.requested_tier ? RANK_BY_KEY.get(t.requested_tier) : undefined;
  const booked = t.booked_tier ? RANK_BY_KEY.get(t.booked_tier) : undefined;
  if (requested === undefined || booked === undefined || booked >= requested) return null;
  if (t.displayed_tier == null) return "not-recorded";
  return t.displayed_tier === t.requested_tier ? "lost-at-confirm" : "nothing-on-show";
}

export type TierDropTally = Record<TierDropCause, number> & { total: number };

export interface TierDropDetail {
  id: string;
  createdAt: string;
  cause: TierDropCause;
  requestedLabel: string;
  bookedLabel: string;
  bucketCode: string;
}

export interface TierDropCounts {
  week: TierDropTally;
  month: TierDropTally;
  /** Every drop inside the 30 day window, newest first. */
  recent: TierDropDetail[];
  /** Rows whose creation stamp could not be read, so neither window holds them. */
  unreadableStamps: number;
}

function emptyTally(): TierDropTally {
  return { "lost-at-confirm": 0, "nothing-on-show": 0, "not-recorded": 0, total: 0 };
}

export const TIER_DROP_WINDOW_DAYS = { week: 7, month: 30 } as const;
const DAY_MS = 86_400_000;

/** Tally the drops made in the last 7 and 30 days before `nowMs`. */
export function countTierDrops(rows: TierDropRow[], nowMs: number): TierDropCounts {
  const week = emptyTally();
  const month = emptyTally();
  const recent: (TierDropDetail & { ms: number })[] = [];
  let unreadableStamps = 0;
  for (const r of rows) {
    const cause = tierDropCause(r.routing_trace);
    if (cause === null) continue;
    const ms = parseStampMs(r.created_at);
    if (ms === null) {
      unreadableStamps++;
      continue;
    }
    const age = nowMs - ms;
    if (age < 0 || age > TIER_DROP_WINDOW_DAYS.month * DAY_MS) continue;
    month[cause]++;
    month.total++;
    if (age <= TIER_DROP_WINDOW_DAYS.week * DAY_MS) {
      week[cause]++;
      week.total++;
    }
    recent.push({
      id: r.id,
      createdAt: r.created_at,
      cause,
      // Both labels exist: tierDropCause returned a cause only for known tiers.
      requestedLabel: tierLabel(r.routing_trace?.requested_tier) ?? "",
      bookedLabel: tierLabel(r.routing_trace?.booked_tier) ?? "",
      bucketCode: r.routing_trace?.bucket_code ?? "",
      ms,
    });
  }
  recent.sort((a, b) => b.ms - a.ms || (a.id < b.id ? -1 : 1));
  return { week, month, recent: recent.map(({ ms: _ms, ...d }) => d), unreadableStamps };
}

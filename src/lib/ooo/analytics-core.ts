import { DateTime } from "luxon";
import type { OooRequest } from "@/lib/db/types";

/**
 * Pure OOO analytics, ported from the Apps Script analytics module: approval
 * stats, per-manager breakdown, coverage alerts (days where too much of a team
 * is out), folks taking no time off, advance-notice medians, busiest month.
 * Clock and timezone are injected so everything is unit-testable
 * (`scripts/test-ooo-analytics.ts`). Math runs in the org's display zone.
 */

export interface RosterPerson {
  id: string;
  name: string;
}

export interface ApprovalStats {
  approved: number;
  rejected: number;
  pending: number;
  total: number;
  /** Decided requests = approved + rejected (a pending request is not a decision). */
  decided: number;
  /**
   * Whole-percent approval rate over DECIDED requests only (#201). Pending
   * requests are not-yet-decisions, so counting them in the denominator would
   * understate the rate. 0 when nothing is decided (callers should show the rate
   * as undefined, e.g. "no decisions yet", when `decided` is 0).
   */
  rate: number;
}

export function approvalStats(requests: OooRequest[]): ApprovalStats {
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  for (const r of requests) {
    if (r.status === "approved") approved++;
    else if (r.status === "rejected") rejected++;
    else if (r.status === "pending") pending++;
  }
  const total = approved + rejected + pending;
  const decided = approved + rejected;
  return {
    approved,
    rejected,
    pending,
    total,
    decided,
    rate: decided > 0 ? Math.round((approved / decided) * 100) : 0,
  };
}

const median = (sorted: number[]): number => {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : Math.round(sorted[mid]);
};

/**
 * Company approval rate = the MEDIAN of per-manager rates (legacy parity).
 * When `activeManagerIds` is given, only those managers count — offboarded
 * managers (no current reports) and the unassigned bucket drop out, so the
 * figure matches the visible By-manager rows.
 */
export function companyApprovalStats(
  requests: OooRequest[],
  activeManagerIds?: Set<string>,
): {
  rate: number;
  managerCount: number;
} {
  const perManager = new Map<string, OooRequest[]>();
  for (const r of requests) {
    const key = r.manager_id ?? "unassigned";
    if (activeManagerIds && (key === "unassigned" || !activeManagerIds.has(key))) {
      continue;
    }
    perManager.set(key, [...(perManager.get(key) ?? []), r]);
  }
  const rates = [...perManager.values()]
    .map((rs) => approvalStats(rs))
    // #201: only managers who have actually decided something have a meaningful
    // approval rate; an all-pending manager must not drag the median to 0.
    .filter((s) => s.decided > 0)
    .map((s) => s.rate)
    .sort((a, b) => a - b);
  return { rate: median(rates), managerCount: rates.length };
}

export interface ManagerBreakdownRow extends ApprovalStats {
  managerId: string;
}

/**
 * Per-manager approval breakdown. When `activeManagerIds` is given, offboarded
 * managers (no current reports) are hidden; the unassigned bucket is kept since
 * it represents "No manager", not an offboarded person.
 */
export function managerBreakdown(
  requests: OooRequest[],
  activeManagerIds?: Set<string>,
): ManagerBreakdownRow[] {
  const perManager = new Map<string, OooRequest[]>();
  for (const r of requests) {
    const key = r.manager_id ?? "unassigned";
    if (activeManagerIds && key !== "unassigned" && !activeManagerIds.has(key)) {
      continue;
    }
    perManager.set(key, [...(perManager.get(key) ?? []), r]);
  }
  return [...perManager.entries()]
    .map(([managerId, rs]) => ({ managerId, ...approvalStats(rs) }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b.rate - a.rate);
}

export interface CoverageAlert {
  date: string; // yyyy-MM-dd in the org zone
  dateFormatted: string; // "Jul 3"
  count: number;
  percent: number;
  people: string[];
  severity: "high" | "medium";
}

/**
 * Days in the next 30 where >=20% of the team is approved-out (high at >=30%).
 * Top 5 by date; people deduped per day across overlapping requests.
 */
export function coverageAlerts(
  team: RosterPerson[],
  requests: OooRequest[],
  nowMs: number,
  zone: string,
): CoverageAlert[] {
  if (!team.length) return [];
  const teamIds = new Set(team.map((p) => p.id));
  const nameOf = new Map(team.map((p) => [p.id, p.name]));
  const today = DateTime.fromMillis(nowMs, { zone }).startOf("day");
  const horizon = today.plus({ days: 30 });

  const byDate = new Map<string, Set<string>>();
  for (const r of requests) {
    if (r.status !== "approved" || !teamIds.has(r.user_id)) continue;
    const end = DateTime.fromISO(r.ends_at, { zone });
    let day = DateTime.fromISO(r.starts_at, { zone }).startOf("day");
    if (day < today) day = today;
    while (day <= end && day <= horizon) {
      const key = day.toISODate()!;
      byDate.set(key, (byDate.get(key) ?? new Set()).add(r.user_id));
      day = day.plus({ days: 1 });
    }
  }

  const alerts: CoverageAlert[] = [];
  for (const [date, ids] of byDate) {
    const percent = Math.round((ids.size / team.length) * 100);
    if (percent < 20) continue;
    alerts.push({
      date,
      dateFormatted: DateTime.fromISO(date, { zone }).toFormat("LLL d"),
      count: ids.size,
      percent,
      people: [...ids].map((id) => nameOf.get(id) ?? id),
      severity: percent >= 30 ? "high" : "medium",
    });
  }
  return alerts.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
}

/** Team members with no approved OOO starting in the last 90 / next 30 days. */
export function peopleWithNoTimeOff(
  team: RosterPerson[],
  requests: OooRequest[],
  nowMs: number,
): RosterPerson[] {
  const windowStart = nowMs - 90 * 24 * 3600 * 1000;
  const windowEnd = nowMs + 30 * 24 * 3600 * 1000;
  const withTimeOff = new Set(
    requests
      .filter((r) => {
        if (r.status !== "approved") return false;
        const start = Date.parse(r.starts_at);
        return start >= windowStart && start <= windowEnd;
      })
      .map((r) => r.user_id),
  );
  return team
    .filter((p) => !withTimeOff.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Median days between submission and the start of the time off. */
export function medianAdvanceNoticeDays(requests: OooRequest[]): number {
  const days = requests
    .map((r) =>
      Math.floor((Date.parse(r.starts_at) - Date.parse(r.created_at)) / 86_400_000),
    )
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  if (!days.length) return 0;
  const mid = Math.floor(days.length / 2);
  return days.length % 2 === 0
    ? Math.round((days[mid - 1] + days[mid]) / 2)
    : days[mid];
}

/**
 * Upcoming month (in the org zone) with the most approved time off — forward-
 * looking, so it answers "when is coverage thinnest next," not historical. Only
 * approved requests starting at/after `nowMs` count.
 */
export function busiestMonth(
  requests: OooRequest[],
  zone: string,
  nowMs: number,
): string {
  const counts = new Map<string, number>();
  for (const r of requests) {
    if (r.status !== "approved") continue;
    if (Date.parse(r.starts_at) < nowMs) continue;
    const key = DateTime.fromISO(r.starts_at, { zone }).toFormat("LLLL yyyy");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let max = 0;
  for (const [month, count] of counts) {
    if (count > max) {
      max = count;
      best = month;
    }
  }
  return best || "None ahead";
}

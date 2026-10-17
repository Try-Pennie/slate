/**
 * Owner alerts skipped because the advisor's calendar cannot be reached, counted
 * against a SHARE (#2436).
 *
 * When the advisor only "previously pitched" alert (#2371) cannot be written because
 * the owning advisor's calendar is `gone` or `not-provisioned`, the row records
 * `skip_reason` and the step stops retrying, which is right per row. Nothing counted
 * them (L77): one advisor without a Calendar licence is correctly silent, and the
 * whole roster skipping read exactly the same.
 *
 * WHAT IS COUNTED: the alerts WRITTEN in the last seven days, by `created_at`, and
 * of those the ones carrying a `skip_reason`. Not the "live" rows (`removed_at` is
 * null), which is what the issue said and is the wrong population: measured on
 * 2026-10-16, 33 of the 35 live rows belonged to calls already completed, because a
 * completed call's alert is never closed. A skip counted over live rows would count
 * for ever after its call, and the page could never end. A week of writes is the rate
 * at which alerts are failing now, and ages out by itself once the calendars read.
 *
 * THE NUMBERS, measured rather than typed (production, read only, 2026-10-16):
 *  - 205 owner alerts since the first on 2026-09-16, 54 in the last 7 days, written
 *    for 33 advisors over 30 days. NONE has ever carried a skip_reason.
 *  - 26 of the 153 agent calendars are `not-provisioned` (26 people), and none of
 *    them holds an owner alert: an unreadable calendar keeps an agent out of the pool,
 *    so a skip needs an advisor whose calendar stopped reading after the fact, or an
 *    owner who is not bookable.
 *  So the healthy rate is zero, and a "handful" is a few advisors, not a few rows: one
 *  advisor holding ten calls is one fix. A page needs at least 3 ADVISORS behind the
 *  skips, more than 20 percent of the week's alerts skipped, and at least 10 alerts in
 *  the week to judge a share at all (L716). Below that floor, half or more skipped
 *  across 3 advisors still pages, because a floor that silences noise also silences a
 *  total failure (L139).
 *
 * THE ALL CLEAR hangs off a MEASURED week: at least the alert floor, and under the
 * line. A week too quiet to judge, a failed read and a read that filled its bound each
 * send nothing in either direction (#1134, #1152).
 *
 * No `@/` imports, so scripts/test-owner-alert-skips.ts drives every branch natively.
 */
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state key for the page and its all clear. */
export const OWNER_ALERT_SKIPS_KEY = "owner_alert_skips";

/** The bound on the week's read. 54 rows were written in the measured week, so a
 *  read that fills this is not a week anybody has seen, and is reported as truncated. */
export const OWNER_ALERT_READ_LIMIT = 1000;

export interface OwnerAlertSkipThresholds {
  windowMs: number;
  /** Fewest alerts written in the window before a share is judged. */
  minAlerts: number;
  /** Fewest distinct advisors behind the skips before anything pages. */
  minAdvisors: number;
  /** Share (percent) of the window's alerts skipped that must be EXCEEDED to page. */
  sharePct: number;
  /** At or above this share the alert floor stops mattering (L139). */
  saturationPct: number;
}

export const OWNER_ALERT_SKIP_THRESHOLDS: OwnerAlertSkipThresholds = {
  windowMs: 7 * 24 * 60 * 60_000,
  minAlerts: 10,
  minAdvisors: 3,
  sharePct: 20,
  saturationPct: 50,
};

/** One owner alert written in the window: whose calendar, and why it was skipped. */
export interface RecentOwnerAlert {
  userId: string;
  skipReason: string | null;
}

export interface SkipCounts {
  skipped: number;
  alerts: number;
  /** Distinct advisors behind the skipped rows. */
  advisors: number;
  pct: number;
  byReason: Record<string, number>;
}

export type OwnerAlertSkipVerdict =
  | { status: "insufficient"; alerts: number; skipped: number }
  | ({ status: "under" } & SkipCounts)
  | ({ status: "breach"; trigger: "rate" | "saturation" } & SkipCounts);

export function judgeOwnerAlertSkips(rows: RecentOwnerAlert[], t: OwnerAlertSkipThresholds): OwnerAlertSkipVerdict {
  const skippedRows = rows.filter((r) => r.skipReason !== null && r.skipReason !== "");
  const byReason: Record<string, number> = {};
  for (const r of skippedRows) byReason[r.skipReason!] = (byReason[r.skipReason!] ?? 0) + 1;
  const counts: SkipCounts = {
    skipped: skippedRows.length,
    alerts: rows.length,
    advisors: new Set(skippedRows.map((r) => r.userId)).size,
    pct: rows.length === 0 ? 0 : Math.round((skippedRows.length / rows.length) * 100),
    byReason,
  };
  const enoughAdvisors = counts.advisors >= t.minAdvisors;
  const saturated = enoughAdvisors && counts.alerts > 0 && counts.skipped * 100 >= t.saturationPct * counts.alerts;
  if (counts.alerts < t.minAlerts) {
    return saturated
      ? { status: "breach", trigger: "saturation", ...counts }
      : { status: "insufficient", alerts: counts.alerts, skipped: counts.skipped };
  }
  if (enoughAdvisors && counts.skipped * 100 > t.sharePct * counts.alerts) {
    return { status: "breach", trigger: "rate", ...counts };
  }
  return { status: "under", ...counts };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The reasons, in the words a reader acts on. Kept to the two kinds the step records. */
function reasonPhrase(byReason: Record<string, number>): string {
  const parts: string[] = [];
  const notProvisioned = byReason["not-provisioned"] ?? 0;
  const gone = byReason["gone"] ?? 0;
  const other = Object.entries(byReason)
    .filter(([k]) => k !== "not-provisioned" && k !== "gone")
    .reduce((sum, [, n]) => sum + n, 0);
  if (notProvisioned > 0) parts.push(`${notProvisioned} never given Google Calendar`);
  if (gone > 0) parts.push(`${gone} whose calendar has gone`);
  if (other > 0) parts.push(`${other} for another reason`);
  return parts.join(", ");
}

/** The page, built from measured counts only, so no error text can reach it. */
export function formatOwnerAlertSkipsPage(v: SkipCounts, windowDays: number): string {
  return (
    `${v.skipped} of ${plural(v.alerts, "owner alert", "owner alerts")} written in the last ${windowDays} days (${v.pct}%) ` +
    `could not be put on the owning advisor's calendar, across ${plural(v.advisors, "advisor", "advisors")}: ${reasonPhrase(v.byReason)}. ` +
    `The calls are booked; what is missing is the "previously pitched" alert on those advisors' calendars. ` +
    `An account never given Calendar needs a Workspace admin; a calendar that has gone needs the advisor to reconnect or leave the pool. ` +
    `The rows are owner_alert_events with a skip_reason.`
  );
}

/** The all clear, from the week that measured it. */
export function formatOwnerAlertSkipsAllClear(v: { skipped: number; alerts: number }, windowDays: number): string {
  const skipped = v.skipped === 0 ? "none" : `${v.skipped}`;
  return (
    `Owner alerts are reaching advisors' calendars again: ${skipped} of the last ` +
    `${plural(v.alerts, "owner alert", "owner alerts")} in ${windowDays} days ${v.skipped === 1 ? "was" : "were"} ` +
    `skipped for an unreachable calendar.`
  );
}

export type OwnerAlertSkipsResult =
  | { status: "truncated"; read: number }
  | { status: "insufficient"; alerts: number; skipped: number }
  | { status: "paged"; verdict: OwnerAlertSkipVerdict }
  | { status: "cleared"; verdict: OwnerAlertSkipVerdict };

/**
 * One monitor tick. A failed read THROWS, so the step's boundary records it and
 * nothing is paged or cleared off a measurement that was not made.
 */
export async function runOwnerAlertSkipsCheck(deps: {
  nowMs: number;
  /** The alerts written since `sinceIso`, at most `limit`. THROWS on a failed read. */
  loadRecent: (sinceIso: string, limit: number) => Promise<RecentOwnerAlert[]>;
  thresholds: OwnerAlertSkipThresholds;
  cooldownMs: number;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
}): Promise<OwnerAlertSkipsResult> {
  const t = deps.thresholds;
  const rows = await deps.loadRecent(new Date(deps.nowMs - t.windowMs).toISOString(), OWNER_ALERT_READ_LIMIT);
  if (rows.length >= OWNER_ALERT_READ_LIMIT) return { status: "truncated", read: rows.length };
  const verdict = judgeOwnerAlertSkips(rows, t);
  const windowDays = Math.round(t.windowMs / (24 * 60 * 60_000));
  if (verdict.status === "insufficient") return verdict;
  if (verdict.status === "breach") {
    await deps.notify(OWNER_ALERT_SKIPS_KEY, deps.cooldownMs, formatOwnerAlertSkipsPage(verdict, windowDays));
    return { status: "paged", verdict };
  }
  await deps.resolve(OWNER_ALERT_SKIPS_KEY, formatOwnerAlertSkipsAllClear(verdict, windowDays));
  return { status: "cleared", verdict };
}

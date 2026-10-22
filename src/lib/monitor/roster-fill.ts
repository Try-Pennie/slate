/**
 * Calendars filling up across the whole roster (#2590), said against the nearly full
 * line an admin sets on Team capacity.
 *
 * Dan, 2026-09-21: "we need slate to let us know in slack when calendars are filling
 * out ... Right now we don't really know when we're fully up on calls and should turn
 * ad spending down." Every other fullness signal answers about ONE tier (the nearly
 * full whisper, #1256; the booked solid page, #1412). This is the one number for the
 * whole business, so the person who controls ad spend can act on it.
 *
 * ## The line is the admin's, never a constant
 *
 * Dan, 2026-10-21: "threshold notice but tie it to the threshold set in the admin
 * panel. so like right now I think it's above 85% or something". That is the nearly
 * full line on Team capacity (`booking_settings.capacity_nearly_full_pct`, #3936,
 * default 85), which flags a day on that page once its share reaches the line. Read
 * through `readNearlyFullPct`, which answers null on a failed read, and a null line is
 * no reading here: a notice judged against a line nobody read would look exactly like
 * one that read it.
 *
 * ## The share is Team capacity's own (L107)
 *
 * Calls that still fit against the calls the shifts could hold, from
 * `teamCapacityReport` through `dayTotals`, the same function the page totals a day
 * with: advisors out for the day and advisors whose calendar is not syncing count on
 * neither side. Added up over the first two days leads can book (`windowDays`, the
 * booker's own window), so the notice speaks to the next two business days.
 *
 * ## A condition, repeating only when it gets worse
 *
 * It holds while the share is at or over the line and ends on a MEASURED reading under
 * it. Its subjects are empty, so a change of which tiers are fullest is no news; its
 * band rises every five points over the line, so the dispatcher posts again only when
 * the share climbs into a worse band, and otherwise once a day (#3801).
 *
 * Pure apart from its injected seams (luxon, type imports and relative imports), so
 * scripts/test-roster-fill.ts drives every branch node natively.
 */
import { DateTime } from "luxon";
import type { TeamCapacityReport } from "../admin/team-capacity-load.ts";
import { dayTotals, type TeamCapacityAdvisor } from "../admin/team-capacity.ts";
import { DEBT_TIER } from "../xbc.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";

/** alert_state key for the condition. */
export const ROSTER_FILLING_KEY = "roster_filling_up";

/** How many of the days leads can book are judged together. */
export const ROSTER_FILL_WINDOW_DAYS = 2;

/** How many points over the line make a worse band, which posts again at once. */
export const ROSTER_FILL_BAND_POINTS = 5;

/** How many tiers the notice names. */
const NAMED_TIERS = 3;

export interface TierFill {
  /** The debt tier digit ("1"). */
  tier: string;
  label: string;
  open: number;
  capacity: number;
  bookedPct: number;
}

export type RosterFillReading =
  | { status: "unmeasured"; why: string }
  | {
      status: "measured";
      /** The office dates judged. */
      days: string[];
      linePct: number;
      open: number;
      capacity: number;
      bookedPct: number;
      /** Advisors left out because their calendar is not syncing. */
      notCounted: number;
      /** Fullest first, or null when the tier roster could not be read. */
      tiers: TierFill[] | null;
      over: boolean;
      band: number;
    };

/** 0 under the line, then one band per `ROSTER_FILL_BAND_POINTS` at and over it. */
export function fillBand(bookedPct: number, linePct: number): number {
  if (bookedPct < linePct) return 0;
  return 1 + Math.floor((bookedPct - linePct) / ROSTER_FILL_BAND_POINTS);
}

/** The judged days' totals for a set of advisors, by `dayTotals`, or null when nobody works. */
function totalsOver(advisors: TeamCapacityAdvisor[], dayIndexes: number[]): { open: number; capacity: number; notCounted: number; bookedPct: number } | null {
  let open = 0;
  let capacity = 0;
  let notCounted = 0;
  for (const i of dayIndexes) {
    const t = dayTotals(advisors, i);
    open += t.open;
    capacity += t.capacity;
    notCounted = Math.max(notCounted, t.notCounted);
  }
  if (capacity <= 0) return null;
  // Team capacity's rounding: down, whole numbers throughout, and never 100 while a call is open.
  const bookedPct = open === 0 ? 100 : Math.min(99, Math.floor((100 * (capacity - open)) / capacity));
  return { open, capacity, notCounted, bookedPct };
}

/** How full the roster is over the next days leads can book, against the line. */
export function judgeRosterFill(input: {
  report: TeamCapacityReport;
  linePct: number | null;
  /** Debt tier digit to its bookable advisors' ids, or null when that read failed. */
  tierAgents: Map<string, string[]> | null;
}): RosterFillReading {
  const { report, linePct } = input;
  if (!report.measurable) return { status: "unmeasured", why: `team capacity: ${report.reason}` };
  if (linePct === null || !Number.isFinite(linePct)) return { status: "unmeasured", why: "the nearly full line could not be read" };
  const days = report.windowDays.slice(0, ROSTER_FILL_WINDOW_DAYS);
  const dayIndexes = days.map((iso) => report.days.indexOf(iso));
  if (days.length === 0) return { status: "unmeasured", why: "no day leads can book" };
  if (dayIndexes.some((i) => i < 0)) return { status: "unmeasured", why: "the report does not hold every judged day" };
  const total = totalsOver(report.advisors, dayIndexes);
  if (total === null) return { status: "unmeasured", why: "nobody is working the judged days" };

  let tiers: TierFill[] | null = null;
  if (input.tierAgents !== null) {
    tiers = [];
    for (const [tier, ids] of input.tierAgents) {
      const members = new Set(ids);
      const t = totalsOver(report.advisors.filter((a) => members.has(a.id)), dayIndexes);
      if (t === null) continue;
      tiers.push({ tier, label: DEBT_TIER[tier]?.label ?? tier, open: t.open, capacity: t.capacity, bookedPct: t.bookedPct });
    }
    tiers.sort((a, b) => b.bookedPct - a.bookedPct || a.tier.localeCompare(b.tier));
  }
  const over = total.bookedPct >= linePct;
  return {
    status: "measured",
    days,
    linePct,
    open: total.open,
    capacity: total.capacity,
    bookedPct: total.bookedPct,
    notCounted: total.notCounted,
    tiers,
    over,
    band: fillBand(total.bookedPct, linePct),
  };
}

type Measured = Extract<RosterFillReading, { status: "measured" }>;

/** "Thu Oct 22 and Fri Oct 23". Office dates, so they need no zone. */
function dayList(days: string[]): string {
  const names = days.map((iso) => DateTime.fromISO(iso).toFormat("ccc LLL d"));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function windowPhrase(days: string[]): string {
  return days.length === 1 ? `the next day leads can book (${dayList(days)})` : `the next ${days.length} days leads can book (${dayList(days)})`;
}

/** The page: the share, the counts, the days, the line, the decision it is for, and the fullest tiers. */
export function formatRosterFillAlert(r: Measured): string {
  const taken = r.capacity - r.open;
  const tiers =
    r.tiers === null
      ? "The debt tiers could not be read this time, so the fullest are not named."
      : r.tiers.length === 0
        ? ""
        : `Fullest tiers: ${r.tiers.slice(0, NAMED_TIERS).map((t) => `${t.label} ${t.bookedPct}%`).join(", ")} booked.`;
  const left =
    r.notCounted === 0
      ? ""
      : `${r.notCounted} advisor${r.notCounted === 1 ? "" : "s"} whose calendar is not syncing ${r.notCounted === 1 ? "is" : "are"} left out of these numbers.`;
  return [
    `Calendars are filling up: ${r.bookedPct}% of the roster's call capacity over ${windowPhrase(r.days)} is already taken ` +
      `(${taken} of ${r.capacity} calls, ${r.open} still open), at or over the ${r.linePct}% nearly full line set on Team capacity. ` +
      `This is the point to consider turning ad spend down.`,
    tiers,
    left,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The all clear, off a measured reading under the line. */
export function formatRosterFillRecovery(r: Measured): string {
  return (
    `Calendars have room again: ${r.bookedPct}% of the roster's call capacity over ${windowPhrase(r.days)} is taken, ` +
    `under the ${r.linePct}% nearly full line set on Team capacity, so the earlier notice about calendars filling up is cleared.`
  );
}

/**
 * One tick: read the report, the line and the tier roster; post when over the line,
 * clear when measured under it, and do nothing at all when it could not be measured.
 * Never throws: a failed read is a reading of its own and a failed post is logged.
 */
export async function runRosterFillCheck(deps: {
  loadReport: () => Promise<TeamCapacityReport>;
  readLine: () => Promise<number | null>;
  loadTierAgents: () => Promise<Map<string, string[]>>;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<RosterFillReading> {
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let report: TeamCapacityReport;
  let linePct: number | null;
  try {
    [report, linePct] = await Promise.all([deps.loadReport(), deps.readLine()]);
  } catch (err) {
    const result: RosterFillReading = { status: "unmeasured", why: why(err) };
    deps.log?.({ status: "unmeasured", why: result.why });
    return result;
  }
  // The tiers only decorate the notice, so a failed read is said in it rather than
  // stopping the roster reading the decision rests on.
  const tierAgents = await deps.loadTierAgents().catch((err: unknown) => {
    deps.log?.({ status: "tiers-unreadable", why: why(err) });
    return null;
  });
  const result = judgeRosterFill({ report, linePct, tierAgents });
  if (result.status === "unmeasured") {
    deps.log?.({ status: "unmeasured", why: result.why });
    return result;
  }
  try {
    if (result.over) {
      await deps.notify(ROSTER_FILLING_KEY, deps.cooldownMs, formatRosterFillAlert(result), { subjects: [], band: result.band });
    } else {
      await deps.resolve(ROSTER_FILLING_KEY, formatRosterFillRecovery(result));
    }
  } catch (err) {
    deps.log?.({ status: result.over ? "notify-failed" : "resolve-failed", why: why(err) });
  }
  deps.log?.({
    status: "measured",
    booked_pct: result.bookedPct,
    line_pct: result.linePct,
    band: result.band,
    days: result.days.join(","),
    open: result.open,
    capacity: result.capacity,
    not_counted: result.notCounted,
  });
  return result;
}

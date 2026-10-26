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
 * neither side, for each of the first two days the booker offers a lead (`bookerDays`,
 * `offeredWindowFor`'s own list), so the notice speaks to the next two days leads can book.
 *
 * ## Every day over the line, not the days added up (#4219)
 *
 * Dan, 2026-10-25: "Fire when the next two days cross 85%". Added up, a full Monday and an
 * 81% Tuesday read 90% and paged at 6:53 PM that day, while Team capacity drew Tuesday
 * under the line. So each judged day is held to the line on its own, the least full one
 * sets the band, and the notice names each day's share and nothing added up.
 *
 * ## The booker's days, not the page's (#4064)
 *
 * After the 6 PM cutoff the booker stops counting today, but Team capacity's page keeps
 * today in front of its days (`windowDays`, #3949) because today's leftover times are
 * still served. Judged on the page's days, the notice at 11:53 PM on Wed 2026-10-21 read
 * "Wed Oct 21 and Thu Oct 22", a day that was over. So before 6 PM it judges today and
 * tomorrow, and from 6 PM tomorrow and the next open day; the page is unchanged. The
 * notice names the days by date; its all clear links to the page.
 *
 * ## A condition, repeating only when it gets worse
 *
 * It holds while every judged day is at or over the line and ends on a MEASURED reading
 * with any of them under it. Its subjects are empty; its band rises every five points
 * the least full day is over the line, so the dispatcher posts again only when that day
 * climbs into a worse band, and otherwise once a day (#3801).
 *
 * ## Only from 9 AM up to 6 PM New York time
 *
 * Dan, 2026-10-26, on the notice posting at 1:23 AM: "I only want it to post during
 * business hours from 9am - 6pm", every day including weekends (`DAYTIME_POSTING_HOURS`).
 * Outside those hours a reading is still taken and logged, but it neither posts nor
 * clears: nothing reaches the dispatcher, so nothing is recorded as sent and the repeat
 * policy cannot take the morning's post for a repeat. The first tick inside the window
 * (the lane runs at :23 and :53, so 9:23 AM) judges that morning's numbers afresh: still
 * over the line, it posts them; under it, an open notice is cleared then, and one never
 * posted says nothing. Never a stale overnight reading.
 *
 * Pure apart from its injected seams (luxon, type imports and relative imports), so
 * scripts/test-roster-fill.ts drives every branch node natively.
 */
import { DateTime } from "luxon";
import type { TeamCapacityReport } from "../admin/team-capacity-load.ts";
import { dayTotals, type TeamCapacityAdvisor } from "../admin/team-capacity.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";
import { DAYTIME_POSTING_HOURS, withinPostingHours } from "../notify/posting-hours.ts";

/** alert_state key for the condition. */
export const ROSTER_FILLING_KEY = "roster_filling_up";

/** How many of the days leads can book are judged together. */
export const ROSTER_FILL_WINDOW_DAYS = 2;

/** How many points over the line make a worse band, which posts again at once. */
export const ROSTER_FILL_BAND_POINTS = 5;

/** One judged day's own share, as Team capacity draws that day. */
export interface DayFill {
  /** The office date. */
  day: string;
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
      /** The judged days added together, for the log line; the notice never says them. */
      open: number;
      capacity: number;
      bookedPct: number;
      /** Each judged day's own share, in day order. The condition is judged on these (#4219). */
      perDay: DayFill[];
      /** Advisors left out because their calendar is not syncing. */
      notCounted: number;
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
}): RosterFillReading {
  const { report, linePct } = input;
  if (!report.measurable) return { status: "unmeasured", why: `team capacity: ${report.reason}` };
  if (linePct === null || !Number.isFinite(linePct)) return { status: "unmeasured", why: "the nearly full line could not be read" };
  const days = report.bookerDays.slice(0, ROSTER_FILL_WINDOW_DAYS);
  const dayIndexes = days.map((iso) => report.days.indexOf(iso));
  if (days.length === 0) return { status: "unmeasured", why: "no day leads can book" };
  if (dayIndexes.some((i) => i < 0)) return { status: "unmeasured", why: "the report does not hold every judged day" };
  const total = totalsOver(report.advisors, dayIndexes);
  if (total === null) return { status: "unmeasured", why: "nobody is working the judged days" };
  const perDay: DayFill[] = [];
  for (const [n, i] of dayIndexes.entries()) {
    const t = totalsOver(report.advisors, [i]);
    // A day with no shifts has no share: neither full nor empty, so nothing is judged.
    if (t === null) return { status: "unmeasured", why: `nobody is working ${dayList([days[n]!])}` };
    perDay.push({ day: days[n]!, open: t.open, capacity: t.capacity, bookedPct: t.bookedPct });
  }
  // The least full day is the one holding the condition, so it sets whether and how far over.
  const leastFull = Math.min(...perDay.map((d) => d.bookedPct));
  const over = leastFull >= linePct;
  return {
    status: "measured",
    days,
    linePct,
    open: total.open,
    capacity: total.capacity,
    bookedPct: total.bookedPct,
    perDay,
    notCounted: total.notCounted,
    over,
    band: fillBand(leastFull, linePct),
  };
}

type Measured = Extract<RosterFillReading, { status: "measured" }>;

/** "Thu Oct 22 and Fri Oct 23". Office dates, so they need no zone. */
function dayList(days: string[]): string {
  const names = days.map((iso) => DateTime.fromISO(iso).toFormat("ccc LLL d"));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Thu Oct 22 is full and Fri Oct 23 is 86% full": a day with no call open is full, as the page labels it. */
function dayShares(days: DayFill[]): string {
  const each = days.map((d) => `${dayList([d.day])} is ${d.open === 0 ? "full" : `${d.bookedPct}% full`}`);
  return each.length <= 1 ? (each[0] ?? "") : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}

/** Team capacity, as a Slack link to the page the line is set on and the days are drawn on. */
function teamCapacityLink(appBaseUrl: string): string {
  return `<${appBaseUrl}/admin/team-capacity|Team capacity>`;
}

/**
 * The page: each day's share and the decision it is for, nothing more (Dan, 2026-10-25,
 * cutting the line, the Team capacity link, the counts and the fullest tiers). The one
 * caveat kept is who is left out of the shares, on its own line when anybody is.
 */
export function formatRosterFillAlert(r: Measured): string {
  const left =
    r.notCounted === 0
      ? ""
      : `${r.notCounted} advisor${r.notCounted === 1 ? "" : "s"} whose calendar is not syncing ${r.notCounted === 1 ? "is" : "are"} left out of these numbers.`;
  return [
    `Calendars are filling up: ${dayShares(r.perDay)}. This is the point to consider turning ad spend down.`,
    left,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The all clear, off a measured reading under the line. */
export function formatRosterFillRecovery(r: Measured, appBaseUrl: string): string {
  return (
    `Calendars have room again: ${dayShares(r.perDay.filter((d) => d.bookedPct < r.linePct))}, ` +
    `under the ${r.linePct}% nearly full line set on ${teamCapacityLink(appBaseUrl)}, so the earlier notice about calendars filling up is cleared.`
  );
}

/**
 * One tick: read the report and the line; post when over the line,
 * clear when measured under it, and do nothing at all when it could not be measured.
 * Outside the posting hours it only measures and logs, holding both the post and the
 * all clear for the first tick inside them.
 * Never throws: a failed read is a reading of its own and a failed post is logged.
 */
export async function runRosterFillCheck(deps: {
  loadReport: () => Promise<TeamCapacityReport>;
  readLine: () => Promise<number | null>;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  /** Slate's own address (`appUrl()`), for the all clear's Team capacity link. */
  appBaseUrl: string;
  /** The tick's clock, which decides whether it may post (`DAYTIME_POSTING_HOURS`). */
  nowMs: number;
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
  const result = judgeRosterFill({ report, linePct });
  if (result.status === "unmeasured") {
    deps.log?.({ status: "unmeasured", why: result.why });
    return result;
  }
  // Outside the posting hours neither the notice nor its all clear reaches the dispatcher,
  // so nothing is recorded as sent and the morning tick judges afresh: held, not dropped.
  const held = !withinPostingHours(deps.nowMs, DAYTIME_POSTING_HOURS);
  if (!held) {
    try {
      if (result.over) {
        await deps.notify(ROSTER_FILLING_KEY, deps.cooldownMs, formatRosterFillAlert(result), { subjects: [], band: result.band });
      } else {
        await deps.resolve(ROSTER_FILLING_KEY, formatRosterFillRecovery(result, deps.appBaseUrl));
      }
    } catch (err) {
      deps.log?.({ status: result.over ? "notify-failed" : "resolve-failed", why: why(err) });
    }
  }
  deps.log?.({
    status: "measured",
    booked_pct: result.bookedPct,
    // Each day's own share, in the order of `days`: what `band` and the notice follow (#4219).
    day_pcts: result.perDay.map((d) => d.bookedPct).join(","),
    line_pct: result.linePct,
    band: result.band,
    held,
    days: result.days.join(","),
    open: result.open,
    capacity: result.capacity,
    not_counted: result.notCounted,
  });
  return result;
}

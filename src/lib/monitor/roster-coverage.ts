/**
 * Hours the org advertises that nobody bookable is rostered to cover (#1454).
 *
 * Measured against production on 2026-08-13: `business_hours` says the org is open
 * 08:00 to 20:00 Monday to Saturday, while every agent roster runs 08:00 to 17:00
 * Monday to Friday. Three hours a day on six days, plus the whole of Saturday, are
 * advertised to leads with nobody able to take the call. The slot passes the org
 * gate, fails the agent gate, and the booker offers nothing.
 *
 * **Why nothing noticed.** `emptyReason` classifies an open day that produced no
 * times as `busy`, and its own comment says that means "either genuinely full, or
 * nobody rostered. Either way not a closure". Those are opposite problems, one
 * solved by hiring and one by editing a schedule, and they arrive as the same word.
 *
 * **It does not compute coverage itself.** `coverageForWeek` (#1297) already
 * answers "for each open hour, how many bookable agents are on shift", with the
 * zone discipline that question needs: the org's window in the org's clock, each
 * agent in their own, judged against concrete dates so a real offset and a DST week
 * apply. A second walk here would be a second definition of the same predicate,
 * agreeing with the settings screen right up until the two drifted (L107). So this
 * module only turns that readout into the runs a person can act on, and the
 * screen and the alarm can never disagree about who covers what.
 *
 * **Why the lane rather than the availability read.** Same reasoning as
 * `empty-reason-health` (#1420): counted on the read it could only conclude when a
 * lead is present, and before cutover there are none, so it would ship blind and
 * stay blind, which is indistinguishable from finding nothing wrong (#1394). The
 * lane holds both inputs already, so it reaches a measured verdict every five
 * minutes with no traffic.
 *
 * Pure (no `@/` imports) so the node suite drives it directly.
 */
import { DateTime } from "luxon";
import {
  coverageForDate,
  memoisedCoverageClock,
  type CoverageAgent,
  type CoverageDay,
  type CoverageReadout,
} from "../booking/business-hours-coverage.ts";
import {
  windowOnDate,
  type BusinessHoursException,
  type BusinessWindow,
} from "../booking/business-hours.ts";
import { searchWindowDays } from "../availability/bookable-days.ts";
import { minutesToTime, weekdayPhrase } from "../schedule-core.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state row key for the LIVE page and its all-clear: a gap on a day a lead
 *  can book right now. Lives with the feature so the cron and the settings screen
 *  refer to the one constant. */
export const ROSTER_COVERAGE_KEY = "roster_coverage_gap";

/** alert_state row key for a gap PAST the booking horizon but inside the staffing
 *  lead time (#1936). The same condition as the live key at a different urgency:
 *  no lead can reach that day yet, and somebody has days to fix it. Its own key so
 *  it carries its own cooldown and its own all-clear, and so filling a far gap
 *  clears this without touching a near one that still stands. */
export const ROSTER_COVERAGE_UPCOMING_KEY = "roster_coverage_upcoming_gap";

/**
 * How far past the booking horizon the alarm looks, in calendar days (#1936).
 *
 * A WEEK, because the remedy is always a person and always slow: change somebody's
 * working hours, or ask somebody to cover. A gap that surfaces with a week to spare
 * reaches whoever sets the rota while there is still a rota to change. It is also
 * exactly one turn of the weekly pattern, so every weekday is inside the range at
 * least once however short the horizon is set, and a Saturday gap is seen from the
 * Saturday before. That is the case the issue was filed about: the old Monday to
 * Sunday window, checked on a Saturday, gave hours of warning and could never see
 * the next Saturday at all.
 *
 * Longer buys little. A gap three weeks out is almost always the same weekly rule
 * as the one a week out, already reported, and the range is walked every five
 * minutes on an invocation four cron lanes share.
 */
export const STAFFING_LEAD_DAYS = 7;

/**
 * The weekday whose uncovered hours never trigger the roster coverage alert, on
 * either key (Dan, 2026-10-02, #3054). Luxon numbering, 6 = Saturday. Saturday is
 * staffed thinly on purpose, so a gap there is the expected state rather than a
 * finding, and paging on it every week is how a channel gets muted (L36). Judged by
 * the gap's own date in the org's zone, whenever the alert is sent.
 */
export const ROSTER_COVERAGE_UNJUDGED_WEEKDAY = 6;

/**
 * The weekday on which the roster coverage check sends nothing at all, neither the
 * page nor the all-clear (Dan, 2026-10-02, #3054). Luxon numbering, 7 = Sunday,
 * read in the org's zone (Eastern). The check still measures and logs, and the
 * alert state is left as it stands, so Monday's tick decides.
 */
export const ROSTER_COVERAGE_QUIET_SEND_WEEKDAY = 7;

/** Whether a gap counts toward either alert: every date except the unjudged weekday.
 *  The ISO date is already the org's local date, so it is read with no zone shift. */
function isJudgedGap(g: DatedCoverageGap): boolean {
  return DateTime.fromISO(g.dateIso, { zone: "UTC" }).weekday !== ROSTER_COVERAGE_UNJUDGED_WEEKDAY;
}

/** Whether `nowMs` falls on the quiet send day in the org's zone. */
function isQuietSendDay(nowMs: number, zone: string): boolean {
  return DateTime.fromMillis(nowMs, { zone }).weekday === ROSTER_COVERAGE_QUIET_SEND_WEEKDAY;
}

/** A stretch of advertised time on one weekday with no bookable agent on shift. */
export interface CoverageGap {
  /** Luxon weekday, 1 = Monday. */
  weekday: number;
  /** Minutes from local midnight, in the ORG's zone (never the agent's). */
  startMinute: number;
  endMinute: number;
  /** True when the gap spans every advertised hour of that day. */
  wholeDay: boolean;
}

/**
 * The uncovered runs, or null when coverage could not be measured.
 *
 * Null is not an empty list, and the difference is the whole point: an unreadable
 * roster rendered as "no gaps" is a detector reporting health it never measured,
 * and `coverageForWeek` returns `{ ok: false }` with no counts at all precisely so
 * that distinction survives to here.
 */
export function gapsFromCoverage(readout: CoverageReadout): CoverageGap[] | null {
  if (!readout.ok) return null;
  return readout.days.flatMap(gapsForDay);
}

/**
 * The uncovered runs on ONE day. The single walk both the weekly readout (the
 * business hours screen) and the dated range (the alarm) go through, so the two
 * cannot come to disagree about what counts as a gap (L41).
 */
function gapsForDay(day: CoverageDay): CoverageGap[] {
  if (!day.is_open || day.hours.length === 0) return [];
  const gaps: CoverageGap[] = [];
  const advertisedStart = day.hours[0].hour * 60;
  const advertisedEnd = (day.hours[day.hours.length - 1].hour + 1) * 60;
  // Merge adjacent uncovered hours, so a three hour hole reports as one stretch
  // rather than three lines a reader has to reassemble.
  let runStart: number | null = null;
  for (const h of day.hours) {
    if (h.agents > 0) {
      if (runStart !== null) {
        gaps.push(makeGap(day.weekday, runStart, h.hour * 60, advertisedStart, advertisedEnd));
        runStart = null;
      }
    } else if (runStart === null) {
      runStart = h.hour * 60;
    }
  }
  if (runStart !== null) {
    gaps.push(makeGap(day.weekday, runStart, advertisedEnd, advertisedStart, advertisedEnd));
  }
  return gaps;
}

// --------------------------------------------------- the evaluated range (#1936)

/** Which alert a date's gaps belong to. */
export type CoverageRange = "live" | "upcoming";

/** One concrete date in the evaluated range, with its coverage. */
export interface RangeDay {
  /** yyyy-mm-dd in the ORG's zone. */
  dateIso: string;
  range: CoverageRange;
  day: CoverageDay;
}

export type CoverageRangeReadout =
  /** Nothing measured. `why` names the read that was missing, for the log line. */
  | { ok: false; why: string }
  | { ok: true; zone: string; nowMs: number; days: RangeDay[] };

/**
 * Coverage on every date from today through the booking horizon plus
 * `STAFFING_LEAD_DAYS` (#1936). Each date is judged through `windowOnDate` (so a
 * holiday exception shuts it and a one off opening opens it) and `coverageForDate`,
 * the same per date predicate the availability grid uses. Nothing here decides who
 * is on shift; it only chooses the dates and labels each one live or upcoming.
 *
 * **The horizon is counted the way the booker counts it.** `horizon_days` is a
 * number of BOOKABLE days, not calendar days (#1326): the booker searches
 * `searchWindowDays(horizon)` calendar days and offers the first `horizon` open
 * ones. So the live range runs through the day that completes that count, and a
 * shut Sunday in the middle neither counts toward it nor ends it early. Today
 * counts only while its window has not closed, because after closing time the
 * booker has nothing left to offer today and the strip reaches one open day
 * further. When the search runs out before enough open days are found (a long
 * closure) the live range ends where the booker's search ends, since no lead can
 * reach beyond it either.
 *
 * Any of the three reads missing is `{ ok: false }`, never an empty range: with no
 * horizon a live gap cannot be told from an upcoming one, with no week there is
 * nothing to hold the roster against, and with no roster every hour would read as
 * uncovered (#1134, #1152).
 */
export function coverageForRange(input: {
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] } | null;
  agents: CoverageAgent[] | null;
  horizonDays: number | null;
  nowMs: number;
}): CoverageRangeReadout {
  if (input.hours === null) return { ok: false, why: "could not read the org's business hours" };
  if (input.horizonDays === null) return { ok: false, why: "could not read the booking horizon" };
  if (input.agents === null) return { ok: false, why: "could not read the agents' working hours" };
  const { hours, agents, horizonDays, nowMs } = input;
  const zone = hours.zone;
  const today = DateTime.fromMillis(nowMs, { zone }).startOf("day");

  // Where the live range ends: the day completing `horizonDays` open days, or the
  // edge of the booker's own search when fewer than that are open inside it.
  const searchDays = searchWindowDays(horizonDays);
  let liveDays = searchDays;
  let openSeen = 0;
  for (let i = 0; i < searchDays && openSeen < horizonDays; i++) {
    const date = today.plus({ days: i });
    const window = windowOnDate(hours, date.toISODate() ?? "", date.weekday);
    if (window === null) continue;
    if (date.plus({ minutes: window.end_minute }).toMillis() <= nowMs) continue;
    openSeen++;
    if (openSeen === horizonDays) liveDays = i + 1;
  }

  // One memoised clock across every date: the shift test builds a zone aware date
  // per agent per hour, and nearly all of them repeat (#1864). Built here and
  // discarded with the walk, because the roster is read per tick.
  const clock = memoisedCoverageClock();
  const days: RangeDay[] = [];
  for (let i = 0; i < liveDays + STAFFING_LEAD_DAYS; i++) {
    const date = today.plus({ days: i });
    const dateIso = date.toISODate() ?? "";
    days.push({
      dateIso,
      range: i < liveDays ? "live" : "upcoming",
      day: coverageForDate({
        window: windowOnDate(hours, dateIso, date.weekday),
        zone,
        dateIso,
        agents,
        clock,
      }),
    });
  }
  return { ok: true, zone, nowMs, days };
}

/** A gap on one concrete date, and which alert it belongs to. */
export interface DatedCoverageGap extends CoverageGap {
  dateIso: string;
  range: CoverageRange;
  /** The gap covers the FIRST advertised hour: a lead arriving at opening finds
   *  nothing at all, which reads as the business being shut rather than busy. */
  opensUncovered: boolean;
}

/**
 * The gaps in a measured range, split by alert, or null when nothing was measured.
 *
 * A gap that has already ENDED is dropped: an hour this morning with nobody on it
 * is over, nobody can act on it, and reporting it would hold the live alert open
 * until midnight. A gap still running is kept whole, so it still says the day
 * opened with nobody on.
 */
export function rangeGaps(
  readout: CoverageRangeReadout,
): { live: DatedCoverageGap[]; upcoming: DatedCoverageGap[] } | null {
  if (!readout.ok) return null;
  const live: DatedCoverageGap[] = [];
  const upcoming: DatedCoverageGap[] = [];
  for (const d of readout.days) {
    if (d.day.hours.length === 0) continue;
    const advertisedStart = d.day.hours[0].hour * 60;
    const midnight = DateTime.fromISO(d.dateIso, { zone: readout.zone }).startOf("day");
    for (const gap of gapsForDay(d.day)) {
      if (midnight.plus({ minutes: gap.endMinute }).toMillis() <= readout.nowMs) continue;
      const dated: DatedCoverageGap = {
        ...gap,
        dateIso: d.dateIso,
        range: d.range,
        opensUncovered: gap.startMinute <= advertisedStart,
      };
      (d.range === "live" ? live : upcoming).push(dated);
    }
  }
  return { live, upcoming };
}

function makeGap(
  weekday: number,
  startMinute: number,
  endMinute: number,
  advertisedStart: number,
  advertisedEnd: number,
): CoverageGap {
  return {
    weekday,
    startMinute,
    endMinute,
    wholeDay: startMinute <= advertisedStart && endMinute >= advertisedEnd,
  };
}

// --------------------------------------------------------------- the copy

// `weekdayPhrase` and the weekday names live in `schedule-core` (#1764), because
// the hours editor states a week in the same words this alert does and two
// groupings would drift the first time one was changed (L41).

/** Gaps that share a window and a shape, so the days can be stated once. */
function groupGaps(gaps: CoverageGap[]): {
  startMinute: number;
  endMinute: number;
  wholeDay: boolean;
  weekdays: number[];
}[] {
  const by = new Map<
    string,
    { startMinute: number; endMinute: number; wholeDay: boolean; weekdays: number[] }
  >();
  for (const g of gaps) {
    const k = `${g.startMinute}-${g.endMinute}-${g.wholeDay}`;
    const found = by.get(k);
    if (found) found.weekdays.push(g.weekday);
    else
      by.set(k, {
        startMinute: g.startMinute,
        endMinute: g.endMinute,
        wholeDay: g.wholeDay,
        weekdays: [g.weekday],
      });
  }
  // Whole uncovered days first: "we say we are open and are shut" outranks "we are
  // thin after five", and the reader may only get the first line.
  return [...by.values()].sort(
    (a, b) => Number(b.wholeDay) - Number(a.wholeDay) || a.startMinute - b.startMinute,
  );
}

/**
 * The uncovered stretches as readable phrases, one per group.
 *
 * Exported because the business hours SCREEN says the same thing (#1458), and
 * the screen and the page must not each own a spelling of it: an admin reading
 * "5:00 PM to 8:00 PM Monday to Friday" on the settings page and something else
 * in Slack would have to work out whether they are the same finding. One
 * grouping, one phrasing, whoever asks (L41).
 */
export function coverageGapPhrases(gaps: CoverageGap[]): string[] {
  return groupGaps(gaps).map((g) => {
    const days = weekdayPhrase(g.weekdays);
    const window = `${minutesToTime(g.startMinute)} to ${minutesToTime(g.endMinute)}`;
    return g.wholeDay ? `all day ${days} (${window})` : `${window} ${days}`;
  });
}

/** "a", "a and b", "a, b, and c": the one way this module joins a list of clauses. */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

/** "Saturday Sep 26". The ISO date is already the org's local date, so it is
 *  formatted as a bare date with no zone arithmetic. Month before day (US order),
 *  and no comma inside a date, so a list of them still reads as a list. */
function datePhrase(dateIso: string): string {
  return DateTime.fromISO(dateIso, { zone: "UTC" }).toFormat("cccc LLL d");
}

/**
 * Dated gaps as phrases, one per stretch shape, with the dates it falls on.
 *
 * The weekly `coverageGapPhrases` cannot serve here: the range can hold two
 * Saturdays, and "Saturday" alone would not say which one is uncovered. Grouped
 * the same way (whole days first, then by start), so the reader who only sees the
 * first line still gets the worst finding.
 */
function datedGapPhrases(gaps: DatedCoverageGap[]): string[] {
  const by = new Map<
    string,
    { startMinute: number; endMinute: number; wholeDay: boolean; opens: boolean; dates: string[] }
  >();
  for (const g of gaps) {
    const opens = opensEmpty(g);
    const k = `${g.startMinute}-${g.endMinute}-${g.wholeDay}-${opens}`;
    const found = by.get(k);
    if (found) found.dates.push(g.dateIso);
    else
      by.set(k, {
        startMinute: g.startMinute,
        endMinute: g.endMinute,
        wholeDay: g.wholeDay,
        opens,
        dates: [g.dateIso],
      });
  }
  return [...by.values()]
    .sort((a, b) => Number(b.wholeDay) - Number(a.wholeDay) || a.startMinute - b.startMinute)
    .map((g) => {
      const dates = joinClauses([...g.dates].sort().map(datePhrase));
      const window = `${minutesToTime(g.startMinute)} to ${minutesToTime(g.endMinute)}`;
      if (g.wholeDay) return `all day ${dates} (${window})`;
      return g.opens ? `${window} on ${dates} (the day opens with nobody on)` : `${window} on ${dates}`;
    });
}

/**
 * Whether a gap gets the "opens with nobody on" emphasis (#1936).
 *
 * An hour missing mid day loses the leads who wanted that hour; a missing FIRST
 * hour is the moment the org says it is open, and a lead arriving then finds
 * nothing at all, which reads as the business being shut. Same condition, same
 * key, so it is emphasis in the sentence and never a second alert. A whole
 * uncovered day is left out: "all day" already says it opens empty, and saying it
 * twice is one fact stated twice (L605).
 */
function opensEmpty(g: DatedCoverageGap): boolean {
  return g.opensUncovered && !g.wholeDay;
}

/** When a dated gap begins, as an instant, judged in the ORG's zone the same way
 *  `rangeGaps` judges when one ends. */
function gapStartMs(g: DatedCoverageGap, zone: string): number {
  return DateTime.fromISO(g.dateIso, { zone })
    .startOf("day")
    .plus({ minutes: g.startMinute })
    .toMillis();
}

/**
 * How far off the earliest gap is, in the words the live page opens with (#3054).
 * Hours while it is under two days away, days after that, because "In about 93
 * hours" makes the reader do the arithmetic the sentence exists to save them.
 */
function untilPhrase(msAway: number): string {
  const hours = Math.round(msAway / 3_600_000);
  if (msAway < 3_600_000) return "Within the hour";
  if (hours < 2) return "In about an hour from this message";
  if (hours < 48) return `In about ${hours} hours from this message`;
  return `In about ${Math.round(hours / 24)} days from this message`;
}

/**
 * The LIVE page: a gap on a day a lead can book right now (#3054).
 *
 * It leads with WHEN the gap starts mattering, because that sets how soon somebody
 * has to act, then what a lead booking now meets, then both remedies, because
 * which one is right is the org's call and not ours: the hours are either
 * under-rostered or over-advertised, and a message naming only the first has
 * assumed the answer.
 *
 * It used to open with "Leads are being turned away", which read as an outage
 * under way when the gap was twelve hours off and nobody had been refused. So it
 * says the gap is happening only when the earliest one has ALREADY STARTED at
 * `sentAt`, the send time the runner passes in. Never the clock read here: the
 * preview must render the same text on every run (#1153).
 */
export function formatRosterCoverageLiveAlert(
  gaps: DatedCoverageGap[],
  sentAt: { nowMs: number; zone: string },
): string {
  const first = [...gaps].sort(
    (a, b) => gapStartMs(a, sentAt.zone) - gapStartMs(b, sentAt.zone),
  )[0];
  const startMs = gapStartMs(first, sentAt.zone);
  const when = `${minutesToTime(first.startMinute)} on ${datePhrase(first.dateIso)}`;
  const lead =
    startMs <= sentAt.nowMs
      ? `Since ${when} the org has been open with nobody bookable rostered, and it still is.`
      : `${untilPhrase(startMs - sentAt.nowMs)}, at ${when}, the org will be open with ` +
        `nobody bookable rostered.`;
  return (
    `${lead} The uncovered hours are ${joinClauses(datedGapPhrases(gaps))}, and the ` +
    `booker is not offering them to leads booking now. Set agents' working hours to ` +
    `cover them, or narrow the org's business hours so we stop advertising them.`
  );
}

/**
 * The UPCOMING notice: a gap past the booking horizon, inside the staffing lead
 * time. It must not read like the live page, because it is not one: no lead can
 * reach those days yet, and what the reader has is time (L11).
 */
export function formatRosterCoverageUpcomingAlert(gaps: DatedCoverageGap[]): string {
  return (
    `No bookable agent is rostered yet for hours the org will soon be offering: ` +
    `${joinClauses(datedGapPhrases(gaps))}.` +
    ` Nothing is broken yet, because those days are past the booking horizon and no ` +
    `lead can book them today. There is time to change someone's working hours, ask ` +
    `someone to cover, or narrow the org's business hours for those days.`
  );
}

/**
 * The gaps in `after` that were not already uncovered in `before` (#1458).
 *
 * The business hours editor is where the gap is CREATED: somebody extends the
 * day to 20:00 or opens Saturday, and the screen accepts it without comment even
 * though it is already rendering the readout that proves nobody is there. The
 * person who caused it is standing in front of the answer and is told nothing.
 *
 * Compared by uncovered HOUR, not by stretch, because the shapes change: opening
 * 17:00 to 20:00 on a day that already had 17:00 to 18:00 uncovered is a new hole
 * from 18:00, and a stretch-level comparison would either report the whole thing
 * as new or miss it entirely.
 *
 * Null when either week could not be measured, never an empty list: an unreadable
 * roster and a change that adds nothing look the same to the caller otherwise,
 * and the safe thing is to say so rather than to stay quiet (L11, L98).
 */
export function newlyUncoveredGaps(
  before: CoverageReadout,
  after: CoverageReadout,
): CoverageGap[] | null {
  const beforeGaps = gapsFromCoverage(before);
  const afterGaps = gapsFromCoverage(after);
  if (beforeGaps === null || afterGaps === null) return null;
  const wasUncovered = new Set<string>();
  for (const g of beforeGaps) {
    for (let m = g.startMinute; m < g.endMinute; m += 60) wasUncovered.add(`${g.weekday}:${m}`);
  }
  // A stretch counts as new when ANY hour in it was covered before. The person is
  // being told what their change did, and a stretch that grew is something their
  // change did.
  return afterGaps.filter((g) => {
    for (let m = g.startMinute; m < g.endMinute; m += 60) {
      if (!wasUncovered.has(`${g.weekday}:${m}`)) return true;
    }
    return false;
  });
}

/**
 * What the admin is told at the moment they widen the week (#1458).
 *
 * A WARNING, never a refusal. Opening hours ahead of rostering them is a
 * legitimate order of operations, and a guard may refuse only what the system
 * genuinely cannot do (L54). So it says what will happen and names both remedies,
 * exactly as the Slack page does, and the save has already gone through.
 */
export function newlyUncoveredWarning(gaps: CoverageGap[]): string {
  const clauses = coverageGapPhrases(gaps);
  const list =
    clauses.length <= 1
      ? (clauses[0] ?? "")
      : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return (
    `Saved. These hours are now open with no bookable agent rostered: ${list}. ` +
    `A lead asking for one of those times is offered nothing and is not told why. ` +
    `Set agents' working hours to cover them, or narrow the business hours again.`
  );
}

/** Said when the roster could not be read, so nothing was compared. */
export const COVERAGE_UNCHECKED_WARNING =
  "Saved. The roster could not be read just now, so this did not check whether the " +
  "new hours leave any time with nobody rostered. The coverage readout below will " +
  "show it once the roster is readable again.";

/**
 * The LIVE all-clear. It answers the live page's claim directly, and only that
 * one: it is sent off a measured clear horizon, so it may say nothing about the
 * week beyond, except that a gap there still stands when one does. Otherwise a
 * reader seeing "covered" would take the far notice as settled too.
 */
export function formatRosterCoverageLiveRecovery(upcomingStillOpen: boolean): string {
  return (
    `From now on every hour the org says it is open inside the booking horizon has ` +
    `at least one bookable agent rostered, so the booker holds none of them back. ` +
    `No action is needed.` +
    (upcomingStillOpen ? ` A gap further out is still open and has its own alert.` : "")
  );
}

/**
 * The UPCOMING all-clear, off a measured clear range past the horizon. When a gap
 * inside the horizon still stands it says so, because a far gap that has slid
 * inside the horizon clears this key while the live one takes it over, and "the
 * week ahead is covered" alone would read as the gap having been filled.
 */
export function formatRosterCoverageUpcomingRecovery(liveStillOpen: boolean): string {
  return (
    `Every advertised hour in the week past the booking horizon now has at least ` +
    `one bookable agent rostered. No action is needed for those days.` +
    (liveStillOpen ? ` A gap inside the booking horizon is still open and has its own alert.` : "")
  );
}

// ------------------------------------------------------------- the runner

export type RosterCoverageVerdict =
  /** Measured: advertised hours nobody bookable covers, split by which alert they
   *  belong to (either list may be empty, not both). `paged` is false while the
   *  alarm is disarmed, so an observed run is never mistaken for a sent one. */
  | { status: "gaps"; live: DatedCoverageGap[]; upcoming: DatedCoverageGap[]; paged: boolean }
  /** Measured: every advertised hour has somebody on shift. */
  | { status: "covered" }
  /** Not measured, so nothing may be claimed in either direction. */
  | { status: "skipped"; why: string };

/**
 * The monitor-cron step: measure, page on a gap, and clear ONLY off a measured
 * covered week.
 *
 * **Disarmed by default, and not for the usual reason.** The other observe-first
 * detectors (#1313, #1315) wait for a threshold to be calibrated. This one has no
 * threshold: a gap is a gap. It waits because it counts BOOKABLE agents, and the
 * roster is deliberately dark before cutover (#1272), so an armed check would
 * report the entire advertised week uncovered on every tick between now and
 * go-live. That is true, useless, and muted long before the day it starts telling
 * the truth. It measures and logs throughout, so the observation is real while it
 * waits, and the issue that arms it is filed in the same change (L65).
 *
 * No consecutive-tick streak, unlike `empty-reason-health`. That one watches a
 * READ, which can blip for a tick. This watches stored configuration, which
 * changes when a human edits it and never flickers, so a first tick reporting a
 * gap is already the standing truth.
 *
 * **Two keys, one per range (#1936), and each all-clear follows its own range.**
 * The live key is raised and cleared off the days inside the booking horizon only,
 * the upcoming key off the lead time past it only. So filling a far gap clears the
 * upcoming notice while a near gap keeps the live page standing, and the reverse.
 * Both ranges come from the one readout, so a tick either measured both or neither.
 *
 * A tick that could not measure clears NOTHING (#1134, #1152), and neither does a
 * disarmed one: silence chosen by a switch is not a measurement of health. A
 * notify or resolve failure is swallowed, because a flaky Slack must never fail
 * the tick or take out the checks after it.
 */
export async function runRosterCoverageCheck(deps: {
  coverage: CoverageRangeReadout;
  /** False until go-live: measure and log, but send nothing. */
  armed: boolean;
  notify: ThrottledNotify;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: AlertResolve;
  /** One per key, both required, so neither can quietly inherit the other's pace. */
  cooldownMs: { live: number; upcoming: number };
  log?: (msg: string) => void;
}): Promise<RosterCoverageVerdict> {
  const coverage = deps.coverage;
  const split = rangeGaps(coverage);
  if (split === null || !coverage.ok) {
    const why = coverage.ok ? "nothing measured" : coverage.why;
    deps.log?.(`monitor roster-coverage: skipped, ${why}`);
    return { status: "skipped", why };
  }
  // Saturday is never judged (Dan, 2026-10-02): a range whose only gaps fall on a
  // Saturday is a covered range, and sends its all-clear like any other.
  const live = split.live.filter(isJudgedGap);
  const upcoming = split.upcoming.filter(isJudgedGap);
  // Sunday sends nothing either way and leaves the alert state as it stands, so
  // Monday's tick decides (Dan, 2026-10-02). It still measures and logs.
  const quietDay = isQuietSendDay(coverage.nowMs, coverage.zone);
  const send = deps.armed && !quietDay;
  if (send) {
    if (live.length > 0) {
      // The readout's own instant, the one `rangeGaps` judged ended gaps by, so
      // "already started" and "already over" are measured from one moment.
      const sentAt = { nowMs: coverage.nowMs, zone: coverage.zone };
      const liveText = formatRosterCoverageLiveAlert(live, sentAt);
      await deps.notify(ROSTER_COVERAGE_KEY, deps.cooldownMs.live, liveText).catch(() => {});
    } else {
      await deps
        .resolve(ROSTER_COVERAGE_KEY, formatRosterCoverageLiveRecovery(upcoming.length > 0))
        .catch(() => {});
    }
    if (upcoming.length > 0) {
      await deps
        .notify(
          ROSTER_COVERAGE_UPCOMING_KEY,
          deps.cooldownMs.upcoming,
          formatRosterCoverageUpcomingAlert(upcoming),
        )
        .catch(() => {});
    } else {
      await deps
        .resolve(ROSTER_COVERAGE_UPCOMING_KEY, formatRosterCoverageUpcomingRecovery(live.length > 0))
        .catch(() => {});
    }
  }
  const outcome = !deps.armed ? "; disarmed, not sent" : quietDay ? "; Sunday, not sent" : "; sent";
  if (live.length === 0 && upcoming.length === 0) {
    if (deps.armed && quietDay) deps.log?.(`monitor roster-coverage: covered${outcome}`);
    return { status: "covered" };
  }
  deps.log?.(
    `monitor roster-coverage: ${live.length} stretch(es) inside the horizon and ` +
      `${upcoming.length} past it with no bookable agent` +
      outcome,
  );
  return { status: "gaps", live, upcoming, paged: send };
}

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
import type { CoverageReadout } from "../booking/business-hours-coverage.ts";
import { minutesToTime } from "../schedule-core.ts";

/** alert_state row key for the page and its all-clear. Lives with the feature so
 *  the cron and the settings screen refer to the one constant. */
export const ROSTER_COVERAGE_KEY = "roster_coverage_gap";

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
  const gaps: CoverageGap[] = [];
  for (const day of readout.days) {
    if (!day.is_open || day.hours.length === 0) continue;
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
  }
  return gaps;
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

const WEEKDAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** Weekdays as a phrase, collapsing consecutive runs: `Monday to Friday` rather
 *  than five names. The five identical weekday tails in the production shape are
 *  one finding, and spelling them out pushes the whole uncovered Saturday off the
 *  bottom of a phone notification. */
function weekdayPhrase(weekdays: number[]): string {
  const runs: number[][] = [];
  for (const w of [...weekdays].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && w === last[last.length - 1] + 1) last.push(w);
    else runs.push([w]);
  }
  const parts = runs.map((run) =>
    run.length >= 3
      ? `${WEEKDAY_NAMES[run[0]]} to ${WEEKDAY_NAMES[run[run.length - 1]]}`
      : run.map((w) => WEEKDAY_NAMES[w]).join(" and "),
  );
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

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
 * The page. It leads with what a LEAD meets, because that is the cost, then names
 * both remedies, because which one is right is the org's call and not ours: the
 * hours are either under-rostered or over-advertised, and a message naming only
 * the first has quietly assumed the answer.
 */
export function formatRosterCoverageAlert(gaps: CoverageGap[]): string {
  const clauses = groupGaps(gaps).map((g) => {
    const days = weekdayPhrase(g.weekdays);
    const window = `${minutesToTime(g.startMinute)} to ${minutesToTime(g.endMinute)}`;
    return g.wholeDay ? `all day ${days} (${window})` : `${window} ${days}`;
  });
  const list =
    clauses.length <= 1
      ? (clauses[0] ?? "")
      : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return (
    `No bookable agent is rostered for hours the org tells leads it is open: ${list}. ` +
    `A lead asking for one of those times is offered nothing and is not told why. ` +
    `Either set agents' working hours to cover them, or narrow the org's business ` +
    `hours so we stop advertising them.`
  );
}

/** The all-clear. It answers the page's claim directly: every advertised hour has
 *  somebody able to take the call again. */
export function formatRosterCoverageRecovery(): string {
  return (
    `Every hour the org advertises now has at least one bookable agent rostered to ` +
    `cover it, so a lead asking for any time in the open week reaches a real diary. ` +
    `No action is needed.`
  );
}

// ------------------------------------------------------------- the runner

export type RosterCoverageVerdict =
  /** Measured: advertised hours nobody bookable covers. `paged` is false while
   *  the alarm is disarmed, so an observed run is never mistaken for a sent one. */
  | { status: "gaps"; gaps: CoverageGap[]; paged: boolean }
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
 * A tick that could not measure clears NOTHING (#1134, #1152), and neither does a
 * disarmed one: silence chosen by a switch is not a measurement of health. A
 * notify or resolve failure is swallowed, because a flaky Slack must never fail
 * the tick or take out the checks after it.
 */
export async function runRosterCoverageCheck(deps: {
  coverage: CoverageReadout;
  /** False until go-live: measure and log, but send nothing. */
  armed: boolean;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: (key: string, text: string) => Promise<boolean>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<RosterCoverageVerdict> {
  const gaps = gapsFromCoverage(deps.coverage);
  if (gaps === null) {
    const why = "could not read the org's business hours or the agents' working hours";
    deps.log?.(`monitor roster-coverage: skipped, ${why}`);
    return { status: "skipped", why };
  }
  if (gaps.length === 0) {
    if (deps.armed) {
      await deps.resolve(ROSTER_COVERAGE_KEY, formatRosterCoverageRecovery()).catch(() => {});
    }
    return { status: "covered" };
  }
  if (deps.armed) {
    await deps
      .notify(ROSTER_COVERAGE_KEY, deps.cooldownMs, formatRosterCoverageAlert(gaps))
      .catch(() => {});
  }
  deps.log?.(
    `monitor roster-coverage: ${gaps.length} advertised stretch(es) with no bookable agent` +
      (deps.armed ? "; paged" : "; disarmed, not sent"),
  );
  return { status: "gaps", gaps, paged: deps.armed };
}

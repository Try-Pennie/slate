/**
 * Hours the org advertises that nobody is rostered to cover (#1454).
 *
 * Measured against production on 2026-08-13: `business_hours` says the org is open
 * 08:00 to 20:00 Monday to Saturday, while all 127 agent rosters run 08:00 to 17:00
 * Monday to Friday. Three hours a day on six days, plus the whole of Saturday, are
 * advertised to leads with nobody able to take the call. The slot passes the org
 * gate, fails the agent gate, and the booker offers nothing.
 *
 * **Why nothing notices this today.** `emptyReason` classifies an open day that
 * produced no times as `busy`, and its own comment says that means "either genuinely
 * full, or nobody rostered. Either way not a closure". Those are opposite problems,
 * one solved by hiring and one by editing a schedule, and they leave the classifier
 * as the same word. This is the check that tells them apart.
 *
 * **Why it lives on the lane rather than on the availability read.** Same reasoning
 * as `empty-reason-health` (#1420): counted on the read it could only ever conclude
 * when a lead is present, and before cutover there are none, so it would ship blind
 * and stay blind, which is indistinguishable from finding nothing wrong (#1394).
 * Both of its inputs are already read on every monitor pass, so it reaches a
 * measured verdict every five minutes with no traffic at all.
 *
 * **Rostered, not bookable.** An agent counts here when they have working hours,
 * whatever their bookable flag says. The roster is deliberately dark before cutover
 * (#1272), so judging on bookability would report the entire week uncovered on every
 * tick until then: true, useless, and trained-ignored long before it mattered.
 * Bookability has its own detectors; this one watches the SHAPE of the week.
 *
 * Pure (luxon only, no `@/` imports) so the node suite drives it directly.
 */
import { DateTime } from "luxon";
import { isWithinWorkingHours, type WorkingRule } from "../availability/compute.ts";
import { minutesToTime } from "../schedule-core.ts";

/** alert_state row key for the page and its all-clear. Lives with the feature so
 *  the cron and the settings screen refer to the one constant. */
export const ROSTER_COVERAGE_KEY = "roster_coverage_gap";

/** One agent's schedule: their rules, in their own zone. */
export interface Roster {
  timezone: string;
  rules: WorkingRule[];
}

/** A stretch of advertised time on one weekday with nobody rostered. */
export interface CoverageGap {
  /** Luxon weekday, 1 = Monday. */
  weekday: number;
  /** Minutes from local midnight, in the ORG's zone (never the agent's). */
  startMinute: number;
  endMinute: number;
  /** True when the gap spans the org's whole advertised window for that day. */
  wholeDay: boolean;
}

export interface RosterCoverageInput {
  /** The org's open windows and zone, or null when that read failed. */
  hours: { zone: string; rules: WorkingRule[] } | null;
  /** Every rostered agent, or null when that read failed. An EMPTY array is a
   *  measurement (nobody is rostered), which is the worst verdict, not a blocker. */
  rosters: Roster[] | null;
  nowMs: number;
}

/**
 * The gaps, or the thing that stopped them being worked out.
 *
 * `blockedBy` is not decoration: "could not check" and "nothing to report" produce
 * the same empty list once it leaves this function, so the blocker travels with the
 * null (the same shape `explainEmptyWindow` uses, and for the same reason).
 */
export type RosterCoverage =
  | { gaps: CoverageGap[]; blockedBy: null }
  | { gaps: null; blockedBy: string };

/**
 * How finely the advertised window is walked.
 *
 * Fifteen minutes because that is the smallest boundary any stored schedule can
 * land on in practice, so a real gap can never hide inside one step. It is a
 * resolution, not a slot length: this check says nothing about whether a bookable
 * appointment fits in the covered time, only whether anyone is on shift for it.
 */
const STEP_MINUTES = 15;

/**
 * Exactly one week, so every weekday is judged exactly once.
 *
 * Deliberately NOT the booking horizon. Both inputs are weekly patterns, and the
 * horizon is currently four days, so a horizon-shaped window would see Saturday
 * only on some days of the week: the Saturday gap would appear and vanish
 * depending on which day the tick ran, which reads as a flapping detector rather
 * than a standing condition.
 */
const WALK_DAYS = 7;

/** Wall-clock minutes from local midnight, set rather than added, so a DST day
 *  lands on the intended clock time instead of drifting by the offset change. */
function timeOnDay(day: DateTime, minutes: number): DateTime {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf("day");
  return day.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  });
}

/** True when at least one rostered agent is on shift for the whole of [startMs, endMs).
 *  Each agent is judged in their OWN zone, through the same predicate the booker's
 *  agent gate uses, so this can never disagree with what the booker would offer. */
function anyoneOnShift(rosters: Roster[], startMs: number, endMs: number): boolean {
  return rosters.some((r) => isWithinWorkingHours(r.rules, r.timezone, startMs, endMs));
}

/**
 * The advertised hours nobody is rostered for, over the coming week.
 *
 * Each side is judged in its own clock and the two are never intersected as raw
 * weekday minutes: the org's window is walked in the org's zone, and each agent is
 * asked about the resulting INSTANTS in theirs. Comparing the stored minute numbers
 * would be correct only while every agent sits in the business zone, which is true
 * of today's roster and is exactly why no production data could tell the two apart
 * (the same trap `compute.ts` documents for the booking gates).
 */
export function rosterCoverageGaps(input: RosterCoverageInput): RosterCoverage {
  const unread: string[] = [];
  if (!input.hours) unread.push("the org's business hours");
  if (!input.rosters) unread.push("the agents' working hours");
  if (unread.length > 0) {
    // EVERY unread input, not just the first: naming one sends the reader back for
    // a second tick to discover the rest.
    const list =
      unread.length === 1
        ? unread[0]
        : `${unread.slice(0, -1).join(", ")} and ${unread[unread.length - 1]}`;
    return { gaps: null, blockedBy: `could not read ${list}` };
  }

  const { zone, rules } = input.hours!;
  const rosters = input.rosters!;
  const start = DateTime.fromMillis(input.nowMs, { zone }).startOf("day");
  if (!start.isValid) return { gaps: null, blockedBy: `could not read the org's zone (${zone})` };

  const gaps: CoverageGap[] = [];
  for (let i = 0; i < WALK_DAYS; i++) {
    const day = start.plus({ days: i });
    for (const window of rules.filter((w) => w.weekday === day.weekday)) {
      if (window.end_minute <= window.start_minute) continue;
      // Walk the advertised window and collect the uncovered runs, merging
      // adjacent steps so a three hour gap reports as one stretch rather than
      // twelve.
      let runStart: number | null = null;
      for (let m = window.start_minute; m < window.end_minute; m += STEP_MINUTES) {
        const stepEnd = Math.min(m + STEP_MINUTES, window.end_minute);
        const covered = anyoneOnShift(
          rosters,
          timeOnDay(day, m).toMillis(),
          timeOnDay(day, stepEnd).toMillis(),
        );
        if (covered) {
          if (runStart !== null) {
            gaps.push(makeGap(day.weekday, runStart, m, window));
            runStart = null;
          }
        } else if (runStart === null) {
          runStart = m;
        }
      }
      if (runStart !== null) gaps.push(makeGap(day.weekday, runStart, window.end_minute, window));
    }
  }
  return { gaps, blockedBy: null };
}

function makeGap(
  weekday: number,
  startMinute: number,
  endMinute: number,
  window: WorkingRule,
): CoverageGap {
  return {
    weekday,
    startMinute,
    endMinute,
    wholeDay: startMinute <= window.start_minute && endMinute >= window.end_minute,
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
  const by = new Map<string, { startMinute: number; endMinute: number; wholeDay: boolean; weekdays: number[] }>();
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
  // Whole uncovered days first: "we are shut but say we are open" outranks "we are
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
    `Nobody is rostered for hours the org tells leads it is open: ${list}. ` +
    `A lead asking for one of those times is offered nothing and is not told why. ` +
    `Either set agents' working hours to cover them, or narrow the org's business ` +
    `hours so we stop advertising them.`
  );
}

/** The all-clear. It answers the page's claim directly: every advertised hour has
 *  somebody on shift for it again. */
export function formatRosterCoverageRecovery(): string {
  return (
    `Every hour the org advertises now has at least one agent rostered to cover it, ` +
    `so a lead asking for any time in the open week reaches a real diary. ` +
    `No action is needed.`
  );
}

// ------------------------------------------------------------- the runner

export type RosterCoverageVerdict =
  /** Measured: advertised hours nobody covers. */
  | { status: "gaps"; gaps: CoverageGap[] }
  /** Measured: every advertised hour has somebody on shift. */
  | { status: "covered" }
  /** Not measured, and this is what stopped it. */
  | { status: "skipped"; why: string };

/**
 * The monitor-cron step: measure, page on a gap, and clear ONLY off a measured
 * covered week.
 *
 * There is no consecutive-tick streak here, deliberately, and the difference from
 * `empty-reason-health` is the subject rather than the style. That one watches a
 * READ, which can blip for a tick, so it waits for a second. This one watches
 * stored configuration, which changes when a human edits it and never flickers, so
 * a first tick reporting a gap is already the standing truth and delaying the page
 * would only delay the fix.
 *
 * A tick that could not read its inputs clears NOTHING (#1134, #1152): it measured
 * no coverage, so it may not announce that coverage returned. A notify or resolve
 * failure is swallowed, because a flaky Slack must never fail the tick or take out
 * the checks after it.
 */
export async function runRosterCoverageCheck(deps: {
  inputs: RosterCoverageInput;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  /** REQUIRED, so `tsc` enumerates every construction site rather than letting a
   *  caller wire a condition with no way to end it (#1151, #1400). */
  resolve: (key: string, text: string) => Promise<boolean>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<RosterCoverageVerdict> {
  const outcome = rosterCoverageGaps(deps.inputs);
  if (outcome.gaps === null) {
    deps.log?.(`monitor roster-coverage: skipped, ${outcome.blockedBy}`);
    return { status: "skipped", why: outcome.blockedBy };
  }
  if (outcome.gaps.length === 0) {
    await deps.resolve(ROSTER_COVERAGE_KEY, formatRosterCoverageRecovery()).catch(() => {});
    return { status: "covered" };
  }
  await deps
    .notify(ROSTER_COVERAGE_KEY, deps.cooldownMs, formatRosterCoverageAlert(outcome.gaps))
    .catch(() => {});
  deps.log?.(
    `monitor roster-coverage: ${outcome.gaps.length} advertised stretch(es) with nobody rostered`,
  );
  return { status: "gaps", gaps: outcome.gaps };
}

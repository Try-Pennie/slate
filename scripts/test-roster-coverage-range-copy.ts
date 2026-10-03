/**
 * #2810: a gap that recurs every open day is stated as a date RANGE, not a list.
 *
 * Since #1936 the roster coverage alarm looks from today through the booking horizon
 * plus a week, so an evening tail nobody covers arrived with up to eleven dates in
 * one sentence, read on a phone mid incident. Consecutive checked dates with the
 * same uncovered hours now collapse into "every open day from A through B".
 *
 * "Consecutive" is judged against the days the check actually looked at, never the
 * calendar: a shut Sunday does not break a run, and neither does a Saturday (never
 * judged since #3054), but an open, checked day that IS covered for those hours
 * does, because a range spanning it would claim a gap that is not there.
 *
 * Driven end to end through the real range and the real runner, so the dates the
 * copy is told were checked are the ones the lane really measured.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-roster-coverage-range-copy.ts
 */
import { DateTime } from "luxon";
import {
  ROSTER_COVERAGE_KEY,
  ROSTER_COVERAGE_UPCOMING_KEY,
  checkedOpenDates,
  coverageForRange,
  formatRosterCoverageLiveAlert,
  formatRosterCoverageUpcomingAlert,
  rangeGaps,
  runRosterCoverageCheck,
} from "../src/lib/monitor/roster-coverage.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
/** Monday 2026-09-28, 07:00 local: before opening, so nothing today has ended. */
const MONDAY_7AM = DateTime.fromISO("2026-09-28T07:00", { zone: ZONE }).toMillis();

/** The production week: open 08:00 to 20:00 Monday to Saturday, Sunday shut. */
const RULES = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_minute: 8 * 60,
  end_minute: 20 * 60,
}));

type Rule = { weekday: number; start_minute: number; end_minute: number };
function agent(rules: Rule[]) {
  return { timezone: ZONE, rules };
}
function weekdays(days: number[], start: number, end: number): Rule[] {
  return days.map((weekday) => ({ weekday, start_minute: start, end_minute: end }));
}

function range(agents: ReturnType<typeof agent>[], horizonDays: number) {
  return coverageForRange({
    hours: { zone: ZONE, rules: RULES, exceptions: [] },
    agents,
    horizonDays,
    nowMs: MONDAY_7AM,
  });
}

/** Runs the real check armed and returns the text sent per key. */
async function sent(readout: ReturnType<typeof range>): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  await runRosterCoverageCheck({
    coverage: readout,
    armed: true,
    notify: async (key: string, _ms: number, text: string) => {
      texts.set(key, text);
    },
    resolve: async () => true,
    cooldownMs: { live: 1000, upcoming: 1000 },
  });
  return texts;
}

// ------------------------------------------- an evening tail every open day

// The roster production carried: Monday to Friday, 08:00 to 17:00. A ten open day
// horizon from Monday Sep 28 runs through Friday Oct 9, so the live range holds
// two working weeks of identical evening tails.
{
  const texts = await sent(range([agent(weekdays([1, 2, 3, 4, 5], 8 * 60, 17 * 60))], 11));
  const live = texts.get(ROSTER_COVERAGE_KEY) ?? "";
  assert(live.length > 0, "the live page is sent");
  eq((live.match(/17:00 to 20:00/g) ?? []).length, 1, "the tail is stated once");
  assert(
    live.includes("from Monday Sep 28 through Friday Oct 9"),
    `two weeks of identical tails collapse into one range (${live})`,
  );
  for (const middle of ["Tuesday Sep 29", "Wednesday Sep 30", "Thursday Oct 1", "Monday Oct 5"]) {
    assert(!live.includes(middle), `a date inside the range is not listed on its own (${middle})`);
  }
  assert(
    live.includes("every open day but Saturday from Monday Sep 28 through Friday Oct 9"),
    `a range spanning a Saturday sets Saturday aside rather than claiming it (${live})`,
  );
  // #3054's opening is kept: it still leads with when the gap starts mattering.
  assert(
    live.startsWith("In about 10 hours from this message, at 17:00 on Monday Sep 28"),
    `the page still opens with when the earliest gap starts (${live})`,
  );
  assert(!/[\u2014\u2013]/.test(live), "no dashes in the copy");

  const upcoming = texts.get(ROSTER_COVERAGE_UPCOMING_KEY) ?? "";
  assert(
    /every open day from Monday Oct 12 through Friday Oct 16/.test(upcoming),
    `the upcoming notice collapses its run the same way (${upcoming})`,
  );
}

// ------------------------------------------- a covered day breaks the run

// Somebody covers Wednesday Sep 30 in the evening. A range from Monday to Friday
// would claim that Wednesday is uncovered, which it is not, so the run must split
// around it.
{
  // Weekly rules cannot cover one Wednesday and not the next, so the break is
  // produced at the copy layer from a measured range with an extra checked date.
  const readout = range([agent(weekdays([1, 2, 3, 4, 5], 8 * 60, 17 * 60))], 11);
  const split = rangeGaps(readout);
  assert(split !== null, "the range is measured");
  const live = (split?.live ?? []).filter(
    (g) => g.dateIso !== "2026-09-30" && DateTime.fromISO(g.dateIso).weekday !== 6,
  );
  const text = formatRosterCoverageLiveAlert(
    live,
    { nowMs: MONDAY_7AM, zone: ZONE },
    checkedOpenDates(readout, "live"),
  );
  assert(
    text.includes("17:00 to 20:00 on Monday Sep 28, Tuesday Sep 29, and every open day"),
    `the two days before the covered Wednesday are listed, not ranged (${text})`,
  );
  assert(
    text.includes("every open day but Saturday from Thursday Oct 1 through Friday Oct 9"),
    `the run after the covered Wednesday is its own range (${text})`,
  );
  assert(!text.includes("Wednesday Sep 30"), `the covered Wednesday is never claimed (${text})`);

  // Positive control: told nothing was checked between them, the same gaps DO
  // collapse across the hole. So the split above is the checked date at work, not
  // a builder that never ranges anything (L1).
  const blind = formatRosterCoverageLiveAlert(live, { nowMs: MONDAY_7AM, zone: ZONE }, []);
  assert(
    blind.includes("every open day but Saturday from Monday Sep 28 through Friday Oct 9"),
    `with no checked dates between them the run is unbroken (${blind})`,
  );
}

// ------------------------------------------- the opens empty marker survives

// Nobody before 09:00: every day opens with nobody on, and the emphasis must ride
// along with the range rather than being lost in the collapse.
{
  const texts = await sent(range([agent(weekdays([1, 2, 3, 4, 5], 9 * 60, 20 * 60))], 11));
  const live = texts.get(ROSTER_COVERAGE_KEY) ?? "";
  assert(
    live.includes(
      "08:00 to 09:00 on every open day but Saturday from Monday Sep 28 through " +
        "Friday Oct 9 (the day opens with nobody on)",
    ),
    `the range keeps the opens with nobody on marker (${live})`,
  );
}

// ------------------------------------------- short runs stay a list

// Two days are clearer named than ranged: "every open day from Monday through
// Tuesday" says less than "Monday and Tuesday".
{
  const readout = range([agent(weekdays([1, 2, 3, 4, 5], 8 * 60, 17 * 60))], 11);
  const split = rangeGaps(readout);
  const two = (split?.upcoming ?? []).filter((g) => ["2026-10-12", "2026-10-13"].includes(g.dateIso));
  eq(two.length, 2, "the fixture holds two upcoming dates");
  const text = formatRosterCoverageUpcomingAlert(two, checkedOpenDates(readout, "upcoming"));
  assert(
    text.includes("17:00 to 20:00 on Monday Oct 12 and Tuesday Oct 13"),
    `a two day run is listed, not ranged (${text})`,
  );
  assert(!text.includes("every open day"), "and carries no range wording");
}

// ------------------------------------------- the checked dates themselves

{
  const readout = range([agent(weekdays([1, 2, 3, 4, 5], 8 * 60, 17 * 60))], 11);
  const live = checkedOpenDates(readout, "live");
  assert(!live.includes("2026-10-04"), "a shut Sunday is not a checked date");
  assert(!live.includes("2026-10-03"), "a Saturday is not a checked date, since it is never judged");
  assert(live.includes("2026-09-30"), "an open weekday is a checked date");
  eq(checkedOpenDates({ ok: false, why: "x" }, "live"), [], "an unmeasured range checked nothing");
}

finish();

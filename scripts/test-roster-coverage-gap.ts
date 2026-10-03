/**
 * #1454: noticing hours the org advertises that no BOOKABLE agent is rostered for.
 *
 * Measured against production on 2026-08-13: `business_hours` says the org is open
 * 08:00 to 20:00 Monday to Saturday, and every agent roster runs 08:00 to 17:00
 * Monday to Friday. Three hours a day on six days, plus the whole of Saturday, are
 * advertised to leads with nobody able to take the call.
 *
 * Nothing notices this today, and the two states it sits between are the reason:
 * `emptyReason` classifies an open day that produced no times as `busy`, whose own
 * comment says that is "either genuinely full, or nobody rostered. Either way not a
 * closure". Those two are opposite problems and they arrive as the same word.
 *
 * The coverage itself is computed by `coverageForWeek` (#1297), which the business
 * hours editor already uses, and this suite drives THAT rather than a fake, so the
 * screen and the alarm cannot drift into disagreeing about who covers what (L107).
 * That is also what makes the Pacific case below meaningful: every live agent is
 * Eastern, so no production data can tell a zone-correct implementation from a raw
 * minute comparison.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-roster-coverage-gap.ts
 */
import { DateTime } from "luxon";
import { coverageForWeek } from "../src/lib/booking/business-hours-coverage.ts";
import {
  ROSTER_COVERAGE_KEY,
  ROSTER_COVERAGE_UPCOMING_KEY,
  formatRosterCoverageLiveAlert,
  formatRosterCoverageLiveRecovery,
  formatRosterCoverageUpcomingRecovery,
  COVERAGE_UNCHECKED_WARNING,
  checkedOpenDates,
  coverageForRange,
  coverageGapPhrases,
  gapsFromCoverage,
  newlyUncoveredGaps,
  newlyUncoveredWarning,
  rangeGaps,
  runRosterCoverageCheck,
} from "../src/lib/monitor/roster-coverage.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
/** A Monday, as `coverageForWeek` expects. */
const WEEK_START = "2026-08-10";

/** The org's advertised week as production stores it: 08:00 to 20:00, Mon to Sat. */
const OPEN_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  is_open: weekday !== 7,
  start_minute: 8 * 60,
  end_minute: 20 * 60,
}));

/** One bookable agent: the same rule on each of the given weekdays. */
function agent(timezone: string, weekdays: number[], startMinute: number, endMinute: number) {
  return {
    timezone,
    rules: weekdays.map((weekday) => ({
      weekday,
      start_minute: startMinute,
      end_minute: endMinute,
    })),
  };
}

/** Gaps for a roster, through the REAL coverage predicate. */
function gapsFor(agents: Parameters<typeof coverageForWeek>[0]["agents"]) {
  return gapsFromCoverage(
    coverageForWeek({ businessHours: OPEN_WEEK, zone: ZONE, agents, weekStartIso: WEEK_START }),
  );
}

// ------------------------------------------------- a fully covered week

// The control. Without this, a detector hard-wired to "everything is a gap" would
// satisfy every other assertion in this file (L1).
{
  const gaps = gapsFor([agent(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)]);
  eq(gaps?.length, 0, "a roster matching the advertised week leaves no gap");
}

// ------------------------------------------------- the production shape

// The measurement that filed the issue. Both gaps, and each one's own shape: the
// weekday tail is a PARTIAL gap and Saturday is a WHOLE advertised day, which is
// the difference between "we are thin after five" and "we say we are open and are
// shut", and they need different words.
const PROD_GAPS = gapsFor([agent(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)]) ?? [];
{
  eq(PROD_GAPS.length, 6, "six advertised days have an uncovered stretch");

  const saturday = PROD_GAPS.find((g) => g.weekday === 6);
  assert(saturday !== undefined, "Saturday is reported");
  eq(saturday?.startMinute, 8 * 60, "Saturday's gap starts when the org says it opens");
  eq(saturday?.endMinute, 20 * 60, "Saturday's gap runs to when the org says it closes");
  eq(saturday?.wholeDay, true, "Saturday is a whole advertised day with nobody rostered");

  for (const weekday of [1, 2, 3, 4, 5]) {
    const gap = PROD_GAPS.find((g) => g.weekday === weekday);
    assert(gap !== undefined, `weekday ${weekday} is reported`);
    eq(gap?.startMinute, 17 * 60, `weekday ${weekday}'s gap starts when the roster ends`);
    eq(gap?.endMinute, 20 * 60, `weekday ${weekday}'s gap ends when the org closes`);
    eq(gap?.wholeDay, false, `weekday ${weekday} is a tail, not a whole uncovered day`);
  }

  assert(
    !PROD_GAPS.some((g) => g.weekday === 7),
    "a day the org does not advertise is never reported as uncovered",
  );
}

// ------------------------------------------------- each agent in their OWN zone

// A Pacific agent working 05:00 to 17:00 local covers 08:00 to 20:00 Eastern, so
// the org's whole Eastern day is covered by someone whose stored minutes (300 and
// 1020) do not resemble the org's (480 and 1200) at all. Compare the two as raw
// weekday minutes and this reports gaps that do not exist.
{
  const gaps = gapsFor([agent("America/Los_Angeles", [1, 2, 3, 4, 5, 6], 5 * 60, 17 * 60)]);
  eq(gaps?.length, 0, "a Pacific agent covering the Eastern day leaves no gap");
}

// The same agent an hour later local no longer reaches the org's opening, and the
// missing hour is reported in the ORG's minutes (08:00 to 09:00), not the agent's.
// This is the direction that catches a gap reported in the wrong clock.
{
  const gaps = gapsFor([agent("America/Los_Angeles", [1, 2, 3, 4, 5, 6], 6 * 60, 17 * 60)]) ?? [];
  assert(gaps.length > 0, "a Pacific agent starting after the org opens leaves a gap");
  eq(gaps[0]?.startMinute, 8 * 60, "the gap is reported from the org's opening minute");
  eq(gaps[0]?.endMinute, 9 * 60, "the gap ends when the Pacific agent comes on shift");
}

// ------------------------------------------------- several agents combine

// Coverage is the UNION. Neither agent covers the advertised day alone; between
// them they do, and a detector judging agents one at a time reports a gap here.
{
  const gaps = gapsFor([
    agent(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 14 * 60),
    agent(ZONE, [1, 2, 3, 4, 5, 6], 14 * 60, 20 * 60),
  ]);
  eq(gaps?.length, 0, "two half day rosters together cover the advertised day");
}

// ------------------------------------------------- nobody at all

// The state the roster is in before cutover (#1272), and the reason the alarm
// ships disarmed. It is a MEASUREMENT, not a failed read, and must not be
// swallowed as one (L98).
{
  const gaps = gapsFor([]) ?? [];
  eq(gaps.length, 6, "with nobody bookable every advertised day is uncovered");
  assert(gaps.every((g) => g.wholeDay), "with nobody bookable every gap is a whole day");
}

// ------------------------------------------------- an unreadable roster

// `coverageForWeek` returns { ok: false } carrying no counts, precisely so an
// unreadable roster cannot be rendered as "nobody covers this". That distinction
// has to survive to here: null, never an empty list.
{
  const gaps = gapsFromCoverage(
    coverageForWeek({
      businessHours: OPEN_WEEK,
      zone: ZONE,
      agents: null,
      weekStartIso: WEEK_START,
    }),
  );
  eq(gaps, null, "an unreadable roster reaches no verdict rather than reporting no gaps");
}

// ------------------------------------------------- the copy a human reads

// The page is dated since #1936, so the production shape is driven through the
// real range: checked Friday 2026-08-14 at 09:00 with a four day horizon, the live
// days are Friday, Saturday, Monday and Tuesday (Sunday is shut).
const FRIDAY_9AM = DateTime.fromISO("2026-08-14T09:00", { zone: ZONE }).toMillis();
function liveReadoutFor(agents: Parameters<typeof coverageForWeek>[0]["agents"]) {
  return coverageForRange({
      hours: {
        zone: ZONE,
        rules: OPEN_WEEK.filter((d) => d.is_open).map(({ weekday, start_minute, end_minute }) => ({
          weekday,
          start_minute,
          end_minute,
        })),
        exceptions: [],
      },
      agents,
      horizonDays: 4,
      nowMs: FRIDAY_9AM,
    });
}
const PROD_READOUT = liveReadoutFor([agent(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)]);
const PROD_LIVE = rangeGaps(PROD_READOUT)?.live ?? [];
/** The dates the check judged inside the horizon, so the copy can range a run (#2810). */
const PROD_CHECKED = checkedOpenDates(PROD_READOUT, "live");
/** The send time the live page is judged from: the same instant the gaps were measured at. */
const SENT_AT = { nowMs: FRIDAY_9AM, zone: ZONE };

{
  const text = formatRosterCoverageLiveAlert(PROD_LIVE, SENT_AT, PROD_CHECKED);

  // The identical weekday tails are ONE clause carrying their dates. Listing them
  // separately is how the one fact worth having (a whole uncovered Saturday) gets
  // pushed off the bottom of a phone notification.
  eq(
    (text.match(/17:00 to 20:00/g) ?? []).length,
    1,
    "the identical weekday tails are stated once, not once per day",
  );
  assert(
    text.includes("Friday Aug 14") && text.includes("Tuesday Aug 18"),
    `the tail names each date it falls on (${text})`,
  );
  assert(text.includes("all day Saturday Aug 15"), `the whole uncovered day is named (${text})`);
  assert(text.includes("08:00 to 20:00"), "Saturday's uncovered window is stated in full");
  assert(
    // Within the list of stretches. Since #3054 the opening sentence names the
    // EARLIEST gap's start, which can be the tail, so the order is judged where the
    // stretches are listed.
    text.indexOf("all day Saturday") < text.indexOf("17:00 to 20:00"),
    "the whole uncovered day comes before the tail in the list of stretches",
  );

  // It must say what to DO, and both directions are legitimate: roster the hours,
  // or stop advertising them. A message naming only the first assumes an answer
  // that is the org's to give.
  assert(
    /working hours/i.test(text) && /business hours/i.test(text),
    `the message offers both remedies (${text})`,
  );

  assert(!/^Slate\b/.test(text), "the alert does not open by repeating Slate's own name");
  assert(!/[\u2014\u2013]/.test(text), "the alert copy carries no dashes");
  assert(!/undefined|NaN|\[object Object\]/.test(text), `nothing leaks into the copy (${text})`);
}

// A whole uncovered day and a tail are DIFFERENT findings and must not read the
// same: one is "we say we are open and are shut", the other is "we are thin".
{
  const wholeDayOnly = formatRosterCoverageLiveAlert(PROD_LIVE.filter((g) => g.wholeDay), SENT_AT, PROD_CHECKED);
  const tailOnly = formatRosterCoverageLiveAlert(PROD_LIVE.filter((g) => !g.wholeDay), SENT_AT, PROD_CHECKED);
  assert(wholeDayOnly !== tailOnly, "a whole uncovered day does not read like a partial tail");
  // The tail's range sets Saturday aside by name ("every open day but Saturday",
  // #2810), so the check is that the uncovered Saturday itself is not claimed.
  assert(
    !tailOnly.includes("Saturday Aug 15") && !tailOnly.includes("all day"),
    "the tail message does not mention the whole uncovered day",
  );
}

for (const text of [
  formatRosterCoverageLiveRecovery(false),
  formatRosterCoverageLiveRecovery(true),
  formatRosterCoverageUpcomingRecovery(false),
  formatRosterCoverageUpcomingRecovery(true),
]) {
  assert(/no action/i.test(text), `the all-clear says no action is needed (${text})`);
  assert(!/[\u2014\u2013]/.test(text), "the recovery copy carries no dashes");
  assert(!/^Slate\b/.test(text), "the recovery does not open with Slate's own name");
}

// ------------------------------------------------- it is a CONDITION

// It is true until somebody edits a schedule or the org's week, so the reader who
// was paged needs to be told when it is over (#1151).
{
  const entry = ALERT_CATALOG.find((e) => e.key === ROSTER_COVERAGE_KEY);
  assert(entry !== undefined, `${ROSTER_COVERAGE_KEY} is in the alert catalog`);
  eq(entry?.kind, "condition", "an uncovered advertised week is a condition, not an incident");
}

// ------------------------------------------------- the check runner

/** Records what a run notified and resolved, so each path is asserted by effect. */
function spy() {
  const notified: string[] = [];
  const resolved: string[] = [];
  return {
    notified,
    resolved,
    notify: async (key: string) => {
      notified.push(key);
    },
    resolve: async (key: string) => {
      resolved.push(key);
      return true;
    },
  };
}

/** The range the monitor lane judges (#1936), over the production week. */
function rangeFor(agents: Parameters<typeof coverageForWeek>[0]["agents"]) {
  return coverageForRange({
    hours: {
      zone: ZONE,
      rules: OPEN_WEEK.filter((d) => d.is_open).map(({ weekday, start_minute, end_minute }) => ({
        weekday,
        start_minute,
        end_minute,
      })),
      exceptions: [],
    },
    agents,
    horizonDays: 4,
    nowMs: FRIDAY_9AM,
  });
}
const UNCOVERED = rangeFor([agent(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)]);
const COVERED = rangeFor([agent(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)]);
const UNREADABLE = rangeFor(null);
const COOLDOWNS = { live: 1000, upcoming: 1000 };

// Armed, with a measured gap: it pages, and clears nothing. The weekday tails sit
// both inside the horizon and in the week past it, so each key raises once.
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    coverage: UNCOVERED,
    armed: true,
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: COOLDOWNS,
  });
  eq(verdict.status, "gaps", "an uncovered advertised range is reported as gaps");
  eq(
    s.notified.sort().join(","),
    [ROSTER_COVERAGE_KEY, ROSTER_COVERAGE_UPCOMING_KEY].sort().join(","),
    "it raises each key whose range holds a gap",
  );
  eq(s.resolved.length, 0, "a tick that found a gap in both ranges sends no all-clear");
}

// DISARMED, with the same gap: it still MEASURES, and sends nothing. This is the
// state between now and cutover, and the verdict must say it did not page, or an
// observed run reads as a sent one.
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    coverage: UNCOVERED,
    armed: false,
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: COOLDOWNS,
  });
  eq(verdict.status, "gaps", "a disarmed check still reaches the measured verdict");
  assert(
    verdict.status === "gaps" && verdict.paged === false,
    "the verdict records that nothing was sent",
  );
  eq(s.notified.length, 0, "a disarmed check pages nobody");
  eq(s.resolved.length, 0, "a disarmed check sends no all-clear");
}

// Armed and measured healthy: it clears, off the MEASUREMENT and not off "we did
// not alert this run" (#1134, #1152).
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    coverage: COVERED,
    armed: true,
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: COOLDOWNS,
  });
  eq(verdict.status, "covered", "a fully covered advertised week is reported as covered");
  eq(s.notified.length, 0, "a covered week pages nobody");
  eq(s.resolved.length, 2, "a covered range clears both keys, each off its own measured range");
}

// Disarmed and covered: it must not send an all-clear either. Silence chosen by a
// switch is not a measurement of health, and an all-clear for a page that was
// never sent is noise about nothing.
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    coverage: COVERED,
    armed: false,
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: COOLDOWNS,
  });
  eq(verdict.status, "covered", "a disarmed covered week still reaches a verdict");
  const { resolved } = s;
  eq(resolved.length, 0, "a disarmed covered week sends no all-clear");
}

// THE failure path. A tick that could not measure may neither page nor clear:
// clearing here would announce coverage had returned off a read that never ran.
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    coverage: UNREADABLE,
    armed: true,
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: COOLDOWNS,
  });
  const { notified, resolved } = s;
  eq(verdict.status, "skipped", "an unreadable tick reaches no verdict");
  eq(notified.length, 0, "an unreadable tick pages nobody");
  eq(resolved.length, 0, "an unreadable tick sends no all-clear");
}

// A flaky Slack must not fail the tick or take out the checks after it.
{
  const boom = async () => {
    throw new Error("slack is down");
  };
  const verdict = await runRosterCoverageCheck({
    coverage: UNCOVERED,
    armed: true,
    notify: boom,
    resolve: boom as unknown as (key: string, text: string) => Promise<boolean>,
    cooldownMs: COOLDOWNS,
  });
  eq(verdict.status, "gaps", "a notify failure still returns the measured verdict");
}

// ------------------------------------- what the SAVE says (#1458)
//
// The alarm notices this after the fact, on a five minute cycle, and tells
// whoever is on call. The business hours editor is where the gap is CREATED, and
// the person who caused it is standing in front of the coverage readout that
// proves nobody is there. These are the pure pieces behind telling them.
{
  const readout = (businessHours: typeof OPEN_WEEK, agents: Parameters<typeof coverageForWeek>[0]["agents"]) =>
    coverageForWeek({ businessHours, zone: ZONE, agents, weekStartIso: WEEK_START });

  // Mon to Fri, 08:00 to 17:00, which is every live agent's real roster.
  const roster = [agent(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)];
  const NINE_TO_FIVE = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    is_open: weekday <= 5,
    start_minute: 8 * 60,
    end_minute: 17 * 60,
  }));

  // Nothing changed, so nothing is newly uncovered. The control: without it, a
  // function returning every gap would satisfy the assertions below (L1).
  const same = newlyUncoveredGaps(readout(NINE_TO_FIVE, roster), readout(NINE_TO_FIVE, roster));
  eq(JSON.stringify(same), "[]", "a week that did not change adds no uncovered time");

  // The headline case: the day is extended past the roster.
  const LATER = NINE_TO_FIVE.map((d) => (d.is_open ? { ...d, end_minute: 20 * 60 } : d));
  const added = newlyUncoveredGaps(readout(NINE_TO_FIVE, roster), readout(LATER, roster));
  assert(added !== null && added.length === 5, `extending to 20:00 adds a gap on each open day (got ${added?.length})`);
  assert(
    added!.every((g) => g.startMinute === 17 * 60 && g.endMinute === 20 * 60),
    "and the gap is the newly advertised stretch, not the whole day",
  );

  // The stretch GREW rather than appeared: 17:00 to 18:00 was already uncovered,
  // and pushing to 20:00 adds 18:00 onwards. An hour level comparison sees it; a
  // stretch level one would either miss it or call the whole thing new.
  const SIX = NINE_TO_FIVE.map((d) => (d.is_open ? { ...d, end_minute: 18 * 60 } : d));
  const grew = newlyUncoveredGaps(readout(SIX, roster), readout(LATER, roster));
  assert(grew !== null && grew.length === 5, "a gap that GREW is reported as newly uncovered");

  // Narrowing the week adds nothing, so a save that FIXES coverage says nothing
  // about gaps. This is the direction that would otherwise nag on every save.
  const narrowed = newlyUncoveredGaps(readout(LATER, roster), readout(NINE_TO_FIVE, roster));
  eq(JSON.stringify(narrowed), "[]", "narrowing the week adds no uncovered time");

  // Opening a day nobody works is the other real shape.
  const SATURDAY = NINE_TO_FIVE.map((d) => (d.weekday === 6 ? { ...d, is_open: true } : d));
  const sat = newlyUncoveredGaps(readout(NINE_TO_FIVE, roster), readout(SATURDAY, roster));
  assert(sat !== null && sat.length === 1 && sat[0].weekday === 6, "opening Saturday is reported");
  assert(sat![0].wholeDay, "and as the whole day, since nobody works any of it");

  // An unreadable roster is NULL, never an empty list: a save that could not be
  // checked and a save that changed nothing must not look the same (L98).
  eq(newlyUncoveredGaps({ ok: false }, readout(LATER, roster)), null, "an unreadable BEFORE reports null");
  eq(newlyUncoveredGaps(readout(NINE_TO_FIVE, roster), { ok: false }), null, "an unreadable AFTER reports null");

  // The words. The screen and the Slack page group and phrase the stretches with
  // ONE function, so an admin cannot read two different spellings of one finding.
  const phrases = coverageGapPhrases(added!);
  eq(phrases.length, 1, "five identical weekday gaps are stated once, not five times");
  assert(
    phrases[0].includes("Monday to Friday"),
    `the days collapse into a run (got ${phrases[0]})`,
  );
  const warning = newlyUncoveredWarning(added!);
  assert(warning.startsWith("Saved."), "the warning says the save WENT THROUGH, because it did");
  assert(warning.includes(phrases[0]), "and carries the same phrase the readout shows");
  assert(
    /narrow the business hours|working hours to cover/.test(warning),
    "and names both remedies, since which is right is the org's call",
  );
  assert(
    !/cannot|not allowed|refused/i.test(warning),
    "and never reads as a refusal: opening hours ahead of rostering them is legitimate (L54)",
  );
  // The Slack page names DATES since #1936 (its range can hold two Saturdays), so
  // it cannot carry the screen's weekday phrase whole; it must still state the
  // stretch in the same clock words.
  const stretch = phrases[0].split(" ").slice(0, 3).join(" ");
  eq(stretch, "17:00 to 20:00", "the screen phrase opens with the uncovered stretch");
  assert(
    formatRosterCoverageLiveAlert(PROD_LIVE, SENT_AT, PROD_CHECKED).includes(stretch),
    "and the Slack page states that stretch in the same words",
  );
  assert(
    COVERAGE_UNCHECKED_WARNING.startsWith("Saved.") &&
      /could not be read/.test(COVERAGE_UNCHECKED_WARNING),
    "an unchecked save says it saved AND that nothing was checked, never that all is well",
  );
  const DASHES = /[\u2014\u2013]/;
  assert(
    !DASHES.test(warning) && !DASHES.test(COVERAGE_UNCHECKED_WARNING),
    "no dashes in the copy",
  );
}

finish();

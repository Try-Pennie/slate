/**
 * #1454: noticing hours the org advertises that nobody is rostered to cover.
 *
 * Measured against production on 2026-08-13: `business_hours` says the org is open
 * 08:00 to 20:00 Monday to Saturday, and all 127 agent rosters run 08:00 to 17:00
 * Monday to Friday. So three hours a day on six days, plus the whole of Saturday,
 * are advertised to leads with nobody able to take the call. A slot passes the org
 * gate and then fails the agent gate, and the booker simply offers nothing.
 *
 * Nothing notices this today, and the two states it sits between are the reason:
 * `emptyReason` classifies an open day that produced no times as `busy`, whose own
 * comment says that is "either genuinely full, or nobody rostered. Either way not a
 * closure". Those two are opposite problems (buy capacity, versus roster the
 * capacity you already have) and they arrive as the same word.
 *
 * The agent's rules are judged in the AGENT's zone and the org's window in the
 * ORG's, never by intersecting the two as raw weekday minutes, which is the trap
 * `compute.ts` documents. That is what the Pacific case below is for: it is the
 * assertion that fails if anyone compares minute numbers.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-roster-coverage-gap.ts
 */
import {
  ROSTER_COVERAGE_KEY,
  formatRosterCoverageAlert,
  formatRosterCoverageRecovery,
  rosterCoverageGaps,
  runRosterCoverageCheck,
} from "../src/lib/monitor/roster-coverage.ts";
import { ALERT_CATALOG } from "../src/lib/notify/alert-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";

/** The org's advertised week as production stores it: 08:00 to 20:00, Mon to Sat. */
const OPEN_WEEK = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start_minute: 8 * 60,
  end_minute: 20 * 60,
}));

/** A Wednesday, so the seven day walk starts mid week and still covers every day. */
const NOW = Date.parse("2026-08-12T14:00:00Z");

/** One roster: the same rule on each of the given weekdays. */
function roster(timezone: string, weekdays: number[], startMinute: number, endMinute: number) {
  return {
    timezone,
    rules: weekdays.map((weekday) => ({
      weekday,
      start_minute: startMinute,
      end_minute: endMinute,
    })),
  };
}

// ------------------------------------------------- a fully covered week

// The control. Without this, a detector hard-wired to "everything is a gap" would
// satisfy every other assertion in this file (L1).
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [roster(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)],
    nowMs: NOW,
  });
  assert(result.blockedBy === null, "a readable week and roster reach a measured verdict");
  eq(result.gaps?.length, 0, "a roster matching the advertised week leaves no gap");
}

// ------------------------------------------------- the production shape

// The measurement that filed the issue. Both gaps, and each one's own shape: the
// weekday tail is a PARTIAL gap and Saturday is a WHOLE advertised day, which is
// the difference between "we are thin after five" and "we are shut but say we are
// open", and they need different words.
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [roster(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)],
    nowMs: NOW,
  });
  const gaps = result.gaps ?? [];
  eq(gaps.length, 6, "six advertised days have an uncovered stretch");

  const saturday = gaps.find((g) => g.weekday === 6);
  assert(saturday !== undefined, "Saturday is reported");
  eq(saturday?.startMinute, 8 * 60, "Saturday's gap starts when the org says it opens");
  eq(saturday?.endMinute, 20 * 60, "Saturday's gap runs to when the org says it closes");
  eq(saturday?.wholeDay, true, "Saturday is a whole advertised day with nobody rostered");

  for (const weekday of [1, 2, 3, 4, 5]) {
    const gap = gaps.find((g) => g.weekday === weekday);
    assert(gap !== undefined, `weekday ${weekday} is reported`);
    eq(gap?.startMinute, 17 * 60, `weekday ${weekday}'s gap starts when the roster ends`);
    eq(gap?.endMinute, 20 * 60, `weekday ${weekday}'s gap ends when the org closes`);
    eq(gap?.wholeDay, false, `weekday ${weekday} is a tail, not a whole uncovered day`);
  }
}

// ------------------------------------------------- each agent in their OWN zone

// A Pacific agent working 05:00 to 20:00 local covers 08:00 to 23:00 Eastern, so
// the org's whole Eastern day is covered by someone whose stored minutes (300 and
// 1200) do not resemble the org's (480 and 1200) at all. Compare the two as raw
// weekday minutes and this reports a three hour morning gap that does not exist.
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [roster("America/Los_Angeles", [1, 2, 3, 4, 5, 6], 5 * 60, 20 * 60)],
    nowMs: NOW,
  });
  eq(result.gaps?.length, 0, "a Pacific agent covering the Eastern day leaves no gap");
}

// The same agent an hour later local no longer reaches the org's opening, and the
// missing hour has to be reported in the ORG's minutes (08:00 to 09:00), not the
// agent's. This is the direction that catches a detector reporting the right gap
// in the wrong clock.
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [roster("America/Los_Angeles", [1, 2, 3, 4, 5, 6], 6 * 60, 20 * 60)],
    nowMs: NOW,
  });
  const gaps = result.gaps ?? [];
  assert(gaps.length > 0, "a Pacific agent starting after the org opens leaves a gap");
  eq(gaps[0]?.startMinute, 8 * 60, "the gap is reported from the org's opening minute");
  eq(gaps[0]?.endMinute, 9 * 60, "the gap ends when the Pacific agent comes on shift");
}

// ------------------------------------------------- several agents combine

// Coverage is the UNION. Neither agent covers the advertised day alone; between
// them they do, and a detector judging agents one at a time reports a gap here.
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [
      roster(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 14 * 60),
      roster(ZONE, [1, 2, 3, 4, 5, 6], 14 * 60, 20 * 60),
    ],
    nowMs: NOW,
  });
  eq(result.gaps?.length, 0, "two half day rosters together cover the advertised day");
}

// ------------------------------------------------- a closed day is not a gap

// Sunday is absent from the advertised week, so nobody needs to cover it. A
// detector counting unrostered days rather than unrostered ADVERTISED hours
// reports Sunday here, which would be a page about working as intended.
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [roster(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)],
    nowMs: NOW,
  });
  assert(
    !(result.gaps ?? []).some((g) => g.weekday === 7),
    "a day the org does not advertise is never reported as uncovered",
  );
}

// ------------------------------------------------- an unread input blocks

// Both reads must SKIP rather than guess, and for opposite reasons. With no
// advertised week there is nothing to hold the roster against; with no rosters
// every agent looks off shift, so the whole week would report as uncovered, which
// is the loudest possible way to be wrong.
{
  const noHours = rosterCoverageGaps({ hours: null, rosters: [], nowMs: NOW });
  eq(noHours.gaps, null, "an unreadable week reaches no verdict");
  assert(
    (noHours.blockedBy ?? "").includes("business hours"),
    `the blocker names the business hours (${noHours.blockedBy})`,
  );

  const noRosters = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: null,
    nowMs: NOW,
  });
  eq(noRosters.gaps, null, "unreadable working hours reach no verdict");
  assert(
    (noRosters.blockedBy ?? "").includes("working hours"),
    `the blocker names the working hours (${noRosters.blockedBy})`,
  );

  // EVERY unread input, not just the first: naming one sends the reader back for a
  // second tick to discover the rest.
  const neither = rosterCoverageGaps({ hours: null, rosters: null, nowMs: NOW });
  assert(
    (neither.blockedBy ?? "").includes("business hours") &&
      (neither.blockedBy ?? "").includes("working hours"),
    `both unread inputs are named (${neither.blockedBy})`,
  );
}

// ------------------------------------------------- an empty roster list

// Distinct from the null above: the read SUCCEEDED and found nobody rostered. That
// is a measured verdict, and it is the worst one, so it must not be swallowed as a
// blocked read (L98: finding nothing is not the same as finding nothing wrong).
{
  const result = rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [],
    nowMs: NOW,
  });
  eq(result.blockedBy, null, "an empty roster list is a measurement, not a blocked read");
  eq(result.gaps?.length, 6, "with nobody rostered every advertised day is uncovered");
  assert(
    (result.gaps ?? []).every((g) => g.wholeDay),
    "with nobody rostered every gap is a whole advertised day",
  );
}

// ------------------------------------------------- the copy a human reads

// The production shape, as the reader would meet it on a phone.
const PROD_GAPS =
  rosterCoverageGaps({
    hours: { zone: ZONE, rules: OPEN_WEEK },
    rosters: [roster(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)],
    nowMs: NOW,
  }).gaps ?? [];

{
  const text = formatRosterCoverageAlert(PROD_GAPS);

  // The five identical weekday tails are ONE line. Listing them separately is how
  // the one fact worth having (a whole uncovered Saturday) gets pushed off the
  // bottom of a phone notification.
  eq(
    (text.match(/17:00 to 20:00/g) ?? []).length,
    1,
    "the five identical weekday tails are stated once, not five times",
  );
  assert(text.includes("Monday to Friday"), `consecutive weekdays read as a range (${text})`);
  assert(text.includes("Saturday"), "the whole uncovered day is named");
  assert(text.includes("08:00 to 20:00"), "Saturday's uncovered window is stated in full");

  // It must say what to DO, and both directions are legitimate: roster the hours,
  // or stop advertising them. A message naming only the first assumes an answer
  // that is the org's to give.
  assert(
    /working hours/i.test(text) && /business hours/i.test(text),
    `the message offers both remedies (${text})`,
  );

  // The copy rules that the style gate and #1153 both enforce.
  assert(!/^Slate\b/.test(text), "the alert does not open by repeating Slate's own name");
  assert(!/[\u2014\u2013]/.test(text), "the alert copy carries no dashes");
  assert(
    !/undefined|NaN|\[object Object\]/.test(text),
    `nothing leaks into the copy (${text})`,
  );
}

// A whole uncovered day and a tail are DIFFERENT findings and must not read the
// same: one is "we are shut but say we are open", the other is "we are thin".
{
  const wholeDayOnly = formatRosterCoverageAlert(PROD_GAPS.filter((g) => g.wholeDay));
  const tailOnly = formatRosterCoverageAlert(PROD_GAPS.filter((g) => !g.wholeDay));
  assert(wholeDayOnly !== tailOnly, "a whole uncovered day does not read like a partial tail");
  assert(!tailOnly.includes("Saturday"), "the tail message does not mention the covered day");
}

// The all-clear answers the page's own claim, and never renders as an empty page.
{
  const text = formatRosterCoverageRecovery();
  assert(text.length > 0, "the recovery notice renders");
  assert(/no action/i.test(text), `the all-clear says no action is needed (${text})`);
  assert(!/[\u2014\u2013]/.test(text), "the recovery copy carries no dashes");
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

// A measured gap pages, and clears nothing.
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    inputs: {
      hours: { zone: ZONE, rules: OPEN_WEEK },
      rosters: [roster(ZONE, [1, 2, 3, 4, 5], 8 * 60, 17 * 60)],
      nowMs: NOW,
    },
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: 1000,
  });
  eq(verdict.status, "gaps", "an uncovered advertised week is reported as gaps");
  eq(s.notified, [ROSTER_COVERAGE_KEY], "it pages on the coverage key");
  eq(s.resolved, [], "a tick that found a gap clears nothing");
}

// A measured healthy week clears, off the MEASUREMENT and not off "we did not
// alert this run" (#1134, #1152).
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    inputs: {
      hours: { zone: ZONE, rules: OPEN_WEEK },
      rosters: [roster(ZONE, [1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)],
      nowMs: NOW,
    },
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: 1000,
  });
  eq(verdict.status, "covered", "a fully covered advertised week is reported as covered");
  eq(s.notified, [], "a covered week pages nobody");
  eq(s.resolved, [ROSTER_COVERAGE_KEY], "a covered week clears any standing page");
}

// THE failure path. A tick that could not read its inputs measured no health, so
// it may neither page nor clear: clearing here would announce that coverage had
// returned off a query that never ran.
{
  const s = spy();
  const verdict = await runRosterCoverageCheck({
    inputs: { hours: null, rosters: null, nowMs: NOW },
    notify: s.notify,
    resolve: s.resolve,
    cooldownMs: 1000,
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
    inputs: {
      hours: { zone: ZONE, rules: OPEN_WEEK },
      rosters: [],
      nowMs: NOW,
    },
    notify: boom,
    resolve: boom as unknown as (key: string, text: string) => Promise<boolean>,
    cooldownMs: 1000,
  });
  eq(verdict.status, "gaps", "a notify failure still returns the measured verdict");
}

finish();

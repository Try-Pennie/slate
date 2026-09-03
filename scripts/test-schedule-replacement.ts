// Pure validation for replacing a user's weekly hours (#1293). The write path
// deletes every rule and reinserts, so what it does with a REFUSED input decides
// whether an agent silently drops out of availability: unchecking every day, or an
// end time that is not after the start, used to clear the rules and report success,
// which reads as "saved" while removing that agent from every bucket.
//
// Kept pure so the refusal rules are node-testable; the atomic write itself is a
// Postgres function, and the server action's use of it is pinned in vitest.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-schedule-replacement.ts
import {
  planScheduleReplacement,
  planUniformSchedule,
} from "../src/lib/schedule-replacement.ts";
import { assert, finish } from "./lib/harness.ts";

/** A real zone, so the day rules are what these cases are testing (#1671). */
const ZONE = "America/New_York";

// --- a normal weekday schedule ---
{
  const plan = planUniformSchedule([1, 2, 3, 4, 5], 480, 1020, ZONE);
  assert(plan.ok === true, "a normal Monday to Friday window is accepted");
  if (plan.ok) {
    assert(plan.rules.length === 5, "one rule per selected day");
    assert(
      plan.rules.every((r) => r.start_minute === 480 && r.end_minute === 1020),
      "every rule carries the window it was given",
    );
    assert(
      plan.rules.map((r) => r.weekday).join(",") === "1,2,3,4,5",
      "the weekdays are the ones selected, in order",
    );
  }
}

// --- refusals: each one used to CLEAR the schedule and report success ---
{
  const noDays = planUniformSchedule([], 480, 1020, ZONE);
  assert(noDays.ok === false, "no days selected is refused, never applied as an empty week");
  if (!noDays.ok) {
    assert(/day/i.test(noDays.error), "the refusal says days are the problem");
    // The message is read by the person who just pressed save, so it has to say
    // what to do, not what went wrong internally.
    assert(/pick|choose|select/i.test(noDays.error), "the refusal says what to do next");
    // Both real routes are named, because someone clearing their week wants one of
    // them: time off for an absence, or the booking pool for a longer term change.
    // A refusal that only says no is a dead end for the person reading it.
    assert(/time off/i.test(noDays.error), "the refusal names time off for an absence");
    assert(/pool|admin/i.test(noDays.error), "the refusal names the booking pool route too");
  }

  const inverted = planUniformSchedule([1], 1020, 480, ZONE);
  assert(inverted.ok === false, "an end before the start is refused");
  const equal = planUniformSchedule([1], 600, 600, ZONE);
  assert(equal.ok === false, "a zero length window is refused");
  if (!equal.ok) assert(/end|after|later/i.test(equal.error), "the refusal names the end time");
}

// --- degenerate inputs a form can still produce ---
{
  assert(
    planUniformSchedule([0], 480, 1020, ZONE).ok === false,
    "weekday 0 is refused: Luxon weekdays are 1 to 7, and 0 would never match a day",
  );
  assert(planUniformSchedule([8], 480, 1020, ZONE).ok === false, "weekday 8 is refused");
  assert(
    planUniformSchedule([1, 1, 2], 480, 1020, ZONE).ok === false,
    "a duplicated day is refused rather than written twice",
  );
  assert(
    planUniformSchedule([1], -1, 1020, ZONE).ok === false,
    "a negative start minute is refused",
  );
  assert(
    planUniformSchedule([1], 480, 1441, ZONE).ok === false,
    "an end past the end of the day is refused",
  );
  // 1440 is midnight at the end of the day, which the compute treats as a valid
  // bound, so it must be allowed rather than rejected as out of range.
  assert(planUniformSchedule([1], 480, 1440, ZONE).ok === true, "an end at midnight is allowed");
  {
    // With a real zone, so the refusal is about the MINUTE and cannot be
    // satisfied by the timezone check refusing first (L140).
    const nanStart = planUniformSchedule([1], Number.NaN, 1020, ZONE);
    assert(nanStart.ok === false, "an unreadable start minute is refused, never written as NaN");
    assert(
      nanStart.ok === false && /times could not be read/i.test(nanStart.error),
      "and it is refused for being an unreadable time, not for anything else",
    );
  }
}

// --- a window PER DAY (#1308) --------------------------------------------------
// Both hours forms used to collapse the week into ONE start and ONE end applied to
// every checked day, and read back only the first day's rule, so an agent working
// 8 to 4 on Fridays could not say so. Worse, the engine has always honoured a
// window per weekday, so per-day hours written by any other route were displayed as
// the first day's and then overwritten on the next save, silently.
{
  const plan = planScheduleReplacement([
    { weekday: 1, start_minute: 540, end_minute: 1020 },
    { weekday: 5, start_minute: 480, end_minute: 960 },
  ], ZONE);
  assert(plan.ok === true, "different hours on different days are accepted");
  if (plan.ok) {
    assert(plan.rules.length === 2, "one rule per day, and only the days given");
    assert(
      plan.rules[1].start_minute === 480 && plan.rules[1].end_minute === 960,
      "Friday keeps its OWN window rather than the first day's",
    );
  }

  // Sorted, so what is written does not depend on the order the form happened to
  // submit its checkboxes in.
  const unsorted = planScheduleReplacement([
    { weekday: 5, start_minute: 480, end_minute: 960 },
    { weekday: 1, start_minute: 540, end_minute: 1020 },
  ], ZONE);
  assert(
    unsorted.ok === true && unsorted.rules.map((r) => r.weekday).join(",") === "1,5",
    "the rules are written in weekday order whatever order they arrived in",
  );
}

// --- a refusal NAMES the day ----------------------------------------------------
// A seven row form that answers "those times could not be read" tells the person
// nothing about which row to look at.
{
  const cases: [string, { weekday: number; start_minute: number; end_minute: number }][] = [
    ["ends before it starts", { weekday: 5, start_minute: 1020, end_minute: 540 }],
    ["unreadable times", { weekday: 5, start_minute: Number.NaN, end_minute: 1020 }],
    ["a start outside the day", { weekday: 5, start_minute: -30, end_minute: 1020 }],
    ["an end outside the day", { weekday: 5, start_minute: 540, end_minute: 2000 }],
  ];
  for (const [what, bad] of cases) {
    const plan = planScheduleReplacement([
      { weekday: 1, start_minute: 540, end_minute: 1020 },
      bad,
    ], ZONE);
    assert(plan.ok === false, `${what} is refused`);
    assert(
      plan.ok === false && plan.error.includes("Friday"),
      `${what} names the day the person has to fix`,
    );
  }

  // All or nothing: one bad day refuses the whole save, because a partial write
  // would leave a week nobody chose while reporting success.
  const partial = planScheduleReplacement([
    { weekday: 1, start_minute: 540, end_minute: 1020 },
    { weekday: 5, start_minute: 1020, end_minute: 540 },
  ], ZONE);
  assert(partial.ok === false, "one bad day refuses the whole week, never just its own row");
}

// --- the timezone (#1671) ---
//
// The timezone was a bare text input writing to a `text not null` column with no
// CHECK, and neither consumer validated it. It is not cosmetic: `isWithinWorkingHours`
// compares `rule.weekday !== day.weekday`, and an unreadable zone makes `day.weekday`
// NaN, so EVERY comparison is false, EVERY rule misses, and the agent is bookable at
// no time at all. The form still renders their hours correctly afterwards, because the
// hours themselves stored fine, so nothing tells them and nothing tells anyone else.
//
// Agents set their own hours at cutover (#1454), which is when a large number of
// people type into this field for the first time.
{
  const good = planUniformSchedule([1, 2, 3], 480, 1020, "America/Los_Angeles");
  assert(good.ok === true, "a real IANA zone is accepted");
  assert(good.ok === true && good.timezone === "America/Los_Angeles", "the plan carries the zone");

  // The exact values measured with Luxon on the issue: two that ARE valid and
  // must keep working, and the two that produce NaN weekdays.
  for (const valid of ["America/New_York", "EST5EDT", "UTC"]) {
    assert(
      planUniformSchedule([1], 480, 1020, valid).ok === true,
      `${valid} is a zone Luxon can read, so it is accepted`,
    );
  }
  for (const bad of ["Eastern", "", "  ", "Not/AZone", "America/New York"]) {
    const plan = planUniformSchedule([1], 480, 1020, bad);
    assert(plan.ok === false, `${JSON.stringify(bad)} is refused`);
    assert(
      plan.ok === false && /time ?zone/i.test(plan.error),
      `${JSON.stringify(bad)} is refused by NAMING the timezone, so the person knows which field to fix (got: ${plan.ok === false ? plan.error : ""})`,
    );
  }

  // The zone is checked even when the days are fine, and the days are still
  // checked when the zone is fine, so neither can hide the other.
  const bothBad = planScheduleReplacement(
    [{ weekday: 5, start_minute: 1020, end_minute: 540 }],
    "Eastern",
  );
  assert(bothBad.ok === false, "a bad zone and a bad day together are still refused");
}



// --- two windows on ONE weekday: a split shift (#1764) ---
//
// The old rule kept a `seen` set of weekdays and refused the second window with
// "That request listed the same day twice", which was correct while the form
// could only send one window per day: a repeated day meant a malformed request.
// The form can now send two, so the same input has to be read as what it is, and
// the check that matters is OVERLAP rather than repetition.
//
// The engine already honours several windows a day (`isWithinWorkingHours` loops
// every rule matching the day and returns on the first that contains the slot),
// so this refusal was the only thing standing between the form and a split shift.
{
  const split = planScheduleReplacement(
    [
      { weekday: 1, start_minute: 480, end_minute: 720 },
      { weekday: 1, start_minute: 840, end_minute: 1020 },
    ],
    ZONE,
  );
  assert(split.ok === true, "two windows on one weekday that do not overlap are accepted");
  if (split.ok) {
    assert(split.rules.length === 2, "both windows are kept, not collapsed into one");
    assert(
      split.rules.map((r) => `${r.weekday}@${r.start_minute}`).join(",") === "1@480,1@840",
      "the two windows keep their own bounds",
    );
  }

  // Touching is not overlapping: noon to 5pm straight after 8am to noon is a
  // legitimate way to say the same thing, and storing it as two rules is harmless
  // to the engine, so it is accepted rather than merged or refused.
  const touching = planScheduleReplacement(
    [
      { weekday: 3, start_minute: 480, end_minute: 720 },
      { weekday: 3, start_minute: 720, end_minute: 1020 },
    ],
    ZONE,
  );
  assert(touching.ok === true, "two windows that touch at noon are accepted, not read as an overlap");
}

// --- overlapping windows on one weekday are refused, and the refusal NAMES the day ---
{
  for (const [a, b, what] of [
    [[480, 720], [600, 1020], "one starting inside the other"],
    [[480, 1020], [600, 720], "one entirely inside the other"],
    [[480, 720], [480, 720], "the same window twice"],
    [[600, 1020], [480, 720], "the overlap arriving in reverse order"],
  ] as [number[], number[], string][]) {
    const plan = planScheduleReplacement(
      [
        { weekday: 5, start_minute: a[0], end_minute: a[1] },
        { weekday: 5, start_minute: b[0], end_minute: b[1] },
      ],
      ZONE,
    );
    assert(plan.ok === false, `${what} is refused`);
    if (!plan.ok) {
      // A seven row form that answers "those times could not be read" tells the
      // person nothing about which row to look at, which is why every other
      // refusal here names its day too.
      assert(
        /Friday/.test(plan.error),
        `${what} is refused by naming the day (got: ${plan.error})`,
      );
      assert(
        /overlap/i.test(plan.error),
        `${what} says the windows overlap rather than that the day was listed twice (got: ${plan.error})`,
      );
      assert(
        !/twice/i.test(plan.error),
        `${what} no longer reads as a malformed request (got: ${plan.error})`,
      );
    }
  }

  // Windows on DIFFERENT days can never overlap each other, so a Monday morning
  // and a Tuesday morning at the same clock time are fine.
  const differentDays = planScheduleReplacement(
    [
      { weekday: 1, start_minute: 480, end_minute: 1020 },
      { weekday: 2, start_minute: 480, end_minute: 1020 },
    ],
    ZONE,
  );
  assert(differentDays.ok === true, "the same window on two different days is not an overlap");
}

// --- the returned rules are ordered by weekday and THEN by start time ---
//
// `a.weekday - b.weekday` alone is not a total order once a weekday holds two
// windows, and `workingHoursDays` reads them back in the order they arrive and
// renders them in that order, so an unstable sort would show a day's afternoon
// window above its morning one, in whatever order the sort happened to leave.
{
  const plan = planScheduleReplacement(
    [
      { weekday: 2, start_minute: 480, end_minute: 720 },
      { weekday: 1, start_minute: 840, end_minute: 1020 },
      { weekday: 1, start_minute: 480, end_minute: 720 },
      { weekday: 1, start_minute: 1080, end_minute: 1200 },
    ],
    ZONE,
  );
  assert(plan.ok === true, "three windows on Monday and one on Tuesday are accepted");
  if (plan.ok) {
    assert(
      plan.rules.map((r) => `${r.weekday}@${r.start_minute}`).join(",") ===
        "1@480,1@840,1@1080,2@480",
      `ordered by weekday then start time (got ${plan.rules.map((r) => `${r.weekday}@${r.start_minute}`).join(",")})`,
    );
  }
}


finish();

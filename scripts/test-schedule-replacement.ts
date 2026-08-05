// Pure validation for replacing a user's weekly hours (#1293). The write path
// deletes every rule and reinserts, so what it does with a REFUSED input decides
// whether an agent silently drops out of availability: unchecking every day, or an
// end time that is not after the start, used to clear the rules and report success,
// which reads as "saved" while removing that agent from every bucket.
//
// Kept pure so the refusal rules are node-testable; the atomic write itself is a
// Postgres function, and the server action's use of it is pinned in vitest.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-schedule-replacement.ts
import { planScheduleReplacement } from "../src/lib/schedule-replacement.ts";
import { assert, finish } from "./lib/harness.ts";

// --- a normal weekday schedule ---
{
  const plan = planScheduleReplacement([1, 2, 3, 4, 5], 480, 1020);
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
  const noDays = planScheduleReplacement([], 480, 1020);
  assert(noDays.ok === false, "no days selected is refused, never applied as an empty week");
  if (!noDays.ok) {
    assert(/day/i.test(noDays.error), "the refusal says days are the problem");
    // The message is read by the person who just pressed save, so it has to say
    // what to do, not what went wrong internally.
    assert(/pick|choose|select/i.test(noDays.error), "the refusal says what to do next");
  }

  const inverted = planScheduleReplacement([1], 1020, 480);
  assert(inverted.ok === false, "an end before the start is refused");
  const equal = planScheduleReplacement([1], 600, 600);
  assert(equal.ok === false, "a zero length window is refused");
  if (!equal.ok) assert(/end|after|later/i.test(equal.error), "the refusal names the end time");
}

// --- degenerate inputs a form can still produce ---
{
  assert(
    planScheduleReplacement([0], 480, 1020).ok === false,
    "weekday 0 is refused: Luxon weekdays are 1 to 7, and 0 would never match a day",
  );
  assert(planScheduleReplacement([8], 480, 1020).ok === false, "weekday 8 is refused");
  assert(
    planScheduleReplacement([1, 1, 2], 480, 1020).ok === false,
    "a duplicated day is refused rather than written twice",
  );
  assert(
    planScheduleReplacement([1], -1, 1020).ok === false,
    "a negative start minute is refused",
  );
  assert(
    planScheduleReplacement([1], 480, 1441).ok === false,
    "an end past the end of the day is refused",
  );
  // 1440 is midnight at the end of the day, which the compute treats as a valid
  // bound, so it must be allowed rather than rejected as out of range.
  assert(planScheduleReplacement([1], 480, 1440).ok === true, "an end at midnight is allowed");
  assert(
    planScheduleReplacement([1], Number.NaN, 1020).ok === false,
    "an unreadable start minute is refused, never written as NaN",
  );
}

finish();

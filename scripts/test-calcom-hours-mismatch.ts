// The note an advisor sees when cal.com holds a different week than Slate (#3549).
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-calcom-hours-mismatch.ts
//
// An advisor who sets their own hours in Slate stops receiving the daily cal.com
// copy, by design (`hoursOverwriteRefusal`). While cal.com still takes bookings,
// that leaves two weeks for one person and nobody told. On 2026-10-08 fourteen
// advisors were in that state, and one of them asked in Slack whether she had to
// update both. These pin when Slate asks, what it says, and that a read it could
// not make is SAID rather than drawn as agreement (Dan, 2026-10-08).
import {
  shouldCompareWithCalcom,
  judgeCalcomHours,
  CALCOM_HOURS_UNCHECKED,
} from "@/lib/calcom/hours-mismatch";
import type { SlateRule } from "@/lib/calcom/schedule-import";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 8, 15, 0);

function rules(days: number[], start = 480, end = 1020): SlateRule[] {
  return days.map((weekday) => ({ weekday, start_minute: start, end_minute: end }));
}

const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function clock(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
/** A cal.com schedule as its API returns one, one availability entry per rule. */
function calSchedule(timeZone: string, rs: SlateRule[]) {
  return {
    timeZone,
    availability: rs.map((r) => ({ days: [DAY[r.weekday]], startTime: clock(r.start_minute), endTime: clock(r.end_minute) })),
  };
}

// ---- when Slate asks cal.com at all ------------------------------------------

eq(shouldCompareWithCalcom("agent", 5, false), true, "an advisor's own week is compared while cal.com is live");
eq(shouldCompareWithCalcom("agent", 5, null), true, "an unreadable retirement switch still compares: a read is harmless and silence would be a guess");
eq(shouldCompareWithCalcom("agent", 5, true), false, "after cutover cal.com takes nothing, so there is nothing to keep in step");
eq(shouldCompareWithCalcom("agent", 0, false), false, "no Slate hours at all is the page's own notice, not this one");
for (const src of ["calcom-import", "admin", "seed", null] as const) {
  eq(shouldCompareWithCalcom(src, 5, false), false, `a ${String(src)} week is kept in step by the daily copy, so it is not asked about`);
}

// ---- Charlene's week, measured 2026-10-08 -------------------------------------
// Slate: Mon to Thu plus Sat in Chicago. cal.com: Mon to Fri in Chicago.
{
  const slate = { timezone: "America/Chicago", rules: [...rules([1, 2, 3, 4]), { weekday: 6, start_minute: 540, end_minute: 1020 }] };
  const read = { kind: "schedule" as const, schedule: calSchedule("America/Chicago", rules([1, 2, 3, 4, 5])) };
  const out = judgeCalcomHours(slate, read, NOW);
  eq(out.kind, "differs", "a different set of days is a difference");
  if (out.kind === "differs") {
    assert(out.text.includes("cal.com still has you working Friday and not Saturday."), `names both directions in one sentence: ${out.text}`);
    assert(out.text.includes("update your hours there"), `says what to do about it: ${out.text}`);
    assert(!/Monday|Thursday/.test(out.text), `names only the days that differ: ${out.text}`);
  }
}

// ---- one direction only ---------------------------------------------------------
{
  const slate = { timezone: "America/New_York", rules: rules([1, 2, 3, 4, 5]) };
  const extra = judgeCalcomHours(slate, { kind: "schedule", schedule: calSchedule("America/New_York", rules([1, 2, 3, 4, 5, 6])) }, NOW);
  eq(extra.kind, "differs", "a day only cal.com has is a difference");
  if (extra.kind === "differs") assert(extra.text.includes("cal.com also has you working Saturday."), extra.text);

  const fewer = judgeCalcomHours(slate, { kind: "schedule", schedule: calSchedule("America/New_York", rules([1, 2, 3])) }, NOW);
  eq(fewer.kind, "differs", "a day only Slate has is a difference");
  if (fewer.kind === "differs") assert(fewer.text.includes("cal.com doesn't have you working Thursday and Friday."), fewer.text);
}

// ---- same days, different hours ---------------------------------------------------
{
  const slate = { timezone: "America/New_York", rules: rules([1, 2, 3, 4, 5]) };
  const cal = calSchedule("America/New_York", [...rules([1, 2, 3, 4]), { weekday: 5, start_minute: 480, end_minute: 960 }]);
  const out = judgeCalcomHours(slate, { kind: "schedule", schedule: cal }, NOW);
  eq(out.kind, "differs", "a half hour on one day is a difference: real windows sit on half hours");
  if (out.kind === "differs") {
    assert(out.text.includes("Your hours on Friday are different there."), out.text);
    assert(!out.text.includes("Monday"), `a matching day is not named: ${out.text}`);
  }
}

// ---- days AND hours ---------------------------------------------------------------
{
  const slate = { timezone: "America/New_York", rules: rules([1, 2, 3, 4, 5]) };
  const cal = calSchedule("America/New_York", [{ weekday: 1, start_minute: 540, end_minute: 1020 }, ...rules([2, 3, 4, 5, 6])]);
  const out = judgeCalcomHours(slate, { kind: "schedule", schedule: cal }, NOW);
  if (out.kind === "differs") {
    assert(out.text.includes("cal.com also has you working Saturday."), out.text);
    assert(out.text.includes("Your hours on Monday are different there too."), out.text);
  } else assert(false, "days and hours both differing is a difference");
}

// ---- timezones ---------------------------------------------------------------------
{
  const slate = { timezone: "America/Denver", rules: rules([1, 2, 3, 4, 5]) };
  const alias = judgeCalcomHours(slate, { kind: "schedule", schedule: calSchedule("America/Boise", rules([1, 2, 3, 4, 5])) }, NOW);
  eq(alias.kind, "same", "two names for one clock are the same week (#2030)");

  const other = judgeCalcomHours(slate, { kind: "schedule", schedule: calSchedule("America/Los_Angeles", rules([1, 2, 3, 4, 5])) }, NOW);
  eq(other.kind, "differs", "the same numbers in another zone are different hours");
  if (other.kind === "differs") {
    assert(other.text.includes("cal.com has your timezone as Pacific time (Los Angeles)."), `names the zone as a person reads it: ${other.text}`);
    assert(!other.text.includes("Your hours on"), `a zone difference is not also reported as every day's hours: ${other.text}`);
  }
}

// ---- agreement --------------------------------------------------------------------
{
  const slate = { timezone: "America/New_York", rules: rules([1, 2, 3, 4, 5]) };
  eq(judgeCalcomHours(slate, { kind: "schedule", schedule: calSchedule("America/New_York", rules([5, 4, 3, 2, 1])) }, NOW).kind, "same", "order does not matter");
}

// ---- cal.com holds no week -----------------------------------------------------------
{
  const slate = { timezone: "America/New_York", rules: rules([1, 2, 3, 4, 5]) };
  const none = judgeCalcomHours(slate, { kind: "no-schedule" }, NOW);
  eq(none.kind, "differs", "a cal.com account with no schedule is offered nothing there");
  if (none.kind === "differs") assert(none.text.includes("cal.com has no working hours set for you."), none.text);

  eq(judgeCalcomHours(slate, { kind: "no-account" }, NOW).kind, "not-in-calcom", "no cal.com account: nothing there to keep in step");
  eq(judgeCalcomHours(slate, { kind: "not-configured" }, NOW).kind, "not-in-calcom", "a deployment with no cal.com key is cal.com wound down");
  eq(judgeCalcomHours(slate, { kind: "loadtest" }, NOW).kind, "not-in-calcom", "the load test roster is synthetic");
}

// ---- every read that could not be made is SAID -----------------------------------------
{
  const slate = { timezone: "America/New_York", rules: rules([1, 2, 3, 4, 5]) };
  const failures = [
    { kind: "rate-limited" as const },
    { kind: "refused" as const, status: 500 },
    { kind: "unreachable" as const, detail: "timeout" },
    { kind: "unreadable" as const, why: "not a list" },
    { kind: "schedule" as const, schedule: { timeZone: "Not/AZone", availability: [] } },
  ];
  for (const read of failures) {
    const out = judgeCalcomHours(slate, read, NOW);
    eq(out.kind, "unchecked", `${read.kind} is a comparison that was not made, never agreement`);
    if (out.kind === "unchecked") eq(out.text, CALCOM_HOURS_UNCHECKED, "one sentence for a comparison not made");
  }
}

finish();

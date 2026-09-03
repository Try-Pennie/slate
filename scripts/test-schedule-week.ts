// The week as the hours form reads and states it (#1764).
//
// Two things live here because they are the same fact seen twice: the stored rules
// turned into rows a person can edit, and the sentence that says what the week
// actually is. Before this there was no sentence at all, so reading your own
// availability meant parsing a grid of 42 dropdowns, and a day could hold only ONE
// window in the form while the engine had always honoured several.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-schedule-week.ts
import {
  DEFAULT_DAY,
  businessHoursSummary,
  workingHoursDays,
  workingHoursSummary,
} from "../src/lib/schedule-week.ts";
import { assert, finish } from "./lib/harness.ts";

const rule = (weekday: number, start: number, end: number) => ({
  weekday,
  start_minute: start,
  end_minute: end,
});

/** A plain 9 to 5 week, which is what nearly every roster looks like. */
const nineToFive = [1, 2, 3, 4, 5].map((d) => rule(d, 540, 1020));

// --- the stored rules become one row per weekday, holding a LIST of windows ---
{
  const days = workingHoursDays([rule(1, 540, 1020), rule(5, 480, 960)]);
  const monday = days.find((d) => d.weekday === 1);
  const friday = days.find((d) => d.weekday === 5);

  assert(days.length === 7, "every weekday gets a row, ticked or not");
  assert(monday?.on === true && monday?.windows.length === 1, "Monday holds its one window");
  assert(
    monday?.windows[0].start === "09:00" && monday?.windows[0].end === "17:00",
    "the window carries the stored times",
  );
  // The whole point of #1308, still true: Friday keeps its own hours.
  assert(
    friday?.windows[0].start === "08:00" && friday?.windows[0].end === "16:00",
    "Friday keeps its own hours rather than showing Monday's",
  );
  assert(days.find((d) => d.weekday === 3)?.on === false, "a day with no rule is not ticked");
}

// --- a SPLIT day is now shown, not counted and warned about ---
{
  const days = workingHoursDays([
    rule(1, 840, 1020),
    rule(1, 480, 720),
    rule(2, 480, 1020),
  ]);
  const monday = days.find((d) => d.weekday === 1);

  assert(monday?.windows.length === 2, "a weekday holding two rules reads back as two windows");
  assert(
    monday?.windows.map((w) => w.start).join(",") === "08:00,14:00",
    `the windows are in start order (got ${monday?.windows.map((w) => w.start).join(",")})`,
  );
  assert(
    !("extraWindows" in (monday as object)),
    "there is no count of windows the form cannot show, because it can show them",
  );
}

// --- an untouched day still carries the default window, so ticking it is one click ---
{
  const days = workingHoursDays([]);
  assert(
    days.filter((d) => d.on).map((d) => d.weekday).join(",") === "1,2,3,4,5",
    "an agent with nothing stored starts on the usual week",
  );
  assert(
    days.every((d) => d.windows.length === 1),
    "every row starts with exactly one window",
  );
  assert(
    days[5].windows[0].start === DEFAULT_DAY.start && days[5].windows[0].end === DEFAULT_DAY.end,
    "an unticked day still holds times, so ticking it needs no further typing",
  );

  const weekendWorker = workingHoursDays([rule(6, 600, 840)]);
  assert(
    weekendWorker.filter((d) => d.on).map((d) => d.weekday).join(",") === "6",
    "a stored week that is only Saturday is honoured, not replaced by the fallback",
  );
}

// --- the sentence above the rows ---
{
  assert(
    workingHoursSummary(workingHoursDays(nineToFive)) ===
      "Monday to Friday, 9:00am to 5:00pm. Saturday and Sunday off.",
    `a plain week reads as one sentence (got ${JSON.stringify(workingHoursSummary(workingHoursDays(nineToFive)))})`,
  );

  // A SPLIT day must not be grouped with the unsplit ones. The grouping key is a
  // day's whole window LIST, not one window, or a split Monday would be collapsed
  // into "Monday to Friday, 8:00am to 5:00pm" and the sentence would state hours
  // the agent does not work.
  const split = workingHoursSummary(
    workingHoursDays([
      rule(1, 480, 720),
      rule(1, 840, 1020),
      ...[2, 3, 4, 5].map((d) => rule(d, 480, 1020)),
    ]),
  );
  assert(
    split ===
      "Monday, 8:00am to 12:00pm and 2:00pm to 5:00pm. Tuesday to Friday, 8:00am to 5:00pm. Saturday and Sunday off.",
    `a split day is stated on its own (got ${JSON.stringify(split)})`,
  );
  assert(
    !/Monday to Friday/.test(split),
    "the split day is not swallowed into a Monday to Friday run",
  );

  // Days that are not consecutive, and a single day off.
  const mwf = workingHoursSummary(workingHoursDays([1, 3, 5].map((d) => rule(d, 540, 1020))));
  assert(
    mwf === "Monday, Wednesday and Friday, 9:00am to 5:00pm. Tuesday, Thursday, Saturday and Sunday off.",
    `non consecutive days are listed (got ${JSON.stringify(mwf)})`,
  );

  const sixDays = workingHoursSummary(workingHoursDays([1, 2, 3, 4, 5, 6].map((d) => rule(d, 540, 1020))));
  assert(
    sixDays === "Monday to Saturday, 9:00am to 5:00pm. Sunday off.",
    `one day off reads in the singular (got ${JSON.stringify(sixDays)})`,
  );

  const everyDay = workingHoursSummary(workingHoursDays([1, 2, 3, 4, 5, 6, 7].map((d) => rule(d, 540, 1020))));
  assert(
    everyDay === "Every day, 9:00am to 5:00pm.",
    `a week with no day off says nothing about days off (got ${JSON.stringify(everyDay)})`,
  );

  // Nothing ticked is a state the form can be IN (somebody unticking their week
  // before saving), and the planner refuses to save it. The sentence has to say
  // that rather than being blank, which would read as a week with no hours.
  const none = workingHoursSummary(
    workingHoursDays(nineToFive).map((d) => ({ ...d, on: false })),
  );
  assert(
    none === "No working days set. Pick at least one day.",
    `an empty week says so and says what to do (got ${JSON.stringify(none)})`,
  );

  // A ticked day whose times are not filled in yet, which is what a freshly added
  // window looks like. It must not be described with somebody else's hours.
  const blank = workingHoursSummary([
    { weekday: 1, on: true, windows: [{ start: "", end: "" }] },
    ...[2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      on: false,
      windows: [{ start: "09:00", end: "17:00" }],
    })),
  ]);
  assert(
    blank === "Monday, no times set yet. Tuesday to Sunday off.",
    `a ticked day with no times says so (got ${JSON.stringify(blank)})`,
  );
}


// --- the ORG's version of the same sentence ---
//
// One grouping, two vocabularies: "off" is about a person, "closed" is about a
// business, and this panel decides whether a lead can be offered a call at all.
{
  const rule = (weekday: number, start: number, end: number) => ({
    weekday,
    start_minute: start,
    end_minute: end,
  });
  const week = businessHoursSummary(workingHoursDays([1, 2, 3, 4, 5].map((d) => rule(d, 480, 1200))));
  assert(
    week === "Open Monday to Friday, 8:00am to 8:00pm. Closed Saturday and Sunday.",
    `the org week reads as open and closed (got ${JSON.stringify(week)})`,
  );

  const shut = businessHoursSummary(
    workingHoursDays([1].map((d) => rule(d, 480, 1200))).map((d) => ({ ...d, on: false })),
  );
  assert(
    /Closed every day/.test(shut) && /leads/.test(shut),
    `an org with nothing open says what that costs (got ${JSON.stringify(shut)})`,
  );
}


finish();

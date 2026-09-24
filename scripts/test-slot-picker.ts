/**
 * #1336: the pure rules behind the ONE shared slot picker the booker and the
 * three reschedule surfaces now run on. Before this, each surface owned a
 * private copy of "which days are offerable, which times belong to a day, and
 * what to show while that is loading", and they had drifted. These are the
 * rules that used to live four times.
 *
 * Two things this file exists to pin, because both are behaviour changes that a
 * future surface could quietly undo:
 *
 *  - **No times before a day is chosen.** The booker used to derive its active
 *    day from the first available one, so a lead landed on a list of bare clock
 *    faces with a day preselected. A time carries no date, so that let someone
 *    pick 10:00 on a day they never looked at. `slotPickerView` returns
 *    `pick-a-day` until a day is chosen, and there is no code path from a null
 *    selection to a `times` view.
 *  - **The strip renders the bookable days themselves**, not a fixed seven day
 *    window with the unbookable ones greyed out, and a skipped day is marked so
 *    it is visible rather than silently absent.
 */
import { DateTime } from "luxon";
import { dayChips, daysWithSlots, slotPickerView, messageLines, pickerSlots } from "../src/lib/booking/slot-picker.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
// 2026-08-13 is a Thursday.
const TODAY = DateTime.fromISO("2026-08-13", { zone: ZONE });

// ---------------------------------------------------------------- day chips

{
  const chips = dayChips(["2026-08-13", "2026-08-14", "2026-08-15"], TODAY, ZONE);
  eq(chips.length, 3, "one chip per offered day");
  eq(chips[0].label, "TODAY", "day zero is labelled TODAY");
  eq(chips[1].label, "FRI", "a later day carries its uppercase weekday");
  eq(chips[0].day, "13", "the day number is the large figure");
  eq(chips[0].month, "AUG", "every chip carries its month text");
  eq(chips[2].month, "AUG", "including the ones whose month has not changed");
  assert(
    chips.every((c) => c.month.length > 0),
    "every chip names its month (Dan, 2026-08-31), so no chip is readable only by looking left",
  );
  assert(
    chips.every((c) => c.gapBefore === false),
    "consecutive days carry no gap marker",
  );
}

{
  // Thursday, Friday, Saturday, then MONDAY: Sunday is skipped, so the gap must
  // show. Without the marker the strip reads "14, 15, 17" with nothing saying a
  // day was left out.
  const chips = dayChips(["2026-08-14", "2026-08-15", "2026-08-17"], TODAY, ZONE);
  eq(chips[0].gapBefore, false, "the first chip never carries a gap marker");
  eq(chips[1].gapBefore, false, "Fri to Sat is consecutive");
  eq(chips[2].gapBefore, true, "Sat to Mon skips Sunday, so the gap is marked");
}

{
  // A gap of any size is marked, not only a single skipped day (#1298).
  const chips = dayChips(["2026-08-13", "2026-08-24"], TODAY, ZONE);
  eq(chips[1].gapBefore, true, "an eleven day gap is marked too");
}

{
  // The month turning over must not read as a date in the past: without it the
  // strip reads "30, 31, 1, 2" and the last two look like days already gone.
  //
  // Every chip names its month (Dan, 2026-08-31, shown both renderings and
  // choosing this one; it reverses the 2026-08-07 record and #1298's correction
  // to it, see #1640). Naming it everywhere means a chip is readable on its own
  // rather than by looking left to find the last one that carried it, and it
  // makes the strip's height constant by construction rather than by reserving
  // a blank line.
  const chips = dayChips(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"], TODAY, ZONE);
  eq(chips[0].month, "AUG", "the first chip names its month");
  eq(chips[1].month, "AUG", "so does the next one in the same month");
  eq(chips[2].month, "SEP", "the turnover names the new month");
  eq(chips[3].month, "SEP", "and the day after the turnover names it too");
  eq(chips[1].gapBefore, false, "a month boundary is not a gap");

  assert(
    chips.every((c) => c.month.length > 0),
    "no chip is left without a month, at a turnover or anywhere else",
  );
}

{
  // A year boundary still has to name the right month on each side. This case
  // mattered more when the month was named only where it CHANGED, because the
  // comparison had to include the year; now that every chip names its own month
  // there is no comparison left to get wrong. The check stays because it is the
  // one that would catch a future rendering that reintroduces a comparison.
  const newYear = dayChips(["2026-12-31", "2027-01-01"], TODAY, ZONE);
  eq(newYear[0].month, "DEC", "December is named on its own chip");
  eq(newYear[1].month, "JAN", "and January on the next, across the year boundary");

  const sameMonthDifferentYear = dayChips(["2026-12-30", "2027-12-30"], TODAY, ZONE);
  eq(
    sameMonthDifferentYear[1].month,
    "DEC",
    "two Decembers a year apart each name themselves",
  );
}

{
  eq(dayChips([], TODAY, ZONE).length, 0, "no offered days means no chips");
}

// ------------------------------------------------------- days with slots

{
  // Grouping is done in the VIEWER's zone, so a late-evening slot lands on the
  // day the viewer sees it on. 2026-08-14T01:30Z is Aug 13, 21:30 in New York.
  const days = daysWithSlots(
    ["2026-08-14T01:30:00.000Z", "2026-08-14T14:00:00.000Z"],
    ZONE,
  );
  eq(days.length, 2, "two viewer-zone days");
  eq(days[0], "2026-08-13", "a late slot belongs to the viewer's evening, not the UTC day");
  eq(days[1], "2026-08-14", "the following morning is its own day");
}

{
  const days = daysWithSlots(
    ["2026-08-20T14:00:00.000Z", "2026-08-14T14:00:00.000Z"],
    ZONE,
  );
  eq(days[0], "2026-08-14", "days come back ascending regardless of input order");
  eq(days[1], "2026-08-20", "later day second");
}

// -------------------------------------------------------------- the view

const base = { loading: false, failed: false, days: ["2026-08-14"], selectedDay: null, slotsForDay: [], outsideForDay: 0 };

{
  eq(slotPickerView({ ...base, loading: true }).kind, "loading", "loading wins");
  eq(
    slotPickerView({ ...base, loading: true, failed: true }).kind,
    "loading",
    "a retry shows loading again rather than the stale failure",
  );
  eq(slotPickerView({ ...base, failed: true }).kind, "failed", "a settled failure is its own state");
  eq(
    slotPickerView({ ...base, failed: true, days: [] }).kind,
    "failed",
    "a failure is never reported as an empty week",
  );
  eq(slotPickerView({ ...base, days: [] }).kind, "no-days", "settled with nothing bookable");
}

{
  // The rule this issue lands.
  const view = slotPickerView(base);
  eq(view.kind, "pick-a-day", "days are offered but none is chosen yet");
  assert(
    !("slots" in view),
    "the pick-a-day view carries no slots at all, so no surface can render one",
  );
}

{
  const view = slotPickerView({
    ...base,
    selectedDay: "2026-08-14",
    slotsForDay: ["2026-08-14T14:00:00.000Z"],
  });
  eq(view.kind, "times", "a chosen day with times shows them");
  if (view.kind === "times") {
    eq(view.day, "2026-08-14", "the view names the day the times belong to");
    eq(view.slots.length, 1, "and carries that day's slots");
  }
}

{
  const view = slotPickerView({ ...base, selectedDay: "2026-08-14", slotsForDay: [] });
  eq(view.kind, "day-empty", "a chosen day whose times have gone is its own state");
  if (view.kind === "day-empty") eq(view.day, "2026-08-14", "and names which day, so the copy can");
}

{
  // A day selection that is no longer offered (its last time was taken while the
  // lead read the page) must fall back to asking for a day, never to a day-empty
  // message about a day the strip no longer shows.
  const view = slotPickerView({
    ...base,
    days: ["2026-08-15"],
    selectedDay: "2026-08-14",
    slotsForDay: [],
  });
  eq(view.kind, "pick-a-day", "a stale selection returns the lead to the strip");
}

// ------------------------------------------- the lead's calling window (#2310)

{
  // Honolulu lead, Eastern agents. Sep 24: 09:00 and 14:00 Eastern are 03:00
  // and 08:00 in Honolulu. Sep 25: 09:00 Eastern only, which is 03:00 there.
  const HNL = "Pacific/Honolulu";
  const slots = [
    "2026-09-24T13:00:00Z",
    "2026-09-24T18:00:00Z",
    "2026-09-25T13:00:00Z",
  ];
  const split = pickerSlots(slots, HNL, HNL);
  eq(split.days, ["2026-09-24", "2026-09-25"], "a day whose times are all outside the window is still drawn");
  eq(split.offered, ["2026-09-24T18:00:00Z"], "only the in window time is offered");
  eq(split.offeredByDay.get("2026-09-24"), ["2026-09-24T18:00:00Z"], "the day keeps its one offerable time");
  eq(split.offeredByDay.has("2026-09-25"), false, "the all outside day offers nothing");
  eq(split.outsideByDay.get("2026-09-25"), ["2026-09-25T13:00:00Z"], "and knows it had a time set aside");

  // The admin panel groups in the admin's zone and filters in the LEAD's.
  const admin = pickerSlots(slots, "America/New_York", HNL);
  eq(admin.offered, ["2026-09-24T18:00:00Z"], "the admin panel filters in the lead's zone, not its own");

  // A New York lead is offered all three from the same list.
  eq(pickerSlots(slots, "America/New_York", "America/New_York").offered.length, 3, "a New York lead sees every time");

  // The view says why, and it is a different state from a day whose times went.
  eq(
    slotPickerView({
      loading: false,
      failed: false,
      days: split.days,
      selectedDay: "2026-09-25",
      slotsForDay: [],
      outsideForDay: 1,
    }),
    { kind: "outside-calling-hours", day: "2026-09-25" },
    "a day with only outside times says so rather than reading as empty",
  );
  eq(
    slotPickerView({
      loading: false,
      failed: false,
      days: split.days,
      selectedDay: "2026-09-25",
      slotsForDay: [],
      outsideForDay: 0,
    }).kind,
    "day-empty",
    "a day whose times simply went is still day-empty",
  );
  eq(
    slotPickerView({
      loading: false,
      failed: false,
      days: split.days,
      selectedDay: "2026-09-24",
      slotsForDay: ["2026-09-24T18:00:00Z"],
      outsideForDay: 1,
    }).kind,
    "times",
    "a day with any offerable time shows its times",
  );
}

// ------------------------------------------------------- message lines

{
  // #1336: two sentence messages broke mid line, so the second sentence started
  // halfway across. Each sentence gets its own line, from one shared helper
  // rather than hand placed breaks per surface.
  eq(
    messageLines("Could not load available times. Check your connection."),
    ["Could not load available times.", "Check your connection."],
    "two sentences split into two lines, keeping their periods",
  );
  eq(
    messageLines("Pick a day above to see the times available."),
    ["Pick a day above to see the times available."],
    "one sentence is one line",
  );
  eq(
    messageLines("Nothing left on Sat, Aug 15. Pick another day above."),
    ["Nothing left on Sat, Aug 15.", "Pick another day above."],
    "a date's own comma and abbreviation do not split the line",
  );
}

finish();

// The one place a time of day is read, snapped and spelled (#1764, #1765).
//
// Two independent time pickers used to carry their own `pad`, their own `to24`
// and their own minute snapping, and they disagreed: the time off form's local
// snap computed ceil(50 / 15) * 15, got 60, and returned 45 with the hour left
// alone, so a typed 5:50pm END became 5:45pm, fourteen minutes SHORTER in the one
// direction its own comment said it must never shorten. The shared helper rounds
// on total minutes and does not have that bug.
//
// So these rules live here, once, and the components hold none of their own.
// #1764 makes the hours fields typeable, which is what makes the disagreement
// reachable from the keyboard rather than only from stored data.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-time-of-day.ts
import { DateTime } from "luxon";
import {
  QUARTER_HOUR_TIMES,
  formatClockTime,
  snapTimeOfDay,
  timeFrom12Hour,
  twelveHourParts,
  filterTimeOptions,
  formatTimeOfDay,
  isQuarterHour,
  quarterHourOptions,
  resolveTypedTime,
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "../src/lib/date/parse.ts";
import { assert, finish } from "./lib/harness.ts";

// --- how a time is SPELLED, once ---
//
// Five places rendered this three different ways (`9:00am`, `9:00 AM`,
// `09:00 AM`). The lowercase form is what a lead already sees in the booker, so
// it is the one kept, and it is kept HERE so a sixth spelling has nowhere to go.
{
  assert(formatTimeOfDay("09:00") === "9:00am", "a morning hour reads as 9:00am");
  assert(formatTimeOfDay("17:15") === "5:15pm", "an afternoon hour reads as 5:15pm");
  assert(formatTimeOfDay("00:00") === "12:00am", "midnight reads as 12:00am, never 0:00am");
  assert(formatTimeOfDay("12:00") === "12:00pm", "noon reads as 12:00pm, never 0:00pm");
  assert(formatTimeOfDay("23:45") === "11:45pm", "the last quarter of the day reads as 11:45pm");
  assert(formatTimeOfDay("09:05") === "9:05am", "an off grid time still spells correctly");

  // Unreadable is null, never a plausible looking string. A formatter that
  // answered "12:00am" for an unreadable value would put a real time on screen
  // for a value nobody chose.
  for (const bad of ["", "  ", "banana", "9", "9:0", "25:00", "09:60", "09:00:00"]) {
    assert(
      formatTimeOfDay(bad) === null,
      `${JSON.stringify(bad)} has no spelling, so it answers null rather than a plausible time`,
    );
  }
}

// --- the options a typeahead offers: the WHOLE day, so nothing storable is unenterable ---
{
  assert(QUARTER_HOUR_TIMES.length === 96, "the day holds 96 quarter hours");
  assert(QUARTER_HOUR_TIMES[0] === "00:00", "the list starts at midnight");
  assert(QUARTER_HOUR_TIMES[95] === "23:45", "the list ends at the last same day quarter");

  const opts = quarterHourOptions();
  assert(opts.length === 96, "one option per quarter hour");
  assert(opts[0].label === "12:00am", "the first option is spelled by the shared formatter");
  assert(opts[95].label === "11:45pm", "the last option is spelled by the shared formatter");
  assert(
    new Set(opts.map((o) => o.label)).size === 96,
    "no two options share a label, so a chosen row is never ambiguous",
  );
  assert(
    opts.every((o, i) => i === 0 || o.value > opts[i - 1].value),
    "the options are in chronological order",
  );
  assert(
    opts.every((o) => o.label === formatTimeOfDay(o.value)),
    "every option label comes from the shared formatter rather than its own expression",
  );
}

// --- a TYPED value: readable, off grid, or blank, each its own answer ---
//
// #1764 decides that an unresolved field BLOCKS the save rather than snapping to
// a neighbour, because snapping something a person just typed would move their
// hours without saying so. That needs the three cases told apart: blank is an
// ordinary state (an added row nobody filled in), off grid is a real time that is
// not offered, and unreadable is not a time at all. One answer for all three
// would make a blank row refuse the save.
{
  const resolvesTo = (text: string, expected: string) => {
    const r = resolveTypedTime(text);
    assert(r.ok === true && r.value === expected, `${JSON.stringify(text)} resolves to ${expected}`);
  };
  resolvesTo("5pm", "17:00");
  resolvesTo("5 PM", "17:00");
  resolvesTo("5:15pm", "17:15");
  resolvesTo("5:15 p.m.", "17:15");
  resolvesTo("5:15p", "17:15");
  resolvesTo("17:15", "17:15");
  resolvesTo("5", "05:00");
  resolvesTo("5:30", "05:30");
  resolvesTo("12am", "00:00");
  resolvesTo("12pm", "12:00");
  resolvesTo("12:45am", "00:45");
  resolvesTo("11:45pm", "23:45");
  resolvesTo("0:00", "00:00");
  resolvesTo("8:00am", "08:00");

  const refused = (text: string, reason: "blank" | "unreadable" | "off-grid") => {
    const r = resolveTypedTime(text);
    assert(
      r.ok === false && r.reason === reason,
      `${JSON.stringify(text)} is refused as ${reason} (got ${r.ok ? "ok" : r.reason})`,
    );
  };
  refused("", "blank");
  refused("   ", "blank");
  refused("banana", "unreadable");
  refused("13pm", "unreadable");
  refused("25:00", "unreadable");
  refused("9:60", "unreadable");
  refused("0pm", "unreadable");
  // Readable, a real instant, and NOT one of the 96. This is the case that must
  // not snap: 5:07pm is what somebody meant to type, and answering 5:00pm or
  // 5:15pm would move it silently.
  refused("5:07", "off-grid");
  refused("5:07pm", "off-grid");
  refused("9:01am", "off-grid");

  assert(isQuarterHour("17:15") === true, "a quarter hour is on the grid");
  assert(isQuarterHour("17:07") === false, "a seven minute past is off the grid");
  assert(isQuarterHour("banana") === false, "an unreadable value is not on the grid");
}

// --- rounding an END time up must never produce an EARLIER time ---
//
// The whole point. The time off form's local copy failed exactly here, above the
// top of the hour, and it failed in the direction that shortens a window the
// agent meant to block. Driven over every minute of the day rather than the few
// cases somebody thinks of, because 5:50pm was reachable and nobody had thought
// of it.
{
  let checked = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const up = roundUpToQuarterHour(hhmm);
    const down = roundDownToQuarterHour(hhmm);
    const upMinutes = Number(up.slice(0, 2)) * 60 + Number(up.slice(3));
    const downMinutes = Number(down.slice(0, 2)) * 60 + Number(down.slice(3));

    // 23:46 to 23:59 clamp to 23:45 rather than spilling into the next day, which
    // is the one documented exception and the only place up may go backwards.
    if (m <= 23 * 60 + 45) {
      assert(
        upMinutes >= m,
        `rounding ${hhmm} up never yields an earlier time (got ${up})`,
      );
    }
    assert(downMinutes <= m, `rounding ${hhmm} down never yields a later time (got ${down})`);
    assert(isQuarterHour(up), `${hhmm} rounded up lands on the grid (got ${up})`);
    assert(isQuarterHour(down), `${hhmm} rounded down lands on the grid (got ${down})`);
    checked++;
  }
  assert(checked === 1440, `every minute of the day was checked (got ${checked})`);

  // The exact case that was wrong, named, so a regression reads as itself.
  assert(roundUpToQuarterHour("17:50") === "18:00", "5:50pm rounds up to 6:00pm, not back to 5:45pm");
  assert(roundUpToQuarterHour("17:46") === "18:00", "5:46pm rounds up to 6:00pm");
  assert(roundUpToQuarterHour("17:59") === "18:00", "5:59pm rounds up to 6:00pm");
  assert(roundUpToQuarterHour("09:01") === "09:15", "9:01am rounds up to 9:15am");
  assert(roundUpToQuarterHour("23:50") === "23:45", "the last minutes of the day clamp rather than spill");
}

// --- typing filters the list ---
{
  const values = (q: string) => filterTimeOptions(q).map((o) => o.value);

  assert(filterTimeOptions("").length === 96, "an empty field offers the whole day");
  assert(filterTimeOptions("   ").length === 96, "whitespace alone offers the whole day");

  // A query with no am or pm matches BOTH halves of the day, so reaching 5:15pm
  // is "5:15p" rather than a scroll through the morning.
  assert(
    values("5:").join(",") ===
      "05:00,05:15,05:30,05:45,17:00,17:15,17:30,17:45",
    `"5:" offers both fives, in order (got ${values("5:").join(",")})`,
  );
  assert(values("5:15p").join(",") === "17:15", `"5:15p" narrows to one option`);
  assert(values("5:15pm").join(",") === "17:15", `"5:15pm" narrows to one option`);
  assert(
    values("17").join(",") === "17:00,17:15,17:30,17:45",
    `a 24 hour query offers that hour (got ${values("17").join(",")})`,
  );
  assert(
    values("8a").join(",") === "08:00,08:15,08:30,08:45",
    `"8a" offers the morning eight only (got ${values("8a").join(",")})`,
  );
  assert(
    values("12a").join(",") === "00:00,00:15,00:30,00:45",
    `"12a" offers midnight rather than noon (got ${values("12a").join(",")})`,
  );
  assert(values("banana").length === 0, "an unreadable query matches nothing");
  assert(values("9:07").length === 0, "an off grid query matches nothing to select");
  assert(
    filterTimeOptions("5:").every((o) => o.label === formatTimeOfDay(o.value)),
    "filtered options carry the same labels as the full list",
  );
}


// --- the 12 hour parts a segmented field works in ---
//
// `DateTimeField` carried its own `pad`, its own identical `to24` and its own
// `snapMinute`, and the snapping is where the two implementations disagreed. The
// conversion lives here now so there is one of it.
{
  assert(timeFrom12Hour(5, 15, "PM") === "17:15", "5:15 PM is 17:15");
  assert(timeFrom12Hour(12, 0, "AM") === "00:00", "12 AM is midnight, not noon");
  assert(timeFrom12Hour(12, 0, "PM") === "12:00", "12 PM is noon");
  assert(timeFrom12Hour(9, 0, "AM") === "09:00", "a morning hour pads to two digits");
  // Hour 0 is the segmented field's "nothing typed yet", which must not become
  // midnight: a half filled field would otherwise submit a real time.
  assert(timeFrom12Hour(0, 30, "AM") === "", "an unset hour submits nothing at all");

  const parts = twelveHourParts("17:15");
  assert(
    parts?.hour12 === 5 && parts?.minute === 15 && parts?.ampm === "PM",
    "17:15 reads back as 5:15 PM",
  );
  assert(twelveHourParts("00:45")?.hour12 === 12, "midnight reads back as 12, never 0");
  assert(twelveHourParts("12:00")?.ampm === "PM", "noon reads back as PM");
  assert(twelveHourParts("banana") === null, "an unreadable time has no parts");

  // The round trip is what the segmented field depends on: it converts out to
  // snap, then back to write the segments.
  for (const value of QUARTER_HOUR_TIMES) {
    const p = twelveHourParts(value);
    assert(
      p !== null && timeFrom12Hour(p.hour12, p.minute, p.ampm) === value,
      `${value} survives a round trip through the 12 hour parts`,
    );
  }
}

// --- snapping the WHOLE time, which is the fix ---
//
// The defect was snapping a MINUTE in isolation: ceil(50 / 15) is 60, which
// cannot be a minute, so the local copy answered 45 and left the hour alone. A
// time is a single quantity and has to be rounded as one.
{
  assert(snapTimeOfDay("17:50", "up") === "18:00", "5:50pm rounds up ACROSS the hour");
  assert(snapTimeOfDay("17:50", "down") === "17:45", "and down within it");
  assert(snapTimeOfDay("17:00", "up") === "17:00", "a time already on the grid does not move");
  assert(snapTimeOfDay("23:50", "up") === "23:45", "the end of the day clamps rather than spilling");
  assert(snapTimeOfDay("", "up") === "", "nothing typed stays nothing");
}

// --- the same spelling, from a Luxon DateTime ---
{
  const dt = DateTime.fromISO("2026-09-03T17:15:00", { zone: "America/New_York" });
  assert(formatClockTime(dt) === "5:15pm", "a DateTime spells the same way an HH:MM string does");
  assert(
    formatClockTime(DateTime.fromISO("2026-09-03T00:00:00", { zone: "UTC" })) === "12:00am",
    "midnight from a DateTime is 12:00am",
  );
  assert(
    formatClockTime(dt) === formatTimeOfDay(dt.toFormat("HH:mm")),
    "the two entry points cannot disagree, because one answers through the other",
  );
  // An invalid DateTime must not render a plausible time.
  assert(formatClockTime(DateTime.invalid("test")) === null, "an invalid DateTime has no spelling");
}


finish();

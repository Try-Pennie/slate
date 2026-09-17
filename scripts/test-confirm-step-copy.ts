// The moment of commitment states the time it is committing to (#2361).
//
// Measured live on 2026-09-15 against both products. cal.com's confirm step is
// headed and states the booking in full ("Confirm your details", then
// "Wednesday, September 16, 2026, 10:30 am"). Slate's said "Tue 15" and a time
// under no heading at all: no weekday written out, no month, no year, and nothing
// naming what the screen was for.
//
// The year is the part that is easy to argue away and hardest to recover from. A
// lead booking in late December is choosing between two years on a day strip that
// shows neither, and the strip is the only other place the date appears.
//
// What is deliberately NOT here is the duration. The event panel states it on this
// same composed screen, so a second copy on the confirm line would be the same fact
// twice on one surface (L605). Read the page, not the component.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-step-copy.ts
import {
  DETAILS_COPY,
  chosenWhen,
  confirmedWhen,
  longDayLabel,
} from "../src/lib/booking/booker-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";

// --- the day, written out, with the year --------------------------------------
{
  eq(
    longDayLabel("2026-09-16T14:30:00.000Z", ZONE, { year: true }),
    "Wednesday, September 16, 2026",
    "the chosen day is spelled in full, in US order, with the year",
  );
  // The existing spelling is untouched: the confirmation screen and the duplicate
  // notice still read without a year, and only this screen asked for one.
  eq(
    longDayLabel("2026-09-16T14:30:00.000Z", ZONE),
    "Wednesday, September 16",
    "and the yearless spelling every other screen uses is unchanged",
  );
}

// --- the year is the reason this exists ---------------------------------------
// The December case the issue names: two instants a year apart that the strip
// draws identically, since a chip carries a weekday, a day number and a month.
{
  const thisYear = longDayLabel("2026-12-30T15:00:00.000Z", ZONE, { year: true });
  const nextYear = longDayLabel("2027-12-30T15:00:00.000Z", ZONE, { year: true });
  assert(thisYear !== nextYear, "two Decembers a year apart do not read the same");
  assert(thisYear.includes("2026"), `and each names its own year (got ${thisYear})`);
}

// --- the line itself ----------------------------------------------------------
{
  const line = chosenWhen(longDayLabel("2026-09-16T14:30:00.000Z", ZONE, { year: true }), "10:30am");
  eq(line, "Wednesday, September 16, 2026 at 10:30am", "the confirm line states the whole instant");

  // One join, not two spellings of it. The confirmation screen says the same
  // "<day> at <time>" and adds the zone, so the two cannot drift apart (L41).
  assert(
    confirmedWhen("Monday, August 17", "2:30pm", "EDT").startsWith(
      chosenWhen("Monday, August 17", "2:30pm"),
    ),
    "the confirmation screen is built from the same join rather than its own copy of it",
  );
}

// --- the heading --------------------------------------------------------------
{
  assert(DETAILS_COPY.heading.trim().length > 0, "the step has a heading at all");
  // It names the screen; the button names the act. Two identical sentences would
  // be one fact said twice on one surface (L605).
  assert(
    DETAILS_COPY.heading !== DETAILS_COPY.confirm,
    "and it is not the button's words repeated as a title",
  );
}

// --- the fields are asked for in words, not derived from a key name -----------
// #2362 moved these out of the component, where the label was built by
// capitalising the state key. A label is a string a lead reads, so it lives with
// every other one (L41).
{
  const labels = Object.values(DETAILS_COPY.fields);
  eq(new Set(labels).size, labels.length, "no two fields are labelled the same");
  for (const [key, label] of Object.entries(DETAILS_COPY.fields)) {
    assert(label.trim().length > 0, `${key} has a label`);
    assert(label[0] === label[0]?.toUpperCase(), `${key}'s label starts with a capital`);
  }
  assert(
    DETAILS_COPY.fields.firstName !== DETAILS_COPY.fields.lastName,
    "the first name is asked for separately from the last",
  );
}

finish();

// Specific dates the org is shut, or open, whatever the weekly pattern says (#1363).
//
// `business_hours` stores one row per weekday, so before this the org's opening
// hours were a weekly pattern and nothing else. The cost was not that "shut for
// Christmas week" was unsayable; it was that the two features written FOR a
// holiday shutdown could never fire on one. The honest closure copy (#1328) and
// the button revealing the first days back (#1329) both derive "closed" from the
// weekly pattern, so through Christmas week the booker would have reported the
// emptiness as demand ("All times are taken right now"), which is the exact
// untruth #1328 set out to remove.
//
// So the thing under test is not the table. It is that ONE judge answers "is the
// org open on this date" for the gate, the read-time filter, the confirm path and
// the empty-reason copy, and that nothing reaches past it to the weekly rules.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-business-hours-exceptions.ts
import {
  windowOnDate,
  resolveBusinessHoursExceptions,
  SEEDED_BUSINESS_HOURS,
  BUSINESS_ZONE,
  type BusinessHoursException,
} from "../src/lib/booking/business-hours.ts";
import { isOrgOpen, slotsWithinBusinessHours } from "../src/lib/availability/compute.ts";
import { emptyReason } from "../src/lib/availability/empty-reason.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");

const shut = (on_date: string, note = "Christmas Day"): BusinessHoursException => ({
  on_date,
  is_open: false,
  start_minute: null,
  end_minute: null,
  note,
});
const openOn = (on_date: string, start: number, end: number): BusinessHoursException => ({
  on_date,
  is_open: true,
  start_minute: start,
  end_minute: end,
  note: "one off Sunday",
});

// 2026-12-25 is a Friday (weekday 5, open in the seeded week);
// 2026-12-27 is a Sunday (weekday 7, shut in the seeded week).
const hours = { rules: SEEDED_BUSINESS_HOURS, exceptions: [] as BusinessHoursException[] };

// --- a date beats the weekday, in both directions -------------------------------
{
  eq(
    windowOnDate(hours, "2026-12-25", 5)?.start_minute,
    8 * 60,
    "with no exception, the weekday's own window applies",
  );

  const closed = { ...hours, exceptions: [shut("2026-12-25")] };
  eq(windowOnDate(closed, "2026-12-25", 5), null, "a closed exception shuts an open weekday");
  assert(
    windowOnDate(closed, "2026-12-24", 4) !== null,
    "and shuts only the date it names, not the day before it",
  );

  // The same table either way, and a one off Saturday is as real a need as a
  // holiday. Deciding otherwise would have meant a second mechanism later.
  const opened = { ...hours, exceptions: [openOn("2026-12-27", 10 * 60, 14 * 60)] };
  eq(
    windowOnDate(opened, "2026-12-27", 7)?.end_minute,
    14 * 60,
    "an open exception opens a normally shut day, with its own window",
  );
  eq(
    windowOnDate(opened, "2026-12-20", 7),
    null,
    "and leaves every other Sunday shut",
  );
}

// --- an unusable exception fails CLOSED -----------------------------------------
// The opposite of the usual direction here, deliberately: these rows are only ever
// written to shut a day or move its hours, so a row we cannot read is far likelier
// to be a closure somebody entered than a day they meant to open, and offering a
// lead a time on a day the office is dark is the expensive mistake.
{
  for (const bad of [
    { ...openOn("2026-12-25", 8 * 60, 20 * 60), start_minute: null },
    { ...openOn("2026-12-25", 20 * 60, 8 * 60) },
    { ...openOn("2026-12-25", -60, 20 * 60) },
    { ...openOn("2026-12-25", 8 * 60, 2000) },
    { ...openOn("2026-12-25", 8.5, 20 * 60) },
  ]) {
    eq(
      windowOnDate({ ...hours, exceptions: [bad] }, "2026-12-25", 5),
      null,
      "an exception whose window cannot be trusted shuts the day rather than widening it",
    );
  }
}

// --- an unreadable DATE is reported, never silently dropped ---------------------
// This is the row that matters most: it matches no date at all, so it shuts
// nothing, and the day it was meant to close stays open and bookable.
{
  const { exceptions, unreadable } = resolveBusinessHoursExceptions([
    shut("2026-12-25"),
    { ...shut("25/12/2026"), note: "hand written" },
    { ...shut(""), note: "empty" },
    shut("2026-12-25"),
  ]);
  eq(exceptions.length, 1, "the usable row survives");
  eq(unreadable.length, 3, "and every unusable one is reported, including the duplicate date");
  eq(exceptions[0].on_date, "2026-12-25", "the first row for a date wins, deterministically");
}

// --- the gate, in the org's own clock -------------------------------------------
{
  const zone = BUSINESS_ZONE;
  const at = (iso: string) => Date.parse(iso);
  const open = { zone, rules: SEEDED_BUSINESS_HOURS, exceptions: [] as BusinessHoursException[] };
  assert(
    isOrgOpen(open, at("2026-12-25T14:00:00-05:00"), at("2026-12-25T14:15:00-05:00")),
    "an ordinary Friday lunchtime is inside the org's hours",
  );

  const holiday = { ...open, exceptions: [shut("2026-12-25")] };
  assert(
    !isOrgOpen(holiday, at("2026-12-25T14:00:00-05:00"), at("2026-12-25T14:15:00-05:00")),
    "and the same instant is refused once the date is closed",
  );

  // The date is the ORG's date. An instant that is still 25 December in Eastern
  // must be judged as the 25th however it was expressed.
  assert(
    !isOrgOpen(holiday, at("2026-12-25T22:00:00Z"), at("2026-12-25T22:15:00Z")),
    "the date is resolved in the org's zone, not in UTC",
  );
  // 26 December 00:30 UTC is still the 25th in Eastern, so it is still shut, and
  // it is outside the window anyway. The interesting one is the other side: the
  // 26th in Eastern is a Saturday the org IS open on.
  assert(
    isOrgOpen(holiday, at("2026-12-26T14:00:00-05:00"), at("2026-12-26T14:15:00-05:00")),
    "the day after the holiday is open again",
  );
}

// --- the read-time filter sees the same answer as the gate ----------------------
// A slot computed before the closure was entered can still be sitting in the slot
// cache. Filtering only on the weekly pattern would keep serving it (#1296).
{
  const zone = BUSINESS_ZONE;
  const slots = ["2026-12-24T14:00:00-05:00", "2026-12-25T14:00:00-05:00"];
  const kept = slotsWithinBusinessHours(slots, 15, {
    zone,
    rules: SEEDED_BUSINESS_HOURS,
    exceptions: [shut("2026-12-25")],
  });
  eq(kept.length, 1, "a cached slot on a closed date is filtered out on the very next request");
  assert(kept[0].startsWith("2026-12-24"), "and the day before it is still offered");
}

// --- the copy a lead reads ------------------------------------------------------
// The whole reason the issue exists: through a holiday shutdown the booker used to
// report the emptiness as demand.
{
  const week = { businessHours: SEEDED_BUSINESS_HOURS, zone: BUSINESS_ZONE };
  const noExceptions = emptyReason({ ...week, exceptions: [], fromDay: "2026-12-24", searchedDays: 4 });
  eq(noExceptions.kind, "busy", "an ordinary run of open days that produced nothing is about supply");

  const shutdown = emptyReason({
    ...week,
    exceptions: ["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-27", "2026-12-28"].map((d) =>
      shut(d),
    ),
    fromDay: "2026-12-24",
    searchedDays: 4,
  });
  eq(shutdown.kind, "closed", "a holiday shutdown reads as a closure, not as every time being taken");
  eq(
    shutdown.kind === "closed" ? shutdown.reopensOn : null,
    "2026-12-29",
    "and it names the first day back, which is the fact that makes the message actionable",
  );
}

// --- nothing reaches past the judge (L3, L107) ----------------------------------
// Every assertion above holds if a caller asks the weekly rules directly, and the
// symptom would be a booker that kept offering times through a shutdown while the
// closure copy said we were shut.
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const rel of [
    "src/lib/availability/compute.ts",
    "src/lib/booking/orchestration.ts",
    "src/lib/availability/empty-reason.ts",
  ]) {
    const code = strip(readFileSync(join(root, rel), "utf8"));
    assert(
      !/isWithinWorkingHours\(\s*(businessHours|bh|hours)\./.test(code),
      `${rel} asks isOrgOpen about the org, never the weekly rules directly`,
    );
  }
  const compute = strip(readFileSync(join(root, "src/lib/availability/compute.ts"), "utf8"));
  assert(compute.includes("isOrgOpen(bh,"), "the slot gate goes through the judge");
  assert(
    /slotsWithinBusinessHours[\s\S]{0,400}isOrgOpen\(/.test(compute),
    "and so does the read-time filter",
  );
}

finish();

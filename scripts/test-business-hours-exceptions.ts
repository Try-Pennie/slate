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
  closedExceptionDates,
  SEEDED_BUSINESS_HOURS,
  BUSINESS_ZONE,
  type BusinessHoursException,
} from "../src/lib/booking/business-hours.ts";
import { isOrgOpen, slotsWithinBusinessHours } from "../src/lib/availability/compute.ts";
import { emptyReason } from "../src/lib/availability/empty-reason.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime } from "luxon";
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

// --- the closed days the volume alarms leave out of their fits (#2764) ----------
// Taken from the same resolved exceptions the gate judges, so a day the booker
// refuses is exactly a day the floors are not fitted to.
{
  eq(
    closedExceptionDates([openOn("2026-12-27", 10 * 60, 14 * 60), shut("2026-12-25"), shut("2026-11-26", "Thanksgiving")]),
    ["2026-11-26", "2026-12-25"],
    "only the CLOSED dates, in date order; an opened Sunday is not a closed day",
  );
  eq(closedExceptionDates([]), [], "no exceptions, no closed days");
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



// --- the next OPEN business day's end (#2505) ---------------------------------
//
// The window the debt tier alarm judges against. It starts at TOMORROW, so the
// answer is always the rest of today plus one whole open day: taking the end of
// TODAY would shrink to a minute at 19:59 and page about a tier with nothing left
// in the last minute of the evening, which is a healthy tier (L36).
{
  const { nextOpenDayEndMs } = await import("../src/lib/booking/business-hours.ts");
  const zone = "America/New_York";
  // Mon to Sat 08:00 to 20:00, Sunday closed: the live week, measured 2026-09-17.
  const week = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 }));
  const hours = { zone, rules: week, exceptions: [] };

  const asEt = (iso: string) => DateTime.fromISO(iso, { zone }).toMillis();
  const et = (ms: number) => DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true });

  // A Thursday morning looks to Friday evening, NOT to the end of Thursday.
  eq(
    et(nextOpenDayEndMs(hours, asEt("2026-09-17T09:00"))!),
    "2026-09-18T20:00:00-04:00",
    "a weekday morning reaches the end of the next open day",
  );
  // Late on Thursday still reaches Friday, so the window never collapses.
  eq(
    et(nextOpenDayEndMs(hours, asEt("2026-09-17T19:59"))!),
    "2026-09-18T20:00:00-04:00",
    "the window does not shrink at the end of the day",
  );
  // SATURDAY SKIPS SUNDAY. This is the case Dan named: "obviously there would be
  // no slots on sunday". A flat 24 hours would ask about a closed day and page.
  eq(
    et(nextOpenDayEndMs(hours, asEt("2026-09-19T10:00"))!),
    "2026-09-21T20:00:00-04:00",
    "Saturday looks past the closed Sunday to Monday",
  );
  eq(
    et(nextOpenDayEndMs(hours, asEt("2026-09-20T10:00"))!),
    "2026-09-21T20:00:00-04:00",
    "Sunday looks to Monday",
  );
  // A holiday exception moves the window, asked of `windowOnDate` rather than of
  // the weekly rules, so a closure cannot be answered by the pattern (L107).
  eq(
    et(
      nextOpenDayEndMs(
        { ...hours, exceptions: [{ on_date: "2026-09-18", is_open: false, start_minute: null, end_minute: null }] },
        asEt("2026-09-17T09:00"),
      )!,
    ),
    "2026-09-19T20:00:00-04:00",
    "a closed day is skipped, not counted",
  );
  // An exception that MOVES the hours is honoured, so the window is the day's own
  // close rather than the weekly one.
  eq(
    et(
      nextOpenDayEndMs(
        { ...hours, exceptions: [{ on_date: "2026-09-18", is_open: true, start_minute: 480, end_minute: 720 }] },
        asEt("2026-09-17T09:00"),
      )!,
    ),
    "2026-09-18T12:00:00-04:00",
    "a shortened day ends when it says it does",
  );
  // DST: the Saturday before the US fall back reaches Sunday... which is closed,
  // so it reaches Monday, whose close is in the NEW offset. Set as wall clock
  // rather than by adding minutes, or the close lands an hour out.
  eq(
    et(nextOpenDayEndMs(hours, asEt("2026-10-31T10:00"))!),
    "2026-11-02T20:00:00-05:00",
    "the close is wall clock across a DST change",
  );
  // An org with no open day at all concludes NOTHING rather than inventing a
  // window: a caller handed a fabricated one would judge a tier against a day
  // nobody works (L215).
  eq(
    nextOpenDayEndMs({ zone, rules: [], exceptions: [] }, asEt("2026-09-17T09:00")),
    null,
    "a week with no open day returns null",
  );
  // And the control, so the null above is not simply what this always returns.
  assert(
    nextOpenDayEndMs(hours, asEt("2026-09-17T09:00")) !== null,
    "a normal week does return a window",
  );
}

finish();

// #2840: the window a lead is offered is the next N days the business is OPEN,
// not the first N days that happen to have a free time. N was a fixed 3 (Sales
// ops, 2026-09-28, Slack #C091G6LEQ80, p1790609176877419, Sam: "We never really
// want to book out further than 3 days if we can help it"); since #3922 it is the
// stored offered open days, 3 by default, so these cases pass the count
// explicitly. Counting days that have times, as the stored rows do, is what let a
// fully booked pool's strip slide into the next week.
import { DateTime } from "luxon";
import { openDaysWindowEndMs, type BusinessHoursException } from "../src/lib/booking/business-hours.ts";
import { bookingWindowExtendedAlert } from "../src/lib/booking/alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const zone = "America/New_York";
// Mon to Sat 08:00 to 20:00, Sunday closed: the live week, measured 2026-09-17.
const week = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 }));
const hours: { zone: string; rules: typeof week; exceptions: BusinessHoursException[] } = { zone, rules: week, exceptions: [] };
const asEt = (iso: string) => DateTime.fromISO(iso, { zone }).toMillis();
const et = (ms: number | null) => (ms === null ? null : DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true }));

eq(et(openDaysWindowEndMs(hours, asEt("2026-09-28T09:00"), 3)), "2026-09-30T20:00:00-04:00", "a Monday morning offers Monday to Wednesday");
// Today counts only while a booking can still start before it closes.
eq(et(openDaysWindowEndMs(hours, asEt("2026-09-28T19:59"), 3)), "2026-09-30T20:00:00-04:00", "today counts while it is still open");
eq(et(openDaysWindowEndMs(hours, asEt("2026-09-28T20:00"), 3)), "2026-10-01T20:00:00-04:00", "a closed today does not use one of the three");
// The closed Sunday is skipped, not counted.
eq(et(openDaysWindowEndMs(hours, asEt("2026-10-02T10:00"), 3)), "2026-10-05T20:00:00-04:00", "Friday offers Friday, Saturday and Monday");
// A holiday exception is a closed day like any other, asked of `windowOnDate`.
eq(
  et(openDaysWindowEndMs(
    { ...hours, exceptions: [{ on_date: "2026-09-29", is_open: false, start_minute: null, end_minute: null, note: null }] },
    asEt("2026-09-28T09:00"),
    3,
  )),
  "2026-10-01T20:00:00-04:00",
  "a holiday is skipped",
);
// DST: counted in wall clock, so the close lands in the new offset.
eq(et(openDaysWindowEndMs(hours, asEt("2026-10-31T10:00"), 3)), "2026-11-03T20:00:00-05:00", "the close is wall clock across a DST change");
// The fourth day is one further open day out, which is what the last resort opens.
eq(et(openDaysWindowEndMs(hours, asEt("2026-09-28T09:00"), 4)), "2026-10-01T20:00:00-04:00", "four days is one open day further");
// No open day at all concludes nothing rather than inventing a window (L215).
eq(openDaysWindowEndMs({ zone, rules: [], exceptions: [] }, asEt("2026-09-28T09:00"), 3), null, "an org never open has no window");
eq(openDaysWindowEndMs(hours, asEt("2026-09-28T09:00"), 0), null, "a zero day window is no window");
// The alert names the window the booker actually used for that lead: the stored
// offered open days as the request read them (#3922), handed in by the route, so
// a saved 4 reads as 4 in Slack and no constant can drift from the setting (L41).
{
  const text = bookingWindowExtendedAlert("511", 3);
  assert(text.includes("3 day booking window"), `the alert names the real window (got ${text})`);
  assert(text.includes("next 3 open days"), "and the real number of open days");
  assert(!/\bthree\b/.test(text), "no hand written count left in the copy");
  const four = bookingWindowExtendedAlert("511", 4);
  assert(four.includes("4 day booking window") && four.includes("next 4 open days"), `a stored 4 reads as 4 (got ${four})`);
  assert(!four.includes("3"), "and nothing in it still says 3");
}

finish();

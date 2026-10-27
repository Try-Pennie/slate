/**
 * #2310: the lead's calling window, the fourth gate a bookable time passes.
 *
 * Regal's quiet hours journey (a0c3d620) cancels any call whose START falls
 * outside 08:00 to 20:00 on the LEAD's clock, so Slate must never offer or book
 * one. The window includes its start and excludes its end (Dan, 2026-09-24):
 * 08:00 may be offered and 07:59 may not; 19:59 may and 20:00 may not.
 *
 * What this pins:
 *  - the four boundary minutes, in two zones, so a comparison that slips from
 *    `<` to `<=` (or judges the END of the call) fails;
 *  - a DST change, where a fixed UTC offset would put the whole window an hour
 *    out for the weeks after the switch;
 *  - which zone an unreadable or missing zone is judged in, so a bad value is
 *    judged somewhere stated rather than waved through;
 *  - the split the shared slot picker runs, which keeps every time and says
 *    which ones the lead can be offered.
 */
import {
  LEAD_CALLING_WINDOW,
  LEAD_CALLING_FALLBACK_ZONE,
  leadCallingZone,
  withinLeadCallingWindow,
  splitByLeadCallingWindow,
  callingWindowLabel,
} from "../src/lib/booking/lead-calling-window.ts";
import { formatTimeOfDay } from "../src/lib/date/parse.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// ------------------------------------------------------------- the constant

eq(LEAD_CALLING_WINDOW.startMinute, 8 * 60, "the window opens at 08:00 local");
eq(LEAD_CALLING_WINDOW.endMinute, 20 * 60, "the window closes at 20:00 local");
eq(LEAD_CALLING_FALLBACK_ZONE, "America/New_York", "the fallback is the booker's own fallback");

// ------------------------------------------------------------ the boundaries

// 2026-09-24 is in EDT (UTC-4), so 08:00 New York is 12:00Z.
const NY = "America/New_York";
eq(withinLeadCallingWindow("2026-09-24T11:59:00Z", NY), false, "07:59 New York is outside");
eq(withinLeadCallingWindow("2026-09-24T12:00:00Z", NY), true, "08:00 New York is inside");
eq(withinLeadCallingWindow("2026-09-24T23:59:00Z", NY), true, "19:59 New York is inside");
eq(withinLeadCallingWindow("2026-09-25T00:00:00Z", NY), false, "20:00 New York is outside");

// Honolulu never observes DST (UTC-10), so 08:00 is 18:00Z.
const HNL = "Pacific/Honolulu";
eq(withinLeadCallingWindow("2026-09-24T17:59:00Z", HNL), false, "07:59 Honolulu is outside");
eq(withinLeadCallingWindow("2026-09-24T18:00:00Z", HNL), true, "08:00 Honolulu is inside");
eq(withinLeadCallingWindow("2026-09-25T05:59:00Z", HNL), true, "19:59 Honolulu is inside");
eq(withinLeadCallingWindow("2026-09-25T06:00:00Z", HNL), false, "20:00 Honolulu is outside");

// The same instant is inside for one lead and outside for another: 9am Eastern is
// 3am in Honolulu, which is the call the issue was opened about.
eq(withinLeadCallingWindow("2026-09-24T13:00:00Z", NY), true, "9am Eastern is fine for a New York lead");
eq(withinLeadCallingWindow("2026-09-24T13:00:00Z", HNL), false, "and is 3am for a Honolulu lead");

// Seconds inside the last minute still count as before the end.
eq(withinLeadCallingWindow("2026-09-24T23:59:59Z", NY), true, "19:59:59 is still inside");

// ------------------------------------------------------------ across DST

// US DST ends 2026-11-01 at 02:00 local. 08:00 New York is 12:00Z before and
// 13:00Z after. A fixed offset read from either side misjudges the other.
eq(withinLeadCallingWindow("2026-10-31T12:00:00Z", NY), true, "08:00 EDT, the day before the change");
eq(withinLeadCallingWindow("2026-11-02T12:00:00Z", NY), false, "12:00Z is 07:00 EST after the change");
eq(withinLeadCallingWindow("2026-11-02T13:00:00Z", NY), true, "08:00 EST after the change");
eq(withinLeadCallingWindow("2026-11-02T00:59:00Z", NY), true, "19:59 EST on the 1st is 00:59Z the next day");
eq(withinLeadCallingWindow("2026-11-02T01:00:00Z", NY), false, "20:00 EST on the 1st");
// Spring forward, 2026-03-08: 08:00 EDT is 12:00Z on the day itself.
eq(withinLeadCallingWindow("2026-03-08T12:00:00Z", NY), true, "08:00 on the spring forward day");
eq(withinLeadCallingWindow("2026-03-08T11:59:00Z", NY), false, "07:59 on the spring forward day");
// Phoenix does not change its clocks, so the same Z instants keep their meaning.
eq(withinLeadCallingWindow("2026-11-02T15:00:00Z", "America/Phoenix"), true, "08:00 Phoenix in November");
eq(withinLeadCallingWindow("2026-11-02T14:59:00Z", "America/Phoenix"), false, "07:59 Phoenix in November");

// -------------------------------------------------------- which zone judges

eq(leadCallingZone("Pacific/Honolulu"), "Pacific/Honolulu", "a curated zone is judged as itself");
eq(leadCallingZone("America/Boise"), "America/Boise", "a real zone outside the picker list is judged as itself");
eq(leadCallingZone("Not/AZone"), LEAD_CALLING_FALLBACK_ZONE, "an unreadable zone falls back, it is not waved through");
eq(leadCallingZone(""), LEAD_CALLING_FALLBACK_ZONE, "an empty zone falls back");
eq(leadCallingZone(null), LEAD_CALLING_FALLBACK_ZONE, "a missing zone falls back");
eq(leadCallingZone(undefined), LEAD_CALLING_FALLBACK_ZONE, "an absent zone falls back");
// A garbage zone is JUDGED, in the fallback: 07:59 Eastern is refused.
eq(withinLeadCallingWindow("2026-09-24T11:59:00Z", "Not/AZone"), false, "a garbage zone is judged in Eastern, not allowed");
eq(withinLeadCallingWindow("2026-09-24T12:00:00Z", null), true, "a missing zone is judged in Eastern");

// An unreadable instant is never inside: the check must not fail open.
eq(withinLeadCallingWindow("not a time", NY), false, "an unreadable start is outside");

// ---------------------------------------------------------------- the split

{
  const slots = [
    "2026-09-24T13:00:00Z", // 3am Honolulu
    "2026-09-24T18:00:00Z", // 8am Honolulu
    "2026-09-24T21:30:00Z", // 11:30am Honolulu
    "2026-09-25T06:00:00Z", // 8pm Honolulu
  ];
  const split = splitByLeadCallingWindow(slots, HNL);
  eq(split.offered, ["2026-09-24T18:00:00Z", "2026-09-24T21:30:00Z"], "only the in window times are offered, in order");
  eq(split.outside, ["2026-09-24T13:00:00Z", "2026-09-25T06:00:00Z"], "the rest are kept aside, not dropped");
  eq(splitByLeadCallingWindow(slots, NY).offered.length, 3, "a New York lead sees three of the four");
  eq(splitByLeadCallingWindow([], NY), { offered: [], outside: [] }, "nothing in, nothing out");
}

// -------------------------------------------------------------- the label

// Derived from the constant, so copy that names the hours cannot drift from the rule.
// #4267: spelled the way every other Slate time is ("8:00am", the booker's and the
// coordinator page's), by the one shared formatter, so a screen showing both reads alike.
eq(callingWindowLabel(), { from: "8:00am", to: "8:00pm" }, "the window reads as 8:00am to 8:00pm");
eq(
  callingWindowLabel().from,
  formatTimeOfDay(`${String(LEAD_CALLING_WINDOW.startMinute / 60).padStart(2, "0")}:00`),
  "through the shared time formatter, never a spelling of its own",
);
assert(!/[\u2013\u2014]/.test(JSON.stringify(callingWindowLabel())), "no dashes in the label");

finish();

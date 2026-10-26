/**
 * The daytime posting hours (Dan, 2026-10-26): 9 AM up to 6 PM New York time, every day
 * of the week, judged on the New York clock so the window follows daylight saving.
 * `src/lib/notify/posting-hours.ts` holds the rule; this pins its edges, a weekend, and
 * both of the coming clock changes, where a fixed UTC offset would be an hour wrong.
 */
import { DAYTIME_POSTING_HOURS, withinPostingHours } from "../src/lib/notify/posting-hours.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const at = (iso: string) => Date.parse(iso);
const inside = (iso: string) => withinPostingHours(at(iso), DAYTIME_POSTING_HOURS);

eq(DAYTIME_POSTING_HOURS.zone, "America/New_York", "the window is New York's clock");

// Mon 2026-10-26, daylight time (UTC-4).
assert(!inside("2026-10-26T05:23:00Z"), "1:23 AM is outside, the post Dan saw");
assert(!inside("2026-10-26T12:59:59Z"), "8:59:59 AM is outside");
assert(inside("2026-10-26T13:00:00Z"), "9:00 AM is inside");
assert(inside("2026-10-26T21:59:59Z"), "5:59:59 PM is inside");
assert(!inside("2026-10-26T22:00:00Z"), "6:00 PM is outside: the window runs up to six, not through it");
assert(!inside("2026-10-27T03:59:00Z"), "11:59 PM is outside");

// The weekend is posted to like any other day.
assert(inside("2026-10-31T13:00:00Z"), "Sat 9:00 AM is inside");
assert(inside("2026-10-25T16:00:00Z"), "Sun noon is inside");
assert(!inside("2026-10-25T12:59:00Z"), "Sun 8:59 AM is outside");

// Sun 2026-11-01: the clocks go back at 2 AM, so the day is standard time (UTC-5).
assert(!inside("2026-11-01T05:30:00Z"), "1:30 AM daylight, before the change, is outside");
assert(!inside("2026-11-01T06:30:00Z"), "1:30 AM standard, the repeated hour, is outside");
assert(!inside("2026-11-01T13:59:00Z"), "8:59 AM standard is outside (9:59 under the old offset)");
assert(inside("2026-11-01T14:00:00Z"), "9:00 AM standard is inside");
assert(inside("2026-11-01T22:59:00Z"), "5:59 PM standard is inside");
assert(!inside("2026-11-01T23:00:00Z"), "6:00 PM standard is outside");

// Sun 2026-03-08: the clocks go forward at 2 AM, so the day is daylight time (UTC-4).
assert(!inside("2026-03-08T12:59:00Z"), "8:59 AM daylight is outside");
assert(inside("2026-03-08T13:00:00Z"), "9:00 AM daylight is inside (8:00 under the old offset)");
assert(inside("2026-03-08T21:59:00Z"), "5:59 PM daylight is inside");
assert(!inside("2026-03-08T22:00:00Z"), "6:00 PM daylight is outside");

// A window is judged in its own zone, never the machine's.
const pacific = { zone: "America/Los_Angeles", fromMinute: 9 * 60, toMinute: 18 * 60 };
assert(!withinPostingHours(at("2026-10-26T13:00:00Z"), pacific), "9 AM New York is 6 AM Pacific, outside a Pacific window");
assert(withinPostingHours(at("2026-10-26T16:00:00Z"), pacific), "9 AM Pacific is inside a Pacific window");

finish();

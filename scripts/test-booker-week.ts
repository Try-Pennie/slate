import { DateTime } from "luxon";
import { bookerWeekDays, isStripDayEnabled } from "../src/components/booker-strip-labels.ts";
import { assert, finish } from "./lib/harness.ts";
const tz = "America/New_York";
const today = DateTime.fromISO("2026-06-18", { zone: tz }); // Thu
const wk = bookerWeekDays(today);
assert(wk.length === 7, "week has 7 days");
assert(wk[0] === "2026-06-18", "week starts today");
assert(wk[6] === "2026-06-24", "week ends today+6");
assert(isStripDayEnabled("2026-06-18", ["2026-06-18"], tz) === true, "weekday with slots -> enabled");
assert(isStripDayEnabled("2026-06-21", ["2026-06-21"], tz) === false, "Sunday always disabled even with slots");
assert(isStripDayEnabled("2026-06-19", [], tz) === false, "no slots -> disabled");
finish();

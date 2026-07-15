import { DateTime } from "luxon";
import { stripDayLabel } from "../src/components/booker-strip-labels.ts";
import { assert, finish } from "./lib/harness.ts";
const tz = "America/New_York";
const today = DateTime.fromISO("2026-06-18", { zone: tz });
assert(stripDayLabel("2026-06-18", today, tz) === "Today", "today -> Today");
assert(stripDayLabel("2026-06-19", today, tz) === "Tomorrow", "tomorrow -> Tomorrow");
assert(stripDayLabel("2026-06-20", today, tz) === "Sat", "later -> weekday abbr");
finish();

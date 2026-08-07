import { slotCacheKey } from "../src/lib/availability/cache-key.ts";
import { searchWindowDays } from "../src/lib/availability/bookable-days.ts";
import { filterSlotsFromNow } from "../src/lib/availability/compute.ts";
import { assert, finish } from "./lib/harness.ts";

const k = slotCacheKey("411", "2026-06-18T16:42:07.123Z", 14);
assert(k.key === "slots:v4:411:2026-06-18T00:00:00.000Z:14", "key anchors from to the start of the UTC day");
assert(k.fromIso === "2026-06-18T00:00:00.000Z", "fromIso is the day anchor");

// #1326: horizonDays counts BOOKABLE days, so the computed window reaches past it
// to leave room for closed days inside the run. A window of exactly 14 days would
// lose a day to every closed Sunday it contained.
assert(
  k.toIso === new Date(Date.parse("2026-06-18T00:00:00.000Z") + searchWindowDays(14) * 86_400_000).toISOString(),
  "toIso spans the SEARCH window, not the bookable-day count",
);
assert(
  Date.parse(k.toIso) > Date.parse("2026-07-02T00:00:00.000Z"),
  "and that window is strictly wider than the old calendar-day one",
);

// The version must move with the meaning. A v3 entry was computed over exactly
// horizonDays CALENDAR days; serving one now would hand back the old short answer
// under the new setting's name, and nothing would look wrong.
assert(k.key.includes(":v4:"), "the key version moved when the horizon changed meaning");
assert(!k.key.includes(":v3:"), "so no entry written under the old meaning can be read back");
// any two timestamps on the same UTC day -> same key (one key per bucket per day)
assert(slotCacheKey("411", "2026-06-18T23:59:00.000Z", 14).key === k.key, "same UTC day shares a key");

const slots = ["2026-06-18T16:30:00.000Z", "2026-06-18T17:00:00.000Z", "2026-06-18T18:00:00.000Z"];
const now = Date.parse("2026-06-18T16:50:00.000Z");
assert(JSON.stringify(filterSlotsFromNow(slots, now, 30)) === JSON.stringify(["2026-06-18T18:00:00.000Z"]),
  "filters slots earlier than now + 30m min-notice");

finish();

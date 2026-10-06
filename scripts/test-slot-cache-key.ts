import { slotCacheKey } from "../src/lib/availability/cache-key.ts";
import { searchWindowDays } from "../src/lib/availability/bookable-days.ts";
import { filterSlotsFromNow } from "../src/lib/availability/compute.ts";
import { assert, finish } from "./lib/harness.ts";

const k = slotCacheKey("411", "2026-06-18T16:42:07.123Z", 14);
// #3366: ONE key per bucket, with no day in it. The cached value is the stored row,
// which does not depend on `from`, and a day in the key gave an evening US lead
// (whose local midnight is yesterday's UTC date) a key no purge ever deleted.
assert(k.key === "slots:v5:411:14", "the key names the bucket and horizon, never a day");
assert(slotCacheKey("411", "2026-06-17T04:00:00.000Z", 14).key === k.key, "yesterday's UTC anchor shares the key");
assert(slotCacheKey("412", "2026-06-18T16:42:07.123Z", 14).key !== k.key, "a different bucket does not");
assert(k.fromIso === "2026-06-18T00:00:00.000Z", "fromIso (the compute window) is still the day anchor");

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
// under the new setting's name, and nothing would look wrong. v5 dropped the day.
assert(k.key.includes(":v5:"), "the key version moved with the key's shape");
assert(!k.key.includes(":v3:") && !k.key.includes(":v4:"), "so no entry written under an old shape can be read back");
// any two timestamps share the key (one key per bucket, #3366)
assert(slotCacheKey("411", "2026-06-18T23:59:00.000Z", 14).key === k.key, "same UTC day shares a key");

const slots = ["2026-06-18T16:30:00.000Z", "2026-06-18T17:00:00.000Z", "2026-06-18T18:00:00.000Z"];
const now = Date.parse("2026-06-18T16:50:00.000Z");
assert(JSON.stringify(filterSlotsFromNow(slots, now, 30)) === JSON.stringify(["2026-06-18T18:00:00.000Z"]),
  "filters slots earlier than now + 30m min-notice");

finish();

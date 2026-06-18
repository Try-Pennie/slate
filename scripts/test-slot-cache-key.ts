import { slotCacheKey } from "../src/lib/availability/cache-key.ts";
import { filterSlotsFromNow } from "../src/lib/availability/compute.ts";
let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); failures++; } else console.log("ok:", m); };

const k = slotCacheKey("411", "2026-06-18T16:42:07.123Z", 14);
assert(k.key === "slots:v2:411:2026-06-18T00:00:00.000Z:14", "key anchors from to the start of the UTC day");
assert(k.fromIso === "2026-06-18T00:00:00.000Z", "fromIso is the day anchor");
assert(k.toIso === "2026-07-02T00:00:00.000Z", "toIso is day-anchor + 14d");
// any two timestamps on the same UTC day -> same key (one key per bucket per day)
assert(slotCacheKey("411", "2026-06-18T23:59:00.000Z", 14).key === k.key, "same UTC day shares a key");

const slots = ["2026-06-18T16:30:00.000Z", "2026-06-18T17:00:00.000Z", "2026-06-18T18:00:00.000Z"];
const now = Date.parse("2026-06-18T16:50:00.000Z");
assert(JSON.stringify(filterSlotsFromNow(slots, now, 30)) === JSON.stringify(["2026-06-18T18:00:00.000Z"]),
  "filters slots earlier than now + 30m min-notice");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

// Sanity test for the push watch-health counter.
// Run: node --experimental-strip-types scripts/test-watch-health.ts
import { liveWatchCount } from "../src/lib/google/watch-health.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const now = Date.parse("2026-06-04T12:00:00.000Z");
const future = "2026-06-11T00:00:00.000Z";
const past = "2026-06-01T00:00:00.000Z";

assert(liveWatchCount([], now) === 0, "no agents yields 0");
assert(liveWatchCount([{ watch_expiration: future }], now) === 1, "future expiration counts as live");
assert(liveWatchCount([{ watch_expiration: past }], now) === 0, "past expiration is not live");
assert(liveWatchCount([{ watch_expiration: null }], now) === 0, "null expiration is not live");
assert(
  liveWatchCount(
    [{ watch_expiration: future }, { watch_expiration: past }, { watch_expiration: null }],
    now,
  ) === 1,
  "mixed set counts only the live channel",
);
assert(
  liveWatchCount([{ watch_expiration: "2026-06-04T12:00:00.000Z" }], now) === 0,
  "expiration exactly at now is not live (strict greater-than)",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

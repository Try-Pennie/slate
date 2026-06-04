// Sanity test for pure alert helpers (throttle + formatting).
// Run: node --experimental-strip-types scripts/test-alerts.ts
import { shouldSendAlert, formatWatchLapseAlert } from "../src/lib/notify/alerts.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const COOLDOWN = 30 * 60 * 1000; // 30 min
const now = 1_000_000_000;

assert(shouldSendAlert(null, now, COOLDOWN), "never-alerted: sends");
assert(!shouldSendAlert(now - 60_000, now, COOLDOWN), "within cooldown: suppressed");
assert(shouldSendAlert(now - COOLDOWN, now, COOLDOWN), "exactly at cooldown: sends");
assert(shouldSendAlert(now - COOLDOWN - 1, now, COOLDOWN), "past cooldown: sends");

assert(
  formatWatchLapseAlert(1, 3).includes("1 of 3") && formatWatchLapseAlert(1, 3).includes("watch failed"),
  "singular phrasing for one failure",
);
assert(
  formatWatchLapseAlert(2, 5).includes("2 of 5") && formatWatchLapseAlert(2, 5).includes("watches failed"),
  "plural phrasing for multiple failures",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

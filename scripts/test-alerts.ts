// Sanity test for pure alert helpers (throttle + formatting).
// Run: node --experimental-strip-types scripts/test-alerts.ts
import {
  shouldSendAlert,
  formatWatchLapseAlert,
  formatSyncFailureAlert,
  isConsecutiveFailure,
} from "../src/lib/notify/alerts.ts";

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


// --- sync-failure alerting (#43) ---
assert(!isConsecutiveFailure(0), "no failures -> no alert");
assert(!isConsecutiveFailure(1), "a single failing pass stays quiet (transient blip)");
assert(isConsecutiveFailure(2), "second consecutive failing pass alerts");
assert(isConsecutiveFailure(5), "longer streaks keep alerting (throttle handles spam)");

const syncMsg = formatSyncFailureAlert(2, 7, "freeBusy failed: 503");
assert(syncMsg.includes("2 of 7"), "sync alert includes the failure count");
assert(syncMsg.includes("consecutive"), "sync alert says it is a streak");
assert(syncMsg.includes("freeBusy failed: 503"), "sync alert carries the first error");
assert(
  formatSyncFailureAlert(1, 7, null).includes("1 of 7 bookable agent on"),
  "singular agent copy + no error suffix when absent",
);
assert(
  formatSyncFailureAlert(2, 7, "x".repeat(500)).length < 500,
  "error detail is truncated",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

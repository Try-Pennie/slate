// Sanity test for pure alert helpers (throttle + formatting).
// Run: node --experimental-strip-types scripts/test-alerts.ts
import {
  shouldSendAlert,
  formatWatchLapseAlert,
  formatSyncFailureAlert,
  isConsecutiveFailure,
  dedupeFailingAgents,
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

// Named watch-lapse alert (#273 Phase 1.3): name the failing agent(s) + their
// consecutive-failure count + last success + the remediation, so the operator
// doesn't have to hand-query the DB to find who broke.
const oneFailing = formatWatchLapseAlert(
  [
    {
      email: "alice@pennie.com",
      consecutiveFailures: 5,
      lastSuccessAt: "2026-06-15T08:00:00Z",
      error: "404 account-gone",
    },
  ],
  110,
);
assert(oneFailing.includes("alice@pennie.com"), "names the failing agent");
assert(oneFailing.includes("1 of 110"), "shows failing/total context");
assert(oneFailing.includes("5 consecutive failures"), "shows the consecutive-failure count");
assert(oneFailing.includes("2026-06-15"), "shows the last successful sync date");
assert(oneFailing.includes("404 account-gone"), "carries the underlying error");
assert(/re-?auth|deactivate/i.test(oneFailing), "includes the remediation");

const manyFailing = Array.from({ length: 7 }, (_, i) => ({
  email: `a${i}@pennie.com`,
  consecutiveFailures: 2,
  lastSuccessAt: null,
  error: null,
}));
const many = formatWatchLapseAlert(manyFailing, 110);
assert(many.includes("never"), "shows 'never' when the calendar never succeeded");
assert(
  many.includes("a0@pennie.com") && !many.includes("a6@pennie.com"),
  "caps the named list instead of dumping all of them",
);
assert(/2 more/.test(many), "notes how many failing agents are beyond the cap");
assert(
  formatWatchLapseAlert([{ email: "a@b.com", consecutiveFailures: 2, lastSuccessAt: null, error: "x".repeat(500) }], 110).length < 600,
  "per-agent error detail is truncated",
);


// --- dedupeFailingAgents: collapse calendar rows to one entry per agent ---
const deduped = dedupeFailingAgents([
  { consecutive_failures: 2, last_success_at: null, last_sync_error: "e1", email: "bob@pennie.com", bookable: true, deactivated_at: null },
  { consecutive_failures: 7, last_success_at: "2026-06-10T00:00:00Z", last_sync_error: "worst", email: "bob@pennie.com", bookable: true, deactivated_at: null },
  { consecutive_failures: 3, last_success_at: null, last_sync_error: "e3", email: "amy@pennie.com", bookable: true, deactivated_at: null },
  { consecutive_failures: 9, last_success_at: null, last_sync_error: "gone", email: "left@pennie.com", bookable: true, deactivated_at: "2026-06-01T00:00:00Z" },
  { consecutive_failures: 9, last_success_at: null, last_sync_error: "off", email: "off@pennie.com", bookable: false, deactivated_at: null },
  { consecutive_failures: 4, last_success_at: null, last_sync_error: "x", email: null, bookable: true, deactivated_at: null },
]);
assert(deduped.length === 2, "one entry per agent; deactivated/non-bookable/no-email dropped");
assert(deduped[0].email === "bob@pennie.com" && deduped[0].consecutiveFailures === 7, "keeps the worst calendar per agent, sorted by failures desc");
assert(deduped[0].error === "worst", "carries the worst calendar's error");
assert(deduped[1].email === "amy@pennie.com", "second agent follows in failure order");
assert(!deduped.some((a) => a.email === "left@pennie.com"), "a deactivated agent is excluded");
assert(!deduped.some((a) => a.email === "off@pennie.com"), "a non-bookable agent is excluded");

// --- sync-failure alerting (#43) ---
assert(!isConsecutiveFailure(0), "no failures -> no alert");
assert(!isConsecutiveFailure(1), "a single failing pass stays quiet (transient blip)");
assert(isConsecutiveFailure(2), "second consecutive failing pass alerts");
assert(isConsecutiveFailure(5), "longer streaks keep alerting (throttle handles spam)");

// Named sync-failure alert (#293): like the watch alert, name the failing
// agent(s) instead of an anonymous count, reusing the FailingAgent shape.
const syncFailing = [
  {
    email: "sync1@pennie.com",
    consecutiveFailures: 4,
    lastSuccessAt: "2026-06-20T09:00:00Z",
    error: "freeBusy failed: 503",
  },
];
const syncMsg = formatSyncFailureAlert(syncFailing, 110);
assert(syncMsg.includes("sync1@pennie.com"), "sync alert names the failing agent");
assert(syncMsg.includes("1 of 110"), "sync alert shows failing/total context");
assert(syncMsg.includes("4 consecutive failures"), "sync alert shows the consecutive-failure count");
assert(syncMsg.includes("2026-06-20"), "sync alert shows the last successful sync date");
assert(syncMsg.includes("freeBusy failed: 503"), "sync alert carries the error");
assert(/re-?auth|deactivate/i.test(syncMsg), "sync alert includes the remediation");
assert(
  formatSyncFailureAlert(
    [{ email: "a@b.com", consecutiveFailures: 2, lastSuccessAt: null, error: "x".repeat(500) }],
    110,
  ).length < 600,
  "sync alert truncates per-agent error detail",
);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

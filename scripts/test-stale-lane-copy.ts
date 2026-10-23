// The stale lane page names causes the cron logs can show, and only a lock the lane takes
// (#4168, #3468).
//
// It used to end "A mid-run CPU kill on the shared cron invocation is the usual cause
// (#760): check the Worker's outcome for exceededCpu, and the cron_<lane> lock." Since
// #3693 every lane runs as its own placed fetch, so lanes no longer share one
// invocation's CPU. On 2026-10-23 the monitor lane went quiet for 22 minutes with zero
// `exceededCpu` outcomes: a gradual deploy cancelled a run mid flight, the next tick
// skipped on the cancelled run's lease, and the run after that ran far from the
// database and took 77 s instead of 21 s. Every one of those is on the dispatcher's
// `lane timings` line, and none is where the page sent the reader.
//
// And the lock was built from the lane's name, which named `cron_bulk-reassign` (the
// route takes `cron_bulk_reassign`) and a lock for lanes that take none at all.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-stale-lane-copy.ts
import { coreLaneAlertText } from "../src/lib/monitor/lane-copy.ts";
import { LANE_NAMES, LANE_RUNS, LANE_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { laneFieldName } from "../src/lib/monitor/lane-timing.ts";
import { assert, finish } from "./lib/harness.ts";

// Built from code points, so this file holds neither character for the style gates to find.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);

const page = (lane: string) =>
  coreLaneAlertText({
    lane,
    ageMs: 22 * 60_000,
    maxStaleMs: LANE_STALE_BOUNDS_MS[lane as keyof typeof LANE_STALE_BOUNDS_MS] ?? 20 * 60_000,
    unreadable: false,
  });

for (const lane of LANE_NAMES) {
  const text = page(lane);
  const field = laneFieldName(LANE_RUNS[lane].route);

  assert(!/exceededCpu|CPU|#760/.test(text), `${lane}: no longer blames a CPU kill on a shared invocation`);
  assert(text.includes(`tag=cron`) && text.includes("lane timings"), `${lane}: sends the reader to the lane timings line`);
  assert(text.includes("scripts/logs.ts"), `${lane}: names the tool that reads that line for the window`);
  assert(/deploy/i.test(text) && /cancel/i.test(text), `${lane}: names a deploy cancelling a run mid flight`);
  assert(
    text.includes(`${field}_placement`) && text.includes("lanes_near_db"),
    `${lane}: names a run far from the database, by the field that shows it (${field}_placement)`,
  );
  assert(text.includes(`${field}_ms`), `${lane}: names a run slower than its cadence, by ${field}_ms`);

  const lock = LANE_RUNS[lane].lock;
  if (lock) {
    assert(text.includes(`the ${lock} lock`), `${lane}: names the lock its route really takes (${lock})`);
  } else {
    assert(!/\block\b/i.test(text), `${lane}: takes no lock of its own, so the page names none (saw: ${text})`);
  }
  assert(!text.includes(`cron_${lane}`) || lock === `cron_${lane}`, `${lane}: never builds a lock name from the lane name`);
  assert(!LONG_DASHES.test(text) && !/undefined|NaN|null/.test(text), `${lane}: clean copy`);
}

// The pairs the issues named.
const bulk = page("bulk-reassign");
assert(bulk.includes("the cron_bulk_reassign lock"), "bulk-reassign names cron_bulk_reassign, with underscores");
assert(!bulk.includes("cron_bulk-reassign"), "and never the hyphenated lock that does not exist");
assert(bulk.includes("bulk_reassign_placement") && bulk.includes("bulk_reassign_ms"), "and its timing fields as the log spells them");

const hold = page("reroute-hold-sweep");
assert(!/\block\b/i.test(hold), "the hold sweep takes no lock of its own, so none is named");
assert(hold.includes("selfheal_placement") && hold.includes("selfheal_ms"), "it runs inside selfheal, so its timings are selfheal's");
assert(/inside the selfheal lane/.test(hold), "and the page says so, or selfheal's fields read as a mistake");

const reminders = page("booking-reminders");
assert(!/\block\b/i.test(reminders), "booking-reminders takes no lock, so none is named");

const monitor = page("monitor");
assert(monitor.includes("the cron_monitor lock"), "monitor names cron_monitor");
assert(!/inside the/.test(monitor), "a lane with its own route is not described as running inside another");

// A lane the registry does not know (the watchdog passes a string) still reads, and
// names no lock rather than inventing one.
const unknown = page("some-new-lane");
assert(!/\block\b/i.test(unknown) && unknown.includes("some_new_lane_ms"), "an unregistered lane invents no lock");

finish();

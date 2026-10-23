// The stale lane page says in plain words why a lane usually goes quiet, and the
// runbook holds the per lane detail (#4168, #3468).
//
// It used to end "A mid-run CPU kill on the shared cron invocation is the usual cause
// (#760): check the Worker's outcome for exceededCpu, and the cron_<lane> lock." Since
// #3693 every lane runs as its own placed fetch, so lanes no longer share one
// invocation's CPU. On 2026-10-23 the monitor lane went quiet for 22 minutes with zero
// `exceededCpu` outcomes: a gradual deploy cancelled a run part way, the next tick
// waited on the cancelled run's lock, and the run after that ran far from the database
// and took 77 s instead of 21 s.
//
// The page is read by a product manager on a phone, so it explains the domain and never
// the interface (Dan, 2026-10-23, "Plainer"): no log command, no field names, no lock
// name. Those live in the runbook section the page names, one line per lane, with the
// lock the lane really takes (the lock used to be built from the lane name, which named
// `cron_bulk-reassign` and locks for lanes that take none).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-stale-lane-copy.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coreLaneAlertText, STALE_LANE_RUNBOOK_SECTION } from "../src/lib/monitor/lane-copy.ts";
import { LANE_NAMES, LANE_RUNS, LANE_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { laneFieldName } from "../src/lib/monitor/lane-timing.ts";
import { assert, finish } from "./lib/harness.ts";

// Built from code points, so this file holds neither character for the style gates to find.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
const WAITED = "the next run then waited for the first to time out";

const page = (lane: string) =>
  coreLaneAlertText({
    lane,
    ageMs: 22 * 60_000,
    maxStaleMs: LANE_STALE_BOUNDS_MS[lane as keyof typeof LANE_STALE_BOUNDS_MS] ?? 20 * 60_000,
    unreadable: false,
  });

// --- The page: plain causes, no interface.
for (const lane of LANE_NAMES) {
  const text = page(lane);
  assert(text.startsWith(`The ${lane} cron lane has not run for 22 minutes`), `${lane}: opens with the lane and how long it has been quiet`);
  assert(text.includes("Its work is not happening."), `${lane}: keeps what the silence means`);
  assert(!/exceededCpu|CPU|#760/.test(text), `${lane}: no longer blames a CPU kill on a shared invocation`);
  assert(
    /a deploy cancelled a run part way/.test(text) &&
      /far from the database and ran slowly/.test(text) &&
      /took longer than its schedule/.test(text),
    `${lane}: names the three usual causes in plain words`,
  );
  assert(
    !/scripts\/|tag=|_placement|lanes_near_db|_ms\b|\bcron_\w+|\block\b|lane timings/i.test(text),
    `${lane}: carries no log command, field name or lock name (saw: ${text})`,
  );
  assert(text.includes(`"${STALE_LANE_RUNBOOK_SECTION}"`), `${lane}: points at the runbook section by name`);
  // Waiting on the first run applies only where a lock makes the next run wait.
  assert(text.includes(WAITED) === (LANE_RUNS[lane].lock !== null), `${lane}: says the next run waited only when the lane takes a lock`);
  assert(!LONG_DASHES.test(text) && !/undefined|NaN|null/.test(text), `${lane}: clean copy`);
}

assert(page("bulk-reassign").includes(WAITED), "bulk-reassign takes a lock, so its next run waits");
assert(!page("reroute-hold-sweep").includes(WAITED), "the hold sweep takes no lock of its own, so nothing waits on one");
assert(!page("booking-reminders").includes(WAITED), "booking-reminders takes no lock");
const unknown = page("some-new-lane");
assert(!unknown.includes(WAITED) && unknown.includes(STALE_LANE_RUNBOOK_SECTION), "an unregistered lane invents no lock");

// --- The runbook section the page names holds the per lane detail, from the registry.
const runbook = readFileSync(join(import.meta.dirname, "..", "docs/alerts-runbook.md"), "utf8");
const start = runbook.indexOf(`## ${STALE_LANE_RUNBOOK_SECTION}\n`);
assert(start >= 0, `the runbook has a section headed "${STALE_LANE_RUNBOOK_SECTION}"`);
const section = runbook.slice(start, runbook.indexOf("\n## ", start + 1));

assert(section.includes(`scripts/logs.ts "tag=cron"`) && section.includes("lane timings"), "the runbook names the log line and how to read it");
assert(section.includes("lanes_near_db"), "and the field that says a run was far from the database");

for (const lane of LANE_NAMES) {
  const run = LANE_RUNS[lane];
  const field = laneFieldName(run.route);
  const line = section.split("\n").find((l) => l.startsWith(`  - \`${lane}\`:`));
  assert(line !== undefined, `${lane}: has its own line in the runbook`);
  if (!line) continue;
  assert(line.includes(`\`${field}_placement\``) && line.includes(`\`${field}_ms\``), `${lane}: its line names the timing fields it is logged under (${field})`);
  assert(
    run.lock ? line.includes(`\`${run.lock}\``) : line.includes("takes no lock"),
    `${lane}: its line names the lock its route really takes, or says it takes none (${run.lock ?? "none"})`,
  );
  if (field !== laneFieldName(lane)) {
    assert(line.includes(`runs inside the ${field} lane`), `${lane}: says it runs inside ${field}, or ${field}'s fields read as a mistake`);
  }
}
assert(!section.includes("cron_bulk-reassign"), "the runbook never names the hyphenated lock that does not exist");

finish();

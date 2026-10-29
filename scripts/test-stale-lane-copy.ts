// The stale lane page says what stopped and where to look; the runbook holds the
// usual causes and the per lane detail (#4168, #3468). Since 2026-10-26 the core
// lanes share ONE page: a Cloudflare cron incident posted six (Dan: "this is too much").
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
import { coreLanesAlertText, coreLanesRecoveryText, STALE_LANE_RUNBOOK_SECTION } from "../src/lib/monitor/lane-copy.ts";
import { LANE_NAMES, LANE_RUNS, LANE_STALE_BOUNDS_MS, stoppedTogether, type StaleLane } from "../src/lib/monitor/health.ts";
import { laneFieldName } from "../src/lib/monitor/lane-timing.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Built from code points, so this file holds neither character for the style gates to find.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`);
const MIN = 60_000;

const lane = (name: string, ageMs: number, unreadable = false): StaleLane => ({
  lane: name,
  ageMs,
  maxStaleMs: LANE_STALE_BOUNDS_MS[name as keyof typeof LANE_STALE_BOUNDS_MS] ?? 20 * MIN,
  unreadable,
});
const page = (stale: StaleLane[], over: Partial<Parameters<typeof coreLanesAlertText>[0]> = {}) =>
  coreLanesAlertText({
    stale,
    othersRunning: true,
    poolGroupingStopped: false,
    cloudflare: { kind: "unknown" },
    ...over,
  });
const clean = (text: string, what: string) =>
  assert(!LONG_DASHES.test(text) && !/undefined|NaN|null|Infinity/.test(text), `${what}: clean copy (saw: ${text})`);

// --- One lane: what stopped, how long, where to look. Nothing else (Dan, 2026-10-26: "this is too much").
for (const name of LANE_NAMES) {
  const text = page([lane(name, 22 * MIN)]);
  assert(text.startsWith(`The ${name} cron lane has not run for 22 minutes`), `${name}: opens with the lane and how long it has been quiet`);
  assert(text.includes(`"${STALE_LANE_RUNBOOK_SECTION}"`), `${name}: points at the runbook section by name`);
  assert(
    !/scripts\/|tag=|_placement|lanes_near_db|_ms\b|\bcron_\w+|\block\b|lane timings|exceededCpu/i.test(text),
    `${name}: carries no log command, field name or lock name (saw: ${text})`,
  );
  // The three usual causes moved to the runbook: repeated on every page they were most of the text.
  assert(!/deploy cancelled|far from the database|longer than its schedule/.test(text), `${name}: no paragraph of causes`);
  clean(text, name);
}
const unreadable = page([lane("sync", 0, true)]);
assert(unreadable.includes("cannot be read") && !/has not run for \d/.test(unreadable), "an unreadable stamp says so and quotes no age");

// --- Several lanes: ONE page naming them all (2026-10-26, six pages for one Cloudflare incident).
const tonight = [
  lane("recompute", 16 * MIN + 2_000),
  lane("reroute-hold-sweep", 16 * MIN + 1_000),
  lane("selfheal", 16 * MIN + 1_000),
  lane("outbox", 16 * MIN),
  lane("sync", 15 * MIN + 59_000),
];
const five = page(tonight);
assert(five.startsWith("5 cron lanes have not run for 16 minutes: recompute, reroute-hold-sweep, selfheal, outbox and sync."), `names every lane once (saw: ${five})`);
eq((five.match(/runbook/g) ?? []).length, 1, "the runbook is named once, not once per lane");
const spread = page([lane("recompute", 12 * MIN), lane("monitor", 25 * MIN)], { othersRunning: false });
assert(spread.startsWith("2 cron lanes have not run for 12 to 25 minutes: recompute and monitor."), `quotes the range when ages differ (saw: ${spread})`);
const mixed = page([lane("recompute", 12 * MIN), lane("sync", 0, true)]);
assert(mixed.includes("recompute and sync") && /last-run record for sync cannot be read/.test(mixed), `an unreadable lane is named, not aged (saw: ${mixed})`);
clean(five, "five lanes");
clean(spread, "spread");
clean(mixed, "mixed");

// --- Stopped together while other lanes ran: the schedule or a deploy, not one lane. Measured, so said.
assert(stoppedTogether(tonight), "five lanes stopping inside two seconds stopped together");
assert(!stoppedTogether([lane("recompute", 12 * MIN), lane("monitor", 25 * MIN)]), "thirteen minutes apart is not together");
assert(!stoppedTogether([lane("sync", 16 * MIN)]), "one lane is not a group");
assert(!stoppedTogether([lane("sync", 16 * MIN), lane("outbox", 0, true)]), "an unreadable stamp cannot be placed in time");
const together = /They stopped together while other lanes kept running/;
// Dan, 2026-10-26: shortened, since it had become the longest line on the page.
assert(five.includes("They stopped together while other lanes kept running: a schedule or deploy problem, not one lane."), `tonight's page says they stopped together while others ran, briefly (saw: ${five})`);
assert(!together.test(page(tonight, { othersRunning: false })), "not claimed when nothing else was running to compare with");
assert(!together.test(spread), "not claimed for lanes that stopped apart");

// --- Cloudflare's status page: quoted when it has an incident, said when it has none, silent when unread.
const incident = page(tonight, {
  cloudflare: { kind: "incident", names: ["Delayed, missed, and duplicated Workers Cron Triggers"] },
});
assert(incident.includes(`Cloudflare's status page has an open incident: "Delayed, missed, and duplicated Workers Cron Triggers".`), `quotes the incident (saw: ${incident})`);
const two = page(tonight, { cloudflare: { kind: "incident", names: ["A", "B"] } });
assert(two.includes(`open incidents: "A" and "B".`), `names each incident (saw: ${two})`);
assert(page(tonight, { cloudflare: { kind: "clear" } }).includes("Cloudflare's status page shows no open Workers incident."), "says when Cloudflare reports nothing");
assert(!/Cloudflare/.test(page(tonight)), "an unread status page claims nothing either way (L11)");

// --- The pool grouping it explains rides on this page rather than posting its own.
assert(page(tonight, { poolGroupingStopped: true }).includes("The pool grouping, which the recompute lane publishes, has stopped with it."), "names the pool grouping as recompute's");
assert(page([lane("sync", 12 * MIN)], { poolGroupingStopped: true }).includes("The pool grouping publish has stopped too."), "without recompute it is only named");
assert(!/pool grouping/.test(five), "no pool grouping line while it is publishing");

// --- the sync sentence and the every minute trigger (2026-10-29) ---------------------
// Dan's exact words for the consequence of a stopped sync lane.
const SYNC_SENTENCE = "Advisors' calendars aren't syncing, so offered times may be out of date.";
assert(five.includes(SYNC_SENTENCE), `sync among the stopped lanes says advisors' calendars aren't syncing (saw: ${five})`);
assert(!page([lane("monitor", 25 * MIN)]).includes(SYNC_SENTENCE), "no calendar sentence when sync is running");
assert(!/not being refreshed|can drift from them/.test(five), "the old calendar sentence is gone");

// Today's page: Cloudflare delivered no every minute tick from 4:51:57 AM ET (08:51:57 UTC).
const silentSince = Date.parse("2026-10-29T08:51:57Z");
const silent = page(tonight, { minuteTrigger: { kind: "silent", sinceMs: silentSince } });
assert(silent.includes("Cloudflare has delivered no every-minute tick since 4:51am ET."), `names the last delivery in ET (saw: ${silent})`);
assert(!together.test(silent), "the measured cause replaces the schedule or deploy guess");
clean(silent, "silent trigger page");
const neverInWindow = page(tonight, { minuteTrigger: { kind: "silent", sinceMs: null } });
assert(neverInWindow.includes("Cloudflare has delivered no every-minute tick in the last 2 hours."), `no delivery in the whole window says so (saw: ${neverInWindow})`);
const delivered = page(tonight, { minuteTrigger: { kind: "delivered", lastMs: silentSince } });
assert(delivered.includes("a schedule or deploy problem") && !/every-minute tick/.test(delivered), "ticks arriving and runs failing keeps the schedule or deploy sentence");
assert(!/every-minute tick/.test(page(tonight, { minuteTrigger: { kind: "unknown" } })), "an unreadable reading claims nothing about Cloudflare (L11)");
assert(page(tonight, { minuteTrigger: { kind: "unknown" } }).includes("a schedule or deploy problem"), "and keeps the old sentence");
const fiveMinuteOnly = page([lane("monitor", 25 * MIN), lane("complete", 25 * MIN)], { minuteTrigger: { kind: "silent", sinceMs: silentSince } });
assert(!/every-minute tick/.test(fiveMinuteOnly), "no every minute sentence when no quiet lane is on that trigger");
const holdSweepOnly = page([lane("reroute-hold-sweep", 14 * MIN)], { minuteTrigger: { kind: "silent", sinceMs: silentSince } });
assert(holdSweepOnly.includes("every-minute tick since"), "the reroute hold sweep runs inside selfheal, so it is on the trigger");

// --- The all-clear names nothing it cannot know and asks for nothing.
const recovery = coreLanesRecoveryText();
assert(/running again/.test(recovery) && /No action is needed\./.test(recovery), "the all-clear says the lanes are running and nothing is needed");
clean(recovery, "recovery");

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

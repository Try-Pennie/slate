/**
 * #1941: the roster coverage alarm stamps `verdict:roster-coverage` only on a
 * MEASURED verdict.
 *
 * The alarm is fail safe: an unreadable roster, a setup read the gate refuses to
 * run without, or a missing week all conclude nothing, and every one of those is
 * silent. Once #1456 arms it, silence is also what a fully covered week looks
 * like, so without this stamp a check that has stopped measuring reads exactly
 * like one that keeps finding the week covered (#1394).
 *
 * Every case below goes through the REAL `coverageForWeek` and the REAL
 * `runRosterCoverageCheck`, so the stamp is decided off the outcome the monitor
 * lane actually gets rather than off a hand built status.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-roster-coverage-verdict.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coverageForWeek } from "../src/lib/booking/business-hours-coverage.ts";
import {
  runRosterCoverageCheck,
  type RosterCoverageVerdict,
} from "../src/lib/monitor/roster-coverage.ts";
import { ALL_SETUP_READ, monitorSetupGates } from "../src/lib/monitor/setup-gates.ts";
import {
  ROSTER_COVERAGE_VERDICT_LANE,
  rosterCoverageReachedVerdict,
} from "../src/lib/monitor/verdict-freshness.ts";
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const WEEK_START = "2026-08-10";
const HOUR = 60 * 60_000;

/** The org's advertised week as production stores it: 08:00 to 20:00, Mon to Sat. */
const OPEN_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  is_open: weekday !== 7,
  start_minute: 8 * 60,
  end_minute: 20 * 60,
}));

function agent(weekdays: number[], startMinute: number, endMinute: number) {
  return {
    timezone: ZONE,
    rules: weekdays.map((weekday) => ({ weekday, start_minute: startMinute, end_minute: endMinute })),
  };
}

/** One tick of the real check over a roster, armed, with sends recorded. */
async function tick(
  agents: Parameters<typeof coverageForWeek>[0]["agents"],
): Promise<{ result: RosterCoverageVerdict; sends: number }> {
  let sends = 0;
  const result = await runRosterCoverageCheck({
    coverage: coverageForWeek({ businessHours: OPEN_WEEK, zone: ZONE, agents, weekStartIso: WEEK_START }),
    armed: true,
    notify: async () => {
      sends++;
      return true;
    },
    resolve: async () => {
      sends++;
      return true;
    },
    cooldownMs: HOUR,
  });
  return { result, sends };
}

// --- a tick whose roster read failed stamps NOTHING ----------------------------
{
  const { result, sends } = await tick(null);
  eq(result.status, "skipped", "an unreadable roster reaches the check as a skip");
  assert(
    !rosterCoverageReachedVerdict(result),
    "a tick whose roster read failed stamps nothing",
  );
  eq(sends, 0, "and it neither pages nor clears, so the stamp is the only thing that could have told");
}

// --- a tick whose setup gate skipped it stamps NOTHING -------------------------
// The route's step returns null when the gate refuses to run it (or when the
// business hours never arrived), and it returns null when the step throws. Both
// reach the predicate as null.
{
  for (const read of ["businessHours", "workingHours", "settings"] as const) {
    const gate = monitorSetupGates({ ...ALL_SETUP_READ, [read]: false }).rosterCoverage;
    assert(!gate.run, `the gate refuses to run roster coverage without ${read}`);
  }
  assert(
    !rosterCoverageReachedVerdict(null),
    "a tick whose setup gate skipped it (or whose step threw) stamps nothing",
  );
}

// --- a tick finding gaps stamps ------------------------------------------------
{
  const { result } = await tick([agent([1, 2, 3, 4, 5], 8 * 60, 17 * 60)]);
  eq(result.status, "gaps", "a weekday only roster against a Saturday week finds gaps");
  assert(rosterCoverageReachedVerdict(result), "a tick finding gaps stamps");
  // Disarmed is still a measurement: the switch decides whether it pages, not
  // whether it looked. Before #1456 this is the state every tick is in.
  const disarmed = await runRosterCoverageCheck({
    coverage: coverageForWeek({
      businessHours: OPEN_WEEK,
      zone: ZONE,
      agents: [agent([1, 2, 3, 4, 5], 8 * 60, 17 * 60)],
      weekStartIso: WEEK_START,
    }),
    armed: false,
    notify: async () => true,
    resolve: async () => true,
    cooldownMs: HOUR,
  });
  assert(rosterCoverageReachedVerdict(disarmed), "a disarmed tick that measured gaps still stamps");
}

// --- a tick finding full coverage stamps (an empty gap list IS a verdict) ------
// The case worth writing carefully. The skipped tick above and this one both end
// with nothing paged and an empty set of findings; the only thing separating them
// is that this one read a roster and held it against the week.
{
  const { result } = await tick([agent([1, 2, 3, 4, 5, 6], 8 * 60, 20 * 60)]);
  eq(result.status, "covered", "a roster matching the advertised week reads as covered");
  assert(rosterCoverageReachedVerdict(result), "a tick finding full coverage stamps");
  const unreadable = await tick(null);
  assert(
    rosterCoverageReachedVerdict(result) !== rosterCoverageReachedVerdict(unreadable.result),
    "a measured empty result and an absent measurement are told apart",
  );
}

// --- the lane and its bound -----------------------------------------------------
{
  eq(ROSTER_COVERAGE_VERDICT_LANE, "verdict:roster-coverage", "the lane name the issue specifies");
  const bound = VERDICT_STALE_BOUNDS_MS[ROSTER_COVERAGE_VERDICT_LANE];
  assert(typeof bound === "number", "the lane has a blindness bound, so the watchdog reads it");
  // It concludes on every five minute tick the week and the roster are readable,
  // so its bound is a maintenance window over a failed read. It must not be one of
  // the traffic fed checks' four days, which would let a whole working week of
  // roster edits go unwatched.
  assert(bound > 60 * 60_000, "the bound survives an ordinary hour long read outage");
  assert(bound <= 24 * HOUR, "the bound is no looser than the truth probe's day");
}

// --- the wiring: the monitor lane stamps through this predicate ----------------
{
  const route = readFileSync(join(import.meta.dirname, "..", "src", "app", "api", "cron", "monitor", "route.ts"), "utf8");
  const call = /recordDetectorVerdict\(\s*ROSTER_COVERAGE_VERDICT_LANE,\s*rosterCoverageReachedVerdict\(rosterCoverage\),?\s*\)/;
  assert(call.test(route), "the monitor lane stamps roster coverage through its predicate over the step's own result");
}

finish();

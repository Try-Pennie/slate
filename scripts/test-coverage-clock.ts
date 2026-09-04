// The coverage walk resolves each local day once, not once per agent per hour.
//
// After #1846 the availability grid's remaining Worker CPU is here. `coverageForDate`
// asks, for every HOUR of every DAY, which agents are on shift, and the shift test
// builds a zone-aware date for that agent from scratch every time. Measured against
// the live roster: 102 agents x 12 hours x 14 days = 17,136 of those, and the walk
// takes 342ms locally, which is roughly the second of CPU the page still spends.
//
// Almost all of it is repeats. There are FIVE distinct timezones across 102 agents,
// so for a given instant every agent in a zone resolves the identical local day, and
// agents sharing a shift pattern resolve the identical window bounds.
//
// THE MEMO IS KEYED ON THE ZONE AND THE INSTANT, NEVER ON THE AGENT. An agent's local
// DATE is what decides which of their rules apply, and the roster spans seven zones,
// so the org's open hours can fall on two different local weekdays for one agent
// (#1739, #1316). Keying on anything coarser than the instant would collapse that
// boundary and put somebody on shift on the wrong day.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-coverage-clock.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  coverageForDate,
  memoisedCoverageClock,
  realCoverageClock,
  type CoverageAgent,
  type CoverageClock,
} from "../src/lib/booking/business-hours-coverage.ts";

const ZONE = "America/New_York";
const WINDOW = { start_minute: 8 * 60, end_minute: 20 * 60 };
const WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 17 * 60 }));

/** A roster in several zones, the way the real one is (#1739). */
function roster(n: number): CoverageAgent[] {
  const zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles"];
  return Array.from({ length: n }, (_, i) => ({
    userId: `u${i}`,
    timezone: zones[i % zones.length]!,
    rules: WEEK,
    out: [],
  }));
}

/** A clock that records every underlying resolution it was asked to do. */
function counting(inner: CoverageClock) {
  const days: string[] = [];
  const windows: string[] = [];
  const clock: CoverageClock = {
    day: (zone, atMs) => { days.push(`${zone}|${atMs}`); return inner.day(zone, atMs); },
    window: (zone, dayStartMs, s, e) => {
      windows.push(`${zone}|${dayStartMs}|${s}|${e}`);
      return inner.window(zone, dayStartMs, s, e);
    },
  };
  return { clock, days, windows };
}

// --- the work is bounded by DISTINCT questions, not by agents x hours --------
{
  const agents = roster(100);
  const bare = counting(realCoverageClock);
  coverageForDate({ window: WINDOW, zone: ZONE, dateIso: "2026-09-08", agents, clock: bare.clock });
  const unmemoised = bare.days.length;

  const memo = counting(realCoverageClock);
  coverageForDate({
    window: WINDOW,
    zone: ZONE,
    dateIso: "2026-09-08",
    agents,
    clock: memoisedCoverageClock(memo.clock),
  });

  assert(unmemoised > 1000, `without a memo it is a lot of work (${unmemoised} day resolutions)`);
  eq(
    new Set(memo.days).size,
    memo.days.length,
    "with one, no local day is resolved twice",
  );
  assert(
    memo.days.length < unmemoised / 10,
    `and there are far fewer of them (${memo.days.length} against ${unmemoised})`,
  );
  // Five zones, twelve open hours: the distinct questions are zone x instant.
  eq(memo.days.length, 5 * 12, "exactly one resolution per zone per hour");
  eq(new Set(memo.windows).size, memo.windows.length, "and no window is computed twice");
}

// --- and it answers exactly the same, which is the half that matters ---------
//
// A memo keyed on too little would be fast and wrong. The cases that catch it are
// the ones a single-zone fixture never has: an agent whose local weekday differs
// from the org's for part of the org's day, and the weeks when only one of two
// zones has changed its clocks.
{
  const agents: CoverageAgent[] = [
    { userId: "ny", timezone: "America/New_York", rules: WEEK, out: [] },
    { userId: "la", timezone: "America/Los_Angeles", rules: WEEK, out: [] },
    { userId: "tokyo", timezone: "Asia/Tokyo", rules: WEEK, out: [] },
    { userId: "london", timezone: "Europe/London", rules: WEEK, out: [] },
  ];
  const DATES = [
    "2026-03-09", // the week the US has changed and Europe has not
    "2026-03-30",
    "2026-09-08",
    "2026-11-02", // the other side of the same gap
    "2026-11-05",
  ];
  const differences: string[] = [];
  for (const dateIso of DATES) {
    const plain = coverageForDate({ window: WINDOW, zone: ZONE, dateIso, agents, clock: realCoverageClock });
    const memo = coverageForDate({
      window: WINDOW, zone: ZONE, dateIso, agents, clock: memoisedCoverageClock(realCoverageClock),
    });
    if (JSON.stringify(plain) !== JSON.stringify(memo)) differences.push(dateIso);
  }
  eq(differences.join(", "), "", "memoised and unmemoised agree on every date, including the clock-change weeks");

  // The positive control on the comparison above. Agreeing proves nothing if the
  // answer is the same everywhere, so the counts must actually VARY across the
  // day: a memo that resolved the wrong local day would move an agent in or out
  // of an hour, and only a varying answer can show that (L1).
  const sample = coverageForDate({ window: WINDOW, zone: ZONE, dateIso: "2026-09-08", agents, clock: realCoverageClock });
  const counts = new Set(sample.hours.map((h) => h.agents));
  assert(
    counts.size > 2,
    `the fixture's coverage really varies across the day (${[...counts].sort((a, b) => a - b).join(", ")})`,
  );
  assert(
    sample.hours.some((h) => h.agents < agents.length),
    "and at least one hour is not fully staffed, so a wrong day would change a count",
  );
}

// --- a memo must never outlive the walk that built it ------------------------
//
// Two calls with their own memo cannot influence each other. Stated as a test
// rather than as a comment, because a module level cache here would be a stale
// roster served for as long as the isolate lived.
{
  const one = memoisedCoverageClock(realCoverageClock);
  const two = memoisedCoverageClock(realCoverageClock);
  const agents = roster(4);
  const a = coverageForDate({ window: WINDOW, zone: ZONE, dateIso: "2026-09-08", agents, clock: one });
  const b = coverageForDate({ window: WINDOW, zone: ZONE, dateIso: "2026-09-08", agents, clock: two });
  eq(JSON.stringify(a), JSON.stringify(b), "two independent memos give the same answer");
}

// --- the default is still to resolve directly, so no caller had to change ----
{
  const agents = roster(3);
  const withClock = coverageForDate({ window: WINDOW, zone: ZONE, dateIso: "2026-09-08", agents, clock: realCoverageClock });
  const without = coverageForDate({ window: WINDOW, zone: ZONE, dateIso: "2026-09-08", agents });
  eq(JSON.stringify(without), JSON.stringify(withClock), "coverageForDate with no clock behaves exactly as before");
}

finish();

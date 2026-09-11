// Which cron lanes a load test deployment holds back, and what it does with a name
// that matches nothing (#2242).
//
// The unknown-name case is the one worth reading. A disable list that silently
// skips what it cannot match reports success having matched nothing (L100), and
// the thing it failed to hold back here is a lane that emails a real inbox about a
// synthetic roster. So it refuses the whole tick instead.
//
// Run: node --experimental-strip-types scripts/test-loadtest-lanes-disabled.ts
import { CRON_ROUTES } from "../worker/cron-routes.ts";
import { allLaneNames, laneDecision, laneName } from "../worker/lanes-disabled.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const MINUTE = ["/api/cron/sync", "/api/cron/recompute", "/api/cron/outbox", "/api/cron/selfheal"];
const FIVE = [
  "/api/cron/complete",
  "/api/cron/watch",
  "/api/cron/monitor",
  "/api/cron/bulk-reassign",
];

// --- nothing disabled is production -------------------------------------------

{
  for (const [label, raw] of [
    ["unset", undefined],
    ["empty", ""],
    ["only separators", " , , "],
  ] as const) {
    const d = laneDecision(MINUTE, raw);
    eq(d.run, MINUTE, `an ${label} setting runs every lane`);
    eq(d.skipped.length, 0, `an ${label} setting holds nothing back`);
    eq(d.unknown.length, 0, `an ${label} setting reports no unknown name`);
  }
}

// --- a real disable -----------------------------------------------------------

{
  const d = laneDecision(FIVE, "monitor,bulk-reassign");
  eq(d.run, ["/api/cron/complete", "/api/cron/watch"], "the named lanes are held back");
  eq(d.skipped, ["/api/cron/monitor", "/api/cron/bulk-reassign"], "and are reported as skipped");
  eq(d.unknown.length, 0, "with nothing unrecognised");
  // The other direction (L159): the same list over a tick holding none of those
  // lanes changes nothing, so the split above is about the names rather than about
  // the list being non-empty.
  eq(laneDecision(MINUTE, "monitor,bulk-reassign").run, MINUTE, "a tick sharing no lane is untouched");
}

{
  // Surrounding space is not a different lane, since the setting is written by hand
  // in a config file where a reader will space the list out.
  eq(laneDecision(FIVE, " monitor , watch ").skipped.length, 2, "names are trimmed");
}

// --- a name that matches nothing ----------------------------------------------

{
  const d = laneDecision(FIVE, "monitor,ooo-aprovals");
  eq(d.unknown, ["ooo-aprovals"], "an unrecognised name is named");
  eq(d.run.length, 0, "and the tick runs nothing at all");
  eq(d.skipped, FIVE, "every lane is reported as held back, so the refusal is visible");
  // The refusal is about the name, not about the tick: the same tick with the typo
  // corrected runs three lanes.
  eq(laneDecision(FIVE, "monitor,ooo-approvals").run.length, 3, "and the corrected list runs");
}

{
  // A lane real elsewhere but not on THIS tick is not unknown: the setting is one
  // list applied to every expression, so most ticks legitimately share no name with
  // most of it.
  const d = laneDecision(MINUTE, "snowflake-export");
  eq(d.unknown.length, 0, "a lane driven by another expression is recognised");
  eq(d.run, MINUTE, "and this tick is untouched by it");
}

// --- the known set is derived, never listed -----------------------------------

{
  const names = allLaneNames();
  const fromMap = new Set<string>();
  for (const v of Object.values(CRON_ROUTES)) {
    for (const p of Array.isArray(v) ? v : [v]) fromMap.add(laneName(p));
  }
  eq(names.length, fromMap.size, "every lane in the route map is a known name");
  assert(
    names.every((n) => fromMap.has(n)),
    "and no known name comes from anywhere but the route map",
  );
  // A lane added to the map is known WITHOUT this file being edited, which is the
  // whole reason it is derived (L96).
  assert(names.includes("hydrate-calendars"), "a lane on its own expression is included");
  assert(names.includes("erasure-audit"), "and so is one co-scheduled with another");
}

{
  eq(laneName("/api/cron/prune-bookings-pii"), "prune-bookings-pii", "a lane name is the last segment");
  eq(laneName("/api/cron/sync"), "sync", "for a short route too");
}

finish();

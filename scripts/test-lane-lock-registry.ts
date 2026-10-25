// Every lock the lane registry names is one the lane's route really takes (#3468).
//
// The stale lane page used to build the lock name from the lane name, so it told the
// reader to check `cron_bulk-reassign` (the route takes `cron_bulk_reassign`) and a
// `cron_reroute-hold-sweep` that does not exist (the sweep runs inside selfheal and
// takes no lock of its own). A reader mid incident who finds no such row reads it as
// "the lock is fine". The registry (`LANE_RUNS`, beside the bounds) now records each
// lane's route and real lock, and this reads the route's own `acquireLock` and
// `acquireLease` calls to hold the two together, in both directions.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lane-lock-registry.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_NAMES, LANE_RUNS } from "../src/lib/monitor/health.ts";
import { laneLockFindings, routeLocks, type LaneRunEntry } from "./lib/lane-lock-scan.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

const routeSource = (route: string): string | null => {
  const file = join(ROOT, "src/app", route, "route.ts");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

/** The text of every `@/` module a route imports, where a lock constant can live. */
const importedSources = (routeText: string): string[] => {
  const out: string[] = [];
  for (const m of routeText.matchAll(/from\s+"@\/([^"]+)"/g)) {
    for (const candidate of [`src/${m[1]}.ts`, `src/${m[1]}/index.ts`, `src/${m[1]}.tsx`]) {
      const file = join(ROOT, candidate);
      if (existsSync(file)) {
        out.push(readFileSync(file, "utf8"));
        break;
      }
    }
  }
  return out;
};

const scheduled = [
  ...new Set([...readFileSync(join(ROOT, "worker/cron-routes.ts"), "utf8").matchAll(/"(\/api\/cron\/[a-z0-9-]+)"/g)].map((m) => m[1])),
];
assert(scheduled.length > 10, `read the scheduled cron routes (saw ${scheduled.length})`);

// --- The real registry agrees with the real routes.
const findings = laneLockFindings(LANE_RUNS, routeSource, importedSources, scheduled);
eq(findings, [], "every lane's recorded route and lock match what its route takes");
eq(Object.keys(LANE_RUNS).sort(), [...LANE_NAMES].sort(), "one registry entry per watched lane");

// The cases the issue named, pinned so a reader of this file sees them.
eq(LANE_RUNS["bulk-reassign"].lock, "cron_bulk_reassign", "bulk-reassign's lock has underscores");
eq(LANE_RUNS["reroute-hold-sweep"], { route: "/api/cron/selfheal", lock: null }, "the hold sweep runs inside selfheal with no lock of its own");
eq(LANE_RUNS["booking-reminders"].lock, null, "booking-reminders takes no lock");

// --- The guard is seen to fail (L1). Each control changes one thing in a copy of the
// real registry and must produce a finding about exactly that lane.
const withLane = (lane: string, entry: LaneRunEntry) => ({ ...LANE_RUNS, [lane]: entry });
const findingsFor = (runs: Record<string, LaneRunEntry>) =>
  laneLockFindings(runs, routeSource, importedSources, scheduled);

const hyphenated = findingsFor(withLane("bulk-reassign", { route: "/api/cron/bulk-reassign", lock: "cron_bulk-reassign" }));
assert(
  hyphenated.length === 1 && hyphenated[0].startsWith("bulk-reassign:") && hyphenated[0].includes("cron_bulk_reassign"),
  `a lock name built from the lane name is refused, naming the real one (saw ${JSON.stringify(hyphenated)})`,
);

const invented = findingsFor(withLane("booking-reminders", { route: "/api/cron/booking-reminders", lock: "cron_booking_reminders" }));
assert(invented.length === 1 && invented[0].startsWith("booking-reminders:"), "a lock the route never takes is refused");

const unnamed = findingsFor(withLane("monitor", { route: "/api/cron/monitor", lock: null }));
assert(unnamed.length === 1 && unnamed[0].startsWith("monitor:"), "a lock the route takes but the registry omits is refused");

const borrowed = findingsFor(withLane("reroute-hold-sweep", { route: "/api/cron/selfheal", lock: "cron_selfheal" }));
assert(
  borrowed.length === 1 && borrowed[0].startsWith("reroute-hold-sweep:"),
  "a sub step lane recording its host route's lock is refused: that lock is the host's",
);

const missing = findingsFor(withLane("sync", { route: "/api/cron/synk", lock: "cron_sync" }));
assert(missing.some((f) => f.startsWith("sync:") && f.includes("no route file")), "a route that does not exist is refused");
assert(missing.some((f) => f.includes("not a route worker/cron-routes.ts schedules")), "and so is one nothing schedules");

// --- The reader itself, on shapes the routes use.
eq(routeLocks(`await acquireLock("cron_x", TTL)`, []).names, ["cron_x"], "a literal lock");
eq(
  routeLocks(`await acquireLease(LANE_LOCK, TTL)`, [`export const LANE_LOCK = "cron_y";`]).names,
  ["cron_y"],
  "a constant declared in an imported module",
);
eq(routeLocks(`await acquireLease(MISSING, TTL)`, []).unresolved, ["MISSING"], "an undeclared constant is reported, never guessed");
const dyn = routeLocks("acquireLock(`anomaly:${code}`, W); acquireLock(name, ttl)", []);
eq([dyn.names.length, dyn.dynamic], [0, 2], "a template or a parameter is a dynamic lock, never a lane's name");

finish();

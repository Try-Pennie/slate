// Repo invariant (#1123): every lane that stamps a heartbeat must be WATCHED by
// exactly one staleness bound, and every bound must watch a lane that really stamps.
//
// The bug class: a heartbeat is only half of a dead-man's switch. `recordHeartbeat`
// writes a row; something has to READ it and alert when it goes stale. Add the
// stamp and forget the bound, and the lane looks instrumented while nothing on
// earth is watching it. That is worse than no heartbeat, because the row's presence
// reads as coverage.
//
// It had happened three times over when this guard was written (2026-07-27):
//   - `snowflake-reconcile` stamped every 6h into a row no bound read. Two other
//     places, worker/cron-routes.ts and the erasure-audit route, documented it as
//     the dead-man's switch covering the whole 6h expression. It was not.
//   - `bulk-reassign` (a 5-min lane) likewise stamped unwatched.
//   - `erasure-audit` had no heartbeat at all and was documented as relying on
//     reconcile's, which did not work either (#1123).
//
// The REVERSE direction matters just as much: a bound whose lane name nobody
// stamps can never go stale (findStaleLanes skips a lane that never stamped, so it
// does not alarm on an uninitialized lane), so a typo in a bound key silently
// disables that alert forever. Both directions are checked here.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-heartbeat-lane-coverage.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LANE_STALE_BOUNDS_MS,
  CANARY_STALE_BOUNDS_MS,
  MIRROR_STALE_BOUNDS_MS,
  RETENTION_STALE_BOUNDS_MS,
  TIME_OFF_STALE_BOUNDS_MS,
  UPTIME_STALE_BOUNDS_MS,
  VERDICT_STALE_BOUNDS_MS,
} from "../src/lib/monitor/health.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const SRC = join(HERE, "..", "src");

/** The bounds maps the lane-watchdog and /api/health actually consult. */
const BOUNDS: Record<string, Record<string, number>> = {
  LANE_STALE_BOUNDS_MS,
  CANARY_STALE_BOUNDS_MS,
  MIRROR_STALE_BOUNDS_MS,
  RETENTION_STALE_BOUNDS_MS,
  // #1394: not a cron lane at all, but the same invariant applies with more force.
  // These rows record when a DETECTOR last reached a measured verdict, and the
  // whole feature is the observation that a stamp nobody reads is worse than no
  // stamp, because its presence reads as coverage.
  VERDICT_STALE_BOUNDS_MS,
  // #2543: the two daily time off lanes, four stamps between them.
  TIME_OFF_STALE_BOUNDS_MS,
  // #1228: noodge's two keyed checks of Slate, stamped from the health endpoints.
  UPTIME_STALE_BOUNDS_MS,
};

// A lane that deliberately stamps with NO bound watching it. Empty on purpose: an
// exemption must be an argued decision recorded here, not a gap nobody noticed.
// (The hourly `agents` lane is the opposite case, documented in health.ts: it does
// not stamp at all, so there is nothing to watch and nothing to exempt.)
const INTENTIONALLY_UNWATCHED = new Set<string>();

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Every lane name stamped anywhere in src/, as `lane -> where`.
 *
 * Two shapes are recognised: a literal `recordHeartbeat("lane")`, and the
 * `*_HEARTBEAT_LANES = new Set([...])` allowlist the smoke route stamps from
 * (its lane comes off a query param, restricted to that set). A `recordHeartbeat(`
 * call with a NON-literal argument in a file that has no such allowlist is a hard
 * failure: the scan cannot know what it stamps, and silently ignoring it would put
 * the hole right back.
 */
/**
 * Every `export const NAME = "literal"` in src/, as `NAME -> "literal"` (#2543).
 *
 * A third readable shape, beside the inline literal and the allowlist. Two lanes
 * that must agree about a name (the route that STAMPS it and the bounds map that
 * WATCHES it) are exactly the case for a shared constant, and without this the
 * guard's only advice would be to write the string twice, which is the drift it
 * exists to catch (L41). A name that resolves to two different literals is dropped
 * rather than guessed at, because a wrong resolution would report a lane as
 * covered when it is not (L98).
 */
function exportedStringConstants(files: string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      const [, name, value] = m as unknown as [string, string, string];
      if (seen.has(name) && seen.get(name) !== value) ambiguous.add(name);
      else seen.set(name, value);
    }
  }
  for (const name of ambiguous) seen.delete(name);
  return seen;
}

function stampedLanes(): { lanes: Map<string, string>; opaque: string[] } {
  const lanes = new Map<string, string>();
  const opaque: string[] = [];
  const constants = exportedStringConstants(tsFiles(SRC));

  for (const file of tsFiles(SRC)) {
    // The helper's own definition, not a stamp site.
    if (file.endsWith(join("lib", "monitor", "heartbeat.ts"))) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("recordHeartbeat(")) continue;
    const where = file.slice(SRC.length - 3); // "src/..."

    const allowlist = /_HEARTBEAT_LANES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
    const allowlisted = allowlist
      ? [...allowlist[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1])
      : [];
    for (const lane of allowlisted) lanes.set(lane, where);

    for (const m of src.matchAll(/recordHeartbeat\(\s*([^)]*?)\s*\)/g)) {
      const arg = m[1];
      const literal = /^["'`]([^"'`]+)["'`]$/.exec(arg);
      if (literal) {
        lanes.set(literal[1], where);
      } else if (constants.has(arg)) {
        lanes.set(constants.get(arg)!, where);
      } else if (allowlisted.length === 0) {
        opaque.push(`${where}: recordHeartbeat(${arg})`);
      }
    }
  }
  return { lanes, opaque };
}

const { lanes: stamped, opaque } = stampedLanes();

// --- the scan itself must not be vacuous --------------------------------------
// A regex regression here would find zero stamps and every assertion below would
// pass by default, which is the exact false-confidence shape this file exists to
// prevent. So require the known-good stamps to still be found.
assert(
  stamped.size >= 17,
  `scan still finds the heartbeat stamp sites (expected at least 17, got ${stamped.size}: ` +
    `${[...stamped.keys()].sort().join(", ")}). A LOW count means the scan regressed, not that ` +
    `the stamps went away`,
);
for (const known of ["sync", "monitor", "snowflake-export", "smoke-canary-full", "verdict:availability-truth"]) {
  assert(stamped.has(known), `scan finds the ${known} stamp`);
}
// The constant-resolved shape needs its own control (#2543): these four are stamped
// through a shared constant rather than an inline literal, so a regression in that
// resolution would drop them from the scan, and a stamp the scan cannot see is one
// nothing holds to having a bound.
for (const viaConstant of [
  "ooo-approvals",
  "ooo-approvals-report",
  "ooo-digest",
  "ooo-digest-nudge",
]) {
  assert(
    stamped.has(viaConstant),
    `scan resolves the ${viaConstant} stamp through its shared constant, rather than only seeing inline literals`,
  );
}
assert(
  opaque.length === 0,
  `every recordHeartbeat call names its lane literally or via a *_HEARTBEAT_LANES allowlist ` +
    `(unreadable: ${opaque.join("; ")})`,
);

// --- forward direction: every stamped lane is watched --------------------------
for (const [lane, where] of [...stamped].sort()) {
  if (INTENTIONALLY_UNWATCHED.has(lane)) continue;
  const watchers = Object.entries(BOUNDS)
    .filter(([, bounds]) => lane in bounds)
    .map(([name]) => name);
  if (watchers.length === 1) {
    assert(true, `lane "${lane}" is watched by ${watchers[0]}`);
  } else if (watchers.length === 0) {
    assert(
      false,
      `lane "${lane}" (stamped in ${where}) is watched by NO staleness bound, so its heartbeat ` +
        `is written and never read: if the lane dies, nothing pages. Add it to ` +
        `LANE_STALE_BOUNDS_MS (a Worker cron lane, also flips /api/health), or to ` +
        `MIRROR_STALE_BOUNDS_MS / CANARY_STALE_BOUNDS_MS (Slack-only)`,
    );
  } else {
    assert(
      false,
      `lane "${lane}" is watched by ${watchers.length} bounds maps (${watchers.join(", ")}); ` +
        `it must be exactly one, or one death pages twice`,
    );
  }
}

// --- reverse direction: every bound watches a lane that really stamps ---------
for (const [mapName, bounds] of Object.entries(BOUNDS)) {
  for (const lane of Object.keys(bounds)) {
    if (stamped.has(lane)) {
      assert(true, `${mapName}'s "${lane}" bound watches a lane that really stamps`);
    } else {
      assert(
        false,
        `${mapName} watches "${lane}", but nothing in src/ stamps that lane. A lane that never ` +
          `stamps is skipped by findStaleLanes (so it never alarms), which means this bound is ` +
          `dead: check the spelling against the recordHeartbeat call`,
      );
    }
  }
}

// --- the scheduled workflows really stamp the lanes they are bounded for (#2263) --
//
// The scan above proves a stamp exists SOMEWHERE in src/ for every bound. These
// five lanes are stamped by a GitHub workflow with a curl, which is outside src/
// entirely, so the scanner sees only the route allowlist that permits the lane and
// never the caller that uses it. A bound whose workflow never calls it can never go
// stale, which silently disables that alert forever (L96: a guard that checks only
// what its registry lists exempts whatever is missing from it).
//
// `smoke-canary` is stamped by the route's DEFAULT, with no `?lane=` at all, and
// that coupling is worth pinning too: changing the route default would silently
// re-aim that workflow's stamp at another lane.
{
  const WORKFLOW_STAMPED: { lane: string; file: string; call: RegExp }[] = [
    { lane: "smoke-canary", file: "smoke-canary.yml", call: /\/api\/smoke\/heartbeat(?!\?)/ },
    { lane: "smoke-canary-full", file: "smoke-canary.yml", call: /lane=smoke-canary-full(?![\w-])/ },
    { lane: "schedule-parity", file: "schedule-parity.yml", call: /lane=schedule-parity(?![\w-])/ },
    { lane: "router-replay", file: "router-replay.yml", call: /lane=router-replay(?![\w-])/ },
    // The two DETECTOR VERDICT lanes stamped from outside the Worker (#2392, #2493),
    // so they are watched by VERDICT_STALE_BOUNDS_MS rather than by the canary map
    // their four neighbours here use, and the assertion below picks the map per row
    // instead of assuming one.
    {
      lane: "verdict:burst-counter",
      file: "burst-counter.yml",
      call: /lane=verdict:burst-counter(?![\w:-])/,
    },
    {
      lane: "verdict:kill-switch",
      file: "kill-switch.yml",
      call: /lane=verdict:kill-switch(?![\w:-])/,
    },
  ];
  // Anchored on a word boundary, never a bare substring. `includes("lane=router-replay")`
  // is satisfied by `lane=router-replay-typo`, and the first version of this guard
  // passed on exactly that planted typo (L1: a guard is only real once it has been
  // seen to fail).
  for (const { lane, file, call } of WORKFLOW_STAMPED) {
    assert(
      CANARY_STALE_BOUNDS_MS[lane] !== undefined || VERDICT_STALE_BOUNDS_MS[lane] !== undefined,
      `${lane} is watched by a staleness bound`,
    );
    const yml = readFileSync(join(HERE, "..", ".github", "workflows", file), "utf8");
    assert(
      call.test(yml),
      `${file} really stamps the ${lane} heartbeat, rather than the bound watching a lane ` +
        "nothing calls",
    );
  }
  // And the reverse: a bound nobody in this list stamps is a bound that can never
  // go stale, so a lane added to the map and never wired is caught here rather than
  // by somebody noticing the alert never fires.
  for (const lane of Object.keys(CANARY_STALE_BOUNDS_MS)) {
    assert(
      WORKFLOW_STAMPED.some((w) => w.lane === lane),
      `${lane} is bounded and no workflow in this list stamps it`,
    );
  }
}

finish();

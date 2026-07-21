// TDD test for the pure classifyLaneHealth helper (#288): the admin lane-health
// strip's per-lane ok/stale/never state, judged against each lane's OWN cadence
// bound (the same bounds the dead-man's switch uses), so the in-app view and the
// pager can never disagree.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-lane-health.ts
import {
  classifyLaneHealth,
  LANE_STALE_BOUNDS_MS,
} from "../src/lib/monitor/health.ts";
import { loadLaneHealth } from "../src/lib/monitor/lane-health-view.ts";
import { assert, finish } from "./lib/harness.ts";

const MIN = 60_000;
const NOW = 1_000 * MIN; // arbitrary fixed now

async function main() {
  // Covers every configured lane, in the fixed bounds order (operator learns positions).
  {
    const rows = classifyLaneHealth({}, NOW);
    assert(
      rows.map((r) => r.lane).join(",") === Object.keys(LANE_STALE_BOUNDS_MS).join(","),
      "one row per configured lane, in canonical bounds order",
    );
  }

  // never: a lane with no heartbeat row (or explicit null) is benign, not stale.
  {
    const rows = classifyLaneHealth({ sync: null }, NOW);
    const sync = rows.find((r) => r.lane === "sync")!;
    assert(sync.state === "never" && sync.ageMs === null, "null heartbeat -> never (uninitialized, not a death)");
    const missing = rows.find((r) => r.lane === "recompute")!;
    assert(missing.state === "never", "a lane absent from the map -> never");
  }

  // ok: stamped within its own bound.
  {
    const rows = classifyLaneHealth({ sync: NOW - 3 * MIN }, NOW);
    const sync = rows.find((r) => r.lane === "sync")!;
    assert(sync.state === "ok" && sync.ageMs === 3 * MIN, `fresh sync -> ok (got ${sync.state}, age ${sync.ageMs})`);
  }

  // stale: overdue past its own bound.
  {
    const rows = classifyLaneHealth({ sync: NOW - 12 * MIN }, NOW);
    const sync = rows.find((r) => r.lane === "sync")!;
    assert(sync.state === "stale", `sync quiet 12m (bound 10m) -> stale (got ${sync.state})`);
  }

  // PER-LANE bounds: the same 12-min silence is stale for a 1-min lane (bound 10m)
  // but OK for a 5-min lane (bound 20m). This is the whole point of per-lane bounds.
  {
    const rows = classifyLaneHealth({ sync: NOW - 12 * MIN, monitor: NOW - 12 * MIN }, NOW);
    assert(rows.find((r) => r.lane === "sync")!.state === "stale", "1-min lane at 12m is stale");
    assert(rows.find((r) => r.lane === "monitor")!.state === "ok", "5-min lane at 12m is still ok");
  }

  // Boundary: strict > (exactly at the bound is still ok).
  {
    const rows = classifyLaneHealth({ sync: NOW - LANE_STALE_BOUNDS_MS.sync }, NOW);
    assert(rows.find((r) => r.lane === "sync")!.state === "ok", "exactly at the bound is ok (strict >)");
  }

  // loadLaneHealth: a successful read classifies and is available.
  {
    const view = await loadLaneHealth(async () => ({ sync: NOW - 2 * MIN }), NOW);
    assert(!view.unavailable, "loadLaneHealth: available when the read succeeds");
    assert(view.rows.find((r) => r.lane === "sync")!.state === "ok", "loadLaneHealth: classifies the read");
  }

  // loadLaneHealth FAILURE PATH: a throwing read flips to unavailable with NO rows,
  // so the admin strip says "unavailable" instead of rendering a falsely all-fine
  // (empty) strip. This is the false-confidence guard the dead-man's switch needs.
  {
    const view = await loadLaneHealth(async () => {
      throw new Error("heartbeat bulk read failed");
    }, NOW);
    assert(view.unavailable, "loadLaneHealth: unavailable when the read throws");
    assert(view.rows.length === 0, "loadLaneHealth: no rows on a read failure (never a false all-fine strip)");
  }

  finish();
}

main();

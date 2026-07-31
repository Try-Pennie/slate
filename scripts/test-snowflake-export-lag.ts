// Node test for the export-lag deletion gate (#1139). Drives the PURE evaluator
// from export-lag.ts with hand-written table readings: no module mocking, no DB,
// no Snowflake.
//
// Why this replaced the row-count reconciliation as the gate: counting Supabase
// against Snowflake only ever flagged "Snowflake is behind", which goes
// structurally negative the moment retention deletes or redacts anything in
// Supabase. The gate degraded to a rubber stamp exactly when deletion began. A
// lag reading is computed entirely in Supabase and is immune to both.
//
// The load-bearing cases here are the FAIL-SAFE ones, not the happy path: a
// cursor that has never moved, and a timestamp that cannot be read, must both
// land on "not ready" (do not delete), never on "ready".
import { assert, eq, finish } from "./lib/harness.ts";
import {
  MAX_EXPORT_LAG_MS,
  evaluateExportLag,
  type TableLag,
} from "../src/lib/snowflake/export-lag-core.ts";

const lag = (over: Partial<TableLag> = {}): TableLag => ({
  table: "bookings",
  cursorTs: "2026-07-31T12:00:00Z",
  newestTs: "2026-07-31T12:05:00Z",
  lagMs: 5 * 60_000,
  backlog: 3,
  ...over,
});

function main() {
  // 1. Healthy: every table is within the lag bound, so deletion may proceed.
  {
    const g = evaluateExportLag([lag(), lag({ table: "routing_decisions", lagMs: 0, backlog: 0 })]);
    eq(g.ready, true, "a mirror within the lag bound is ready for deletion");
    eq(g.reasons.length, 0, "a healthy mirror gives no reasons");
  }

  // 2. A lagging table blocks the gate and NAMES itself, so the alert says which.
  {
    const g = evaluateExportLag([
      lag(),
      lag({ table: "routing_decisions", lagMs: MAX_EXPORT_LAG_MS + 60_000, backlog: 900 }),
    ]);
    eq(g.ready, false, "a table past the lag bound is not ready");
    assert(g.reasons.some((r) => r.includes("routing_decisions")), "the reason names the lagging table");
    assert(g.reasons.some((r) => r.includes("900")), "the reason reports the unexported backlog");
    assert(!g.reasons.some((r) => r.includes("bookings")), "a healthy table is not reported as a fault");
  }

  // 3. Exactly AT the bound is still ready; one ms past it is not. Pins the
  //    boundary so a later refactor cannot silently move it.
  {
    eq(evaluateExportLag([lag({ lagMs: MAX_EXPORT_LAG_MS })]).ready, true, "lag exactly at the bound is ready");
    eq(evaluateExportLag([lag({ lagMs: MAX_EXPORT_LAG_MS + 1 })]).ready, false, "one ms past the bound is not ready");
  }

  // 4. FAIL-SAFE: rows exist but the cursor has never moved. Nothing is in the
  //    warehouse at all, so deleting would destroy the only copy.
  {
    const g = evaluateExportLag([lag({ cursorTs: null, lagMs: Number.POSITIVE_INFINITY, backlog: 12 })]);
    eq(g.ready, false, "a table with rows and no export cursor is not ready");
    assert(g.reasons.some((r) => /never exported|nothing exported/i.test(r)), "the reason says nothing was exported");
  }

  // 5. An EMPTY table (no cursor, no rows) is not a fault. Nothing to export
  //    means nothing can be behind, and this must not freeze the other lanes.
  {
    const g = evaluateExportLag([lag({ cursorTs: null, newestTs: null, lagMs: 0, backlog: 0 })]);
    eq(g.ready, true, "an empty table with no cursor is ready (nothing can be behind)");
  }

  // 6. FAIL-SAFE: an unreadable lag reading lands on not-ready. NaN compares
  //    false against every threshold, so a naive `lagMs > BOUND` would read as
  //    healthy and delete (the #1169/#1171 class).
  {
    const g = evaluateExportLag([lag({ lagMs: Number.NaN })]);
    eq(g.ready, false, "an unreadable lag reading is not ready, never silently healthy");
    assert(g.reasons.some((r) => /could not|unreadable/i.test(r)), "the reason says the reading was unreadable");
  }

  // 7. No tables measured at all is not a licence to delete. An empty reading
  //    means the measurement did not happen, which is not the same as healthy.
  {
    const g = evaluateExportLag([]);
    eq(g.ready, false, "an empty measurement is not ready (absence is not proof of health)");
  }
}

main();
finish();

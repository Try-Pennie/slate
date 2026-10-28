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
  exportLagAgeMs,
  type TableLag,
} from "../src/lib/snowflake/export-lag-core.ts";

const lag = (over: Partial<TableLag> = {}): TableLag => ({
  table: "bookings",
  cursorTs: "2026-07-31T12:00:00Z",
  newestTs: "2026-07-31T12:05:00Z",
  oldestPendingTs: "2026-07-31T12:05:00Z",
  lagMs: 5 * 60_000,
  backlog: 3,
  ...over,
});

// The night of 2026-09-02 (#1713), as measured against production. The gate read
// at the retention lanes' scheduled instant, and the only row waiting had been
// written by a time off request seven minutes earlier. L614: the predicate is
// evaluated at the consumer's instant against a row stamped at the producer's.
const NIGHT = {
  cursorTs: "2026-09-02T00:11:36Z",
  newestTs: "2026-09-02T02:53:14Z",
  oldestPendingTs: "2026-09-02T02:53:14Z",
  nowMs: Date.parse("2026-09-02T03:00:04Z"),
};

function main() {
  // 0. THE METRIC (#1713). Lag is the AGE of the oldest row still waiting for
  //    export, measured against the clock, never the gap between the two newest
  //    rows: on a sparse table that gap is the table's arrival rhythm and is
  //    unbounded above however healthy the lane is (L537).
  {
    const age = exportLagAgeMs(NIGHT);
    eq(age, 6 * 60_000 + 50_000, "the one waiting row is 6 minutes 50 seconds old, not 2 hours 41 minutes");
    const g = evaluateExportLag([lag({ table: "audit_log", ...NIGHT, lagMs: age, backlog: 1 })]);
    eq(g.ready, true, "so the retention lanes run that night instead of refusing");

    // The same shape with a lane that really has stalled: the waiting row is three
    // hours old, past the two hour bound the 30 minute cadence set (#4349). Both
    // directions, or the guard proves nothing (L1).
    const stalled = exportLagAgeMs({ ...NIGHT, oldestPendingTs: "2026-09-02T00:00:04Z" });
    eq(stalled, 3 * 60 * 60_000, "a row waiting three hours reads as three hours");
    eq(
      evaluateExportLag([lag({ table: "audit_log", ...NIGHT, oldestPendingTs: "2026-09-02T00:00:04Z", lagMs: stalled })]).ready,
      false,
      "and a lane that has genuinely stalled still refuses",
    );

    eq(exportLagAgeMs({ ...NIGHT, oldestPendingTs: null }), 0, "nothing waiting past the cursor is zero lag");
    eq(exportLagAgeMs({ ...NIGHT, newestTs: null, oldestPendingTs: null }), 0, "an empty table is zero lag");
    eq(
      exportLagAgeMs({ ...NIGHT, cursorTs: null }),
      Number.POSITIVE_INFINITY,
      "rows with no cursor at all are infinitely behind (nothing is in the warehouse)",
    );
    assert(
      Number.isNaN(exportLagAgeMs({ ...NIGHT, oldestPendingTs: "not a date" })),
      "an unreadable waiting stamp is NaN, which the evaluator refuses, never a healthy zero",
    );
    assert(
      Number.isNaN(exportLagAgeMs({ ...NIGHT, nowMs: Number.NaN })),
      "an unreadable clock is NaN too, never a healthy zero",
    );
    eq(
      exportLagAgeMs({ ...NIGHT, oldestPendingTs: "2026-09-02T03:10:00Z" }),
      0,
      "a waiting row stamped after the clock (skew) floors at zero rather than going negative",
    );
  }

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
    assert(
      g.reasons.some((r) => /oldest row waiting for export is .* old/.test(r)),
      "the reason says what is measured: the age of the oldest waiting row (#1713)",
    );
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

// Node test for the Snowflake export loop (#1099). Drives the pure exportTable
// from export-core with hand-written fakes: no module mocking, no DB, no
// Snowflake. The load-bearing case is the failure path: a non-terminal MERGE
// must NOT advance the watermark, so the batch re-exports next tick.
import { assert, eq, finish } from "./lib/harness.ts";
import {
  MIRROR_TABLES,
  exportTable,
  type CursorPos,
  type ExportDeps,
  type Row,
  type TableSpec,
} from "../src/lib/snowflake/export-core.ts";

const spec: TableSpec = MIRROR_TABLES.find((t) => t.table === "bookings")!;

function makeDeps(pages: Row[][], opts: { failMergeOn?: number; now?: () => number } = {}) {
  let call = 0;
  const merged: Row[][] = [];
  const saves: { key: string; ts: string; id: string }[] = [];
  let cursor: CursorPos | null = null;
  const deps: ExportDeps = {
    async loadCursor() {
      return cursor;
    },
    async fetchBatch() {
      return pages[call++] ?? [];
    },
    async mergeBatch(_spec, rows) {
      if (opts.failMergeOn != null && merged.length === opts.failMergeOn) {
        throw new Error("non-terminal Snowflake response");
      }
      merged.push(rows);
    },
    async saveCursor(key, ts, id) {
      saves.push({ key, ts, id });
      cursor = { last_ts: ts, last_id: id };
    },
    now: opts.now ?? (() => 0),
  };
  return { deps, merged, saves };
}

const row = (id: string, updated_at: string): Row => ({ id, updated_at });

async function main() {
  // 1. Happy path: a short page merges once and advances the cursor to its last row.
  {
    const { deps, merged, saves } = makeDeps([[row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-02T00:00:00Z")]]);
    const res = await exportTable(spec, deps, { limit: 500, deadline: Infinity });
    eq(res.exported, 2, "happy: exported both rows");
    eq(res.batches, 1, "happy: one batch");
    eq(merged.length, 1, "happy: merged once");
    eq(saves.length, 1, "happy: saved cursor once");
    eq(saves[0].id, "b", "happy: cursor advanced to the last row id");
    eq(saves[0].ts, "2026-01-02T00:00:00Z", "happy: cursor advanced to the last row watermark");
  }

  // 2. Keyset across a full page then a short page: loops, stops on the short page.
  {
    const full = Array.from({ length: 500 }, (_, i) => row(`r${i}`, "2026-01-01T00:00:00Z"));
    const { deps, merged } = makeDeps([full, [row("last", "2026-01-03T00:00:00Z")]]);
    const res = await exportTable(spec, deps, { limit: 500, deadline: Infinity });
    eq(res.batches, 2, "keyset: two batches");
    eq(res.exported, 501, "keyset: all rows across both pages");
    eq(merged.length, 2, "keyset: merged each page");
  }

  // 3. FAILURE PATH: a non-terminal merge must NOT advance the cursor.
  {
    const { deps, merged, saves } = makeDeps([[row("a", "2026-01-01T00:00:00Z")]], { failMergeOn: 0 });
    let threw = false;
    try {
      await exportTable(spec, deps, { limit: 500, deadline: Infinity });
    } catch {
      threw = true;
    }
    assert(threw, "failure: exportTable propagates the merge error");
    eq(merged.length, 0, "failure: nothing recorded as merged");
    eq(saves.length, 0, "failure: cursor NOT advanced on a failed merge");
  }

  // 4. Deadline already passed: no fetch, no merge, flagged.
  {
    const { deps, merged } = makeDeps([[row("a", "2026-01-01T00:00:00Z")]], { now: () => 1000 });
    const res = await exportTable(spec, deps, { limit: 500, deadline: 500 });
    assert(res.hitDeadline, "deadline: flagged when now is past the deadline");
    eq(res.exported, 0, "deadline: exported nothing");
    eq(merged.length, 0, "deadline: no merge attempted");
  }

  // 5. #3120: the lane lock was lost mid run. Another run now owns the export, and
  // the MERGE overwrites unconditionally by id, so a batch from this older run could
  // put a stale row version back over the newer run's. The fence is asked BEFORE
  // each merge, and a lost lease stops the table with nothing merged or saved.
  {
    const full = Array.from({ length: 2 }, (_, i) => row(`r${i}`, `2026-01-0${i + 1}T00:00:00Z`));
    const { deps, merged, saves } = makeDeps([full, full, full]);
    let asks = 0;
    const res = await exportTable(spec, deps, {
      limit: 2,
      deadline: Infinity,
      stillHeld: async () => ++asks < 2,
    });
    eq(merged.length, 1, "lease lost: the batch after the loss is not merged");
    eq(saves.length, 1, "lease lost: and its cursor is not saved");
    assert(res.leaseLost === true, "lease lost: reported, so the run stops the remaining tables");
    eq(asks, 2, "lease lost: asked once per batch, before its merge");
  }

  // CONTROL: a lease that stays held changes nothing.
  {
    const { deps, merged } = makeDeps([[row("a", "2026-01-01T00:00:00Z")]]);
    const res = await exportTable(spec, deps, { limit: 500, deadline: Infinity, stillHeld: async () => true });
    eq(merged.length, 1, "lease held: the batch merges");
    assert(!res.leaseLost, "lease held: nothing reported lost");
  }

  // --- #3261: a rerouted booking's bucket history reaches the warehouse ---------------
  // Migration 0166 records which bucket a reroute moved a booking from and to; without
  // these two columns the warehouse knows a booking's bucket today but never that a
  // correction moved it. That the warehouse table HAS them is held separately, by
  // scripts/test-snowflake-mirror-columns.ts, which checks every exported column
  // against docs/snowflake-setup.sql and its ALTER.
  {
    const events = MIRROR_TABLES.find((t) => t.table === "booking_events");
    const col = (name: string) => events?.cols.find((c) => c.name === name);
    eq(col("from_bucket_id")?.type, "varchar", "booking_events exports the bucket a reroute moved from");
    eq(col("to_bucket_id")?.type, "varchar", "and the bucket it moved to");
  }

  finish();
}

await main();

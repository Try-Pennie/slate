// The transfer queue's daily tallies are kept for good (#4380).
//
// `transfer_queue_days` holds one row per business day (counts and instants, no lead
// data). The first draft of migration 0214 had its writer delete rows older than 30
// days; Dan chose on 2026-10-29 to keep them all, since a row a business day is small
// and lets staffing be looked at over time. Automatic deletion is his decision (L9), so
// this pins it: the writer deletes nothing, and no migration prunes the table.
//
// Run: node --experimental-strip-types scripts/test-transfer-queue-retention.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const pruning = /delete\s+from\s+(public\.)?transfer_queue_days/i;

// Positive control: the statement the first draft carried is what the pattern catches.
assert(pruning.test("  delete from transfer_queue_days where day < p_day - 30;"), "the pattern catches the 30 day prune");

const offenders = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => pruning.test(readFileSync(join(dir, f), "utf8")));
assert(
  offenders.length === 0,
  `transfer_queue_days is kept for good (Dan, 2026-10-29), so nothing deletes from it: ${offenders.join(", ")}`,
);

finish();

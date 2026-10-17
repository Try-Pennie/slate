// Which bookings indexes can serve an equality lookup on one column, judged from
// migration SQL text alone, so a planted bad index can be fed to it without touching
// the repo. One copy for the tripwires that pair a bookings read with the index it
// needs: scripts/test-event-holder-index.ts (#3218, gcal_event_id) and
// scripts/test-idempotency-key-index.ts (#3863, idempotency_key).
//
// What it can see: an index on bookings LED by the column, never dropped later in the
// sequence, and not partial on status. Every read these guard asks a status list it
// passes at runtime, or none at all, and the planner can use an index partial on
// status only when it can prove the query implies the predicate, so such an index
// would sit there unused while reading as coverage. What it cannot see: whether the
// planner actually picks the index, which only a real database answers
// (scripts/verify-idempotency-key-index-sql.ts reads the plan for its lookup).
//
// Imports nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lower cased, comment stripped migration SQL for the given files, in the order given. */
export function migrationSql(dir: string, files: readonly string[]): string {
  return files
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();
}

/** Names of the bookings indexes led by `column` that can serve `where column = $1`. */
export function bookingsIndexesLedBy(sql: string, column: string): string[] {
  const found: string[] = [];
  const re =
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?bookings\s*(?:using\s+btree\s*)?\(([^)]*)\)([^;]*);/g;
  for (const m of sql.matchAll(re)) {
    const [, name, cols, rest] = m;
    const lead = cols.split(",")[0].trim();
    if (lead !== column) continue;
    // A status predicate cannot be proved by a runtime IN list (or by no status at
    // all); anything else in the WHERE must be implied by the equality itself.
    const where = rest.match(/\bwhere\b([\s\S]*)$/)?.[1] ?? "";
    if (/\bstatus\b/.test(where)) continue;
    const dropped = new RegExp(`drop\\s+index\\s+(?:concurrently\\s+)?(?:if\\s+exists\\s+)?(?:public\\.)?${name}\\b`);
    if (dropped.test(sql.slice((m.index ?? 0) + m[0].length))) continue;
    found.push(name);
  }
  return found;
}

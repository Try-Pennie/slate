// Tripwire (#3218): the event holder check #3216 added (liveBookingHoldingEvent in
// src/lib/booking/service.ts) asks "does a live booking hold this gcal_event_id"
// once per queued event deletion and once per failed live delete. Without an
// index led by bookings.gcal_event_id every one of those asks scans the whole
// bookings table, which grows with booking volume, and nothing would ever say so.
//
// Two halves, each blind where the other looks:
//   1. the QUERY still has the shape the index was written for (equality on
//      gcal_event_id against bookings), so a rewrite of the read re-opens this;
//   2. the MIGRATIONS still carry a bookings index that can serve it: led by
//      gcal_event_id, never dropped afterwards, and not partial on status. The
//      statuses are a runtime argument (confirmed, rescheduled AND completed), so
//      an index partial on a status list the planner cannot prove the argument
//      implies would sit there unused while reading as coverage.
// Run: node --experimental-strip-types scripts/test-event-holder-index.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const migrationsDir = join(root, "supabase", "migrations");

/** Lower-cased, comment-stripped migration SQL in file order. */
function migrationSql(files: string[]): string {
  return files
    .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
    .join("\n")
    .replace(/--[^\n]*/g, "")
    .toLowerCase();
}

/**
 * Names of the bookings indexes that can serve `where gcal_event_id = $1 and
 * status in (...)`. It judges SQL text
 * only, so a planted bad index can be fed to it without touching the repo.
 */
function holderIndexes(sql: string): string[] {
  const found: string[] = [];
  const re =
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?bookings\s*(?:using\s+btree\s*)?\(([^)]*)\)([^;]*);/g;
  for (const m of sql.matchAll(re)) {
    const [, name, cols, rest] = m;
    const lead = cols.split(",")[0].trim();
    if (lead !== "gcal_event_id") continue;
    // A status predicate cannot be proved by a runtime IN list; anything else in
    // the WHERE must be implied by the equality itself (is not null is).
    const where = rest.match(/\bwhere\b([\s\S]*)$/)?.[1] ?? "";
    if (/\bstatus\b/.test(where)) continue;
    const dropped = new RegExp(`drop\\s+index\\s+(?:concurrently\\s+)?(?:if\\s+exists\\s+)?(?:public\\.)?${name}\\b`);
    if (dropped.test(sql.slice((m.index ?? 0) + m[0].length))) continue;
    found.push(name);
  }
  return found;
}

// Half 1: the query keeps the shape the index serves.
{
  const service = readFileSync(join(root, "src", "lib", "booking", "service.ts"), "utf8");
  const start = service.indexOf("liveBookingHoldingEvent:");
  assert(start >= 0, "service.ts still wires liveBookingHoldingEvent");
  // The body ends at the next wired dep. A missing end marker would slice to the
  // end of the file and let unrelated code answer, so it is refused by name.
  const end = start >= 0 ? service.indexOf("\n    reservationPinsEvent", start) : -1;
  assert(end > start, "service.ts: the holder check's body ends at reservationPinsEvent (update this marker if the deps moved)");
  const body = end > start ? service.slice(start, end) : "";
  assert(/\.from\("bookings"\)/.test(body), "the holder check reads bookings");
  assert(/\.eq\("gcal_event_id",/.test(body), "the holder check filters on gcal_event_id equality");
}

// Half 2: the real migrations carry a usable index.
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const real = holderIndexes(migrationSql(files));
assert(real.length > 0, `a bookings index led by gcal_event_id serves the holder check (found: ${real.join(", ") || "none"})`);

// Positive controls (L1): each way the coverage can be lost must be caught.
{
  // The real tree with migration 0164 removed BY NAME, and the real tree with a
  // later migration dropping its index: both must be refused.
  const index0164 = "0164_bookings_gcal_event_id_idx.sql";
  assert(files.includes(index0164), `control: ${index0164} is on disk to remove`);
  const without = files.filter((f) => f !== index0164);
  assert(holderIndexes(migrationSql(without)).length === 0, "control: the real tree without 0164 is caught");
  assert(
    holderIndexes(migrationSql(files) + "\ndrop index if exists bookings_gcal_event_id_idx;").length === 0,
    "control: the real tree plus a later drop of the index is caught",
  );

  const plant = (s: string) => holderIndexes(s.toLowerCase()).length;
  assert(plant("create index x on bookings (gcal_event_id) where gcal_event_id is not null;") === 1, "control: a partial not null index counts");
  assert(plant("create index x on bookings (status, gcal_event_id);") === 0, "control: gcal_event_id as a SECOND column is caught");
  assert(
    plant("create index x on bookings (gcal_event_id) where status in ('confirmed', 'rescheduled');") === 0,
    "control: an index partial on status is caught",
  );
  assert(
    plant("create index x on bookings (gcal_event_id);\ndrop index if exists x;") === 0,
    "control: an index dropped by a later migration is caught",
  );
  assert(plant("create index x on busy_blocks (gcal_event_id);") === 0, "control: an index on another table is caught");
}

finish();

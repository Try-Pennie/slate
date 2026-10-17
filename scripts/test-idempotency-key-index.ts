// Tripwire (#3863): the reservation resume's lookup by key in ANY status
// (findLatestBookingByIdempotencyKey in src/lib/booking/service.ts, #3847) and the
// index that serves it (migration 0185) stay paired.
//
// The only index on bookings.idempotency_key used to be 0010's partial unique index
// over ACTIVE bookings, which a read with no status predicate cannot use, so the
// lookup scanned the whole table and nothing said so. Two halves, each blind where the
// other looks:
//   1. the QUERY still has the shape the index was written for (equality on
//      idempotency_key against bookings), so a rewrite of the read re-opens this;
//   2. the MIGRATIONS still carry a bookings index that can serve it: led by
//      idempotency_key, never dropped afterwards, and not partial on status.
// Whether the planner really picks it is read from a real plan, which no text scan can
// answer, by scripts/verify-idempotency-key-index-sql.ts in the DB replay workflow.
//
// Run: node --experimental-strip-types scripts/test-idempotency-key-index.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";
import { bookingsIndexesLedBy, migrationSql } from "./lib/scan-bookings-lookup-index.ts";

const root = join(import.meta.dirname, "..");
const migrationsDir = join(root, "supabase", "migrations");
const keyIndexes = (sql: string): string[] => bookingsIndexesLedBy(sql, "idempotency_key");

// Half 1: the query keeps the shape the index serves.
{
  const service = readFileSync(join(root, "src", "lib", "booking", "service.ts"), "utf8");
  const start = service.indexOf("findLatestBookingByIdempotencyKey:");
  assert(start >= 0, "service.ts still wires findLatestBookingByIdempotencyKey");
  // The body ends where the property closes. A missing end would slice to the end of
  // the file and let unrelated code answer, so it is refused by name.
  const end = start >= 0 ? service.indexOf("\n    },", start) : -1;
  assert(end > start, "service.ts: the lookup's body closes at its own `},` (update this marker if the deps moved)");
  const body = end > start ? service.slice(start, end) : "";
  assert(/\.from\("bookings"\)/.test(body), "the lookup reads bookings");
  assert(/\.eq\("idempotency_key",/.test(body), "the lookup filters on idempotency_key equality");
  assert(!/\.(?:in|eq)\("status",/.test(body), "the lookup asks every status, which is why the partial ACTIVE index cannot serve it");
}

// Half 2: the real migrations carry a usable index.
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const real = keyIndexes(migrationSql(migrationsDir, files));
assert(real.length > 0, `a bookings index led by idempotency_key, not partial on status, serves the lookup (found: ${real.join(", ") || "none"})`);

// Positive controls (L1): each way the coverage can be lost must be caught.
{
  const index0185 = "0185_bookings_idempotency_key_idx.sql";
  assert(files.includes(index0185), `control: ${index0185} is on disk to remove`);
  // Without 0185 the tree still holds 0010's partial ACTIVE index on the column, which
  // is exactly the index that cannot serve this read, so this is the trap itself.
  const without = files.filter((f) => f !== index0185);
  assert(keyIndexes(migrationSql(migrationsDir, without)).length === 0, "control: the real tree without 0185 is caught, 0010's partial index notwithstanding");
  assert(
    keyIndexes(migrationSql(migrationsDir, files) + "\ndrop index if exists bookings_idempotency_key_idx;").length === 0,
    "control: the real tree plus a later drop of the index is caught",
  );

  const plant = (s: string) => keyIndexes(s.toLowerCase()).length;
  assert(plant("create index x on bookings (idempotency_key);") === 1, "control: a plain index counts");
  assert(
    plant("create unique index if not exists x on bookings (idempotency_key) where idempotency_key is not null and status in ('confirmed', 'rescheduled');") === 0,
    "control: an index partial on status (0010's shape) is caught",
  );
  assert(plant("create index x on bookings (created_at, idempotency_key);") === 0, "control: idempotency_key as a SECOND column is caught");
  assert(plant("create index x on booking_reservations (idempotency_key);") === 0, "control: an index on another table is caught");
}

finish();

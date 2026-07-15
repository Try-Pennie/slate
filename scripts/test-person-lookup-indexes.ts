// Tripwire: every column the direct-API person-lookup queries
// (findActiveBookingsForPerson, #357) must have a supporting index in the
// migrations, so the lookup never silently regresses to a full table scan as the
// bookings table grows (#365). If someone adds a new match column to the lookup,
// or an index gets dropped, this fails and points at the gap.
// Run: node --experimental-strip-types scripts/test-person-lookup-indexes.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const migrationsDir = join(import.meta.dirname, "..", "supabase", "migrations");
const sql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n")
  .toLowerCase();

// Every `create index ... on bookings ...` body, so we can check a column is
// actually part of a bookings index (not just mentioned elsewhere in the file).
const bookingsIndexBodies = [
  ...sql.matchAll(/create index[^;]*?\bon bookings\b[^;]*;/g),
].map((m) => m[0]);

function indexedColumn(col: string): boolean {
  return bookingsIndexBodies.some((body) => body.includes(col));
}

// The four columns findActiveBookingsForPerson filters on.
for (const col of ["external_id", "salesforce_id", "attendee_phone", "attendee_email"]) {
  assert(indexedColumn(col), `person-lookup column "${col}" is covered by a bookings index`);
}

// attendee_email is matched case-insensitively (ilike), which a plain btree
// can't serve — it needs a trigram (gin/gist) index to be used.
{
  const emailIdx = bookingsIndexBodies.find((b) => b.includes("attendee_email"));
  assert(
    !!emailIdx && (emailIdx.includes("gin_trgm_ops") || emailIdx.includes("gist_trgm_ops")),
    "attendee_email index is a trigram index (supports the case-insensitive ilike lookup)",
  );
}

finish();

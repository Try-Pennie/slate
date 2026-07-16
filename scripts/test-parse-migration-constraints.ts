// Unit tests for the shared migration-constraint parser (scripts/lib/
// parse-migration-constraints.ts), extracted so both the upsert-onConflict guard
// (#770) and the singleton "one row per X" guard (#839) read the migrations the
// same way. The two guards differ in ONE policy decision: a PARTIAL unique index
// (one with a WHERE) cannot back an `ON CONFLICT (cols)` inference, but it DOES
// enforce a singleton invariant. So the parser keeps partial and non-partial
// unique indexes in separate buckets and lets each guard pick.
//
// Run: node --experimental-strip-types scripts/test-parse-migration-constraints.ts
import {
  parseMigrationConstraints,
  parseDeclaredTables,
  normCols,
} from "./lib/parse-migration-constraints.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// normCols strips quotes/whitespace and joins on comma.
eq(normCols(' "user_id" , calendar_id '), "user_id,calendar_id", "normCols normalizes quotes and spaces");

// A NON-partial `create unique index` lands in uniqueIndexes, not partial.
{
  const c = parseMigrationConstraints(
    "create unique index t_ab on t (a, b);",
  );
  assert(c.uniqueIndexes.get("t")?.has("a,b") ?? false, "non-partial unique index -> uniqueIndexes");
  assert(!(c.partialUniqueIndexes.get("t")?.has("a,b") ?? false), "non-partial unique index NOT in partialUniqueIndexes");
}

// A PARTIAL unique index (has WHERE) lands in partialUniqueIndexes, not uniqueIndexes.
{
  const c = parseMigrationConstraints(
    "create unique index t_a on t (a) where deleted_at is null;",
  );
  assert(c.partialUniqueIndexes.get("t")?.has("a") ?? false, "partial unique index -> partialUniqueIndexes");
  assert(!(c.uniqueIndexes.get("t")?.has("a") ?? false), "partial unique index NOT in uniqueIndexes (the #770 rule)");
}

// `if not exists` and quoted/spaced columns parse and normalize.
{
  const c = parseMigrationConstraints(
    'create unique index if not exists t_uniq on public.t ("user_id",  calendar_id);',
  );
  assert(c.uniqueIndexes.get("t")?.has("user_id,calendar_id") ?? false, "if-not-exists + public. + quoted cols parse");
}

// Table-level UNIQUE constraint is a non-partial unique index.
{
  const c = parseMigrationConstraints(
    "create table t (\n  id uuid primary key,\n  a uuid not null,\n  b uuid not null,\n  unique (a, b)\n);",
  );
  assert(c.uniqueIndexes.get("t")?.has("a,b") ?? false, "table-level UNIQUE(a,b) -> uniqueIndexes");
  eq(c.primaryKeys.get("t") ?? "", "id", "column-level `id ... primary key` captured");
}

// Column-level UNIQUE and column-level PK.
{
  const c = parseMigrationConstraints(
    "create table t (\n  email text not null unique,\n  key text primary key\n);",
  );
  assert(c.uniqueIndexes.get("t")?.has("email") ?? false, "column-level `email ... unique` -> uniqueIndexes");
  eq(c.primaryKeys.get("t") ?? "", "key", "column-level `key text primary key` captured");
}

// A column-level UNIQUE that appears AFTER the column-level PRIMARY KEY line must
// still be captured (e.g. google_credentials: `id ... primary key` then
// `user_id ... unique`). The scan must not stop at the PK.
{
  const c = parseMigrationConstraints(
    "create table t (\n  id uuid primary key default gen_random_uuid(),\n  user_id uuid not null unique references u(id),\n  token text not null unique\n);",
  );
  eq(c.primaryKeys.get("t") ?? "", "id", "PK captured when it precedes the unique columns");
  assert(c.uniqueIndexes.get("t")?.has("user_id") ?? false, "column-level unique AFTER the PK line is captured (user_id)");
  assert(c.uniqueIndexes.get("t")?.has("token") ?? false, "a second column-level unique after the PK line is captured (token)");
}

// Table-level composite PRIMARY KEY.
{
  const c = parseMigrationConstraints(
    "create table t (\n  a uuid not null,\n  b timestamptz not null,\n  primary key (a, b)\n);",
  );
  eq(c.primaryKeys.get("t") ?? "", "a,b", "table-level PRIMARY KEY (a,b) captured");
}

// A singleton config table pinned with `id smallint primary key default 1 check (id = 1)`
// is captured as a PK on `id` (its whole-table singleton guard).
{
  const c = parseMigrationConstraints(
    "create table cfg (\n  id smallint primary key default 1 check (id = 1),\n  v text\n);",
  );
  eq(c.primaryKeys.get("cfg") ?? "", "id", "check(id=1) singleton table -> PK on id");
}

// parseDeclaredTables (#874/#875): enumerate every created table. This helper
// backs both the singleton completeness check (#874) and the RLS-coverage check
// (#875), so its edge cases are pinned here rather than only through those guards.
{
  const tables = parseDeclaredTables(
    "create table users (\n  id uuid primary key\n);\n" +
      "CREATE TABLE IF NOT EXISTS Audit_Log (\n  id uuid primary key\n);\n" +
      "create table public.oauth2_tokens (\n  id uuid primary key\n);",
  );
  assert(tables.has("users"), "declares users");
  // Case-insensitive: a `CREATE TABLE` in caps is still counted (the old local
  // regex in test-migrations.ts missed this, leaving the table RLS-unchecked).
  assert(tables.has("Audit_Log"), "case-insensitive create table is counted");
  // Digit-in-name and a `public.` prefix are both handled.
  assert(tables.has("oauth2_tokens"), "public. prefix stripped and digit-in-name kept");
  eq(tables.size, 3, "exactly the three declared tables, no phantom entries");
}
{
  // An `alter table ... add column` must NOT register a table (only create table does).
  const tables = parseDeclaredTables(
    "create table t (\n  id uuid primary key\n);\nalter table other add column x int;",
  );
  assert(tables.has("t") && !tables.has("other"), "alter table is not a declaration");
}

finish();

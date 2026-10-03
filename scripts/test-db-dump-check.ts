// The judge between the daily database dump and the heartbeat that says a backup
// exists (#3076). Every refusal is produced here from a hand written dump, and the
// healthy dump is proved to pass first, so a refusal below cannot be the fixture's
// own fault (L159).
//
// Run: node --experimental-strip-types scripts/test-db-dump-check.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  copyRowCount,
  DUMP_FILES,
  judgeDump,
  NEVER_EMPTY_TABLES,
  REQUIRED_TABLES,
  type DumpFile,
} from "./lib/db-dump-check.ts";

const copy = (schema: string, table: string, rows: number) =>
  [
    `COPY "${schema}"."${table}" ("id") FROM stdin;`,
    ...Array.from({ length: rows }, (_, i) => `row-${table}-${i}`),
    "\\.",
    "",
  ].join("\n");

function healthy(): Record<DumpFile, string> {
  return {
    "roles.sql": `SET client_encoding = 'UTF8';\nALTER ROLE "anon" SET "statement_timeout" TO '3s';\n`,
    "schema.sql": REQUIRED_TABLES.map((t) => `CREATE TABLE IF NOT EXISTS "public"."${t}" (\n  "id" uuid\n);\n`).join(""),
    "data.sql":
      "SET session_replication_role = replica;\n" +
      copy("auth", "users", 0) +
      REQUIRED_TABLES.map((t) => copy("public", t, 3)).join(""),
    "history_schema.sql": `CREATE TABLE IF NOT EXISTS "supabase_migrations"."schema_migrations" ("version" text);\n`,
    "history_data.sql": copy("supabase_migrations", "schema_migrations", 157),
  };
}

const problemsOf = (files: Partial<Record<DumpFile, string | null>>) => judgeDump(files).problems.join(" | ");

// --- the healthy dump passes, and says what it counted ----------------------
{
  const v = judgeDump(healthy());
  eq(v.ok, true, "a complete dump is kept");
  eq(v.problems, [], "a complete dump has no problems");
  eq(v.rows.bookings, 3, "it counts the data rows per table");
  eq(v.rows["supabase_migrations.schema_migrations"], 157, "it counts the applied migrations");
}

// --- copyRowCount -------------------------------------------------------------
eq(copyRowCount(copy("public", "users", 4), "public", "users"), 4, "counts the rows between COPY and its terminator");
eq(copyRowCount(copy("public", "users", 0), "public", "users"), 0, "an empty table still has a block, with zero rows");
eq(copyRowCount(copy("public", "users_x", 2), "public", "users"), null, "a table whose name only STARTS the same is not it");
eq(
  copyRowCount(`COPY "public"."users" ("id") FROM stdin;\nrow\n`, "public", "users"),
  null,
  "a block that never reaches its terminator is a dump cut short, not a count",
);

// --- every file must be there and hold something ------------------------------
for (const name of DUMP_FILES) {
  const files: Partial<Record<DumpFile, string | null>> = healthy();
  files[name] = null;
  assert(problemsOf(files).includes(`${name} is missing`), `a missing ${name} is refused by name`);
  files[name] = "   \n";
  assert(problemsOf(files).includes(`${name} is empty`), `an empty ${name} is refused by name`);
}

// --- the roles file must be a role dump ---------------------------------------
assert(
  problemsOf({ ...healthy(), "roles.sql": "SET client_encoding = 'UTF8';\n" }).includes("names no role"),
  "a roles file with no role in it is refused",
);

// --- every protected table must be declared and dumped ------------------------
for (const table of ["users", "ooo_requests", "bookings"]) {
  const h = healthy();
  const schema = h["schema.sql"].replace(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`, "-- dropped (");
  assert(
    problemsOf({ ...h, "schema.sql": schema }).includes(`does not create public.${table}`),
    `a schema without public.${table} is refused`,
  );
  const data = h["data.sql"].replace(copy("public", table, 3), "");
  assert(
    problemsOf({ ...h, "data.sql": data }).includes(`no complete COPY block for public.${table}`),
    `a data dump without public.${table} is refused`,
  );
}

// --- a table that is never empty, dumped empty, is the wrong database ----------
for (const table of NEVER_EMPTY_TABLES) {
  const h = healthy();
  const data = h["data.sql"].replace(copy("public", table, 3), copy("public", table, 0));
  assert(
    problemsOf({ ...h, "data.sql": data }).includes(`no rows for public.${table}`),
    `zero rows in public.${table} is refused`,
  );
}
// And a table that may legitimately be empty is not refused for it.
{
  const h = healthy();
  const data = h["data.sql"].replace(copy("public", "ooo_requests", 3), copy("public", "ooo_requests", 0));
  eq(judgeDump({ ...h, "data.sql": data }).ok, true, "an empty time off table is a real state and is kept");
}

// --- a dump cut short after the required tables is still refused ---------------
{
  const h = healthy();
  const data = h["data.sql"] + `COPY "public"."zz_last_table" ("id") FROM stdin;\nrow\n`;
  assert(
    problemsOf({ ...h, "data.sql": data }).includes("was cut short"),
    "an unterminated COPY anywhere in the data is refused",
  );
}

// --- the migration history must be there --------------------------------------
assert(
  problemsOf({ ...healthy(), "history_data.sql": copy("supabase_migrations", "schema_migrations", 0) }).includes(
    "no applied migrations",
  ),
  "a history dump with no applied migrations is refused",
);

// --- one run names every problem, not only the first --------------------------
{
  const v = judgeDump({ ...healthy(), "roles.sql": null, "history_data.sql": "" });
  assert(v.problems.length >= 2, "two broken files produce two reasons");
  eq(v.ok, false, "and the dump is refused");
}

finish();

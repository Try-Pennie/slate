// #2271: replaying supabase/migrations into an EMPTY database must produce a
// schema PostgREST can actually read.
//
// Migration 0121 grants the table privileges production holds and sets matching
// default privileges. This suite is the half that keeps that correct, because a
// migration that grants is only right until the next table is added by a route
// that does not inherit: `grant ... on all tables` reaches only what exists when
// it runs, so migration 0122's table is covered by the DEFAULT privileges or by
// nothing at all, and nothing would say so until the next restore.
//
// WHAT IT CHECKS, and what it cannot. The scanner's own header
// (scripts/lib/scan-migration-grants.ts) is the full statement; the short form
// is that this is a TEXT SCAN and is not evidence that a replay works. It reads
// the directory in apply order and asks, per live table, whether anything would
// give anon, authenticated and service_role SELECT on it. It cannot read a
// database, cannot see Supabase's own default privileges, and says nothing
// about RLS (scripts/test-migrations.ts owns that) or about a grant being too
// wide.
//
// It also refuses a blanket `grant ... on all functions in schema public` to
// anon or authenticated. Seventeen statements across 0024 to 0108 deliberately
// revoke EXECUTE from those roles on SECURITY DEFINER functions that bypass
// RLS, and one blanket grant after them undoes every one. The hand fix that
// unblocked the #2261 branch contained exactly that statement, so it is the
// likeliest thing to be pasted in later.
//
// THE POSITIVE CONTROLS are the reason to believe any of the above. A scanner
// blind to the shape and a clean tree produce the same empty result (L98, L1),
// so this suite reconstructs the real defect over the REAL migration corpus and
// requires itself to catch it: with 0121 removed every live table must be
// reported, with only its default privileges removed a synthetic later table
// must be reported, and with the hand fix appended the function grant must be
// reported.
//
// Run: node --experimental-strip-types scripts/test-migration-grants.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { parseCreatedTables } from "./lib/parse-migration-constraints.ts";
import {
  parseGrants,
  REQUIRED_ROLES,
  scanMigrationGrants,
  type MigrationSource,
} from "./lib/scan-migration-grants.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");

const real: MigrationSource[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ version: f.slice(0, 4), sql: readFileSync(join(DIR, f), "utf8") }));

const GRANTS_VERSION = "0121";
const withoutGrantsMigration = real.filter((f) => f.version !== GRANTS_VERSION);

// --- the real tree -------------------------------------------------------
{
  const scan = scanMigrationGrants(real);

  // A scan that read nothing reports nothing, and reads as a healthy tree. The
  // floor is deliberately well under the 39 live tables so adding one does not
  // fail this, and well over zero so an empty read cannot pass.
  assert(scan.tablesChecked >= 30, `judged ${scan.tablesChecked} live tables (floor 30)`);

  eq(
    scan.ungranted.map((u) => `${u.table} (created in ${u.createdIn}, missing ${u.missing.join(", ")})`),
    [],
    "every live table has a covering grant when these migrations are replayed into an empty database",
  );

  eq(
    scan.forbiddenFunctionGrants.map((g) => `${g.version}: ${g.grantees.join(", ")}`),
    [],
    "no migration blanket grants on all functions to anon or authenticated, which would undo the deliberate revokes",
  );
}

// --- 0121 itself, read through the scanner -------------------------------
// The default privileges are assembled inside a DO block out of concatenated
// string fragments, so this asserts the scanner really reads them rather than
// relying on the coverage result, which the blanket grant alone would satisfy.
{
  const file = real.find((f) => f.version === GRANTS_VERSION);
  assert(file !== undefined, `migration ${GRANTS_VERSION} is on disk`);
  if (file) {
    const grants = parseGrants(file.sql);
    eq(
      [...grants.blanketTables].sort(),
      [...REQUIRED_ROLES].sort(),
      "0121 grants on all existing tables to all three API roles",
    );
    eq(
      [...grants.defaultTables].sort(),
      [...REQUIRED_ROLES].sort(),
      "0121 sets default privileges on tables for all three API roles, so a later migration's table inherits them",
    );
  }
}

// --- positive control: the real defect, over the real corpus -------------
// #2271 as it was measured: the directory with nothing granting anything.
{
  const scan = scanMigrationGrants(withoutGrantsMigration);
  assert(
    scan.ungranted.length === scan.tablesChecked && scan.tablesChecked >= 30,
    `without ${GRANTS_VERSION}, all ${scan.tablesChecked} live tables are reported (got ${scan.ungranted.length})`,
  );
  const allThreeMissing = scan.ungranted.every(
    (u) => u.missing.length === REQUIRED_ROLES.length,
  );
  assert(allThreeMissing, "and each one is short of all three roles, not just some");
}

// --- positive control: the half that rots ---------------------------------
// The blanket grant kept, the default privileges removed, and a table added by
// a LATER migration. This is what "a migration that grants is only correct until
// the next table" looks like, and the blanket grant alone must not hide it.
{
  const stripped = real.map((f) =>
    f.version === GRANTS_VERSION
      ? { ...f, sql: f.sql.replace(/do \$\$[\s\S]*\$\$;/, "") }
      : f,
  );
  const withLaterTable: MigrationSource[] = [
    ...stripped,
    { version: "0122", sql: "create table later_arrival (id uuid primary key);" },
  ];
  const scan = scanMigrationGrants(withLaterTable);
  // Every REAL table created after the grants migration is in the same position as
  // the synthetic one (it relies on the default privileges alone), so it is reported
  // too. The expectation is derived from the corpus rather than fixed at the day this
  // was written, when no real table came later; #2367's booking_handoffs is the first
  // that did, and a fixed list would have read its correct report as a failure.
  const realLater = [
    ...parseCreatedTables(real.filter((f) => f.version > GRANTS_VERSION).map((f) => f.sql).join("\n")),
  ];
  eq(
    scan.ungranted.map((u) => u.table).sort(),
    [...realLater, "later_arrival"].sort(),
    "with the default privileges gone, every table created after them is reported (and only those)",
  );
  eq(
    scan.ungranted.find((u) => u.table === "later_arrival")?.missing,
    [...REQUIRED_ROLES],
    "naming all three roles it would be short of",
  );

  // The same corpus WITH the default privileges must be clean, or the control
  // above would pass for the wrong reason (a scanner that reports every late
  // table whatever the directory says).
  const withDefaults = scanMigrationGrants([
    ...real,
    { version: "0122", sql: "create table later_arrival (id uuid primary key);" },
  ]);
  eq(
    withDefaults.ungranted.map((u) => u.table),
    [],
    "and with 0121 intact the same later table inherits, so the report is about the default privileges and not about lateness",
  );
}

// --- positive control: the hand fix that must not be pasted in -----------
{
  const handFix = real.map((f) =>
    f.version === GRANTS_VERSION
      ? {
          ...f,
          sql: `${f.sql}\ngrant all on all functions in schema public to anon, authenticated, service_role;\n`,
        }
      : f,
  );
  const scan = scanMigrationGrants(handFix);
  eq(
    scan.forbiddenFunctionGrants.map((g) => g.version),
    [GRANTS_VERSION],
    "the branch's hand fix (grant all on all functions to anon, authenticated) is caught, and blamed on the file holding it",
  );
}

// --- ordering: a grant before the create covers nothing -------------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "grant select on all tables in schema public to anon, authenticated, service_role;" },
    { version: "0002", sql: "create table too_late (id uuid);" },
  ]);
  eq(
    scan.ungranted.map((u) => u.table),
    ["too_late"],
    "`on all tables` reaches only the tables that exist when it runs, so an earlier one does not cover a later table",
  );
}

// --- ordering: default privileges after the create cover nothing ----------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table already_there (id uuid);" },
    {
      version: "0002",
      sql: "alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;",
    },
  ]);
  eq(
    scan.ungranted.map((u) => u.table),
    ["already_there"],
    "default privileges apply at creation time, so ones set afterwards do not reach an existing table",
  );
}

// --- a comment is not a grant --------------------------------------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table commented (id uuid);" },
    {
      version: "0002",
      sql: "-- grant select on all tables in schema public to anon, authenticated, service_role;\nselect 1;",
    },
  ]);
  eq(
    scan.ungranted.map((u) => u.table),
    ["commented"],
    "a grant written inside a comment grants nothing and does not satisfy this guard",
  );
}

// --- partial coverage names the role that is short ------------------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table partly (id uuid);" },
    { version: "0002", sql: "grant select on all tables in schema public to service_role;" },
  ]);
  eq(
    scan.ungranted[0]?.missing,
    ["anon", "authenticated"],
    "a grant to one role reports the two it is short of, rather than passing or reporting all three",
  );
}

// --- a grant with no SELECT does not make a table readable ----------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table write_only (id uuid);" },
    { version: "0002", sql: "grant insert, update on all tables in schema public to anon, authenticated, service_role;" },
  ]);
  eq(
    scan.ungranted.map((u) => u.table),
    ["write_only"],
    "a grant carrying no SELECT leaves the table unreadable, which is the failure being guarded",
  );
}

// --- an explicit per table grant counts -----------------------------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table just_this_one (id uuid);" },
    {
      version: "0002",
      sql: "grant select on table public.just_this_one to anon, authenticated, service_role;",
    },
  ]);
  eq(scan.ungranted, [], "an explicit grant on the table itself covers it");
}

// --- a table created and later dropped is not demanded --------------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table gone_now (id uuid);" },
    { version: "0002", sql: "drop table if exists gone_now;" },
  ]);
  eq(scan.ungranted, [], "a table a later migration drops is not required to carry a grant");
  eq(scan.tablesChecked, 0, "and is not counted as judged");
}

// --- granting to PUBLIC reaches every role --------------------------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "create table open_to_all (id uuid);" },
    { version: "0002", sql: "grant select on all tables in schema public to public;" },
  ]);
  eq(scan.ungranted, [], "a grant to PUBLIC reaches anon, authenticated and service_role");
}

// --- a blanket function grant to service_role alone is fine ---------------
{
  const scan = scanMigrationGrants([
    { version: "0001", sql: "grant execute on all functions in schema public to service_role;" },
  ]);
  eq(
    scan.forbiddenFunctionGrants,
    [],
    "granting EXECUTE to service_role alone is what production holds and is not refused",
  );
}

finish();

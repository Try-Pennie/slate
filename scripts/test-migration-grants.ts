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
// A SECOND half was added by #2391 and lives at the bottom of this file, with
// its own header: the same directory, asked the opposite question about
// functions rather than tables, which is whether a SECURITY DEFINER function
// takes EXECUTE back from anon and authenticated in its own migration.
//
// Run: node --experimental-strip-types scripts/test-migration-grants.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { parseCreatedTables } from "./lib/parse-migration-constraints.ts";
import {
  EXECUTE_REVOKE_ROLES,
  parseGrants,
  REQUIRED_ROLES,
  scanDefinerExecuteGrants,
  scanMigrationGrants,
  type MigrationSource,
} from "./lib/scan-migration-grants.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");

const FILENAMES: string[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const real: MigrationSource[] = FILENAMES.map((f) => ({
  version: f.slice(0, 4),
  sql: readFileSync(join(DIR, f), "utf8"),
}));

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

// =========================================================================
// #2391: a SECURITY DEFINER function must take EXECUTE back in its own file
// =========================================================================
//
// A SECURITY DEFINER function runs with its OWNER's rights, so it bypasses the
// RLS that every other client read is held to. Two separate grants hand it to a
// client side role, and BOTH have to be taken away:
//
//   - Postgres gives EXECUTE to PUBLIC on every new function, and anon inherits
//     whatever PUBLIC holds.
//   - 0121's `alter default privileges ... grant execute on functions to anon,
//     authenticated, service_role` gives each of those roles a DIRECT grant at
//     creation time.
//
// `revoke ... from public` does NOT remove a grant made directly to a role
// (L541), so the PUBLIC-only revoke that reads like a fix leaves anon and
// authenticated holding EXECUTE. The sufficient form is the one all seventeen
// existing sites already use: `revoke execute on function f(args) from public,
// anon, authenticated`. That is what this enforces.
//
// The real tree is read first, and the count of definitions examined is
// asserted, because a scan that read nothing reports nothing and a tree with no
// findings reads exactly the same way (L98).

const plantedScan = (sql: string) => scanDefinerExecuteGrants(sql, "planted.sql");

const COMPLIANT = `
create or replace function planted_reader(p_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$ select 1 $$;

revoke execute on function planted_reader(uuid) from public, anon, authenticated;
`;

// --- the real tree --------------------------------------------------------
{
  let definersChecked = 0;
  const findings: string[] = [];
  for (const name of FILENAMES) {
    const scan = scanDefinerExecuteGrants(readFileSync(join(DIR, name), "utf8"), name);
    definersChecked += scan.definersChecked;
    for (const d of scan.findings) {
      const short = d.missing.length > 0 ? `${d.reason}: ${d.missing.join(", ")}` : d.reason;
      findings.push(`${d.file}:${d.line} ${d.functionName} (${short})`);
    }
  }

  // The floor is well under the definitions on disk today, so adding one does
  // not fail this, and well over zero, so a scan that read nothing cannot pass.
  assert(
    definersChecked >= 15,
    `the real migrations were read: ${definersChecked} SECURITY DEFINER definitions examined (floor 15)`,
  );

  eq(
    findings,
    [],
    "every SECURITY DEFINER function revokes EXECUTE from public, anon and authenticated in its own migration",
  );
}

// --- positive control: the real corpus with one revoke removed ------------
// A synthetic fixture and a scanner that reads nothing agree, so the defect is
// reconstructed over a REAL migration and the guard must catch it there.
{
  const name = "0073_count_bookings_per_local_day.sql";
  const sql = readFileSync(join(DIR, name), "utf8");
  const stripped = sql.replace(
    /revoke execute on function count_bookings_per_local_day[\s\S]*?;/i,
    "",
  );
  assert(stripped !== sql, `${name} really holds the revoke this control removes`);

  const scan = scanDefinerExecuteGrants(stripped, name);
  eq(
    scan.findings.map((f) => `${f.functionName} (${f.reason})`),
    ["count_bookings_per_local_day (no-revoke)"],
    "removing the revoke from a real migration is caught, and named",
  );
  eq(
    scan.findings[0]?.missing,
    [...EXECUTE_REVOKE_ROLES],
    "naming all three roles that would be left holding EXECUTE",
  );
  eq(
    scan.definersChecked,
    1,
    "and the definition is still counted as examined, so the catch is not a side effect of reading nothing",
  );
}

// --- planted: a definer function with no revoke at all --------------------
{
  const scan = plantedScan(`
-- a header comment, so the blamed line is not line 1 by accident
create or replace function planted_no_revoke(p_id uuid)
returns int
language sql
security definer
set search_path = public
as $$ select 1 $$;
`);
  eq(scan.definersChecked, 1, "a SECURITY DEFINER definition with no revoke is examined");
  eq(scan.findings.length, 1, "and is reported");
  eq(scan.findings[0]?.file, "planted.sql", "blamed on the file it is in");
  eq(scan.findings[0]?.line, 3, "and on the line of its own create statement");
  eq(scan.findings[0]?.functionName, "planted_no_revoke", "and named");
  eq(scan.findings[0]?.reason, "no-revoke", "with the reason kept apart from a short revoke");
}

// --- planted: L541, a revoke from PUBLIC alone ----------------------------
// The case a naive "does the file say revoke" check passes. anon and
// authenticated each hold a DIRECT grant from 0121's default privileges, and
// revoking from PUBLIC does not touch a direct grant.
{
  const scan = plantedScan(`
create or replace function planted_public_only(p_id uuid)
returns int
language sql
security definer
set search_path = public
as $$ select 1 $$;

revoke execute on function planted_public_only(uuid) from public;
`);
  eq(scan.findings.length, 1, "a revoke naming only PUBLIC is still reported (L541)");
  eq(scan.findings[0]?.reason, "roles-short", "as a short revoke rather than a missing one");
  eq(
    scan.findings[0]?.missing,
    ["anon", "authenticated"],
    "naming the two roles whose direct grant a revoke from PUBLIC leaves standing",
  );
}

// --- planted: the compliant form passes -----------------------------------
{
  const scan = plantedScan(COMPLIANT);
  eq(scan.definersChecked, 1, "the compliant fixture is examined");
  eq(scan.findings, [], "and `from public, anon, authenticated` satisfies the guard");
}

// --- planted: `revoke all` is the other shipped form ----------------------
// 0092 writes `revoke all on function erase_booking_pii(text) from ...`, which
// carries EXECUTE with it.
{
  const scan = plantedScan(
    COMPLIANT.replace(
      "revoke execute on function planted_reader(uuid) from public, anon, authenticated;",
      "revoke all on function planted_reader(uuid) from public, anon, authenticated;",
    ),
  );
  eq(scan.findings, [], "`revoke all` takes EXECUTE with it and is accepted");
}

// --- planted: a privilege list with no EXECUTE in it ----------------------
{
  const scan = plantedScan(
    COMPLIANT.replace("revoke execute on", "revoke trigger, references on"),
  );
  eq(
    scan.findings.map((f) => f.reason),
    ["no-revoke"],
    "a revoke carrying no EXECUTE leaves the function callable, which is the failure being guarded",
  );
}

// --- planted: two revokes whose roles add up ------------------------------
{
  const scan = plantedScan(`${COMPLIANT.replace(
    "revoke execute on function planted_reader(uuid) from public, anon, authenticated;",
    "revoke execute on function planted_reader(uuid) from public;",
  )}
revoke execute on function planted_reader(uuid) from anon, authenticated;
`);
  eq(scan.findings, [], "two revoke statements covering the three roles between them are enough");
}

// --- planted: a commented revoke revokes nothing --------------------------
{
  const scan = plantedScan(
    COMPLIANT.replace("revoke execute on", "-- revoke execute on"),
  );
  eq(
    scan.findings.map((f) => f.reason),
    ["no-revoke"],
    "a revoke written inside a comment is not a revoke",
  );
}

// --- planted: a revoke naming a DIFFERENT function is not this one's ------
{
  const scan = plantedScan(
    COMPLIANT.replace("revoke execute on function planted_reader(uuid)", "revoke execute on function something_else(uuid)"),
  );
  eq(
    scan.findings.map((f) => f.functionName),
    ["planted_reader"],
    "a revoke on a neighbouring function does not satisfy this one",
  );
}

// --- planted: SECURITY INVOKER is out of scope ----------------------------
{
  const scan = plantedScan(`
create or replace function planted_invoker(p_id uuid)
returns int
language sql
security invoker
set search_path = public
as $$ select 1 $$;
`);
  eq(scan.definersChecked, 0, "a SECURITY INVOKER function runs as the caller and is not examined");
  eq(scan.findings, [], "and is not reported");
}

// --- planted: a second overload of one name needs its own revoke ----------
{
  const scan = plantedScan(`
create or replace function planted_pair(p_id uuid)
returns int language sql security definer set search_path = public as $$ select 1 $$;

create or replace function planted_pair(p_id uuid, p_flag boolean)
returns int language sql security definer set search_path = public as $$ select 1 $$;

revoke execute on function planted_pair(uuid) from public, anon, authenticated;
`);
  eq(scan.definersChecked, 2, "both overloads are examined");
  eq(
    scan.findings.map((f) => f.reason),
    ["overload-unrevoked"],
    "one revoke for two definitions of a name leaves an overload callable, and is reported as its own reason",
  );
}

// --- planted: the escape hatch, with and without a reason -----------------
{
  const noReason = plantedScan(`
-- anon-execute-ok:
create or replace function planted_reader(p_id uuid)
returns int
language sql
security definer
set search_path = public
as $$ select 1 $$;
`);
  eq(
    noReason.findings.map((f) => f.reason),
    ["no-revoke"],
    "the escape hatch with no reason after the colon is refused, so the syntax alone cannot read as reasoned (L675)",
  );

  const withReason = plantedScan(`
-- anon-execute-ok: the signed in user path calls this and RLS is re-checked inside it
create or replace function planted_reader(p_id uuid)
returns int
language sql
security definer
set search_path = public
as $$ select 1 $$;
`);
  eq(withReason.definersChecked, 1, "an opted out definition is still examined");
  eq(withReason.findings, [], "and an opt out carrying a real reason is honoured");

  const onTheLine = plantedScan(
    `create or replace function planted_reader(p_id uuid) returns int language sql security definer set search_path = public as $$ select 1 $$; -- anon-execute-ok: called only through the signed in user path\n`,
  );
  eq(onTheLine.findings, [], "and the opt out may sit on the create line itself");
}

finish();

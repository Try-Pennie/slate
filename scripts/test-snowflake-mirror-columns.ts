// Guard: the Snowflake mirror DDL can accept every MERGE the export lane builds
// (#1116). Reads docs/snowflake-setup.sql and compares it against MIRROR_TABLES.
//
// The load-bearing case is the failure path. Since #1116 the MERGE writes
// `exported_at` on both branches for every table, so a mirror table missing that
// column fails 100% of its exports, and the failure only shows up in production
// against the real warehouse. The positive controls below prove this guard
// actually catches a missing column and a wrong type rather than passing
// vacuously (L1).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  findMirrorSchemaProblems,
  findMissingSelfHealAlters,
  parseSnowflakeAddColumns,
  parseSnowflakeTables,
  PROVISIONED_MIRROR_COLUMNS,
} from "./lib/parse-snowflake-setup.ts";
import { LOAD_STAMP_COL, MIRROR_TABLES } from "../src/lib/snowflake/export-core.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(repoRoot, "docs/snowflake-setup.sql"), "utf8");
const STAMP_TYPE = "TIMESTAMP_NTZ";

const declared = parseSnowflakeTables(sql);

// --- the parser reads the real file ------------------------------------------
assert(declared.size >= MIRROR_TABLES.length, `parsed ${declared.size} CREATE TABLE blocks from the setup SQL`);
const bookings = declared.get("bookings");
assert(bookings != null && bookings.length > 5, "parsed the bookings mirror block");
eq(
  bookings?.find((c) => c.name === "id")?.type,
  "VARCHAR",
  "id parses as VARCHAR despite the inline PRIMARY KEY",
);
eq(
  bookings?.find((c) => c.name === "prefill")?.type,
  "VARIANT",
  "a JSONB column is declared VARIANT",
);
assert(
  !bookings?.some((c) => c.name.startsWith("--") || c.name.toUpperCase() === "CLUSTER"),
  "comment lines and the trailing CLUSTER BY are not mistaken for columns",
);

// --- the real DDL matches what the lane exports ------------------------------
const problems = findMirrorSchemaProblems(MIRROR_TABLES, declared, LOAD_STAMP_COL, STAMP_TYPE);
for (const p of problems) console.error(`  ${p.table}: ${p.problem}`);
eq(problems.length, 0, "every exported column, plus the exported_at load stamp, is declared in the mirror DDL");

// --- the self-heal ALTER list covers every mirror table ----------------------
// The ALTERs are what actually add the column to an ALREADY-provisioned
// warehouse (every CREATE is IF NOT EXISTS, so re-running the file is otherwise
// a no-op). That list sits beside the table list by hand, so hold it in sync
// against MIRROR_TABLES rather than trusting it (L41).
const alterRe = new RegExp(
  `ALTER TABLE IF EXISTS\\s+(\\w+)\\s+ADD COLUMN IF NOT EXISTS\\s+${LOAD_STAMP_COL}\\s+${STAMP_TYPE}`,
  "gi",
);
const altered = new Set([...sql.matchAll(alterRe)].map((m) => m[1].toLowerCase()));
for (const spec of MIRROR_TABLES) {
  assert(altered.has(spec.table), `${spec.table} has a self-heal ALTER adding ${LOAD_STAMP_COL}`);
}
eq(altered.size, MIRROR_TABLES.length, "the self-heal ALTER list names no table that is not mirrored");

// --- a column added after provisioning carries its own ALTER (#2772) ---------
// The check above proves the CREATE block holds every exported column, and the
// CREATE is IF NOT EXISTS, so on the live warehouse it is a no-op: a column that
// reaches the CREATE and not an ALTER passes it while every bookings MERGE fails in
// production on an unknown column. So every column declared after the day the
// warehouse was provisioned must also have a matching idempotent ALTER.
const alters = parseSnowflakeAddColumns(sql);
const alterProblems = findMissingSelfHealAlters(declared, alters, PROVISIONED_MIRROR_COLUMNS);
for (const p of alterProblems) console.error(`  ${p.table}: ${p.problem}`);
eq(alterProblems.length, 0, "every column declared after provisioning has a self-heal ALTER of the same type");

// The snapshot must name exactly the mirrored tables, or a new table's columns
// would all read as added after provisioning (or a stale entry as covered).
eq(
  Object.keys(PROVISIONED_MIRROR_COLUMNS).sort().join(","),
  MIRROR_TABLES.map((t) => t.table).sort().join(","),
  "the provisioning snapshot names exactly the mirrored tables",
);

// #2772: the framing page's origin rides into the warehouse.
const bookingsSpec = MIRROR_TABLES.find((t) => t.table === "bookings");
eq(
  bookingsSpec?.cols.find((c) => c.name === "referrer_origin")?.type,
  "varchar",
  "the bookings mirror exports referrer_origin as a varchar",
);
assert(
  (alters.get("bookings") ?? []).some((c) => c.name === "referrer_origin" && c.type === "VARCHAR"),
  "the setup file carries the ALTER that adds referrer_origin to the existing bookings mirror",
);

// #2828: whether a booking was routed or made through an advisor's own link
// (bookings.kind, migration 0144), so warehouse analytics can leave the advisor
// link bookings out of anything about routing.
eq(
  bookingsSpec?.cols.find((c) => c.name === "kind")?.type,
  "varchar",
  "the bookings mirror exports kind as a varchar",
);
assert(
  (alters.get("bookings") ?? []).some((c) => c.name === "kind" && c.type === "VARCHAR"),
  "the setup file carries the ALTER that adds kind to the existing bookings mirror",
);
// The ALTER leaves every row already in the warehouse with a null kind, and those
// rows are never exported again unless they change. Every booking created before
// #2073 shipped is routed (nothing could make any other kind), so the setup file
// says so for exactly that population, and no later one.
assert(
  /^UPDATE\s+bookings\s+SET\s+kind\s*=\s*'routed'\s+WHERE\s+kind\s+IS\s+NULL\s+AND\s+created_at\s*<\s*'2026-09-28 15:17:32 \+00:00'::TIMESTAMP_TZ\s*;$/im.test(
    sql,
  ),
  "the setup file backfills kind only for bookings created before advisor links shipped",
);

// #4397: whether a booking came through the partner program (bookings.program_lead,
// migration 0213), so warehouse reports can tell program bookings from any other.
eq(
  bookingsSpec?.cols.find((c) => c.name === "program_lead")?.type,
  "boolean",
  "the bookings mirror exports program_lead as a boolean",
);
assert(
  (alters.get("bookings") ?? []).some((c) => c.name === "program_lead" && c.type === "BOOLEAN"),
  "the setup file carries the ALTER that adds program_lead to the existing bookings mirror",
);
// The rows already mirrored are never exported again unless they change, so they
// are filled with false, and only where the ALTER left them null.
assert(
  /^UPDATE\s+bookings\s+SET\s+program_lead\s*=\s*FALSE\s+WHERE\s+program_lead\s+IS\s+NULL\s*;$/im.test(sql),
  "the setup file fills program_lead with false for the bookings already mirrored",
);

// --- positive controls: the guard can fail -----------------------------------
const withoutSourceAlter = sql.replace(
  /^ALTER TABLE IF EXISTS\s+bookings\s+ADD COLUMN IF NOT EXISTS\s+source\s+VARCHAR\s*;$/m,
  "",
);
assert(withoutSourceAlter !== sql, "control setup: the source ALTER was found to remove");
assert(
  findMissingSelfHealAlters(
    parseSnowflakeTables(withoutSourceAlter),
    parseSnowflakeAddColumns(withoutSourceAlter),
    PROVISIONED_MIRROR_COLUMNS,
  ).some((p) => p.table === "bookings" && p.problem.startsWith("source ")),
  "control: a column in the CREATE with no ALTER for the live warehouse is caught",
);

const wrongAlterType = new Map(alters);
wrongAlterType.set(
  "bookings",
  (alters.get("bookings") ?? []).map((c) => (c.name === "source" ? { ...c, type: "NUMBER" } : c)),
);
assert(
  findMissingSelfHealAlters(declared, wrongAlterType, PROVISIONED_MIRROR_COLUMNS).some((p) =>
    p.problem.includes("NUMBER in its ALTER"),
  ),
  "control: an ALTER whose type differs from the CREATE is caught",
);

eq(
  parseSnowflakeAddColumns("ALTER TABLE bookings ADD COLUMN source VARCHAR;").size,
  0,
  "control: a non idempotent ALTER does not count, since re-running the file would error on it",
);

const withoutStamp = new Map(declared);
withoutStamp.set("audit_log", declared.get("audit_log")!.filter((c) => c.name !== LOAD_STAMP_COL));
const missing = findMirrorSchemaProblems(MIRROR_TABLES, withoutStamp, LOAD_STAMP_COL, STAMP_TYPE);
assert(
  missing.some((p) => p.table === "audit_log" && p.problem.includes(LOAD_STAMP_COL)),
  "control: dropping exported_at from a mirror table is caught",
);

const wrongType = new Map(declared);
wrongType.set(
  "bookings",
  declared.get("bookings")!.map((c) => (c.name === LOAD_STAMP_COL ? { ...c, type: "VARCHAR" } : c)),
);
assert(
  findMirrorSchemaProblems(MIRROR_TABLES, wrongType, LOAD_STAMP_COL, STAMP_TYPE).some((p) =>
    p.problem.includes("expected TIMESTAMP_NTZ"),
  ),
  "control: declaring exported_at with the wrong type is caught",
);

const droppedCol = new Map(declared);
droppedCol.set("bookings", declared.get("bookings")!.filter((c) => c.name !== "attendee_email"));
assert(
  findMirrorSchemaProblems(MIRROR_TABLES, droppedCol, LOAD_STAMP_COL, STAMP_TYPE).some((p) =>
    p.problem.includes("attendee_email"),
  ),
  "control: an exported column absent from the DDL is caught",
);

assert(
  findMirrorSchemaProblems(
    [{ table: "audit_log", cols: [{ name: "id" }, { name: LOAD_STAMP_COL }] }],
    declared,
    LOAD_STAMP_COL,
    STAMP_TYPE,
  ).some((p) => p.problem.includes("must not be an exported source column")),
  "control: adding exported_at to a lane column list is caught",
);

assert(
  findMirrorSchemaProblems([{ table: "not_a_table", cols: [{ name: "id" }] }], declared, LOAD_STAMP_COL, STAMP_TYPE)
    .length > 0,
  "control: a mirror table with no CREATE TABLE block is caught",
);

finish();

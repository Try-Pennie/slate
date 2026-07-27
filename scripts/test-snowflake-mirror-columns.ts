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
import { findMirrorSchemaProblems, parseSnowflakeTables } from "./lib/parse-snowflake-setup.ts";
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

// --- positive controls: the guard can fail -----------------------------------
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

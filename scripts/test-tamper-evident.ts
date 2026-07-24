// #1040: audit_log and booking_events must be tamper-evident. A BEFORE UPDATE OR
// DELETE trigger on each table raises an exception so even the RLS-bypassing
// secret-key client cannot silently rewrite audit history short of dropping the
// trigger. booking_events carries a single sanctioned bypass (the
// `slate.allow_erasure` session GUC) so the #1072 erasure function can redact
// reason_detail; audit_log has NO bypass (its trail is never redacted, only
// appended to, per docs/pii-retention.md §4).
//
// This is a static guard: it pins the protection into the migration corpus so a
// later edit that drops a trigger, removes the sentinel from booking_events, or
// (worse) adds the sentinel to audit_log fails the build instead of silently
// eroding tamper-evidence. The runtime behavior itself is verified by applying
// the migration to the database (docs/migrations-runbook.md).
// Run: node --experimental-strip-types scripts/test-tamper-evident.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const sql = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n")
  .toLowerCase();

const SENTINEL = "slate.allow_erasure";

// table -> trigger function name, for every BEFORE UPDATE OR DELETE row trigger.
const triggers = new Map<string, string>();
for (const m of sql.matchAll(
  /create\s+trigger\s+\w+\s+before\s+update\s+or\s+delete\s+on\s+(\w+)\s+for\s+each\s+row\s+execute\s+(?:function|procedure)\s+(\w+)/g,
)) {
  triggers.set(m[1], m[2]);
}

// table -> trigger function name, for every BEFORE TRUNCATE statement trigger.
// Row-level UPDATE/DELETE triggers do NOT fire on TRUNCATE, so a bulk wipe would
// slip past them without this separate statement-level guard.
const truncateTriggers = new Map<string, string>();
for (const m of sql.matchAll(
  /create\s+trigger\s+\w+\s+before\s+truncate\s+on\s+(\w+)\s+for\s+each\s+statement\s+execute\s+(?:function|procedure)\s+(\w+)/g,
)) {
  truncateTriggers.set(m[1], m[2]);
}

// function name -> does its body reference the erasure sentinel?
const fnHasSentinel = new Map<string, boolean>();
for (const m of sql.matchAll(
  /create\s+(?:or\s+replace\s+)?function\s+(\w+)\s*\([^)]*\)([\s\S]*?)\$\$\s*;/g,
)) {
  fnHasSentinel.set(m[1], m[2].includes(SENTINEL));
}

for (const table of ["audit_log", "booking_events"]) {
  assert(
    triggers.has(table),
    `${table} has a BEFORE UPDATE OR DELETE trigger (tamper-evident, #1040)`,
  );
}

const beFn = triggers.get("booking_events");
assert(
  beFn !== undefined && fnHasSentinel.get(beFn) === true,
  `booking_events' append-only guard carries the ${SENTINEL} bypass for the #1072 erasure path`,
);

const auditFn = triggers.get("audit_log");
assert(
  auditFn !== undefined && fnHasSentinel.get(auditFn) === false,
  `audit_log's append-only guard has NO bypass (fully immutable, pii-retention.md §4)`,
);

for (const table of ["audit_log", "booking_events"]) {
  assert(
    truncateTriggers.has(table),
    `${table} has a BEFORE TRUNCATE trigger (a bulk wipe can't slip past the row triggers, #1040)`,
  );
}

// TRUNCATE is always blocked, even on booking_events: erasure redacts specific
// rows and never truncates, so the truncate guard must NOT carry the sentinel.
const beTruncFn = truncateTriggers.get("booking_events");
assert(
  beTruncFn !== undefined && fnHasSentinel.get(beTruncFn) === false,
  `booking_events' TRUNCATE guard has NO erasure bypass (truncate is never sanctioned)`,
);

finish();

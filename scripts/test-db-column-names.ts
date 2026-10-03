// A column name no declared table type holds (#1731 follow-up). Run:
//   node --experimental-strip-types scripts/test-db-column-names.ts
//
// Why this guard exists, and it is worth stating because the defect was invisible
// to everything else the repo runs: on 2026-09-02 the cal.com parity sweep shipped
// filtering `buckets` on an `active` column that does not exist. PostgREST answers
// 42703, `unwrap` turns it into a throw, and the sweep could never have executed a
// single time. `tsc` was clean, the whole unit suite was green, CI passed, and the
// pre-push gate passed, because the column is a STRING argument to a query builder
// and nothing in the type system ever sees it.
//
// A wrong column is never a partial failure. It is a query that cannot run at all,
// in code that usually runs on a schedule or by hand rather than on the hot path,
// so it is discovered on the day it is needed.
//
// The mapping to check against was already in the repo: `schema.ts` maps each
// table to its row interface, `types.ts` declares that interface's fields.
//
// SCOPE WIDENED TO `src/` (#2369). It covered `scripts/` only, on the argument that
// `src/`'s query shapes would fight it, and the widening was named there as a
// deliberate act. #2369 is what made it one: the same defect had shipped in `src/`
// five times, `bookings.is_test` every time, and every one was found by hand. The
// prediction about the shapes was right and measuring it is what fixed it rather
// than justifying staying out: the embedded resource select produced exactly two
// false findings, and `withoutEmbeddedGroups` is the answer to them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  tableTypeMap,
  interfaceFields,
  scanDbColumns,
  withoutEmbeddedGroups,
  withoutWholeLineComments,
} from "./lib/scan-db-columns.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const schemaSrc = readFileSync(join(root, "src/lib/db/schema.ts"), "utf8");
const typesSrc = readFileSync(join(root, "src/lib/db/types.ts"), "utf8");
const tables = tableTypeMap(schemaSrc);
const fields = interfaceFields(typesSrc);

// --- the mapping reads at all -------------------------------------------------
// Both halves are asserted non-empty first. An empty map makes every scan below
// return nothing, which is indistinguishable from a clean tree (L98), and it is
// the single likeliest way this guard rots into a no-op: either source file can be
// reshaped without anyone thinking about this scanner.
assert(tables.size >= 20, `the schema maps at least 20 tables (got ${tables.size})`);
assert(fields.size >= 20, `types.ts declares at least 20 interfaces (got ${fields.size})`);
assert(tables.get("buckets") === "Bucket", "buckets maps to the Bucket interface");
assert(fields.get("Bucket")?.has("code") === true, "Bucket declares code");
assert(fields.get("Bucket")?.has("is_test") === true, "Bucket declares is_test");
assert(
  fields.get("Bucket")?.has("active") === false,
  "Bucket does NOT declare active: the exact column the shipped defect filtered on",
);

// --- the scanner catches the shape that shipped -------------------------------
{
  const bad = `const r = await db.from("buckets").select("id, code").eq("active", true);`;
  const found = scanDbColumns("f.ts", bad, tables, fields);
  eq(found.length, 1, "the defect that shipped is caught");
  eq(found[0].column, "active", "naming the column");
  eq(found[0].where, "eq", "and which part of the chain used it");
}
{
  const bad = `const r = await db.from("buckets").select("id, activee, code");`;
  const found = scanDbColumns("f.ts", bad, tables, fields);
  eq(found.length, 1, "a bad column inside a select list is caught too");
  eq(found[0].where, "select", "reported against the select");
}
{
  const ok = `const r = await db.from("buckets").select("id, code, is_test").eq("is_test", false);`;
  eq(scanDbColumns("f.ts", ok, tables, fields).length, 0, "a correct chain is clean");
}

// --- what it deliberately does not judge --------------------------------------
// Each of these would produce a finding nobody can act on, and the response to
// that is to switch the guard off rather than fix it (L36).
{
  const s = `const r = await db.from("buckets").select("*");`;
  eq(scanDbColumns("f.ts", s, tables, fields).length, 0, "a star select is not judged");
}
{
  const s = `const r = await db.from("buckets").select("id, event_types(name, duration_min)");`;
  eq(scanDbColumns("f.ts", s, tables, fields).length, 0, "an embedded resource is not judged");
}
{
  // The shape that produced the only two false findings when the scan was widened to
  // `src/`: the group's INNER columns are bare words once the list is split on
  // commas, so they were judged against the OUTER table and reported as missing.
  const s =
    `const p = db.from("availability_schedules")` +
    `.select("id, user_id, timezone, availability_rules(schedule_id, weekday, start_minute, end_minute)")` +
    `.in("user_id", ids);`;
  eq(
    scanDbColumns("f.ts", s, tables, fields).length,
    0,
    "a column INSIDE an embedded group is not judged against the outer table",
  );
}
{
  // And the other direction, or the strip could be swallowing real findings: a bad
  // column OUTSIDE the group must still be caught with a group present.
  const s =
    `const p = db.from("availability_schedules")` +
    `.select("id, nonsense_column, availability_rules(weekday, start_minute)");`;
  const found = scanDbColumns("f.ts", s, tables, fields);
  eq(found.length, 1, "a bad column beside an embedded group is still caught");
  eq(found[0].column, "nonsense_column", "and it is the one outside the group");
}
{
  eq(
    withoutEmbeddedGroups("id, availability_rules(weekday, start_minute), timezone"),
    "id,, timezone",
    "the group and its identifier are both removed, leaving the outer columns",
  );
  eq(
    withoutEmbeddedGroups("id, a(b(c)), x"),
    "id,, x",
    "a nested group goes entirely",
  );
  eq(withoutEmbeddedGroups("id, code"), "id, code", "a list with no group is untouched");
}
{
  const s = `const r = await db.from("some_view_not_in_types").select("whatever");`;
  eq(scanDbColumns("f.ts", s, tables, fields).length, 0, "a table the repo does not declare is skipped, not accused");
}
{
  // A value that merely looks like a column must not be read as one. `.limit(10)`
  // and `.eq(someVar, x)` carry no string column at all.
  const s = `const r = await db.from("buckets").select("id").limit(10).eq(col, true);`;
  eq(scanDbColumns("f.ts", s, tables, fields).length, 0, "a non-literal filter argument is not judged");
}
{
  // `.order("created_at", { ascending: false })` names a real column and must pass,
  // while an order on a column that is not there must not.
  const good = `const r = await db.from("buckets").select("id").order("created_at", { ascending: false });`;
  eq(scanDbColumns("f.ts", good, tables, fields).length, 0, "ordering on a real column is clean");
  const bad = `const r = await db.from("buckets").select("id").order("sort_weight");`;
  eq(scanDbColumns("f.ts", bad, tables, fields).length, 1, "ordering on a column that is not there is caught");
}

// --- the real tree ------------------------------------------------------------
function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...scriptFiles(p));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
      out.push(p);
    }
  }
  return out;
}

// BOTH trees (#2369). `src/` is where the defect kept shipping, and the count is
// asserted per tree: one empty walk would otherwise be hidden by the other's total,
// which is the same false negative as an empty table map above (L98).
const scriptTree = scriptFiles(join(root, "scripts"));
const srcTree = scriptFiles(join(root, "src"));
assert(scriptTree.length > 100, `the scan reached the scripts tree (${scriptTree.length} files)`);
assert(srcTree.length > 100, `the scan reached the src tree (${srcTree.length} files)`);
const files = [...scriptTree, ...srcTree];

const real: ReturnType<typeof scanDbColumns> = [];
let sawAnyChain = false;
for (const f of files) {
  // This file is skipped, and it has to be: its fixtures NAME the bad columns in
  // order to prove the guard catches them, so a scanner that read its own source
  // would report its own test data as defects (L245).
  if (f.endsWith("test-db-column-names.ts")) continue;
  const src = readFileSync(f, "utf8");
  if (/\.from\(\s*["'`]/.test(src)) sawAnyChain = true;
  real.push(...scanDbColumns(f.slice(root.length), src, tables, fields));
}
// A run that found no query chains at all would report a clean tree while having
// examined nothing, which is the same false negative as an empty table map above.
assert(sawAnyChain, "at least one query chain was actually found in scripts/");

// The positive control: the guard must catch a real defect planted in the real
// tree, not only in a synthetic string. A scan that quietly stopped reading files
// would pass every assertion above and this one is what refuses it.
{
  // The victim must query buckets in CODE, not in a comment. The scanner blanks whole
  // line comments (#2369), so a plant landing in one is correctly not found, and the
  // control would then report the scan broken when it was working. Searching the same
  // text the scanner reads is what keeps the two in step.
  const victim = files.find((f) =>
    /\.from\(\s*["'`]buckets["'`]/.test(withoutWholeLineComments(readFileSync(f, "utf8"))),
  );
  assert(victim !== undefined, "a real file queries buckets in code, so the control has something to damage");
  if (victim) {
    const damaged = readFileSync(victim, "utf8").replace(
      /\.from\(\s*["'`]buckets["'`]\s*\)/,
      '.from("buckets").eq("active", true)',
    );
    const caught = scanDbColumns("planted.ts", damaged, tables, fields);
    assert(
      caught.some((c) => c.column === "active" && c.table === "buckets"),
      "this run was PROVEN to work: it caught a column planted into a real file",
    );
  }
}

if (real.length > 0) {
  console.error("\nColumns no declared table type holds:");
  for (const f of real) {
    console.error(`  ${f.file}:${f.line}  ${f.table}.${f.column} (in .${f.where})`);
  }
}
assert(
  real.length === 0,
  `no scripts/ or src/ query names a column its table does not declare (found ${real.length})`,
);

finish();

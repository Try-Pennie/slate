// Repo invariant (#770): every `onConflict` target must be backed by a unique
// index or primary key that Postgres can actually infer.
//
// This guards a bug class this codebase has already shipped once. Migration 0022:
// busy_blocks' (user_id, gcal_event_id) uniqueness was a PARTIAL unique index, and
// PostgREST/supabase-js upsert emits a bare `ON CONFLICT (cols)`, which Postgres
// cannot match to a partial index (42P10). So EVERY gcal busy-block upsert failed,
// silently, from 0001 until 0022. The availability cache held no Google events at
// all and the booker over-offered slots for months (#35).
//
// The failure is invisible in code review and in unit tests (a mocked client happily
// accepts any onConflict string). It only shows up against real Postgres. So assert
// it here, statically, against the migrations.
//
// Two ways a target is satisfiable (see hasUpsertTarget):
//   1. a NON-PARTIAL unique index on exactly those columns, or
//   2. the table's primary key on exactly those columns.
// A PARTIAL unique index does NOT count here (that is the 0022 bug); it DOES count
// as a singleton guard, which is a separate invariant asserted in
// scripts/test-singleton-guards.ts (#839). Both read the migrations through the
// shared parser in scripts/lib/parse-migration-constraints.ts.
// Run: node --experimental-strip-types scripts/test-upsert-conflict-targets.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMigrationConstraints,
  hasUpsertTarget,
  normCols,
} from "./lib/parse-migration-constraints.ts";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

const constraints = parseMigrationConstraints(sql);

/** Every `.from("table")....upsert(..., { onConflict: "cols" })` in src/. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

type Site = { file: string; table: string; cols: string };
const sites: Site[] = [];
for (const file of sourceFiles(join(ROOT, "src"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/onConflict:\s*"([^"]+)"/g)) {
    // Walk back to the nearest .from("<table>") that opens this chain.
    const before = src.slice(0, m.index);
    const fromMatches = [...before.matchAll(/\.from\(\s*"(\w+)"\s*\)/g)];
    const table = fromMatches.at(-1)?.[1];
    if (!table) continue;
    sites.push({ file: file.slice(ROOT.length + 1), table, cols: normCols(m[1]) });
  }
}

assert(sites.length > 0, `found upsert onConflict sites to check (got ${sites.length})`);

for (const site of sites) {
  assert(
    hasUpsertTarget(constraints, site.table, site.cols),
    `${site.table}(${site.cols}) upsert target is backed by a non-partial unique index or PK [${site.file}]`,
  );
}

finish();

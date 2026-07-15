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
// Two ways a target is satisfiable:
//   1. a NON-PARTIAL unique index on exactly those columns, or
//   2. the table's primary key on exactly those columns.
// Run: node --experimental-strip-types scripts/test-upsert-conflict-targets.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

const norm = (cols: string) =>
  cols
    .split(",")
    .map((c) => c.trim().replace(/"/g, ""))
    .filter(Boolean)
    .join(",");

/** Non-partial unique indexes: "table" -> set of "col,col" they cover. */
const uniqueIndexes = new Map<string, Set<string>>();
// create [unique] index [if not exists] <name> on <table> (<cols>) [where ...];
const indexRe =
  /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\S+\s+on\s+(?:public\.)?(\w+)\s*\(([^)]+)\)([^;]*);/gi;
for (const m of sql.matchAll(indexRe)) {
  const [, table, cols, tail] = m;
  // A WHERE makes it PARTIAL, and a partial index cannot be inferred by
  // ON CONFLICT (cols). That is exactly the 0022 bug, so do not count it.
  if (/\bwhere\b/i.test(tail)) continue;
  const set = uniqueIndexes.get(table) ?? new Set<string>();
  set.add(norm(cols));
  uniqueIndexes.set(table, set);
}

/** Primary keys: "table" -> "col,col". */
const primaryKeys = new Map<string, string>();
for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
  const [, table, body] = m;

  // A table-level UNIQUE constraint is backed by a unique index and IS inferable by
  // ON CONFLICT, exactly like `create unique index`. e.g. reassign_intents (0065).
  for (const u of body.matchAll(/^\s*unique\s*\(([^)]+)\)/gim)) {
    const set = uniqueIndexes.get(table) ?? new Set<string>();
    set.add(norm(u[1]));
    uniqueIndexes.set(table, set);
  }

  const tableLevel = body.match(/^\s*primary\s+key\s*\(([^)]+)\)/im);
  if (tableLevel) {
    primaryKeys.set(table, norm(tableLevel[1]));
    continue;
  }
  // Column-level: `key text primary key`, `id uuid primary key default ...`
  for (const line of body.split("\n")) {
    const col = line.match(/^\s*(\w+)\s+[\w\s()]*?\bprimary\s+key\b/i);
    if (col) {
      primaryKeys.set(table, col[1]);
      break;
    }
    // Column-level UNIQUE: `email text not null unique`
    const uniqueCol = line.match(/^\s*(\w+)\s+[\w\s()]*?\bunique\b/i);
    if (uniqueCol) {
      const set = uniqueIndexes.get(table) ?? new Set<string>();
      set.add(uniqueCol[1]);
      uniqueIndexes.set(table, set);
    }
  }
}

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
    sites.push({ file: file.slice(ROOT.length + 1), table, cols: norm(m[1]) });
  }
}

assert(sites.length > 0, `found upsert onConflict sites to check (got ${sites.length})`);

for (const site of sites) {
  const byIndex = uniqueIndexes.get(site.table)?.has(site.cols) ?? false;
  const byPk = primaryKeys.get(site.table) === site.cols;
  assert(
    byIndex || byPk,
    `${site.table}(${site.cols}) upsert target is backed by a non-partial unique index or PK [${site.file}]`,
  );
}

// The #770 index itself: a duplicate slate block for one booking must be impossible.
assert(
  uniqueIndexes.get("busy_blocks")?.has("booking_id") ?? false,
  "#770: busy_blocks has a non-partial UNIQUE index on booking_id",
);

finish();

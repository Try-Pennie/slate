// Repo invariant (#3273): every paged read is ordered by a key that is UNIQUE.
//
// `selectAllPages` cuts pages with OFFSET under the order its caller's key gives.
// A key two rows share leaves those rows free to swap between page requests, so
// one is read twice and the other never, which is how a 43 advisor busy read came
// back as 2,392 rows holding 1,826 distinct ones and a sold out Monday was offered.
// The type system makes a key REQUIRED; only the schema can say it is unique, so
// this reads the unique column sets the migrations declare and requires every
// caller's key to cover one. See scripts/lib/scan-paged-read-keys.ts.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  judgePagedReadKey,
  pagedReadKeys,
  uniqueSetsFromMigrations,
} from "./lib/scan-paged-read-keys.ts";
import { assert, finish } from "./lib/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// --- the schema reading, on fixtures ------------------------------------------
const fixtureSets = uniqueSetsFromMigrations([
  `create table if not exists public.things (
     id uuid primary key default gen_random_uuid(), -- a comment, with (parens)
     day date not null,
     code text not null unique,
     name text,
     unique (day, name)
   );
   create table pairs (a text, b text, n int, primary key (a, b));
   create unique index pairs_partial on pairs (n) where n > 0;
   create unique index things_lower on things (lower(name));
   create unique index if not exists things_name_day on things (name, day);`,
]);
const fx = (table: string, keys: string[]) =>
  judgePagedReadKey({ file: "fixture", line: 1, table, keys }, fixtureSets);
assert(fx("things", ["id"]) === null, "a column primary key is unique");
assert(fx("things", ["code"]) === null, "a column unique constraint is unique");
assert(fx("things", ["day", "name"]) === null, "a table unique constraint is unique");
assert(fx("things", ["name", "day"]) === null, "a full unique index is unique, in any column order");
assert(fx("pairs", ["a", "b"]) === null, "a table primary key is unique");
assert(fx("pairs", ["b", "a", "n"]) === null, "a superset of a unique set is unique");
assert(fx("pairs", ["a"]) !== null, "half of a composite primary key is NOT unique");
assert(fx("pairs", ["n"]) !== null, "a PARTIAL unique index is not unique over the table");
assert(fx("things", ["name"]) !== null, "an expression index does not make the bare column unique");
assert(fx("things", ["day"]) !== null, "an ordinary column is not unique");
assert(fx("missing", ["id"]) !== null, "a table the migrations never declare is refused, not passed");

// --- the call reading, on fixtures --------------------------------------------
const calls = pagedReadKeys(
  "fixture.ts",
  `const a = await selectAllPages<Row>("x", "id", () => db.from("things").select("id"));
const b = await selectAllPages<Row>(\`ctx \${n}\`, ["a", "b"], () =>
  db.from("pairs").select("a") // a ) in a comment
);`,
);
assert(calls.length === 2, `reads both fixture calls (got ${calls.length})`);
assert(calls[0]?.table === "things" && calls[0]?.keys?.join() === "id", "reads a string key");
assert(calls[1]?.table === "pairs" && calls[1]?.keys?.join() === "a,b", "reads an array key past a template context");

// --- the real repository ------------------------------------------------------
const migDir = join(ROOT, "supabase", "migrations");
const realSets = uniqueSetsFromMigrations(
  readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(migDir, f), "utf8")),
);
assert((realSets.get("busy_blocks") ?? []).some((s) => s.join() === "id"), "busy_blocks reads as keyed on id");
assert(
  (realSets.get("pilot_offer_samples") ?? []).some((s) => [...s].sort().join() === "sampled_at,system"),
  "pilot_offer_samples reads as keyed on (sampled_at, system)",
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const scanned = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "scripts"))].filter(
  // The scanners and the node suites name selectAllPages in fixtures, not reads.
  (p) => !/scripts\/(test-[^/]*|lib\/scan-[^/]*)$/.test(p) && !p.endsWith("src/lib/supabase/paginate.ts"),
);

let reads = 0;
for (const file of scanned) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("selectAllPages")) continue;
  for (const read of pagedReadKeys(file.slice(ROOT.length + 1), src)) {
    reads++;
    const why = judgePagedReadKey(read, realSets);
    assert(why === null, `${read.file}:${read.line} pages ${read.table ?? "?"}: ${why ?? "ok"}`);
  }
}
// Measured when this guard was written: 72 paged reads. A scan that finds none
// has stopped reading the tree, and an empty pass is not a clean one.
assert(reads >= 70, `found the repository's paged reads (got ${reads})`);

// Positive control on the real code: page the availability busy read on a column
// two meetings can share, and the guard must refuse it.
const svcPath = join(ROOT, "src", "lib", "availability", "service.ts");
const svc = readFileSync(svcPath, "utf8");
const svcReads = pagedReadKeys("service.ts", svc).filter((r) => r.table === "busy_blocks");
assert(svcReads.length === 1, "the availability busy read is a paged read");
const mutated = pagedReadKeys(
  "service.ts",
  svc.replace(/("busy_blocks",\s*)"id"/, '$1"starts_at"'),
).filter((r) => r.table === "busy_blocks");
assert(
  mutated.length === 1 && judgePagedReadKey(mutated[0], realSets) !== null,
  "positive control: the busy read keyed on starts_at is refused",
);

finish();

// Nothing may read `supabase_migrations` over the REST API (#2261).
//
// It answers 406 on every Supabase project, because PostgREST exposes `public`
// only. The load test seed shipped with exactly that read and died on it the
// first time anybody ran it, having written nothing: a refusal that can never
// succeed is indistinguishable from the bad schema the check exists to catch.
//
// Run: node --experimental-strip-types scripts/test-migration-schema-reads.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationSchemaReads, MIGRATIONS_RPC } from "./lib/scan-migration-schema-reads.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

/**
 * The schema name, ASSEMBLED rather than written.
 *
 * The controls below have to feed the scanner the exact text it looks for, and a
 * file holding that text is a file the scanner correctly flags: this guard would
 * fail on its own fixtures forever. Building the literal at run time leaves this
 * file with no copy of it while the scanner still receives the identical string,
 * which is the same trick the repo's dash lint uses for a test that must name a
 * forbidden character.
 */
const SCHEMA = ["supabase", "migrations"].join("_");

function tsFilesUnder(dir: string, prefix: string): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...tsFilesUnder(join(dir, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    out.push({
      name: `${prefix}${entry.name}`,
      source: readFileSync(join(ROOT, dir, entry.name), "utf8"),
    });
  }
  return out;
}

// --- the real tree ------------------------------------------------------------

{
  const files = [...tsFilesUnder("scripts", "scripts/"), ...tsFilesUnder("src", "src/")];
  assert(files.length > 100, `the scan really read the tree (${files.length} files)`);
  const found = migrationSchemaReads(files);
  if (found.length === 0) {
    assert(true, "nothing reads supabase_migrations over the REST API");
  } else {
    for (const r of found) {
      fail(
        `${r.file}:${r.line} reads supabase_migrations over REST, which answers 406 on every ` +
          `project. Call the ${MIGRATIONS_RPC}() RPC instead: ${r.text}`,
      );
    }
  }
}

{
  // The read path that DOES work is really there, so this guard is pointing
  // somewhere rather than merely forbidding something (L111: a message telling
  // somebody how to recover must name an action that exists).
  const sql = readFileSync(join(ROOT, "supabase/migrations/0072_applied_migration_versions.sql"), "utf8");
  assert(
    sql.includes(`create or replace function ${MIGRATIONS_RPC}()`),
    "the RPC this guard names is shipped by a migration",
  );
  const seed = readFileSync(join(ROOT, "scripts/loadtest/seed.ts"), "utf8");
  assert(
    seed.includes(`rpc/${MIGRATIONS_RPC}`),
    "and the load test seed reads its branch's migrations through it",
  );
}

// --- positive controls --------------------------------------------------------

{
  // The exact shape the seed shipped with. A guard that has only ever seen a clean
  // tree is satisfied by a guard that cannot see anything (L1).
  const bad = [
    {
      name: "fake.ts",
      source: [
        "const res = await fetch(`${BASE}/" + SCHEMA + ".schema_migrations?select=version`, {",
        '  headers: { "accept-profile": "' + SCHEMA + '" },',
        "});",
      ].join("\n"),
    },
  ];
  const found = migrationSchemaReads(bad);
  assert(found.length >= 1, "a control catches the read the seed shipped with");
  eq(found[0]!.line, 1, "and points at the line the path is on");
}

{
  // The accept-profile header ALONE, with the table reached another way.
  const found = migrationSchemaReads([
    { name: "f.ts", source: 'await fetch(url, { headers: { "accept-profile": "' + SCHEMA + '" } });' },
  ]);
  eq(found.length, 1, "a control catches the accept-profile header on its own");
}

{
  // Both directions (L159). Prose about the schema is not a read, and this file,
  // its scanner and migration 0072 all have to name it to explain the rule at all.
  const quiet = migrationSchemaReads([
    { name: "f.ts", source: "// " + SCHEMA + " is unreachable over the API, so use the RPC" },
    { name: "g.ts", source: "const applied = await fetch(`${BASE}/rpc/applied_migration_versions`);" },
    {
      name: "h.sql.ts",
      source: "const sql = `select version from " + SCHEMA + ".schema_migrations`;",
    },
  ]);
  eq(quiet.length, 0, "a comment, the RPC call and a plain SQL string are all left alone");
}

{
  // The opt out, for a caller that genuinely reaches the schema another way.
  const found = migrationSchemaReads([
    {
      name: "f.ts",
      source: [
        "// migrations-read-ok: this runs against a project with the schema exposed",
        "await fetch(`${BASE}/" + SCHEMA + ".schema_migrations?select=version`);",
      ].join("\n"),
    },
  ]);
  eq(found.length, 0, "the opt out silences it when the reason is written down");
}

finish();

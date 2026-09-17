// Does production hold a table no migration created? Run: pnpm verify:table-drift (#2294)
//
// Reads production, writes nothing. Judgement is in lib/table-drift.ts and pinned offline by
// scripts/test-table-drift.ts; this file only gathers the two lists.
//
// The live side comes from PostgREST's own root document, which names every table it
// exposes, rather than from a catalogue query. That is deliberate: it needs no function to
// be added to the database to ask a question ABOUT the database, and it is the same surface
// the grants question is really about, since a table PostgREST does not expose is not
// reachable over the API at all. Confirmed against production on 2026-09-17: 41 definitions,
// matching a direct count of pg_class exactly.
//
// The declared side goes through the repo's own `parseDeclaredTables`, the same parser the
// RLS and grants scans use, so the two sides cannot disagree about what "declared" means
// (L41). It nets out a create followed by a later drop, because migrations are append only.
//
// Exit codes are TABLE_DRIFT_EXIT, plus 1 for "no credentials here", decided before anything
// is read so it can never be confused with a finding.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFiles } from "./smoke-env.ts";
import { parseDeclaredTables } from "./lib/parse-migration-constraints.ts";
import {
  TABLE_DRIFT_EXIT,
  describeTableDrift,
  judgeTableDrift,
  tablesFromRootDocument,
} from "./lib/table-drift.ts";

loadEnvFiles([".env.local", ".dev.vars"]);
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SECRET_KEY?.trim();
if (!url || !key) {
  console.error(
    "FAILED (not-configured): SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL are needed here; nothing was read",
  );
  process.exit(1);
}

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function declaredTables(): string[] {
  const all = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
  return [...parseDeclaredTables(all)].sort();
}

async function liveTables(): Promise<string[] | null> {
  let status: number;
  let body: unknown;
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key as string, Authorization: `Bearer ${key}` },
    });
    status = res.status;
    // A body that is not JSON is not a table list, and saying which failure it was is the
    // whole point of keeping these apart.
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error(
      `could not read the live table list: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const read = tablesFromRootDocument({ status, body });
  if (!read.ok) {
    console.error(`could not read the live table list: ${read.why}`);
    return null;
  }
  return read.tables;
}

const live = await liveTables();
if (live === null) {
  console.error("FAILED (read-failed): production's table list could not be read, so nothing was compared");
  process.exit(TABLE_DRIFT_EXIT.readFailed);
}

const declared = declaredTables();
const verdict = judgeTableDrift({ live, declared });

console.log(`compared ${live.length} live tables against ${declared.length} declared by migrations`);
console.log(describeTableDrift(verdict));

if (verdict.code === TABLE_DRIFT_EXIT.agree) {
  console.log("PASSED");
} else {
  console.error(`FAILED (exit ${verdict.code})`);
}
process.exit(verdict.code);

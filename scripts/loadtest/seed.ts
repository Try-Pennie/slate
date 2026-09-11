// Seeds an ISOLATED (branch/local) DB with a 200-agent org for the load test: org
// + event type + 60 XBC buckets + agents + schedules/rules + agent_calendars +
// realistic in-window busy_blocks. Inserts via the Supabase REST API (same posture
// as scripts/seed-buckets.ts). Idempotent-ish: safe on a fresh branch.
//
// SAFETY: refuses to run against the production project ref unless FORCE=1.
//
// Two things it now copies from production rather than inventing (#2243):
//
//   the EVENT TYPE. It used to seed 30 minutes on a 15 minute grid; production is
//   20 on a 10 with 120 minutes notice, measured 2026-09-11. The grid is what
//   decides how many slots a day offers and therefore how much four drivers
//   contend, so seeding the wrong one makes the whole run a test of a shape
//   nothing runs;
//
//   the ROSTER SHAPE, through `roster-shape.ts`. `ROSTER_SHAPE_FILE` points at a
//   fresher export from `export-roster-shape.ts` when there is one.
//
// It also REFUSES a branch whose migrations do not match what this checkout ships,
// because the migration directory has never been replayed from empty (L570) and a
// seed against a half-migrated branch produces a run whose findings are about the
// schema.
//
// Run (against a branch):
//   SUPABASE_URL=https://<branch-ref>.supabase.co \
//   SUPABASE_SECRET_KEY=<branch secret key> \
//   node --experimental-strip-types scripts/loadtest/seed.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allXbcCodes, bucketSpecForXbc } from "../../src/lib/xbc.ts";
import { SHIPPED_MIGRATION_VERSION } from "../../src/lib/db/migration-version.ts";
import { generateSeed } from "./generate.ts";
import { PRODUCTION_SHAPE, type RosterShape } from "./roster-shape.ts";
import { migrationMismatch, readAgentCount } from "./seed-guards.ts";

const PROD_REF = "drukfvgaynzrralbzkzj";
const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_TYPE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_COUNT = (() => {
  const n = readAgentCount(process.env.AGENTS, 200);
  if (n === null) {
    throw new Error(
      `AGENTS is not a positive whole number: ${JSON.stringify(process.env.AGENTS)}. Refused by ` +
        `name rather than left to become a roster of NaN agents.`,
    );
  }
  return n;
})();

function loadEnv(): Record<string, string> {
  const fromFile: Record<string, string> = {};
  const p = join(import.meta.dirname, "../../.env.local");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      fromFile[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1).trim();
    }
  }
  const url = process.env.SUPABASE_URL ?? fromFile.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? fromFile.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY (the BRANCH).");
  if (url.includes(PROD_REF) && process.env.FORCE !== "1") {
    throw new Error(
      `Refusing to seed the production project (${PROD_REF}). Point SUPABASE_URL at a branch, or set FORCE=1 if you really mean it.`,
    );
  }
  return { url: `${url}/rest/v1`, key };
}

const { url: BASE, key: KEY } = loadEnv();
const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
  Prefer: "resolution=merge-duplicates,return=minimal",
};

async function insert(table: string, rows: unknown[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await fetch(`${BASE}/${table}`, {
      method: "POST",
      headers: H,
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
    });
    if (!res.ok) {
      throw new Error(`insert ${table} [${i}] -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

/**
 * The roster shape to reproduce: a fresher export if one is named, else the one
 * baked in from 2026-09-11.
 *
 * An unreadable file REFUSES rather than falling back to the default. Falling back
 * would seed a run against a shape nobody chose while the log said the file had
 * been honoured, and the whole point of pointing at a file is that the run is
 * about the roster in it.
 */
function loadShape(): RosterShape {
  const path = process.env.ROSTER_SHAPE_FILE;
  if (!path) return PRODUCTION_SHAPE;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`ROSTER_SHAPE_FILE ${path} could not be read: ${(err as Error).message}`);
  }
  const shape = JSON.parse(raw) as RosterShape;
  if (!Array.isArray(shape.profiles) || shape.profiles.length === 0) {
    throw new Error(`ROSTER_SHAPE_FILE ${path} carries no profiles`);
  }
  console.log(`  roster shape: ${path} (measured ${shape.measuredAt}, ${shape.agents} agents)`);
  return shape;
}

/**
 * The branch must hold EXACTLY the migrations this checkout ships, and the count
 * must match too.
 *
 * The highest version alone is not enough: the directory has never been replayed
 * from empty (L570), so a branch can carry the newest file and be missing one in
 * the middle, and every finding of the run would then be about the schema rather
 * than about the booking path. Refused rather than warned, because a seed is cheap
 * to re-run and a ten minute load run judged against the wrong schema is not.
 */
async function assertMigrationsMatch(): Promise<void> {
  const shipped = readdirSync(join(import.meta.dirname, "../../supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, 4))
    .sort();
  const res = await fetch(`${BASE}/supabase_migrations.schema_migrations?select=version`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "accept-profile": "supabase_migrations" },
  });
  if (!res.ok) {
    throw new Error(
      `could not read the branch's applied migrations (${res.status}). The seed refuses to ` +
        `run against a schema it cannot check.`,
    );
  }
  const applied = ((await res.json()) as { version: string }[]).map((r) => r.version);
  // The DECISION lives in `seed-guards.ts` and is pinned offline; this is the read.
  const why = migrationMismatch(applied, shipped, SHIPPED_MIGRATION_VERSION);
  if (why) throw new Error(why);
  console.log(`  migrations: ${applied.length} applied, highest ${SHIPPED_MIGRATION_VERSION}`);
}

async function main() {
  console.log(`Seeding ${AGENT_COUNT} agents into ${BASE} ...`);
  await assertMigrationsMatch();

  await insert("organizations", [{ id: ORG_ID, name: "Loadtest Org" }]);
  // Production's own event type, measured 2026-09-11: 20 minutes on a 10 minute
  // grid with 120 minutes notice and no buffers. The grid is what decides how many
  // slots a day offers, so it decides how much four drivers contend; a 30-on-15
  // seed offers a third fewer times and understates exactly that.
  await insert("event_types", [
    {
      id: EVENT_TYPE_ID,
      org_id: ORG_ID,
      name: "Loadtest call",
      duration_min: 20,
      slot_interval_min: 10,
      min_notice_min: 120,
    },
  ]);

  const buckets = allXbcCodes().map((code) => {
    const spec = bucketSpecForXbc(code);
    return {
      org_id: ORG_ID,
      code,
      name: spec?.name ?? code,
      event_type_id: EVENT_TYPE_ID,
      assignment: "round_robin",
      criteria: spec?.criteria ?? {},
    };
  });
  await insert("buckets", buckets);

  const seed = generateSeed({
    agentCount: AGENT_COUNT,
    orgId: ORG_ID,
    nowMs: Date.now(),
    windowDays: 4,
    blocksPerAgentPerDay: Number(process.env.BLOCKS_PER_DAY ?? 12),
    calendarsPerAgent: Number(process.env.CALS_PER_AGENT ?? 1),
    shape: loadShape(),
  });
  await insert("users", seed.users);
  await insert("availability_schedules", seed.schedules);
  await insert("availability_rules", seed.rules);
  await insert("agent_calendars", seed.agentCalendars);
  await insert("busy_blocks", seed.busyBlocks);

  console.log(
    `Done. ${seed.users.length} agents, ${buckets.length} buckets, ${seed.busyBlocks.length} busy_blocks.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

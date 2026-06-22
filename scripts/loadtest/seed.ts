// Seeds an ISOLATED (branch/local) DB with a 200-agent org for the #273
// load test: org + event type + 60 XBC buckets + agents (attrs spanning the
// XBC space) + schedules/rules + agent_calendars + realistic in-window
// busy_blocks. Inserts via the Supabase REST API (same posture as
// scripts/seed-buckets.ts). Idempotent-ish: safe on a fresh branch.
//
// SAFETY: refuses to run against the production project ref unless FORCE=1.
//
// Run (against a branch):
//   SUPABASE_URL=https://<branch-ref>.supabase.co \
//   SUPABASE_SECRET_KEY=<branch secret key> \
//   node --experimental-strip-types scripts/loadtest/seed.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allXbcCodes, bucketSpecForXbc } from "../../src/lib/xbc.ts";
import { generateSeed } from "./generate.ts";

const PROD_REF = "drukfvgaynzrralbzkzj";
const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_TYPE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_COUNT = Number(process.env.AGENTS ?? 200);

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

async function main() {
  console.log(`Seeding ${AGENT_COUNT} agents into ${BASE} ...`);

  await insert("organizations", [{ id: ORG_ID, name: "Loadtest Org" }]);
  await insert("event_types", [
    { id: EVENT_TYPE_ID, org_id: ORG_ID, name: "Loadtest call", duration_min: 30, slot_interval_min: 15, min_notice_min: 120 },
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

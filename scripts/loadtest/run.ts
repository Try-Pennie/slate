// Drives the cron lanes against the seeded (isolated) DB and reports whether
// they hold up at 200 agents (#273 Increment 5). Point it at an app instance
// running with SLATE_LOADTEST=true and env -> the branch DB; this hits the
// recompute + sync endpoints repeatedly and prints per-tick timings + freshness.
//
// Run:
//   SLATE_BASE=http://localhost:3000 CRON_SECRET=<secret> \
//   SUPABASE_URL=https://<branch>.supabase.co SUPABASE_SECRET_KEY=<key> \
//   node --experimental-strip-types scripts/loadtest/run.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function env(name: string, fallbackKey?: string): string {
  if (process.env[name]) return process.env[name] as string;
  const p = join(import.meta.dirname, "../../.env.local");
  if (fallbackKey && existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (line.startsWith(`${fallbackKey}=`)) return line.slice(fallbackKey.length + 1).trim();
    }
  }
  return "";
}

const SLATE_BASE = process.env.SLATE_BASE ?? "http://localhost:3000";
const CRON_SECRET = env("CRON_SECRET", "CRON_SECRET");
const SUPA = `${env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")}/rest/v1`;
const SUPA_KEY = env("SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEY");
const TICKS = Number(process.env.TICKS ?? 10);

const auth = { Authorization: `Bearer ${CRON_SECRET}` };
const stats = (xs: number[]) => {
  if (!xs.length) return { p50: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return { p50: Math.round(s[Math.floor(s.length / 2)]), max: Math.round(s[s.length - 1]) };
};

async function hit(path: string): Promise<{ ms: number; body: Record<string, unknown> }> {
  const t0 = performance.now();
  const res = await fetch(`${SLATE_BASE}${path}`, { headers: auth });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ms: performance.now() - t0, body };
}

async function freshness(): Promise<{ total: number; stale6m: number; spreadSec: number }> {
  const res = await fetch(`${SUPA}/bucket_slots?select=computed_at`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  const rows = (await res.json()) as { computed_at: string }[];
  const ts = rows.map((r) => Date.parse(r.computed_at)).sort((a, b) => a - b);
  const now = Date.now();
  return {
    total: ts.length,
    stale6m: ts.filter((t) => now - t > 6 * 60_000).length,
    spreadSec: ts.length ? Math.round((ts[ts.length - 1] - ts[0]) / 1000) : 0,
  };
}

async function driveLane(path: string): Promise<void> {
  const times: number[] = [];
  let lastBody: Record<string, unknown> = {};
  for (let i = 0; i < TICKS; i++) {
    const { ms, body } = await hit(path);
    times.push(ms);
    lastBody = body;
  }
  const { p50, max } = stats(times);
  console.log(`  ${path}: p50 ${p50}ms, max ${max}ms over ${TICKS} ticks; last=${JSON.stringify(lastBody)}`);
}

async function main() {
  if (!CRON_SECRET) throw new Error("Set CRON_SECRET (same value the app uses).");
  console.log(`Driving ${SLATE_BASE} for ${TICKS} ticks/lane ...\n`);

  console.log("RECOMPUTE lane (the one that saturated):");
  await driveLane("/api/cron/recompute");
  console.log("\nSYNC lane:");
  await driveLane("/api/cron/sync");
  console.log("\nWATCH lane:");
  await driveLane("/api/cron/watch");

  if (SUPA_KEY) {
    const f = await freshness();
    console.log(
      `\nFreshness: ${f.total} buckets, ${f.stale6m} stale >6m, ${f.spreadSec}s spread across the set.`,
    );
  }
  console.log(
    "\nPASS if: recompute p50 is well under 50000ms (budget) and drains its due set,\n" +
      "no lane errors, and stale>6m stays 0. See RUNBOOK.md for interpretation + the subrequest-ceiling check.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

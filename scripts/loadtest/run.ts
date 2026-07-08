// Drives the cron lanes against the seeded (isolated) DB and reports whether
// they hold up at 200 agents (#273 Increment 5) AND whether the booking-outbox
// drain lane (#429/#440 P5) self-heals a crash backlog without starving the
// sync tail. Point it at an app instance running with SLATE_LOADTEST=true and
// env -> the branch DB.
//
// It hits recompute + sync + watch repeatedly (the #273 starvation check), then
// drains /api/cron/outbox to empty while re-driving the sync lane each pass (the
// #440 starvation check), drives /api/cron/complete + /api/cron/selfheal, and
// finally runs invariant queries against the DB: every crash row self-healed,
// no cancelled booking kept a stuck slot, and booking.cancelled fired exactly
// once per row (the (endpoint,event,dedupe_key) unique index held).
//
// Run:
//   SLATE_BASE=http://localhost:3000 CRON_SECRET=<secret> \
//   SUPABASE_URL=https://<branch>.supabase.co SUPABASE_SECRET_KEY=<key> \
//   node --experimental-strip-types scripts/loadtest/run.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkSoakInvariants } from "./invariants.ts";

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
const MAX_DRAIN_TICKS = Number(process.env.MAX_DRAIN_TICKS ?? 60);

const auth = { Authorization: `Bearer ${CRON_SECRET}` };
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };
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

/** Exact row count via PostgREST's Content-Range (Prefer: count=exact, HEAD). */
async function count(pathAndFilter: string): Promise<number> {
  const res = await fetch(`${SUPA}/${pathAndFilter}`, {
    method: "HEAD",
    headers: { ...supaHeaders, Prefer: "count=exact" },
  });
  const range = res.headers.get("content-range") ?? "*/0";
  return Number(range.split("/")[1] ?? 0);
}

async function rows(pathAndFilter: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${SUPA}/${pathAndFilter}`, { headers: supaHeaders });
  return (await res.json().catch(() => [])) as Record<string, unknown>[];
}

/**
 * Every row of a result set, paginated via Range so PostgREST's 1000-row cap can
 * never silently truncate an invariant into a false pass (the #440 soak bug).
 */
async function listAll(pathAndFilter: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPA}/${pathAndFilter}`, {
      headers: { ...supaHeaders, Range: `${from}-${from + PAGE - 1}` },
    });
    const page = (await res.json().catch(() => [])) as Record<string, unknown>[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** One selfheal tick, normalised to the shape the convergence loop expects. */
async function selfhealTick(): Promise<{ freed: number; recreated: number }> {
  const { body } = await hit("/api/cron/selfheal");
  return {
    freed: Number(body.stuckFreed ?? 0),
    recreated: Number(body.missingRecreated ?? 0),
  };
}

async function freshness(): Promise<{ total: number; stale6m: number; spreadSec: number }> {
  const ts = (await rows("bucket_slots?select=computed_at"))
    .map((r) => Date.parse(r.computed_at as string))
    .sort((a, b) => a - b);
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

/**
 * Drain /api/cron/outbox until no pending rows remain (or MAX_DRAIN_TICKS),
 * re-driving the sync lane each pass so we can see the outbox drain does NOT
 * starve the 25s sync tail (#440). Reports both lanes' per-tick timings.
 */
async function drainOutboxToEmpty(): Promise<{ ticks: number; drained: boolean }> {
  const outboxTimes: number[] = [];
  const syncTimes: number[] = [];
  let ticks = 0;
  let pending = await count("booking_outbox?status=eq.pending");
  console.log(`  starting backlog: ${pending} pending outbox rows`);
  while (pending > 0 && ticks < MAX_DRAIN_TICKS) {
    const ob = await hit("/api/cron/outbox");
    const sy = await hit("/api/cron/sync"); // interleaved: prove it stays healthy
    outboxTimes.push(ob.ms);
    syncTimes.push(sy.ms);
    ticks++;
    pending = await count("booking_outbox?status=eq.pending");
  }
  const o = stats(outboxTimes);
  const s = stats(syncTimes);
  console.log(`  outbox: p50 ${o.p50}ms, max ${o.max}ms over ${ticks} ticks; ${pending} still pending`);
  console.log(`  sync while draining: p50 ${s.p50}ms, max ${s.max}ms (must stay well under 25000ms)`);
  return { ticks, drained: pending === 0 };
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

  console.log("\nOUTBOX drain (#440 P5 crash-backlog self-heal, sync interleaved):");
  const drain = await drainOutboxToEmpty();
  console.log("\nCOMPLETE lane:");
  await driveLane("/api/cron/complete");

  if (SUPA_KEY) {
    // SELFHEAL to convergence + invariants. reconcile (#428) is capped at 200
    // blocks/tick, so this loops until a tick frees nothing before reading the
    // stuck-slot invariant. All counts are uncapped server-side counts (the delivery
    // set is paginated) so a large soak can't truncate into a false pass (#440).
    console.log("\nSELFHEAL to convergence (#401/#428 backstops) + INVARIANTS:");
    const inv = await checkSoakInvariants({
      count,
      listAll,
      driveSelfheal: selfhealTick,
      log: (m) => console.log(m),
    });
    console.log(`  selfheal converged in ${inv.selfhealTicks} ticks; ${inv.deliveries} deliveries checked`);

    const f = await freshness();
    console.log(
      `\nFreshness: ${f.total} buckets, ${f.stale6m} stale >6m, ${f.spreadSec}s spread across the set.`,
    );

    console.log("\nINVARIANTS (post-soak):");
    if (inv.pass) console.log("  ok: every invariant held (outbox delivered, no stuck slots, exactly-once webhooks)");
    else for (const msg of inv.failures) console.log(`  FAIL: ${msg}`);

    console.log(
      "\nPASS if: recompute p50 well under 50000ms and drains its due set; the outbox\n" +
        "backlog drained to 0 while the interleaved sync lane stayed well under 25000ms;\n" +
        "stale>6m is 0; and every invariant above is ok. See RUNBOOK.md.",
    );
    if (!drain.drained) console.log("WARN: outbox did not drain to empty within MAX_DRAIN_TICKS.");
    process.exit(inv.pass && drain.drained ? 0 : 1);
  }
  console.log("\n(No SUPABASE_SECRET_KEY set: skipped freshness + invariant checks.)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

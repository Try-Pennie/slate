// Routing fairness report (#348): the cutover go/no-go artifact for equal-share
// routing (#305). Reads the bookings for a pay period and reports, per bucket and
// per agent, availability-corrected fairness from each booking's
// `routing_trace.considered` (the free+eligible candidate set recorded at
// assignment). An agent is only "expected" bookings for slots they were a
// candidate for, so a rarely-free agent is judged fairly, not flagged as
// under-served. Read-only.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=<secret> \
//     node --experimental-strip-types scripts/routing-fairness-report.ts
//
// Optional env:
//   FAIRNESS_PERIOD_AT  ISO instant to anchor the pay period (default: now).
//   FAIRNESS_MIN_BOOKINGS  buckets below this are flagged insufficient (default 20).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { payPeriod } from "../src/lib/availability/roundrobin.ts";
import { computeFairness, type TraceRow } from "../src/lib/availability/fairness.ts";

function loadEnv(): { url: string; key: string } {
  const fromFile: Record<string, string> = {};
  const p = join(import.meta.dirname, "../.env.local");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      fromFile[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1).trim();
    }
  }
  const url = process.env.SUPABASE_URL ?? fromFile.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SECRET_KEY ?? fromFile.SUPABASE_SECRET_KEY ?? "";
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY.");
  return { url: `${url}/rest/v1`, key };
}

const { url: BASE, key: KEY } = loadEnv();
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function get(path: string): Promise<unknown[]> {
  const res = await fetch(`${BASE}/${path}`, { headers: { ...H, Prefer: "count=none" } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as unknown[];
}

interface RoutingTrace {
  bucket_code: string;
  chosen_user_id: string;
  considered: string[];
}

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const num = (n: number, w = 7) => n.toFixed(2).padStart(w);

async function main() {
  const anchorMs = process.env.FAIRNESS_PERIOD_AT
    ? Date.parse(process.env.FAIRNESS_PERIOD_AT)
    : Date.now();
  const minBookings = Number(process.env.FAIRNESS_MIN_BOOKINGS ?? "20");
  const period = payPeriod(anchorMs);
  const fromIso = new Date(period.startMs).toISOString();
  const toIso = new Date(period.endMs).toISOString();

  // Match the ranker's own counting: same status filter + starts_at window.
  const rowsRaw = (await get(
    `bookings?select=routing_trace&starts_at=gte.${fromIso}&starts_at=lt.${toIso}` +
      `&status=in.(confirmed,rescheduled,completed)&routing_trace=not.is.null&limit=100000`,
  )) as { routing_trace: RoutingTrace | null }[];

  // Only original ranker decisions: a reschedule blanks `considered`, so those
  // rows carry no candidacy and are skipped (they did not exercise the ranker).
  const rows: TraceRow[] = rowsRaw
    .map((r) => r.routing_trace)
    .filter((t): t is RoutingTrace => !!t && Array.isArray(t.considered) && t.considered.length > 0)
    .map((t) => ({ bucketCode: t.bucket_code, chosenUserId: t.chosen_user_id, considered: t.considered }));

  const users = (await get("users?select=id,name,email")) as { id: string; name: string | null; email: string | null }[];
  const label = new Map(users.map((u) => [u.id, u.name || u.email || u.id]));
  const who = (id: string) => label.get(id) ?? id;

  const report = computeFairness(rows, { minBookings });

  console.log(`\nRouting fairness  period ${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}  (${rows.length} ranker decisions)\n`);
  console.log("Negative deviation = under-served (got fewer than a fair split would give, accounting for availability).\n");

  for (const b of report.buckets) {
    const flag = b.insufficient ? `  [INSUFFICIENT: ${b.bookings} < ${minBookings}, skew unreliable]` : "";
    console.log(`Bucket ${b.bucketCode}  (${b.bookings} bookings)${flag}`);
    console.log(`  ${pad("agent", 32)} ${pad("got", 7)} ${pad("fair", 7)} ${pad("deviation", 9)}`);
    for (const a of b.agents) {
      console.log(`  ${pad(who(a.userId), 32)} ${String(a.received).padStart(7)} ${num(a.expected)} ${num(a.deviation, 9)}`);
    }
    console.log("");
  }

  console.log("Per-agent total across all buckets (commission-relevant):");
  console.log(`  ${pad("agent", 32)} ${pad("got", 7)} ${pad("fair", 7)} ${pad("deviation", 9)}`);
  for (const a of report.byAgent) {
    console.log(`  ${pad(who(a.userId), 32)} ${String(a.received).padStart(7)} ${num(a.expected)} ${num(a.deviation, 9)}`);
  }
  console.log("");
}

void main();

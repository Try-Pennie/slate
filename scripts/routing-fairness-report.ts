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
import { computeFairness, excludeTestEntities, type TraceRow } from "../src/lib/availability/fairness.ts";

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

  // Match the ranker's own counting: same status filter + starts_at window. We
  // fetch ALL commission-relevant bookings (no routing_trace filter) so the raw
  // bookings-received total (#424) sees reassign/reschedule rows the ranker math
  // skips; assigned_user_id is the CURRENT owner, reflecting manual reassigns.
  const rowsRaw = (await get(
    `bookings?select=routing_trace,assigned_user_id&starts_at=gte.${fromIso}&starts_at=lt.${toIso}` +
      `&status=in.(confirmed,rescheduled,completed)&limit=100000`,
  )) as { routing_trace: RoutingTrace | null; assigned_user_id: string | null }[];

  // Only original ranker decisions: a reschedule blanks `considered`, so those
  // rows carry no candidacy and are skipped (they did not exercise the ranker).
  const rows: TraceRow[] = rowsRaw
    .map((r) => r.routing_trace)
    .filter((t): t is RoutingTrace => !!t && Array.isArray(t.considered) && t.considered.length > 0)
    .map((t) => ({ bucketCode: t.bucket_code, chosenUserId: t.chosen_user_id, considered: t.considered }));

  // Raw bookings-received: every booking's current owner, including ones gained
  // via reassign/reschedule that never exercised the ranker (#424).
  const rawAssignments = rowsRaw
    .map((r) => r.assigned_user_id)
    .filter((id): id is string => !!id);

  const users = (await get("users?select=id,name,email,is_test")) as {
    id: string;
    name: string | null;
    email: string | null;
    is_test: boolean;
  }[];
  const label = new Map(users.map((u) => [u.id, u.name || u.email || u.id]));
  const who = (id: string) => label.get(id) ?? id;

  // Exclude synthetic test entities (#460): the smoke-test agent and its
  // isolated test buckets are real, bookable rows (assignment must still reach
  // them for the smoke test), but they must never be counted in this
  // cross-bucket / org-wide fairness report. Drop their bookings and raw
  // assignments before the math, matching how the read-side gates exclude with
  // is_test = false.
  const testUserIds = users.filter((u) => u.is_test).map((u) => u.id);
  const testBuckets = (await get("buckets?select=code&is_test=eq.true")) as { code: string }[];
  const cleaned = excludeTestEntities(rows, rawAssignments, {
    testUserIds,
    testBucketCodes: testBuckets.map((b) => b.code),
  });

  const report = computeFairness(cleaned.rows, { minBookings, rawAssignments: cleaned.rawAssignments });

  console.log(`\nRouting fairness  period ${fromIso.slice(0, 10)} to ${toIso.slice(0, 10)}  (${cleaned.rows.length} ranker decisions)\n`);
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

  console.log("Per-agent total across all buckets:");
  console.log("  got/fair/deviation = router-assigned only (ranker decisions).");
  console.log("  raw = ALL bookings received incl. reassign/reschedule (the commission-relevant count).");
  console.log(`  ${pad("agent", 32)} ${pad("got", 7)} ${pad("fair", 7)} ${pad("deviation", 9)} ${pad("raw", 7)}`);
  for (const a of report.byAgent) {
    console.log(
      `  ${pad(who(a.userId), 32)} ${String(a.received).padStart(7)} ${num(a.expected)} ${num(a.deviation, 9)} ${String(a.rawReceived).padStart(7)}`,
    );
  }
  console.log("");
}

void main();

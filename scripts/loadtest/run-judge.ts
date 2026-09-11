// Collect one booking load run's evidence and judge it (#2244).
//
// The JUDGEMENT is pure and lives in `judge-booking-run.ts`, pinned offline by
// `scripts/test-judge-booking-run.ts`. This file is the reads: the driver result
// files, the branch database, and Cloudflare's analytics. It writes ONE dated
// report and nothing else.
//
// Run:
//   RUN_ID=<run> RESULTS=results SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//   REPORT=reports/2026-09-15-run.md \
//   node --experimental-strip-types scripts/loadtest/run-judge.ts
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  judgeBookingRun,
  JUDGE_EXIT,
  type JudgeInput,
  type JudgedBooking,
  type PlatformReading,
} from "./judge-booking-run.ts";
import { DRIVERS, PER_DRIVER_PER_MINUTE, RUN_MINUTES, type DriverResult } from "./book-plan.ts";
import type { SoakSample } from "./invariants.ts";
import { PRODUCTION_SUPABASE_REF } from "../../src/lib/loadtest-guard.ts";

// ONE constant, shared with the app's own load test refusals (#2242). A second
// spelling beside each script is how one of them ends up naming a project that
// is not production (L2, L41).
const PROD_REF = PRODUCTION_SUPABASE_REF;

function need(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`FAILED: ${name} is not set, so nothing was judged.`);
    process.exit(1);
  }
  return v;
}

const RUN_ID = need("RUN_ID");
const RESULTS = need("RESULTS");
const REPORT = need("REPORT");
const SUPA_URL = need("SUPABASE_URL");
const SUPA_KEY = need("SUPABASE_SECRET_KEY");
if (SUPA_URL.includes(PROD_REF)) {
  console.error("FAILED: SUPABASE_URL points at production. A load run is judged against its branch.");
  process.exit(1);
}
const SUPA = `${SUPA_URL.replace(/\/$/, "")}/rest/v1`;
const H = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

/**
 * Every row, paginated. NEVER a single capped list: PostgREST returns at most one
 * 1000 row page, and a run makes 600 bookings, so a capped read of `bookings`
 * would silently hide exactly the overlaps this judge exists to find, which is how
 * the #440 soak invariant false-passed.
 */
async function listAll(pathAndFilter: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${SUPA}/${pathAndFilter}`, {
      headers: { ...H, Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`read ${pathAndFilter} -> ${res.status} ${await res.text()}`);
    const page = (await res.json()) as Record<string, unknown>[];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Driver files, by mode. A file this cannot read is REPORTED as missing rather
 *  than skipped, so the judge sees an incomplete run instead of a short one. */
function loadDrivers(mode: "steady" | "burst"): DriverResult[] {
  let names: string[] = [];
  try {
    names = readdirSync(RESULTS).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: DriverResult[] = [];
  for (const name of names) {
    try {
      const r = readJson<DriverResult>(join(RESULTS, name));
      if (r.mode === mode) out.push(r);
    } catch (err) {
      console.error(`note: ${name} could not be read (${(err as Error).message}); counted as missing`);
    }
  }
  return out.sort((a, b) => a.driver - b.driver);
}

/**
 * Cloudflare's own numbers, or nulls.
 *
 * Every failure resolves to NULL rather than to a zero, and the judge maps that to
 * `unmeasured`. A zero CPU reading and a pipeline that has not caught up are the
 * same value otherwise, and the pipeline has been measured three hours behind
 * (#1533).
 */
async function platformReading(fromIso: string, toIso: string): Promise<PlatformReading> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const script = process.env.LOADTEST_WORKER_NAME ?? "";
  if (!token || !account || !script) {
    console.error("note: no Cloudflare credentials, so the platform half is unmeasured");
    return { invocations: null, cpuMsP99: null, outcomes: null };
  }
  const query = `query($account:String!,$script:String!,$from:Time!,$to:Time!){
    viewer { accounts(filter:{accountTag:$account}) {
      workersInvocationsAdaptive(limit:10000, filter:{scriptName:$script, datetime_geq:$from, datetime_leq:$to}) {
        sum { requests subrequests }
        quantiles { cpuTimeP99 }
        dimensions { outcome }
      } } }
  }`;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { account, script, from: fromIso, to: toIso } }),
    });
    if (!res.ok) {
      console.error(`note: the analytics API answered ${res.status}, so the platform half is unmeasured`);
      return { invocations: null, cpuMsP99: null, outcomes: null };
    }
    const body = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: {
            workersInvocationsAdaptive?: {
              sum?: { requests?: number };
              quantiles?: { cpuTimeP99?: number };
              dimensions?: { outcome?: string };
            }[];
          }[];
        };
      };
    };
    const rows = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.error("note: the analytics API returned no rows, so the platform half is unmeasured");
      return { invocations: null, cpuMsP99: null, outcomes: null };
    }
    const outcomes: Record<string, number> = {};
    let invocations = 0;
    let cpuUs = 0;
    for (const r of rows) {
      const n = r.sum?.requests ?? 0;
      invocations += n;
      outcomes[r.dimensions?.outcome ?? "(unnamed)"] =
        (outcomes[r.dimensions?.outcome ?? "(unnamed)"] ?? 0) + n;
      // The worst p99 across the grouped rows, which is the honest reading: the API
      // reports a quantile per group and they cannot be averaged into one.
      cpuUs = Math.max(cpuUs, r.quantiles?.cpuTimeP99 ?? 0);
    }
    // MICROSECONDS, not milliseconds. The units are the trap here
    // (docs/cloudflare-platform-notes.md), and a reading a thousand times too small
    // sits comfortably under every budget.
    return { invocations, cpuMsP99: cpuUs / 1000, outcomes };
  } catch (err) {
    console.error(`note: the analytics read failed (${(err as Error).message}); platform half unmeasured`);
    return { invocations: null, cpuMsP99: null, outcomes: null };
  }
}

/**
 * The CPU budget, refused by NAME when it cannot be read.
 *
 * `Number("two hundred")` is NaN, and `cpuMsP99 > NaN` is false, so an unreadable
 * budget would make the CPU bar silently pass on every run while reading as
 * configured (L50).
 *
 * env-ok: CPU_BUDGET_MS (optional; defaults to 200ms, the per invocation budget
 * docs/cloudflare-platform-notes.md derives for the lanes, and only a deliberate
 * re-measurement would move it)
 */
function cpuBudgetMs(): number {
  const raw = (process.env.CPU_BUDGET_MS ?? "").trim();
  if (raw === "") return 200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`FAILED: CPU_BUDGET_MS is not a positive number: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

const steady = loadDrivers("steady");
const burst = loadDrivers("burst");

let samples: SoakSample[] = [];
try {
  samples = readJson<{ samples: SoakSample[] }>(join(RESULTS, "freshness.json")).samples;
} catch {
  console.error("note: no freshness samples were found, which the judge reports as incomplete");
}

let ipControl = { sent: 0, firstRefusedAt: null as number | null };
try {
  ipControl = readJson<typeof ipControl>(join(RESULTS, "ip-ceiling.json"));
} catch {
  console.error("note: no per address ceiling control was found");
}

let faultPass: JudgeInput["faultPass"];
try {
  faultPass = readJson<NonNullable<JudgeInput["faultPass"]>>(join(RESULTS, "fault-pass.json"));
} catch {
  // Absent is a run with no fault leg, which the judge handles; it is NOT an
  // implicit pass, because the judge only skips the bar when the leg is absent and
  // fails an empty one.
}

// Run scoped: every row this run created carries the run id in its external id, so
// nothing a previous run left behind can enter the overlap check.
const bookings = (await listAll(
  `bookings?select=id,external_id,idempotency_key,assigned_user_id,starts_at,ends_at,status&external_id=like.${RUN_ID}-*`,
)) as unknown as JudgedBooking[];
const blocks = await listAll("busy_blocks?select=booking_id&booking_id=not.is.null");

/**
 * Whether `bookings_active_slot_uniq` is really enforcing, taken from the
 * PREFLIGHT rather than from the catalogue.
 *
 * It used to ask PostgREST for `pg_indexes`. PostgREST does not expose that view:
 * measured 2026-09-11 it answers 404 everywhere, so the bar reported the index
 * missing on EVERY run and would have been muted by the second week (L36). The
 * preflight plants a real duplicate and records whether the database refused it,
 * which is the behaviour the run depends on rather than a name in a catalogue
 * (L63): an index that is present but not enforcing reads as fine to a lookup.
 *
 * A MISSING preflight file is `false`, not `true`. The run has then not been shown
 * the index enforcing, and the judge's finding says exactly that.
 */
let slotUniqueIndexPresent = false;
try {
  slotUniqueIndexPresent = readJson<{ slotUniqueIndexEnforced?: boolean }>(
    join(RESULTS, "preflight.json"),
  ).slotUniqueIndexEnforced === true;
} catch {
  console.error(
    "note: no preflight result was found, so the run was never shown the unique index enforcing",
  );
}

const startedAt = Math.min(...steady.map((d) => d.startedAtMs), Date.now());
const finishedAt = Math.max(...steady.map((d) => d.finishedAtMs), startedAt);

const input: JudgeInput = {
  runId: RUN_ID,
  target: { drivers: DRIVERS, perDriverPerMinute: PER_DRIVER_PER_MINUTE, minutes: RUN_MINUTES },
  driverResults: steady,
  burstResults: burst,
  freshnessSamples: samples,
  bookings,
  bookingIdsWithBusyBlock: [...new Set(blocks.map((b) => String(b.booking_id)))],
  slotUniqueIndexPresent,
  ipCeilingControl: ipControl,
  platform: await platformReading(
    new Date(startedAt).toISOString(),
    new Date(finishedAt + 60_000).toISOString(),
  ),
  faultPass,
  budgets: { cpuMsP99: cpuBudgetMs() },
};

const result = judgeBookingRun(input);

const lines: string[] = [];
lines.push(`# Booking path load run ${RUN_ID}`);
lines.push("");
lines.push(`Judged ${new Date().toISOString()}. Verdict: **${result.verdict.toUpperCase()}**.`);
lines.push("");
if (result.incomplete.length > 0) {
  lines.push("## This run was not judged");
  lines.push("");
  lines.push(
    "Every rate below is computable from a partial run and every one of them looks plausible, " +
      "so nothing was computed at all.",
  );
  lines.push("");
  for (const why of result.incomplete) lines.push(`- ${why}`);
}
const m = result.measurements;
if (m) {
  lines.push("## What the run measured");
  lines.push("");
  lines.push(`- attempts: ${m.attempts}, confirmed: ${m.confirmed}`);
  lines.push(
    `- confirmed a minute: ${m.confirmedPerMinute.toFixed(1)} against a target of ${m.targetPerMinute}`,
  );
  lines.push(`- all responses: p50 ${m.all?.p50 ?? "n/a"}ms, p95 ${m.all?.p95 ?? "n/a"}ms, max ${m.all?.max ?? "n/a"}ms`);
  lines.push(`- successful only: p50 ${m.ok?.p50 ?? "n/a"}ms, p95 ${m.ok?.p95 ?? "n/a"}ms, max ${m.ok?.max ?? "n/a"}ms`);
  lines.push(`- 5xx: ${m.fiveXx}, no reply at all: ${m.noReply}, write refusals: ${m.writeRefusals}`);
  lines.push(`- refusals by the address Slate saw: ${JSON.stringify(m.refusalsByIp)}`);
  lines.push(`- worst recompute age: ${m.freshnessMaxSec}s`);
  lines.push("");
  lines.push("### Outcome mix");
  lines.push("");
  for (const [k, n] of Object.entries(m.outcomes).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${n}`);
  }
}
if (result.findings.length > 0) {
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  for (const f of result.findings) lines.push(`- **${f.bar}**: ${f.detail}`);
}
lines.push("");
lines.push(
  "Subrequests are deliberately not a bar: Cloudflare exposes no counter for them, so one could " +
    "never be measured. A breach arrives as a non-ok invocation outcome, which is what is judged.",
);

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
console.log(`\nreport written to ${REPORT}`);
process.exit(result.exit === JUDGE_EXIT.pass ? 0 : result.exit);

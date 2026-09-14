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
import { ceilingVerdict, exactAddressBound, type CeilingVerdict } from "./preflight-checks.ts";
import { DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "../../src/lib/rate-limit-core.ts";
import { burstControlStrength, type BurstDepthReading } from "./burst-target.ts";
import { REQUEST_CPU_P99_MS } from "./judge-booking-run.ts";
import {
  INVOCATIONS_QUERY,
  SCHEDULED_QUERY,
  readInvocationsResponse,
  readScheduledResponse,
  shouldPollAgain,
  pollTimings,
  WRANGLER_CRON_CPU_MS,
} from "./platform-reading.ts";
import {
  BOOKING_WRITES_PER_MINUTE,
  DRIVERS,
  PER_DRIVER_PER_MINUTE,
  RUN_MINUTES,
  type DriverMode,
  type DriverResult,
} from "./book-plan.ts";
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

/**
 * A whole number from a setting, or a refusal by name.
 *
 * `Number("")` is 0 and `Number("ten")` is NaN, and NaN compares false against
 * every threshold, so both would silently mean "this leg was not asked for" while
 * reading as configured (L50). An unset value really does mean zero and says so;
 * anything else unreadable stops the judge rather than quietly dropping a bar.
 */
function wholeNumber(raw: string | undefined, name: string): number {
  const v = (raw ?? "").trim();
  if (v === "") return 0;
  if (!/^\d+$/.test(v)) {
    console.error(`FAILED: ${name} is not a whole number: ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return Number(v);
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
function loadDrivers(mode: DriverMode): DriverResult[] {
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
 * Cloudflare's own numbers, or nulls, POLLED until the window settles (#2279).
 *
 * This bar had never once reached a reading. The recorded reason was a lagging
 * analytics pipeline; the real reason was that the query asked for
 * `dimensions { outcome }`, which is not a field, so the API answered HTTP 200
 * with an `errors` array and null data on every run and the reader reported an
 * empty window it had never successfully queried. The decision logic and the
 * queries now live in `platform-reading.ts` and are pinned offline.
 *
 * The poll is still worth having. The measured lag on 2026-09-13 was 1.9 minutes,
 * which a single immediate read routinely misses and a bounded poll rides out. It
 * is minutes rather than the three hours the issue quoted: that figure belongs to
 * the Workers LOGS query pipeline (#1533), a different system from this one.
 *
 * env-ok: PLATFORM_POLL_DEADLINE_MS (optional; how long to wait for the analytics
 * window to catch up, default 300000, five minutes, inside the judge job's 15)
 * env-ok: PLATFORM_POLL_INTERVAL_MS (optional; default 20000)
 */
async function platformReading(
  fromIso: string,
  toIso: string,
  expectedInvocations: number,
): Promise<PlatformReading> {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const script = process.env.LOADTEST_WORKER_NAME ?? "";
  const blind = (why: string): PlatformReading => ({
    invocations: null,
    cpuMsP99: null,
    subrequests: null,
    statuses: null,
    cron: null,
    unreadableWhy: why,
  });
  if (!token || !account || !script) {
    return blind(
      "no Cloudflare credentials on this runner, so the platform half was never queried",
    );
  }

  const variables = { account, script, from: fromIso, to: toIso };
  async function ask(query: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const timings = pollTimings(
    process.env.PLATFORM_POLL_DEADLINE_MS,
    process.env.PLATFORM_POLL_INTERVAL_MS,
  );
  if (!timings.ok) {
    console.error(`FAILED: ${timings.why}.`);
    process.exit(1);
  }
  const { deadlineMs, intervalMs } = timings.timings;
  const startedAtMs = Date.now();
  let last: ReturnType<typeof readInvocationsResponse> | null = null;

  for (;;) {
    try {
      const { status, body } = await ask(INVOCATIONS_QUERY);
      last = readInvocationsResponse(status, body);
    } catch (err) {
      last = { ok: false, why: `the analytics read failed: ${(err as Error).message}` };
    }
    const decision = shouldPollAgain({
      invocations: last.ok ? last.reading.invocations : null,
      expected: expectedInvocations,
      elapsedMs: Date.now() - startedAtMs,
      deadlineMs,
    });
    console.error(
      `note: platform window ${decision.reason} after ` +
        `${Math.round((Date.now() - startedAtMs) / 1000)}s ` +
        `(${last.ok ? last.reading.invocations : "no reading"} of ${expectedInvocations} invocations)`,
    );
    if (!decision.again) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (!last || !last.ok) {
    return blind(last?.why ?? "the analytics API was never read");
  }

  // The scheduled half, asked ONCE and only after the window has settled. Without
  // it the CPU reading cannot be told apart from the cron lanes, so the judge
  // refuses to claim anything about CPU rather than guessing (L98).
  let cron: PlatformReading["cron"] = null;
  let cronWhy: string | null = null;
  try {
    const { status, body } = await ask(SCHEDULED_QUERY);
    const read = readScheduledResponse(status, body);
    if (read.ok) cron = read.reading;
    else cronWhy = read.why;
  } catch (err) {
    cronWhy = `the scheduled read failed: ${(err as Error).message}`;
  }

  return {
    invocations: last.reading.invocations,
    cpuMsP99: last.reading.cpuMsP99,
    subrequests: last.reading.subrequests,
    statuses: last.reading.statuses,
    cron,
    unreadableWhy: cronWhy,
  };
}

/**
 * The REQUEST path's CPU budget, refused by NAME when it cannot be read.
 *
 * `Number("two hundred")` is NaN, and `cpuMsP99 > NaN` is false, so an unreadable
 * budget would make the CPU bar silently pass on every run while reading as
 * configured (L50).
 *
 * The default is `REQUEST_CPU_P99_MS`, derived from the run's own latency bar. It
 * used to be 200ms, which is the LANE budget for a scheduled invocation and a
 * different question entirely: a borrowed number is a bar nobody derived (#2321).
 *
 * env-ok: CPU_BUDGET_MS (optional; defaults to the request path budget derived in
 * judge-booking-run.ts, and only a deliberate re-derivation would move it)
 */
function cpuBudgetMs(): number {
  const raw = (process.env.CPU_BUDGET_MS ?? "").trim();
  if (raw === "") return REQUEST_CPU_P99_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`FAILED: CPU_BUDGET_MS is not a positive number: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

/**
 * The ceiling a SCHEDULED invocation is killed at, which is a different number
 * from the per request budget above and about a different thing.
 *
 * It mirrors `limits.cpu_ms` in wrangler.jsonc (120000). A cron lane approaching it
 * is a real finding; measured on production 2026-09-13 the every minute lane peaked
 * at 74,365ms, about 62 percent of it. `scripts/test-loadtest-platform-reading.ts`
 * holds this against wrangler.jsonc so the two cannot drift (L41).
 *
 * env-ok: CRON_CPU_BUDGET_MS (optional; defaults to the shipped `limits.cpu_ms`)
 */
function cronCpuBudgetMs(): number {
  const raw = (process.env.CRON_CPU_BUDGET_MS ?? "").trim();
  if (raw === "") return WRANGLER_CRON_CPU_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`FAILED: CRON_CPU_BUDGET_MS is not a positive number: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

const steady = loadDrivers("steady");
const burst = loadDrivers("burst");
// What the run itself sent on the steady pass. It is the CONTROL the analytics
// count is polled against: the run knows how many requests it made, so a count far
// under it means the window has not caught up rather than that the Worker was idle.
const steadyAttempts = steady.reduce((n, d) => n + d.attempts.length, 0);

let samples: SoakSample[] = [];
try {
  samples = readJson<{ samples: SoakSample[] }>(join(RESULTS, "freshness.json")).samples;
} catch {
  console.error("note: no freshness samples were found, which the judge reports as incomplete");
}

// A MISSING artifact is judged by the same function as a present one, from an
// empty status list, so "the step never ran" gets its own conclusion rather than
// being hand assembled here into something that looks like a reading (L98).
let ipControl: CeilingVerdict = ceilingVerdict(
  [],
  BOOKING_WRITES_PER_MINUTE,
  exactAddressBound(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES) ?? 0,
);
try {
  ipControl = readJson<CeilingVerdict>(join(RESULTS, "ip-ceiling.json"));
} catch {
  console.error("note: no per address ceiling control was found");
}

/**
 * The fault pass, derived from the fault leg's OWN driver files rather than from a
 * summary somebody wrote beside them (#2262).
 *
 * One derivation, not two (L70). A separate `fault-pass.json` holding the same
 * three numbers would be a second place they could disagree, and the one that
 * matters, the percentage, is not a number this side of the run knows: the driver
 * reads it from the deployment before it sends anything, and a deployment running
 * zero percent answers every request perfectly and satisfies the bar with no fault
 * ever injected (L98).
 *
 * Absent is a run with no fault leg. That is NOT an implicit pass: whether it was
 * asked for is `expectedLegs.faultPct`, and the judge calls a configured leg that
 * never arrived incomplete.
 */
const faultDrivers = loadDrivers("fault");
let faultPass: JudgeInput["faultPass"];
if (faultDrivers.length > 0) {
  const attempts = faultDrivers.flatMap((d) => d.attempts);
  const reported = [...new Set(faultDrivers.map((d) => d.faultPct ?? 0))];
  if (reported.length > 1) {
    // Two fault drivers that saw different percentages were not measuring one
    // deployment, and folding them into an average would hide that (L11).
    console.error(
      `note: fault drivers reported different percentages (${reported.join(", ")}); the lowest is ` +
        "carried so the judge compares against what at least one of them actually met",
    );
  }
  faultPass = {
    attempts: attempts.length,
    fiveXx: attempts.filter((a) => a.status >= 500 && a.status <= 599).length,
    faultPct: Math.min(...reported),
  };
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
let overlapConstraintPresent = false;
try {
  const pre = readJson<{ slotUniqueIndexEnforced?: boolean; overlapConstraintEnforced?: boolean }>(
    join(RESULTS, "preflight.json"),
  );
  slotUniqueIndexPresent = pre.slotUniqueIndexEnforced === true;
  // Read the same way and defaulting the same way (#2274): a preflight predating
  // this field leaves it ABSENT, and absent must mean "never shown to enforce"
  // rather than "fine", or an old artifact silently vouches for a guard nobody
  // exercised.
  overlapConstraintPresent = pre.overlapConstraintEnforced === true;
} catch {
  console.error(
    "note: no preflight result was found, so the run was never shown either guard enforcing",
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
  overlapConstraintPresent,
  ipCeilingControl: ipControl,
  platform: await platformReading(
    new Date(startedAt).toISOString(),
    new Date(finishedAt + 60_000).toISOString(),
    steadyAttempts,
  ),
  faultPass,
  // What this run was CONFIGURED to include, so a leg asked for and never
  // delivered is incomplete rather than quietly skipped. Both default to zero, so
  // a hand run that drove only the steady pass judges exactly as it did before.
  //
  // env-ok: EXPECT_BURST_DRIVERS (optional; the workflow's burst matrix size, and
  // zero for a hand run with no burst leg)
  // env-ok: EXPECT_FAULT_PCT (optional; the workflow's fault_pct input, and zero
  // for a hand run with no fault leg)
  expectedLegs: {
    burstDrivers: wholeNumber(process.env.EXPECT_BURST_DRIVERS, "EXPECT_BURST_DRIVERS"),
    faultPct: wholeNumber(process.env.EXPECT_FAULT_PCT, "EXPECT_FAULT_PCT"),
  },
  budgets: { cpuMsP99: cpuBudgetMs(), cronCpuMs: cronCpuBudgetMs() },
};

const result = judgeBookingRun(input);

/**
 * What the burst's pool depth was, for the report (#2278).
 *
 * `BURST_POOL_DEPTH` is empty when the setup could not measure it (a hand run that
 * named the code instead), and empty must stay UNMEASURED rather than becoming a
 * number: "nobody measured the depth" and "it was one deep" are the two states
 * this exists to tell apart (L98, L11).
 *
 * env-ok: BURST_POOL_DEPTH (optional; the depth setup-burst measured, and empty
 * for a hand run or a named code)
 * env-ok: BURST_CODE (optional; the code the burst actually fired at)
 */
function burstDepthReading(): BurstDepthReading | null {
  const code = (process.env.BURST_CODE ?? "").trim();
  if (code === "") return null;
  const raw = (process.env.BURST_POOL_DEPTH ?? "").trim();
  if (raw === "") {
    return { measured: false, code, why: "the setup did not report a measured depth" };
  }
  const depth = Number(raw);
  return Number.isFinite(depth)
    ? { measured: true, code, depth }
    : { measured: false, code, why: `the reported depth (${raw}) could not be read as a number` };
}

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
  // The number the run exists to produce after #2274, on EVERY run rather than
  // only when it is not zero (#2323). A measured zero and a check that never ran
  // read the same when neither prints, so the count carries its denominator.
  lines.push(
    `- overlapping pairs: ${m.overlappingPairs} over ${m.activeBookings} active bookings ` +
      `(same slot pairs: ${m.sameSlotPairs})`,
  );
  lines.push(`- worst recompute age: ${m.freshnessMaxSec}s`);
  // The strength of the burst control, stated rather than assumed (#2278). A run
  // with no burst leg says nothing here, because there was no control to describe.
  const burstDepth = burstDepthReading();
  if (burstDepth) lines.push(`- the burst's pool: ${burstControlStrength(burstDepth)}`);
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
  "Subrequests ARE counted: `sum { subrequests }` is a field, and this run's mean per invocation " +
    "is above. What Cloudflare does not expose is a PER INVOCATION maximum, which is what the 1000 " +
    "subrequest ceiling is about, so the mean is reported and never made a bar. A breach arrives as " +
    "an invocation status other than success, which IS judged. The previous wording here said no " +
    "counter existed at all, which was wrong (#2279).",
);

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
console.log(`\nreport written to ${REPORT}`);
process.exit(result.exit === JUDGE_EXIT.pass ? 0 : result.exit);

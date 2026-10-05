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
  percentiles,
  JUDGE_EXIT,
  type JudgeInput,
  type JudgedBooking,
  type PlatformReading,
} from "./judge-booking-run.ts";
import { ceilingVerdict, exactAddressBound, type CeilingVerdict } from "./preflight-checks.ts";
import {
  readConfirmStartup,
  readDeferredSpans,
  type ConfirmStartupReading,
  type DeferredSpanReading,
} from "./confirm-startup.ts";
import { DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "../../src/lib/rate-limit-core.ts";
import { burstControlStrength, type BurstDepthReading } from "./burst-target.ts";
import { baselineReading, latencyReportLine, verdictText } from "./latency-bar.ts";
import { recomputeArmLine } from "../../src/lib/booking/post-confirm-recompute-modes.ts";
import { REQUEST_CPU_P99_MS, cronCpuShareText, faultPassKeepsFiveXxBar } from "./judge-booking-run.ts";
import {
  INVOCATIONS_QUERY,
  SCHEDULED_QUERY,
  readInvocationsResponse,
  readScheduledResponse,
  shouldPollAgain,
  pollTimings,
  WRANGLER_CRON_CPU_MS,
  readScheduledFromArchive,
  reconcileScheduled,
  type ReadResult,
  type ScheduledReading,
} from "./platform-reading.ts";
import {
  BOOKING_WRITES_PER_MINUTE,
  DRIVERS,
  PER_DRIVER_PER_MINUTE,
  faultMinutesFrom,
  RUN_MINUTES,
  type DriverMode,
  type DriverResult,
} from "./book-plan.ts";
import type { SoakSample } from "./invariants.ts";
import { PRODUCTION_SUPABASE_REF } from "../../src/lib/loadtest-guard.ts";
import { allLaneNames } from "../../worker/lanes-disabled.ts";
import { LANE_STALE_BOUNDS_MS } from "../../src/lib/monitor/health.ts";
import { parseFaultTargets } from "../../src/lib/loadtest-fault.ts";
import { faultLaneExpectationsFor, type FaultLaneEvidence } from "./fault-lanes.ts";

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

/**
 * Files that could not be used as a steady driver's result (#3222): unparsable, or a
 * `driver-N.json` that says another mode. Handed to the judge so a driver with no
 * steady file is named by its real cause rather than as one that hung.
 */
const unreadableDriverFiles: { file: string; why: string }[] = [];

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
      else if (mode === "steady" && /^driver-\d+\.json$/.test(name)) {
        unreadableDriverFiles.push({ file: name, why: `it says mode ${String(r.mode)}, not steady` });
      }
    } catch (err) {
      console.error(`note: ${name} could not be read (${(err as Error).message}); counted as missing`);
      if (mode === "steady" && /^driver-\d+\.json$/.test(name)) {
        unreadableDriverFiles.push({ file: name, why: (err as Error).message });
      }
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
  archiveScheduled: ScheduledReading | null,
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
    cronSource: null,
    cronNote: null,
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
  //
  // And it is RECONCILED against the run's own archived log (#2352), because that
  // dataset has never once reported a tick for a load test Worker: measured live on
  // 2026-09-15 it held 61 rows for production and ZERO for `slate-loadtest` while
  // that Worker was plainly ticking every minute. A zero from it used to become
  // "with no cron in the window", written into a report as a fact about the
  // deployment when it was a fact about the read.
  let platformScheduled: ReadResult<ScheduledReading>;
  try {
    const { status, body } = await ask(SCHEDULED_QUERY);
    platformScheduled = readScheduledResponse(status, body);
  } catch (err) {
    platformScheduled = { ok: false, why: `the scheduled read failed: ${(err as Error).message}` };
  }
  const settled = reconcileScheduled({ platform: platformScheduled, archive: archiveScheduled });
  if (settled.why) console.error(`note: ${settled.why}`);

  return {
    invocations: last.reading.invocations,
    cpuMsP99: last.reading.cpuMsP99,
    subrequests: last.reading.subrequests,
    statuses: last.reading.statuses,
    cron: settled.ok ? settled.reading : null,
    cronSource: settled.ok ? settled.source : null,
    cronNote: settled.ok ? settled.why : null,
    unreadableWhy: settled.ok ? null : settled.why,
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
// #3258: the same day baseline at rest, which the latency bar is judged against.
// Read from EVERY result file rather than through `loadDrivers`, which would take
// the first baseline silently and count a corrupt baseline.json as missing:
// `baselineReading` refuses two, and calls a corrupt one unreadable.
function resultFileEntries(): { name: string; parsed?: unknown; error?: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(RESULTS).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map((name) => {
    try {
      return { name, parsed: readJson<unknown>(join(RESULTS, name)) };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
}
const baseline = baselineReading(resultFileEntries());
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

/**
 * The confirm path's own time, split from the isolate's startup (#2340).
 *
 * Read from the archived `wrangler tail` stream, which is the only place both
 * halves exist: the invocation's own start and the confirm profile's total. The
 * platform's CPU percentile counts them as one number.
 *
 * A file that is not there is NULL, not an empty reading, and the judge fails the
 * bar on a null rather than passing it: a run that could not read its own archive
 * proved nothing about what a lead waits for (L98).
 */
let confirmStartup: ConfirmStartupReading | null = null;
/**
 * The SAME archive, read for the cron ticks it holds (#2352).
 *
 * Null when there is no archive at all, which is why the text is kept rather than
 * the two readers each opening the file: a missing archive and a window with no
 * cron in it are different facts, and the reconciliation below turns on exactly
 * that difference.
 */
let archiveScheduled: ScheduledReading | null = null;
/**
 * What each DEFERRED job cost, by name (#2353).
 *
 * The span after the response is where the expensive confirms actually spend
 * their time, and it was one opaque number. Read from the same archive, so a run
 * whose archive never arrived reports null for all three rather than three
 * separate silences.
 */
let deferred: Record<string, DeferredSpanReading> | null = null;
try {
  const archive = readFileSync(join(RESULTS, "tail.jsonl"), "utf8");
  confirmStartup = readConfirmStartup(archive);
  archiveScheduled = readScheduledFromArchive(archive);
  deferred = readDeferredSpans(archive);
} catch {
  console.error("note: no archived Worker log was found, so the confirm startup split is unread");
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
// env-ok: FAULT_MINUTES (optional; the fault pass's length, unset in the workflow,
// read through the same reader the driver uses so the two agree on the plan)
const FAULT_MINUTES = faultMinutesFrom(process.env.FAULT_MINUTES) ?? (() => {
  console.error(`FAILED: FAULT_MINUTES is not a positive number of minutes: ${JSON.stringify(process.env.FAULT_MINUTES)}.`);
  process.exit(1);
})();
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
  // WHICH systems the deployment reported failing (#3104). Drivers that disagree were
  // not measuring one deployment; nothing is carried, and the judge calls a pass with
  // no recorded targets incomplete rather than picking one of them.
  const targetLists = [...new Set(faultDrivers.map((d) => [...(d.faultTargets ?? [])].sort().join(",")))];
  if (targetLists.length > 1) {
    console.error(`note: fault drivers reported different fault targets (${targetLists.join(" | ")})`);
  }
  faultPass = {
    attempts: attempts.length,
    fiveXx: attempts.filter((a) => a.status >= 500 && a.status <= 599).length,
    faultPct: Math.min(...reported),
    faultTargets: targetLists.length === 1 && targetLists[0] !== "" ? targetLists[0]!.split(",") : [],
    // The files themselves, and the plan each was meant to run, so the judge gives
    // them the steady drivers' checks and fails a pass cut short at its deadline
    // with its figures (#3222). The length is read from FAULT_MINUTES through the
    // driver's own reader, so a hand run that set it is judged against its plan.
    drivers: faultDrivers,
    expectedPerDriver: Math.round(PER_DRIVER_PER_MINUTE * FAULT_MINUTES),
  };
}

/**
 * What the fault leg was ASKED to fail (#3104), the workflow's `fault_targets` input,
 * read through the deployment's own parser so the three sides agree on what a list
 * means. Unset is the default list, which is what a fault leg dispatched before the
 * input existed ran.
 *
 * env-ok: EXPECT_FAULT_TARGETS (optional; the workflow's fault_targets input, and
 * unset for a hand run, which means the default read only list)
 */
const expectedFaultTargets = parseFaultTargets(process.env.EXPECT_FAULT_TARGETS);
if (expectedFaultTargets.unknown.length > 0) {
  console.error(
    `FAILED: EXPECT_FAULT_TARGETS names ${expectedFaultTargets.unknown.join(", ")}, which is no fault target.`,
  );
  process.exit(1);
}

/**
 * The cron lanes while the deployment was faulted (#3104): the lane sampler's file
 * and what the lanes are held to.
 *
 * The lanes are every lane the watchdog bounds, MINUS the ones the load test
 * environment holds back. Which those are arrives as a setting, like the judge's
 * other expectations, and NOT by reading wrangler.jsonc here: that read needed
 * wrangler installed and the repo root as the working directory, and threw after
 * every driver had run, leaving the run with no verdict. A setting that is missing
 * or names no lane is an incomplete verdict (`lanesRunByDeployment`), and
 * `scripts/test-fault-lanes.ts` holds the workflow's value equal to wrangler's, so
 * the copy cannot drift from the deployment it describes (L41, L422). The window
 * opens when the fault driver started, which is after the deployment confirmed it
 * was faulting.
 *
 * env-ok: EXPECT_LANES_DISABLED (optional; the load test environment's
 * SLATE_LANES_DISABLED, and unset for a hand run, which makes a fault pass
 * incomplete rather than guessed)
 */
let faultLanes: JudgeInput["faultLanes"];
if (faultDrivers.length > 0) {
  let evidence: FaultLaneEvidence | null = null;
  try {
    const raw = readJson<FaultLaneEvidence>(join(RESULTS, "fault-lanes.json"));
    if (raw.kind === "fault-lanes" && raw.runId === RUN_ID) evidence = raw;
    else console.error("note: fault-lanes.json is not this run's lane evidence; counted as missing");
  } catch (err) {
    console.error(`note: no lane sampler file could be read (${(err as Error).message})`);
  }
  faultLanes = {
    evidence,
    // From what the run was CONFIGURED to fail, never what the deployment reported;
    // a disagreement between the two is already incomplete in the judge.
    expectations: faultLaneExpectationsFor({
      configuredTargets: expectedFaultTargets.targets,
      rawDisabled: process.env.EXPECT_LANES_DISABLED,
      bounds: LANE_STALE_BOUNDS_MS,
      knownLanes: allLaneNames(),
      windowStartMs: Math.min(...faultDrivers.map((d) => d.startedAtMs)),
    }),
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

// Hoisted so the report can NAME which source the cron half came from (#2352):
// a zero from the analytics dataset alone is the reader being blind, not an empty
// window, and a reader has to be able to see which one answered.
const platform = await platformReading(
  new Date(startedAt).toISOString(),
  new Date(finishedAt + 60_000).toISOString(),
  steadyAttempts,
  archiveScheduled,
);

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
  confirmStartup,
  platform,
  faultPass,
  faultLanes,
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
    faultTargets: expectedFaultTargets.targets,
    // env-ok: EXPECT_BASELINE (optional; "1" when the workflow ran the same day
    // baseline leg, #3258. Unset on a hand run, which keeps the fixed bar.)
    baseline: process.env.EXPECT_BASELINE === "1",
  },
  unreadableDriverFiles,
  budgets: { cpuMsP99: cpuBudgetMs(), cronCpuMs: cronCpuBudgetMs() },
  baseline,
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
lines.push(`Judged ${new Date().toISOString()}. ${verdictText(result.verdict, result.speedUnmeasured)}`);
lines.push("");
// #3258: which arm of the post confirm recompute this run was dispatched for, so
// three back to back reports cannot be read against the wrong arm. The preflight
// refuses a deployment running any other arm, which is why the dispatch is enough.
// env-ok: EXPECT_POST_CONFIRM_RECOMPUTE (optional; the workflow's input, unset on a
// hand run, which is the on arm)
lines.push(recomputeArmLine(process.env.EXPECT_POST_CONFIRM_RECOMPUTE));
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
  lines.push(`- attempts: ${m.attempts} of ${m.planned} planned, confirmed: ${m.confirmed}`);
  // #3222: a driver that stopped at its own deadline, named with how far it got.
  for (const c of m.cutShort) {
    lines.push(
      `- driver ${c.driver} cut short at its ${(c.deadlineMs / 60_000).toFixed(1)} minute deadline ` +
        `after ${c.made} of ${c.planned} requests`,
    );
  }
  lines.push(
    `- confirmed a minute: ${m.confirmedPerMinute.toFixed(1)} against a target of ${m.targetPerMinute}`,
  );
  lines.push(`- all responses: p50 ${m.all?.p50 ?? "n/a"}ms, p95 ${m.all?.p95 ?? "n/a"}ms, max ${m.all?.max ?? "n/a"}ms`);
  lines.push(`- successful only: p50 ${m.ok?.p50 ?? "n/a"}ms, p95 ${m.ok?.p95 ?? "n/a"}ms, max ${m.ok?.max ?? "n/a"}ms`);
  if (m.latency) lines.push(latencyReportLine(m.latency));
  lines.push(`- 5xx: ${m.fiveXx}, no reply at all: ${m.noReply}, timed out at the driver's bound: ${m.timedOut}, write refusals: ${m.writeRefusals}`);
  lines.push(`- refusals by the address Slate saw: ${JSON.stringify(m.refusalsByIp)}`);
  // The number the run exists to produce after #2274, on EVERY run rather than
  // only when it is not zero (#2323). A measured zero and a check that never ran
  // read the same when neither prints, so the count carries its denominator.
  lines.push(
    `- overlapping pairs: ${m.overlappingPairs} over ${m.activeBookings} active bookings ` +
      `(same slot pairs: ${m.sameSlotPairs})`,
  );
  lines.push(`- worst recompute age: ${m.freshnessMaxSec}s`);
  // #3104: said on every faulted run, including the ones whose 5xx are reported
  // rather than barred, so a database fault pass's errors are still in front of the
  // reader, with the reason they did not fail the run beside them.
  if (faultPass) {
    lines.push(
      `- fault pass: ${faultPass.faultTargets.join(", ") || "unrecorded systems"} failing ` +
        `${faultPass.faultPct} percent of calls; ${faultPass.attempts} requests, ${faultPass.fiveXx} 5xx ` +
        (faultPassKeepsFiveXxBar(faultPass.faultTargets)
          ? "(held to no 5xx)"
          : "(reported, not barred: a failure of one of these systems is a 5xx by design)"),
    );
  }
  const laneX = faultLanes?.expectations;
  if (faultLanes?.evidence && laneX && !("why" in laneX)) {
    const e = faultLanes.evidence;
    lines.push(
      `- cron lanes under fault: ${e.samples.length} readings over ` +
        `${((e.finishedAtMs - laneX.windowStartMs) / 60_000).toFixed(1)} min ` +
        `(${e.failedReads} failed), ${Object.keys(laneX.lanes).length} lanes judged`,
    );
  }
  // The two halves of a confirm's wall time, reported APART (#2340). The platform
  // CPU percentile below counts them as one number, and the run that failed on it
  // was failing on the half the confirm does not control.
  lines.push(
    m.confirmSamples === null
      ? "- confirm wall time: the archived log carried no confirm profile, so the confirm's own " +
          "time and the isolate's startup were not told apart"
      : `- confirm wall time over ${m.confirmSamples} confirms (${m.confirmCold} of them the ` +
          `first on their isolate): inside the confirm p50 ${m.confirmHandler?.p50 ?? "n/a"}ms, ` +
          `p95 ${m.confirmHandler?.p95 ?? "n/a"}ms; before it started, cold p95 ` +
          `${m.confirmColdStartup?.p95 ?? "n/a"}ms (max ${m.confirmColdStartup?.max ?? "n/a"}ms), ` +
          `warm p95 ${m.confirmWarmStartup?.p95 ?? "n/a"}ms; after the response had gone, ` +
          `p95 ${m.confirmAfterResponse?.p95 ?? "n/a"}ms ` +
          `(max ${m.confirmAfterResponse?.max ?? "n/a"}ms), which no lead waits for` +
          // What the archive itself lost, so a thin sample is never read as a
          // quiet run. The stream is written under a timeout, so its last line is
          // routinely half written.
          (confirmStartup && confirmStartup.unreadable + confirmStartup.unparsable > 0
            ? ` (${confirmStartup.unreadable} profiles unreadable, ` +
              `${confirmStartup.unparsable} lines not readable JSON)`
            : "") +
          (confirmStartup && confirmStartup.impossible > 0
            ? `; ${confirmStartup.impossible} readings could not be right and were floored at zero`
            : ""),
  );
  // The deferred span, APPORTIONED by job (#2353). The line above reports the
  // whole span; this says which job it was, which is the question somebody
  // optimising it actually has. WALL, like every number a Worker can produce
  // about itself: no in process timer can apportion CPU (see confirm-startup.ts).
  lines.push(
    deferred === null
      ? "- after the response, by job: the archive carried no deferred span, so the webhook " +
          "send and the tally beside it were not told apart"
      : "- after the response, by job: " +
          Object.entries(deferred)
            // Dearest first, so a reader meets the expensive job first.
            .sort((a, b) => (percentiles(b[1].ms)?.p95 ?? 0) - (percentiles(a[1].ms)?.p95 ?? 0))
            .map(([context, d]) => {
              // Through the judge's own percentile helper, so the report and the
              // bars compute a p95 exactly one way (L41).
              const p = percentiles(d.ms);
              return (
                `${context} x${d.calls} p95 ${p?.p95 ?? "n/a"}ms (max ${p?.max ?? "n/a"}ms` +
                `${d.failed > 0 ? `, ${d.failed} failed` : ""}` +
                `${d.unreadable > 0 ? `, ${d.unreadable} unread` : ""})`
              );
            })
            .join(", "),
  );
  // WHERE the cron half was read from, on every run (#2352). Without it, a report
  // saying "no cron in the window" cannot be told from one whose dataset was blind,
  // which is what happened on every load run this bar has ever judged.
  lines.push(
    platform.cron === null
      ? `- cron ticks in the window: not measured (${platform.unreadableWhy ?? "no reason given"})`
      : `- cron ticks in the window: ${platform.cron.invocations} from the ` +
          `${platform.cronSource === "archive" ? "run's own archived log" : platform.cronSource === "platform" ? "analytics dataset" : "analytics dataset and the archived log, which agree"}` +
          // The worst tick's share of the kill limit on EVERY run (#2357), so a pass
          // at 99 percent never reads the same as a pass at 3.
          (platform.cron.invocations > 0
            ? `; ${cronCpuShareText(platform.cron.worstCpuMs, cronCpuBudgetMs())}`
            : "") +
          (platform.cron.unreadableCpu
            ? `, ${platform.cron.unreadableCpu} of them carrying no readable CPU figure`
            : "") +
          (platform.cronNote ? `; ${platform.cronNote}` : ""),
  );
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

// The REQUEST path's CPU budget is its own number (#2321).
//
// The judge compared the request path's CPU percentile against `CPU_BUDGET_MS`,
// defaulting to 200ms, which is the LANE budget from
// docs/cloudflare-platform-notes.md. The two are not the same question and were
// never meant to be one number:
//
//   - the lane budget is about a scheduled invocation on a shared every minute
//     tick, and its real ceiling is `limits.cpu_ms` (120,000ms), which the cron
//     half of this bar already judges against;
//   - the request budget is about a LEAD WAITING, and about spend, on a path
//     Cloudflare scales horizontally.
//
// A borrowed number is a bar nobody derived: the 200 came from production's mixed
// p50 of 198ms on 2026-09-13, which is a reading about whatever traffic that hour
// held, not a budget anybody set for a confirm (L107, L353).
//
// The run on 2026-09-14 measured the request path at a CPU p99 of 4,908ms over
// 1,364 invocations with no cron in the window, against wall p95 of 4,025ms: the
// confirm path is compute bound rather than waiting on anything. That is the
// finding this bar has to be able to state in its own terms.
//
// Run: node --experimental-strip-types scripts/test-loadtest-cpu-budget.ts
import {
  OK_P95_MS,
  REQUEST_CPU_P99_MS,
  REQUEST_CPU_LATENCY_SHARE,
  judgeBookingRun,
} from "./loadtest/judge-booking-run.ts";
import { WRANGLER_CRON_CPU_MS } from "./loadtest/platform-reading.ts";
import {
  ceilingVerdict,
  exactAddressBound,
  CEILING_REFUSED_BY,
  type CeilingAttempt,
} from "./loadtest/preflight-checks.ts";
import { DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES } from "../src/lib/rate-limit-core.ts";
import { readConfirmStartup } from "./loadtest/confirm-startup.ts";
import { formatLine } from "../src/lib/log.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the request budget is DERIVED from the thing it protects --------------------
{
  // Not a literal beside the latency bar. CPU is the compute floor under wall
  // time, so a request burning more than this on CPU alone has no headroom left
  // for the database and Google round trips it also has to make, and the latency
  // bar is about to fail for a cause this one can NAME first. Deriving it means
  // moving the latency bar moves this with it (L41).
  eq(
    REQUEST_CPU_P99_MS,
    Math.round(OK_P95_MS * REQUEST_CPU_LATENCY_SHARE),
    "the request CPU budget is a stated share of the latency bar, never a second literal",
  );
  assert(
    REQUEST_CPU_LATENCY_SHARE > 0 && REQUEST_CPU_LATENCY_SHARE < 1,
    "and the share is a fraction of it, so the CPU bar fires BEFORE the latency bar",
  );
}

// --- it is not the lane budget, and not the platform ceiling ----------------------
{
  // 200ms is the lane budget and 120,000ms is what Cloudflare kills a scheduled
  // invocation at. Either standing in for this one is a bar about a different
  // question: the first fails every run over ordinary database time, the second
  // can never fire on a path that answers in seconds.
  assert(REQUEST_CPU_P99_MS !== 200, "the request budget is not the lane budget it used to borrow");
  assert(
    REQUEST_CPU_P99_MS < WRANGLER_CRON_CPU_MS,
    "and it is far under the ceiling a scheduled invocation is killed at",
  );
  assert(
    REQUEST_CPU_P99_MS < OK_P95_MS,
    "a CPU budget at or above the latency bar could never fire on its own, since CPU cannot " +
      "exceed wall time",
  );
}

// --- the finding says which path and which budget ----------------------------------
{
  // The old wording named a number with no provenance. A reader meeting it went to
  // the lane budget in the platform notes, which is about the cron tick.
  const input = healthy();
  input.platform.cpuMsP99 = REQUEST_CPU_P99_MS + 1;
  const found = judgeBookingRun(input).findings.find((f) => /CPU/i.test(f.bar));
  assert(found !== undefined, "a request path over its budget is a finding");
  assert(
    /request/i.test(found!.detail) || /request/i.test(found!.bar),
    "which says it is about the REQUEST path",
  );
  assert(
    found!.detail.includes(String(REQUEST_CPU_P99_MS)),
    "and names the budget it was judged against",
  );
}

// --- the measured run is over it, which is the whole point --------------------------
{
  // 2026-09-14, run 34862015419: p99 4,908ms with no cron in the window. A budget
  // this does not fail is a budget that cannot see the thing #2321 is about.
  const input = healthy();
  input.platform.cpuMsP99 = 4908;
  const found = judgeBookingRun(input).findings.find((f) => /CPU/i.test(f.bar));
  assert(found !== undefined, "the measured 4,908ms p99 is over the request budget");
}

// --- and a path answering inside it still passes -------------------------------------
{
  const input = healthy();
  input.platform.cpuMsP99 = REQUEST_CPU_P99_MS - 1;
  const found = judgeBookingRun(input).findings.find((f) => /CPU/i.test(f.bar));
  eq(found, undefined, "a confirm under the budget is not a finding");
}

/**
 * A run that passes every bar, so only the CPU reading is under test.
 *
 * Four drivers of 150 attempts each and ten freshness samples, because the judge
 * refuses to compute anything at all from a run that did not happen as configured:
 * every rate is computable from a partial run and every one of them looks
 * plausible, so it reports incomplete instead and no bar below is reached.
 */
function healthy() {
  const attempt = (driver: number, n: number) => ({
    n,
    code: "112",
    startIso: "2026-09-16T14:00:00.000Z",
    externalId: `d${driver}-e${n}`,
    status: 200,
    outcome: "created",
    ms: 900,
    sentAtMs: 0,
    seenIp: "203.0.113.9",
  });
  const driverResults = Array.from({ length: 4 }, (_, driver) => ({
    driver,
    runId: "run-1",
    mode: "steady" as const,
    startedAtMs: 0,
    finishedAtMs: 600_000,
    attempts: Array.from({ length: 150 }, (_, n) => attempt(driver, n)),
  }));
  const all = driverResults.flatMap((d) => d.attempts);
  return {
    runId: "run-1",
    target: { drivers: 4, perDriverPerMinute: 15, minutes: 10 },
    driverResults,
    burstResults: [],
    freshnessSamples: Array.from({ length: 10 }, (_, i) => ({
      atMs: i * 60_000,
      maxAgeSec: 60,
    })),
    bookings: all.map((a, i) => ({
      id: a.externalId,
      external_id: a.externalId,
      status: "confirmed",
      assigned_user_id: `u${i}`,
      starts_at: "2026-09-16T14:00:00.000Z",
      ends_at: "2026-09-16T14:20:00.000Z",
    })),
    bookingIdsWithBusyBlock: all.map((a) => a.externalId),
    slotUniqueIndexPresent: true,
    overlapConstraintPresent: true,
    // Built by the REAL verdict and reader functions rather than typed out, so
    // neither can describe a state the run can never produce (L48). Hand written,
    // both of these silently stopped matching the shape their producers make.
    ipCeilingControl: ceilingVerdict(
      [
        ...Array.from({ length: 64 }, () => ({
          status: 200,
          seenIp: "203.0.113.9",
          refusedBy: null,
        })),
        ...Array.from({ length: 116 }, () => ({
          status: 429,
          seenIp: "203.0.113.9",
          refusedBy: CEILING_REFUSED_BY.address,
        })),
      ] as CeilingAttempt[],
      60,
      exactAddressBound(DIRECT_BOOKING_API_IP_HOURLY_RATE_RULES)!,
    ),
    confirmStartup: readConfirmStartup(
      Array.from({ length: 40 }, () =>
        JSON.stringify({
          outcome: "ok",
          eventTimestamp: 0,
          logs: [
            {
              level: "info",
              timestamp: 1_400,
              message: [
                formatLine("confirm-profile", {
                  msg: "where the confirm spent its wall time",
                  total_ms: 900,
                  isolate_age_ms: 90_000,
                }),
              ],
            },
          ],
        }),
      ).join("\n"),
    ),
    platform: {
      invocations: 600,
      cpuMsP99: 40,
      subrequests: 8,
      statuses: { success: 600 },
      // `agreed-empty` because that is what a window with no cron in it now
      // requires (#2352): both the analytics dataset and the run's own archived
      // log reporting none. A bare zero is the reader being blind.
      cron: { invocations: 0, worstCpuMs: 0, byCron: {} },
      cronSource: "agreed-empty" as const,
    },
    expectedLegs: { burstDrivers: 0, faultPct: 0 },
    budgets: { cpuMsP99: REQUEST_CPU_P99_MS, cronCpuMs: WRANGLER_CRON_CPU_MS },
  };
}

// --- a zero only ONE source reported is not an empty window (#2352) -------------

{
  // The analytics dataset reported zero scheduled invocations for the load test
  // Worker on every run it has ever judged, while the Worker ticked every minute.
  // Taking that for an empty window is what let the request CPU budget be applied
  // to a window full of cron lanes, and put "with no cron in the window" into a
  // report as a fact about the deployment.
  const base = healthy();
  const r = judgeBookingRun({
    ...base,
    platform: {
      ...base.platform,
      cpuMsP99: REQUEST_CPU_P99_MS + 5_000,
      cron: { invocations: 0, worstCpuMs: 0, byCron: {} },
      cronSource: "platform",
      cronNote: "the scheduled invocations dataset reported none while the log holds ticks",
    },
  });
  // Judged on the FINDING rather than the verdict: `unmeasured` collapses to
  // `fail` whenever any other bar already found something, so the verdict alone
  // could not tell this refusal from an unrelated failure (L11).
  assert(
    r.findings.some((f) => f.bar === "platform limits" && f.detail.includes("dataset")),
    "a zero from one source alone measures nothing, and says which source said it",
  );
  assert(
    !r.findings.some((f) => f.bar === "Worker CPU on the request path"),
    "and the request CPU budget is NOT applied to it, which is the false conclusion this replaces",
  );
}

{
  // The other direction, or the guard could simply be refusing every zero and the
  // request half would never be judged again (L1).
  const base = healthy();
  const r = judgeBookingRun({
    ...base,
    platform: { ...base.platform, cpuMsP99: REQUEST_CPU_P99_MS + 5_000 },
  });
  assert(
    r.findings.some((f) => f.bar === "Worker CPU on the request path"),
    "while two sources agreeing on zero still judges the request path exactly as before",
  );
}

finish();

// A slow load run is graded, not cancelled (#3222).
//
// Run 37215457763 had confirms slower than planned. The drivers send one request at
// a time, so slow answers stretched a ten minute plan to fourteen to sixteen, and
// driver 2 met the drive job's twenty minute timeout after about 134 of its 150
// bookings. GitHub killed it, it wrote nothing, the ceiling check and the fault pass
// were skipped behind it, and the judge called the whole run INCOMPLETE: a slow run
// produced no verdict on the very bar it should have failed.
//
// So each driver now stops at a deadline of its OWN, derived from the plan and sized
// so a driver whose every request sat at the latency bar still finishes, and writes
// a well formed partial file when it stops. The job timeout is derived from that
// deadline, so the platform only ever kills a driver that is genuinely hung. This
// pins three things:
//
//   the deadline and the job timeout are one computation, held equal to the number
//   in the workflow, so the two cannot drift back into the timeout firing first;
//
//   the decision to stop, as a pure function;
//
//   the REAL driver, against a local stub, stopping at its deadline, writing a file
//   the judge can read, and exiting zero so nothing downstream is skipped (L3).
//
// Run: node --experimental-strip-types scripts/test-loadtest-driver-deadline.ts
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { BASELINE_BOOKINGS } from "./loadtest/latency-bar.ts";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  driverDeadlineMs,
  driveJobTimeoutMinutes,
  archiveTailMinutes,
  archiveJobTimeoutMinutes,
  faultMinutesFrom,
  FAULT_MINUTES_DEFAULT,
  deadlineReached,
  effectiveDeadlineMs,
  requestAbortMs,
  REQUEST_TIMEOUT_MS,
  REQUEST_OVERRUN_MS,
  DRIVE_JOB_SETUP_MINUTES,
  DRIVE_DEADLINE_GRACE_MINUTES,
  PER_REQUEST_OVERHEAD_MAX_MS,
  DEADLINE_WORST_CASE_SHARE,
  PER_DRIVER_PER_MINUTE,
  RUN_MINUTES,
  type DriverResult,
} from "./loadtest/book-plan.ts";
import { OK_P95_MS } from "./loadtest/judge-booking-run.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOTAL = PER_DRIVER_PER_MINUTE * RUN_MINUTES;
const PLAN = { total: TOTAL, perMinute: PER_DRIVER_PER_MINUTE };

// --- the deadline comes from the plan and the bar ---------------------------------
{
  const deadline = driverDeadlineMs(PLAN);
  assert(deadline >= RUN_MINUTES * 60_000, "the deadline never cuts a run that is keeping to its plan");
  // #3163 (L743): a driver cut short by its deadline is FAILED by the judge as an
  // incomplete plan, so the deadline must sit well clear of the slowest run that
  // still PASSES: every request at the latency bar, with the slowest overhead
  // measured between one reply and the next request. Sized at exactly that time
  // (#3222), a passing run with a few slow gaps was failed for being slow, which
  // is the verdict the latency bar exists to give, not the deadline.
  const slowestPassingMs = TOTAL * (OK_P95_MS + PER_REQUEST_OVERHEAD_MAX_MS);
  assert(
    slowestPassingMs <= deadline * DEADLINE_WORST_CASE_SHARE,
    `the slowest passing driver (${Math.round(slowestPassingMs / 1000)}s: every request at the ${OK_P95_MS}ms bar plus the ${PER_REQUEST_OVERHEAD_MAX_MS}ms measured worst overhead) uses at most ${DEADLINE_WORST_CASE_SHARE * 100}% of the ${Math.round(deadline / 1000)}s deadline`,
  );
  assert(DEADLINE_WORST_CASE_SHARE <= 0.75, "and the share it may use leaves at least a quarter of the deadline spare");
  assert(PER_REQUEST_OVERHEAD_MAX_MS >= 1_650, "the overhead is the measured max (1.65s on run 37215457763), never the median");
  // A driver a little under the bar finishes; one at twice the bar does not, and is
  // stopped and graded rather than left for the job's timeout to kill.
  assert(TOTAL * (4_500 + 500) < deadline, "a driver a little under the bar finishes");
  assert(TOTAL * (2 * OK_P95_MS + PER_REQUEST_OVERHEAD_MAX_MS) > deadline, "a driver at twice the bar is stopped and graded");
  // A tiny plan is still bounded by its own schedule, never by zero.
  assert(
    driverDeadlineMs({ total: 2, perMinute: 1 }) >= 60_000,
    "a short plan's deadline still covers its own spacing",
  );
}

// --- the job timeout is derived from the deadline, and the workflow agrees --------
{
  const minutes = driveJobTimeoutMinutes(PLAN);
  assert(
    minutes * 60_000 >=
      driverDeadlineMs(PLAN) + (DRIVE_JOB_SETUP_MINUTES + DRIVE_DEADLINE_GRACE_MINUTES) * 60_000,
    "the job outlives the deadline by the setup and the grace, so a slow driver stops itself first",
  );
  const yml = readFileSync(join(ROOT, ".github/workflows/loadtest.yml"), "utf8");
  const drive = /^ {2}drive:\n([\s\S]*?)(?=^ {2}\S)/m.exec(yml)?.[1] ?? "";
  assert(drive !== "", "the workflow has a drive job");
  const declared = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(drive)?.[1] ?? NaN);
  eq(declared, minutes, "the drive job's timeout-minutes is the one derived from the plan");
  // Positive control on the extraction itself: a workflow with a different number
  // must be read as different, or the equality above could never fail (L1).
  const planted = yml.replace(/(^ {2}drive:\n[\s\S]*?^ {4}timeout-minutes:\s*)\d+/m, "$1999");
  const plantedDrive = /^ {2}drive:\n([\s\S]*?)(?=^ {2}\S)/m.exec(planted)?.[1] ?? "";
  eq(
    Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(plantedDrive)?.[1] ?? NaN),
    999,
    "control: a changed timeout is read as changed",
  );
}

// --- the log archive covers the whole drive it records ---------------------------
//
// The archive streams the Worker's logs beside the drive. It used to stop at a fixed
// fifteen minutes, while a drive may now legitimately run its fifteen minute
// deadline plus setup and grace, so a slow run lost exactly the last lines the
// judge reads its confirm timings from.
{
  const yml = readFileSync(join(ROOT, ".github/workflows/loadtest.yml"), "utf8");
  const archive = /^ {2}archive:\n([\s\S]*?)(?=^ {2}\S)/m.exec(yml)?.[1] ?? "";
  const tail = Number(/timeout (\d+)m npx wrangler tail/.exec(archive)?.[1] ?? NaN);
  eq(tail, archiveTailMinutes(PLAN), "the archive's tail window is the one derived from the plan");
  assert(
    archiveTailMinutes(PLAN) > driveJobTimeoutMinutes(PLAN),
    "and outlasts the longest a drive job can run",
  );
  const jobTimeout = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(archive)?.[1] ?? NaN);
  eq(jobTimeout, archiveJobTimeoutMinutes(PLAN), "the archive job's timeout is derived from its window");
  assert(jobTimeout > tail, "and is longer than the window, so the tail ends before the job is killed");
  // Control: a planted fixed window is read as different (L1).
  const planted = yml.replace(/timeout \d+m npx wrangler tail/, "timeout 15m npx wrangler tail");
  const plantedArchive = /^ {2}archive:\n([\s\S]*?)(?=^ {2}\S)/m.exec(planted)?.[1] ?? "";
  eq(Number(/timeout (\d+)m npx wrangler tail/.exec(plantedArchive)?.[1] ?? NaN), 15, "control: a changed window is read as changed");
}

// --- the fault plan's length is read one way by the driver and the judge -----------
{
  eq(faultMinutesFrom(undefined), FAULT_MINUTES_DEFAULT, "unset is the default the workflow runs");
  eq(faultMinutesFrom("5"), 5, "a hand run's FAULT_MINUTES is read");
  eq(faultMinutesFrom("0"), null, "zero is refused, not a plan");
  eq(faultMinutesFrom("soon"), null, "and so is something that is not a number, never NaN");
}

// --- when to stop ------------------------------------------------------------------
{
  eq(deadlineReached({ nowMs: 100, nextAtMs: 200, deadlineAtMs: 1_000 }), false, "before the deadline it carries on");
  eq(deadlineReached({ nowMs: 1_000, nextAtMs: 900, deadlineAtMs: 1_000 }), true, "at the deadline it stops");
  eq(
    deadlineReached({ nowMs: 100, nextAtMs: 1_000, deadlineAtMs: 1_000 }),
    true,
    "and it does not sleep toward a request it would only send after the deadline",
  );
  // The override exists so the test below can make a driver stop in milliseconds.
  // It can only SHORTEN: a stray value cannot lengthen a deadline past the job.
  eq(effectiveDeadlineMs(60_000, undefined), 60_000, "with no override the derived deadline applies");
  eq(effectiveDeadlineMs(60_000, "500"), 500, "an override shortens it");
  eq(effectiveDeadlineMs(60_000, "600000"), 60_000, "and can never lengthen it");
  eq(effectiveDeadlineMs(60_000, "soon"), 60_000, "an unreadable override is ignored, never NaN");
}

// --- one request may not outlive the driver's own bounds -----------------------------
{
  const deadlineAtMs = 1_000_000;
  eq(
    requestAbortMs({ nowMs: 0, deadlineAtMs }),
    REQUEST_TIMEOUT_MS,
    "well before the deadline a request is bounded by its own timeout",
  );
  eq(
    requestAbortMs({ nowMs: deadlineAtMs, deadlineAtMs }),
    Math.min(REQUEST_TIMEOUT_MS, REQUEST_OVERRUN_MS),
    "a request sent at the deadline may only overrun it by the overrun",
  );
  assert(
    requestAbortMs({ nowMs: deadlineAtMs + REQUEST_OVERRUN_MS + 5, deadlineAtMs }) > 0,
    "and never gets a zero or negative bound, which would abort before it is sent",
  );
  assert(REQUEST_TIMEOUT_MS > 12_000, "the per request bound clears the slowest confirm seen (12s)");
  // The whole point: the job's timeout must not fire while a request is still
  // inside its bounds, or a hung request kills the driver before it writes.
  assert(
    REQUEST_OVERRUN_MS + 30_000 <= DRIVE_DEADLINE_GRACE_MINUTES * 60_000,
    "the overrun plus time to write the file fits inside the grace before the job timeout",
  );
}

// --- the real driver stops at its deadline and writes what it ran ------------------

/** The plan's spacing between one driver's requests. */
const GAP_MS = 60_000 / PER_DRIVER_PER_MINUTE;
/**
 * Seven eighths of the spacing, so the driver stops before its SECOND request
 * because that one is scheduled past the deadline, not because a clock ran out: the
 * test waits on no timer, and a loaded machine still has most of a gap to send the
 * first.
 */
const TEST_DEADLINE_MS = Math.round((GAP_MS * 7) / 8);

/** Run the real driver against a local stub whose booking answer is slow, or never comes. */
/** What the fault leg's version check is answered with once the deploy has landed. */
const VERSION_FAULTED = { loadtest: true, productionSecrets: [], faultPct: 10, faultTargets: ["google-read"] };

async function runDriver(
  answer: "slow" | "hang" | "stall-body",
  extraEnv: Record<string, string> = {},
  out = "driver-2.json",
): Promise<{ code: number; stderr: string; result: DriverResult | null; bookingsSeen: number; versionSeen: number }> {
  let bookingsSeen = 0;
  let versionSeen = 0;
  const server = createServer((req, res) => {
    if (req.url === "/api/smoke/version") {
      versionSeen += 1;
      // The FIRST version check never answers, the way a deploy mid swap can.
      if (versionSeen === 1) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(VERSION_FAULTED));
      return;
    }
    if (req.url?.startsWith("/api/availability")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ slots: ["2026-10-05T14:00:00.000Z", "2026-10-05T15:00:00.000Z"] }));
      return;
    }
    if (req.url === "/api/bookings" && req.method === "POST") {
      bookingsSeen += 1;
      req.resume();
      // "hang" never answers; the driver's own abort is the only way out.
      if (answer === "hang") return;
      // "stall-body" sends a 200 and half a body, then nothing.
      if (answer === "stall-body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"outcome":');
        return;
      }
      // Slow, the way the 2026-10-04 confirms were.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ outcome: "booked" }));
      }, 300);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "slate-3222-"));
  const outPath = join(dir, out);
  let code = 0;
  let stderr = "";
  try {
    await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--import", "./scripts/register-paths.mjs", "scripts/loadtest/book.ts"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          SLATE_BASE: `http://127.0.0.1:${port}`,
          BOOKING_API_KEY: "test-key",
          RUN_ID: "run-3222",
          DRIVER: "2",
          OUT: outPath,
          MODE: "steady",
          DRIVE_DEADLINE_MS: String(TEST_DEADLINE_MS),
          ...extraEnv,
        },
        timeout: 60_000,
      },
    );
  } catch (err) {
    code = (err as { code?: number }).code ?? 1;
    stderr = String((err as { stderr?: string }).stderr ?? "");
  }
  server.closeAllConnections();
  server.close();
  const result = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as DriverResult) : null;
  rmSync(dir, { recursive: true, force: true });
  return { code, stderr, result, bookingsSeen, versionSeen };
}

{
  const { code, stderr, result: r, bookingsSeen } = await runDriver("slow");
  eq(code, 0, `a driver cut short by its deadline exits zero, so nothing downstream is skipped ${stderr.slice(0, 300)}`);
  assert(r !== null, "and it wrote its file");
  eq(r?.mode, "steady", "a well formed steady file");
  eq(r?.planned, TOTAL, "carrying the whole plan, so the short file is visibly short");
  assert(r?.cutShort !== undefined, "and saying it was cut short");
  eq(r?.cutShort?.deadlineMs, TEST_DEADLINE_MS, "at the deadline it was given");
  eq(r?.cutShort?.attemptsMade, r?.attempts.length, "with the count of what it made, agreeing with the file");
  assert((r?.attempts.length ?? 0) >= 1 && (r?.attempts.length ?? 0) < TOTAL, "having made some, not all");
  eq(bookingsSeen, r?.attempts.length, "and every request the deployment saw is in the file");
}

{
  // A request that NEVER answers. Before the per request abort this kept the driver
  // from ever writing its file, and the job's timeout killed it silently: the very
  // INCOMPLETE this issue removes.
  const { code, stderr, result: r } = await runDriver("hang", { DRIVE_REQUEST_TIMEOUT_MS: "300" });
  eq(code, 0, `a driver whose request hung still exits zero ${stderr.slice(0, 300)}`);
  assert(r !== null, "and still writes its file");
  eq(r?.attempts[0]?.status, 0, "the hung request has no status");
  eq(r?.attempts[0]?.outcome, "timed-out", "and is recorded as timed out, not as any other failure");
  assert(r?.cutShort !== undefined, "and the driver then stops at its deadline as before");
}

{
  // A 200 whose BODY stalls. The body read used to swallow the abort as a null
  // body, so the attempt read as a 200 with no outcome: a success nobody saw.
  const { code, stderr, result: r } = await runDriver("stall-body", { DRIVE_REQUEST_TIMEOUT_MS: "300" });
  eq(code, 0, `a driver whose response body stalled still exits zero ${stderr.slice(0, 300)}`);
  eq(r?.attempts[0]?.outcome, "timed-out", "a stalled body is recorded as timed out");
  eq(r?.attempts[0]?.status, 0, "and not as the 200 its headers claimed");
}

{
  // The fault leg's version polling carries the same abort. Its first check never
  // answers; before, that hung the driver until the job's timeout killed it.
  const { code, stderr, result: r, versionSeen } = await runDriver(
    "slow",
    { MODE: "fault", DRIVER: "0", FAULT_PCT: "10", FAULT_TARGETS: "google-read", FAULT_MINUTES: "1", DRIVE_REQUEST_TIMEOUT_MS: "300" },
    "fault-0.json",
  );
  eq(code, 0, `a fault driver whose first version check hung still drives ${stderr.slice(0, 300)}`);
  assert(versionSeen >= 2, "it gave up on the hung check and asked again");
  eq(r?.mode, "fault", "and wrote its fault file");
  eq(r?.faultPct, 10, "having confirmed the percentage from the second answer");
}

// --- a failed leg does not skip the legs that can still be judged -------------------
//
// A job with `needs:` and no `if:` is skipped when ANY ancestor did not succeed.
// One late burst driver exits 3 by design, which failed the burst job and skipped
// the whole steady pass, freshness and the archive behind it, and with them the
// ceiling and the fault pass: the run was INCOMPLETE with nothing driven. Each of
// those jobs now runs on an explicit condition, and the judge fails the burst.

/** The `if:` and `needs:` of one job, read from the workflow text. */
function jobGate(yml: string, job: string): { cond: string; needs: string } {
  const body = new RegExp(`^ {2}${job}:\\n([\\s\\S]*?)(?=^ {2}\\S)`, "m").exec(yml)?.[1] ?? "";
  return {
    cond: /^ {4}if:\s*(.+)$/m.exec(body)?.[1] ?? "",
    needs: /^ {4}needs:\s*(.+)$/m.exec(body)?.[1] ?? "",
  };
}

/** Why a job would be skipped behind a failed burst, or would run when it must not. */
function gateProblems(yml: string): string[] {
  const out: string[] = [];
  for (const job of ["drive", "freshness", "archive"]) {
    const g = jobGate(yml, job);
    if (!g.cond.includes("!cancelled()")) out.push(`${job} has no !cancelled() condition, so a failed burst skips it`);
    if (!g.cond.includes("needs.preflight.result == 'success'")) out.push(`${job} does not require the preflight`);
    if (!g.cond.includes("needs.setup-burst.result == 'success'")) out.push(`${job} does not require the burst setup`);
    if (g.cond.includes("needs.burst.result")) out.push(`${job} still depends on the burst succeeding`);
    if (!g.needs.includes("preflight") || !g.needs.includes("setup-burst") || !g.needs.includes("burst")) {
      out.push(`${job} must need preflight, setup-burst and burst to read their results and keep its order`);
    }
  }
  const ceiling = jobGate(yml, "ceiling");
  if (!ceiling.cond.includes("!cancelled()") || !ceiling.cond.includes("needs.drive.result == 'success'")) {
    out.push("ceiling does not run on the drive job's own success, so a failed burst still skips it");
  }
  const fault = jobGate(yml, "fault");
  for (const dep of ["drive", "freshness", "ceiling"]) {
    if (!fault.cond.includes("!cancelled()") || !fault.cond.includes(`needs.${dep}.result == 'success'`)) {
      out.push(`fault does not run on ${dep}'s own success`);
    }
  }
  return out;
}

{
  const yml = readFileSync(join(ROOT, ".github/workflows/loadtest.yml"), "utf8");
  eq(gateProblems(yml), [], "the steady pass, freshness, archive, ceiling and fault run whatever the burst did");
  // Control: the workflow as it was, with the conditions stripped, is caught (L1).
  const stripped = yml.replace(/^ {4}if: \$\{\{ !cancelled\(\).*\n/gm, "");
  assert(gateProblems(stripped).length >= 5, "control: a workflow without the conditions fails the check");
}

// --- #3258: the same day baseline leg ---------------------------------------------------
{
  // The driver in baseline mode: its own plan (a dozen at four a minute), its own
  // mode on the file the judge gathers by mode, and its own id prefix, so no steady
  // booking id is reused. Cut short by the test deadline after its first request.
  const { code, stderr, result: r } = await runDriver("slow", { MODE: "baseline", DRIVER: "0" }, "baseline.json");
  eq(code, 0, `the baseline driver exits zero ${stderr.slice(0, 300)}`);
  eq(r?.mode, "baseline", "and writes a baseline file, which the judge gathers apart from the steady pass");
  eq(r?.planned, BASELINE_BOOKINGS, "planning the baseline's dozen, not a steady driver's plan");
  assert((r?.attempts.length ?? 0) >= 1, "having booked");
  assert(r?.attempts.every((a) => a.externalId.startsWith("run-3222-r-")) ?? false, "under the baseline's own id prefix");
}
/**
 * Why the baseline is not wired the way the judge relies on (#3258), as findings, so
 * the same check can be run on the real files AND on a broken copy (L1): a control
 * that only re-tests its own mutation proves nothing about the check.
 */
function baselineWiringProblems(yml: string, runJudge: string): string[] {
  const out: string[] = [];
  const job = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S)`, "m").exec(yml)?.[1] ?? "";
  const baseline = job("baseline");
  if (!/MODE: baseline/.test(baseline) || !/OUT: results\/baseline\.json/.test(baseline)) {
    out.push("the baseline job does not drive baseline mode into baseline.json");
  }
  if (!/needs: preflight/.test(baseline)) out.push("the baseline does not wait for the preflight to warm the deployment");
  const setup = jobGate(yml, "setup-burst");
  if (!setup.needs.includes("baseline")) out.push("the burst setup does not wait for the baseline to finish at rest");
  if (!setup.cond.includes("!cancelled()") || !setup.cond.includes("needs.preflight.result == 'success'")) {
    out.push("the burst setup is skipped behind a failed baseline");
  }
  const judge = job("judge");
  if (!/needs: \[[^\]]*\bbaseline\b/.test(judge)) out.push("the judge does not wait for the baseline");
  if (!/EXPECT_BASELINE: "1"/.test(judge)) out.push("the judge is not told the run carried a baseline");
  if (!/baselineReading\(resultFileEntries\(\)\)/.test(runJudge)) out.push("the judge entry does not read the baseline through baselineReading");
  if (!/baseline: process\.env\.EXPECT_BASELINE === "1"/.test(runJudge)) out.push("the judge entry does not pass the expectation through");
  return out;
}

{
  const yml = readFileSync(join(ROOT, ".github/workflows/loadtest.yml"), "utf8");
  const runJudge = readFileSync(join(ROOT, "scripts/loadtest/run-judge.ts"), "utf8");
  eq(
    baselineWiringProblems(yml, runJudge),
    [],
    "the baseline runs at rest before the burst, a failed one costs only the speed verdict, and the judge " +
      "is told to expect it, so a missing file reports the speed as unmeasured rather than as the fixed bar",
  );
  // Controls: the REAL check, run on a copy with one piece removed, must go red (L1).
  const noExpectation = yml.replace(/^ +EXPECT_BASELINE: "1"\n/m, "");
  assert(noExpectation !== yml, "control setup: the expectation line was really removed");
  eq(
    baselineWiringProblems(noExpectation, runJudge),
    ["the judge is not told the run carried a baseline"],
    "control: a judge job without EXPECT_BASELINE is caught, and only that",
  );
  const noPass = runJudge.replace(/baseline: process\.env\.EXPECT_BASELINE === "1"/, "baseline: false");
  eq(
    baselineWiringProblems(yml, noPass),
    ["the judge entry does not pass the expectation through"],
    "control: a judge entry that drops the expectation is caught",
  );
}

finish();

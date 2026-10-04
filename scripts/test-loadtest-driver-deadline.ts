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
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  driverDeadlineMs,
  driveJobTimeoutMinutes,
  deadlineReached,
  effectiveDeadlineMs,
  requestAbortMs,
  REQUEST_TIMEOUT_MS,
  REQUEST_OVERRUN_MS,
  DRIVE_JOB_SETUP_MINUTES,
  DRIVE_DEADLINE_GRACE_MINUTES,
  PER_REQUEST_OVERHEAD_MS,
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
  eq(
    deadline,
    TOTAL * (OK_P95_MS + PER_REQUEST_OVERHEAD_MS),
    "and it is the time a driver takes when every request sits AT the latency bar",
  );
  // The 2026-10-04 run, as measured: its drivers took 14.2 to 16.1 minutes with a
  // p95 near 8s. A driver at the bar is inside the deadline; one at that run's
  // pace is not, which is exactly the run that must be graded rather than lost.
  assert(TOTAL * (4_500 + 500) < deadline, "a driver a little under the bar finishes");
  assert(TOTAL * (8_000 + 500) > deadline, "a driver at the slow run's pace is stopped and graded");
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
async function runDriver(
  answer: "slow" | "hang",
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stderr: string; result: DriverResult | null; bookingsSeen: number }> {
  let bookingsSeen = 0;
  const server = createServer((req, res) => {
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
  const out = join(dir, "driver-2.json");
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
          OUT: out,
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
  const result = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as DriverResult) : null;
  rmSync(dir, { recursive: true, force: true });
  return { code, stderr, result, bookingsSeen };
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

finish();

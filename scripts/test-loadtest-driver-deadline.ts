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

// --- the real driver stops at its deadline and writes what it ran ------------------
{
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
  let code: number | null = 0;
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
          // Under the plan's four second spacing, so the driver stops before its
          // SECOND request because that one is scheduled past the deadline, not
          // because a clock ran out: the test waits on no timer, and a loaded
          // machine has three and a half seconds to send the first.
          DRIVE_DEADLINE_MS: "3500",
        },
        timeout: 60_000,
      },
    );
  } catch (err) {
    code = (err as { code?: number }).code ?? 1;
    stderr = String((err as { stderr?: string }).stderr ?? "");
  }
  server.close();
  eq(code, 0, `a driver cut short by its deadline exits zero, so nothing downstream is skipped ${stderr.slice(0, 300)}`);
  assert(existsSync(out), "and it wrote its file");
  const r = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as DriverResult) : null;
  eq(r?.mode, "steady", "a well formed steady file");
  eq(r?.planned, TOTAL, "carrying the whole plan, so the short file is visibly short");
  assert(r?.cutShort !== undefined, "and saying it was cut short");
  eq(r?.cutShort?.deadlineMs, 3500, "at the deadline it was given");
  eq(r?.cutShort?.attemptsMade, r?.attempts.length, "with the count of what it made, agreeing with the file");
  assert((r?.attempts.length ?? 0) >= 1 && (r?.attempts.length ?? 0) < TOTAL, "having made some, not all");
  eq(bookingsSeen, r?.attempts.length, "and every request the deployment saw is in the file");
  rmSync(dir, { recursive: true, force: true });
}

finish();

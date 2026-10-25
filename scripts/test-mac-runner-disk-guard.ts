// The Mac runners refuse a job when Dan's work disk is nearly full.
//
// The runners share the disk Dan works on, and on 2026-10-24 their first runs
// used about 10 GB in half an hour. scripts/mac-runner/setup.sh writes a job
// started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED) that fails the job, saying why,
// under MIN_FREE_GB. This writes that hook from the script's own function into a
// temporary folder and runs it with a floor no disk can meet and one every disk
// does, so a broken hook is seen failing both ways rather than passing silently.
//
// Run: node --experimental-strip-types scripts/test-mac-runner-disk-guard.ts
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const SETUP = join(import.meta.dirname, "mac-runner/setup.sh");
const source = readFileSync(SETUP, "utf8");

const fn = /^write_disk_guard\(\) \{\n[\s\S]*?^\}\n/m.exec(source)?.[0];
assert(fn !== undefined, "setup.sh defines write_disk_guard");

// Every runner's settings name the hook, or the guard is written and never run.
assert(/echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=\$DISK_GUARD"/.test(source), "each runner's .env names the guard as its job started hook");
assert(/^ {2}write_disk_guard$/m.test(source), "writing a runner's settings writes the guard");
const floor = /^MIN_FREE_GB=(\d+)$/m.exec(source)?.[1];
eq(floor, "10", "the floor is 10 GB");
// A root owned file in a folder cirunner owns can still be deleted by a job.
const guardPath = /^DISK_GUARD=(.+)$/m.exec(source)?.[1] ?? "";
assert(guardPath.startsWith("/usr/local/") && !guardPath.includes("RUNNER_HOME"), `the guard lives in a root owned folder, not the runner's home: ${guardPath}`);

/** Writes the guard with a floor, runs it, and returns its exit and output. */
function runGuard(minGb: number): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "mac-runner-guard-"));
  try {
    // chown needs root, and is about who may edit the hook, not what it does.
    const body = (fn ?? "").replace(/^\s*chown root:wheel.*$/m, "");
    const harness = join(dir, "harness.sh");
    writeFileSync(harness, `${body}\nMIN_FREE_GB=${minGb}\nRUNNER_HOME=${dir}\nDISK_GUARD=${dir}/guard.sh\nwrite_disk_guard\n`);
    execFileSync("bash", [harness]);
    eq(statSync(join(dir, "guard.sh")).mode & 0o777, 0o755, `the guard written with a ${minGb} GB floor is executable`);
    const run = spawnSync("bash", [join(dir, "guard.sh")], { encoding: "utf8" });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const refused = runGuard(1_000_000);
  eq(refused.status, 1, "a floor above any disk refuses the job");
  assert(/::error title=The Mac runner's disk is nearly full::\d+ GB free, under the 1000000 GB floor/.test(refused.out), `the refusal says how much is free and the floor: ${refused.out.trim()}`);
}
{
  const passed = runGuard(0);
  eq(passed.status, 0, "a floor of zero lets the job start");
  eq(passed.out, "", "and says nothing");
}

finish();

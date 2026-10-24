// Where every job runs is decided by ONE org variable, PENNIE_CI_RUNNER.
//
// From 2026-10-23 GitHub refused every hosted job in the Try-Pennie org over
// billing, while self-hosted runners still got jobs. So the jobs moved to runners
// on Dan's work MacBook, labelled `pennie-mac`, with ONE of them, `pennie-mac-docker`,
// able to reach Docker: two Docker jobs there share one Docker host, and each
// starts a local Supabase on the same ports, so they must never run at once.
//
// The switch back has to be one setting, with no code change: a job goes to the
// Mac only when the variable is EXACTLY `pennie-mac`, and to GitHub's
// `ubuntu-latest` for anything else (missing, empty, `github`, a typo). This pins
// that, for every job, and that each job needing Docker goes to the Docker runner.
//
// Run: node --experimental-strip-types scripts/test-runner-routing.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowJobs } from "./lib/scan-workflow-jobs.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

// These stay on GitHub's runners because they run GNU `timeout` (and `setsid`),
// which a Mac has neither of: loadtest.yml is dispatched by hand, and clock-shift.yml
// is a daily report, so nothing waits on either.
const STAYS_ON_GITHUB = new Set(["loadtest.yml", "clock-shift.yml"]);

// A command a Mac does not have fails a routed job as "command not found" rather
// than running it. `timeout-minutes` is the job key, not the command.
const LINUX_ONLY = /\b(setsid|sha256sum|apt-get|timeout)\s/;

// A job needs Docker when it starts a local Supabase (the browser checks), dumps
// the database (`supabase db dump` runs pg_dump in a container) or runs the
// throwaway Postgres suites.
const NEEDS_DOCKER = /pnpm test:e2e|supabase db dump|scripts\/verify-\*-sql\.ts|verify:[\w-]+-sql/;

const RUNS_ON = /^ {4}runs-on: *(.+)$/m;
const ROUTED = /^\$\{\{ vars\.PENNIE_CI_RUNNER == 'pennie-mac' && '([\w-]+)' \|\| 'ubuntu-latest' \}\}$/;

/** What GitHub resolves the routed expression to, for a value of the variable. */
function resolve(runsOn: string, variable: string): string | null {
  const m = ROUTED.exec(runsOn);
  if (!m) return null;
  // `a == b && 'x' || 'y'`: the label is a non-empty string, so this is a ternary.
  return variable === "pennie-mac" ? m[1] : "ubuntu-latest";
}

// --- the resolver, on known answers first (L1) ---------------------------------------
{
  const expr = "${{ vars.PENNIE_CI_RUNNER == 'pennie-mac' && 'pennie-mac' || 'ubuntu-latest' }}";
  eq(resolve(expr, "pennie-mac"), "pennie-mac", "the exact value routes to the Mac");
  eq(resolve(expr, ""), "ubuntu-latest", "a missing variable reads as empty and goes to GitHub");
  eq(resolve(expr, "github"), "ubuntu-latest", "the documented switch back goes to GitHub");
  eq(resolve(expr, "Pennie-Mac"), "ubuntu-latest", "a typo goes to GitHub, never to a runner that does not exist");
  eq(resolve("ubuntu-latest", "pennie-mac"), null, "a plain label is not routed");
  eq(resolve("${{ vars.PENNIE_CI_RUNNER || 'ubuntu-latest' }}", "pennie-mac"), null, "a bare fallback is refused: any value would become a runner label");
}

// --- every job in every workflow -------------------------------------------------------
const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
assert(files.length > 10, `found ${files.length} workflows; the directory read is wrong if this is small`);

let routed = 0;
let docker = 0;
for (const file of files) {
  const jobs = parseWorkflowJobs(readFileSync(join(WORKFLOWS, file), "utf8"));
  for (const job of jobs) {
    const where = `${file} ${job.name}`;
    const runsOn = RUNS_ON.exec(job.body)?.[1].trim();
    if (runsOn === undefined) {
      assert(false, `${where} has no runs-on the test can read`);
      continue;
    }
    if (STAYS_ON_GITHUB.has(file)) {
      eq(runsOn, "ubuntu-latest", `${where} stays on GitHub's runners`);
      continue;
    }
    // Comments are stripped first: the browser job's explanation sits above it,
    // inside the previous job's body as the parser cuts it.
    const code = job.body.replace(/^\s*#.*$/gm, "");
    const wantsDocker = NEEDS_DOCKER.test(code);
    const linuxOnly = LINUX_ONLY.exec(code.replace(/timeout-minutes/g, ""));
    assert(linuxOnly === null, `${where} runs ${linuxOnly?.[1]}, which a Mac does not have`);
    const expected = wantsDocker ? "pennie-mac-docker" : "pennie-mac";
    eq(resolve(runsOn, "pennie-mac"), expected, `${where} runs on ${expected} when the variable says pennie-mac`);
    eq(resolve(runsOn, ""), "ubuntu-latest", `${where} runs on GitHub when the variable is not set`);
    routed++;
    if (wantsDocker) docker++;
  }
}
// Known answers from the tree on 2026-10-24: 25 jobs, three of them needing Docker
// (ci.yml browser, db-backup.yml backup, db-replay.yml replay). A count of zero
// would mean the scan found nothing, not that nothing needed checking (L98).
assert(routed >= 25, `routed ${routed} jobs; expected at least 25`);
eq(docker, 3, "three jobs need Docker: the browser checks, the backup and the replay");

// --- the security scan installs its tools on either machine ----------------------------
{
  const action = readFileSync(join(ROOT, ".github/actions/security-scan/action.yml"), "utf8");
  const steps = action.split(/\n(?=    - name: )/).slice(1);
  const linuxOnly = steps.filter((s) => /\n {6}if: runner\.os == 'Linux'/.test(s));
  eq(linuxOnly.length, 2, "gitleaks and semgrep each have a Linux only install");
  for (const step of linuxOnly) {
    const name = /- name: (.+)/.exec(step)![1];
    const mac = steps.find((s) => s.includes(`- name: ${name} (Mac runner)`));
    assert(mac !== undefined, `"${name}" has a Mac runner counterpart`);
    assert(mac !== undefined && /\n {6}if: runner\.os == 'macOS'/.test(mac), `"${name} (Mac runner)" runs only on a Mac`);
    assert(mac !== undefined && !/\bsudo\b/.test(mac.replace(/^\s*#.*$/gm, "")), `"${name} (Mac runner)" needs no sudo, which the runner user does not have`);
  }
  for (const step of steps.filter((s) => !/\n {6}if: runner\.os/.test(s))) {
    const body = step.replace(/^\s*#.*$/gm, "");
    assert(!/\bsudo\b|sha256sum|pipx /.test(body), `${/- name: (.+)/.exec(step)![1]} runs on both machines, so uses nothing only Linux has`);
  }
}

finish();

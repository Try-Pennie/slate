// Every job in every workflow sets a timeout (#1597).
//
// GitHub's default is SIX HOURS, so a stalled step does not fail, it hangs, and a
// hang reads as slowness until somebody goes looking (L110). The cost is worst
// exactly where the pipeline matters most: ci.yml's concurrency is deliberately
// `cancel-in-progress: false` on main (a run on main IS the deploy), so a hung
// main run is never superseded, later pushes queue behind it, and every deploy is
// blocked for up to six hours. A hang also bills up to 360 minutes against the
// metered Actions budget, and the smoke canary fires every 30 minutes, so one
// hang there can stack.
//
// The class has already fired here in miniature: #1437 was the Supabase CLI
// download hanging up its socket rather than failing.
//
// SCOPED TO THE DIRECTORY, not to a file. Bidspoke's version of this guard
// covered only the one workflow it was written for, and the same defect sat
// untouched in the three files next door (L135, L30). Reading the directory means
// a sixth workflow is covered by construction rather than by somebody remembering
// to add it here.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//   scripts/test-workflow-timeouts.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowJobs, readTimeoutMinutes } from "./lib/scan-workflow-jobs.ts";
import { assert, finish } from "./lib/harness.ts";
import {
  CANARY_VERSION_TIMEOUT_MS,
  cronsFromWranglerConfig,
  maxCronWaitMs,
} from "./lib/gradual-deploy.ts";
import { DEFAULT_VERSION_TIMEOUT_MS } from "./lib/post-deploy-probe.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".github", "workflows");

/**
 * Nothing here should ever need six hours. The ceiling is not about saving
 * minutes, it is so a number large enough to be indistinguishable from no
 * timeout at all cannot be written and still read as a bound.
 */
const MAX_TIMEOUT_MINUTES = 60;

// --- the parser, on a fixture ---------------------------------------------------
//
// A parser that returns NOTHING passes every assertion below, because a workflow
// with no jobs has no job missing a timeout (L98). So it is exercised on a
// fixture where the right answer is known first.
{
  const fixture = [
    "name: Fixture",
    "on:",
    "  push:",
    "jobs:",
    "  first:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 12  # measured max 90s",
    "    steps:",
    "      - run: echo hi",
    "        timeout-minutes: 3",
    "  second:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo bye",
  ].join("\n");

  const jobs = parseWorkflowJobs(fixture);
  assert(jobs.length === 2, `both jobs are found, not one giant block (got ${jobs.length})`);
  assert(
    jobs.map((j) => j.name).join(",") === "first,second",
    `and by name in file order (got ${jobs.map((j) => j.name).join(",")})`,
  );
  assert(
    jobs[0].timeoutMinutes === 12,
    "a job's own timeout is read, trailing comment and all (each real one carries the duration it was set from)",
  );
  assert(
    jobs[1].timeoutMinutes === null,
    "a job with no timeout reads as null, not as inheriting its neighbour's",
  );
  // The block-match bug this parser exists to avoid: if `first` swallowed
  // `second`, `second`'s missing timeout would be answered by `first`'s.
  assert(
    !jobs[0].body.includes("second"),
    "a job's body stops at the next job key (or one job answers for every other)",
  );
  // A STEP's timeout must never answer for the job's. `second` has a step-level
  // one in no job here, so check the indent rule directly.
  assert(
    readTimeoutMinutes("    steps:\n      - run: x\n        timeout-minutes: 3\n") === null,
    "a step-level timeout is not read as the job's (a bounded step does not bound the job)",
  );
}

// --- every job in every workflow ------------------------------------------------
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
assert(
  files.length > 0,
  `the workflow directory has files to check (found ${files.length}); an empty read must never pass as "every job is fine"`,
);

let jobCount = 0;
for (const file of files) {
  const jobs = parseWorkflowJobs(readFileSync(join(DIR, file), "utf8"));
  assert(jobs.length > 0, `${file}: its jobs are readable (a file parsed as having none checks nothing)`);
  for (const job of jobs) {
    jobCount++;
    assert(
      job.timeoutMinutes !== null,
      `${file}: job \`${job.name}\` sets timeout-minutes (without one GitHub lets it hang for six hours, and on main that blocks every deploy behind it)`,
    );
    if (job.timeoutMinutes === null) continue;
    assert(
      job.timeoutMinutes > 0,
      `${file}: job \`${job.name}\` has a positive timeout (got ${job.timeoutMinutes})`,
    );
    assert(
      job.timeoutMinutes <= MAX_TIMEOUT_MINUTES,
      `${file}: job \`${job.name}\` is bounded at ${MAX_TIMEOUT_MINUTES} minutes or less (got ${job.timeoutMinutes}); a number this large is indistinguishable from no timeout at all`,
    );
  }
}
assert(jobCount > 0, `there were jobs to check (checked ${jobCount})`);

// --- positive control: the guard catches a job with no timeout -------------------
//
// Everything above is satisfied by a scan that found nothing wrong AND by one
// that cannot see the defect at all (L1, L98).
{
  const missing = parseWorkflowJobs(
    ["jobs:", "  hangs:", "    runs-on: ubuntu-latest", "    steps:", "      - run: sleep 99999"].join("\n"),
  );
  assert(missing.length === 1 && missing[0].timeoutMinutes === null, "a job with no timeout is detected as such");
  const capped = parseWorkflowJobs(
    ["jobs:", "  huge:", "    runs-on: ubuntu-latest", "    timeout-minutes: 360", "    steps:", "      - run: x"].join("\n"),
  );
  assert(
    capped[0].timeoutMinutes !== null && capped[0].timeoutMinutes > MAX_TIMEOUT_MINUTES,
    "and a timeout large enough to be no timeout is detected as over the ceiling",
  );
}

// --- the deploy bound must clear the probe's OWN bound (L522) -------------------
//
// The post-deploy probe polls for up to DEFAULT_VERSION_TIMEOUT_MS waiting for
// Cloudflare to serve the commit just deployed. If the JOB's timeout were at or
// below that, the job would be killed while the probe was still legitimately
// waiting, and the run would read as a hung deploy rather than as propagation
// never completing: a wrong diagnosis, on the one alert that pages about main.
//
// Read from the probe's own constant rather than restated here, so raising the
// probe's window fails this rather than silently crossing the job's bound.
{
  const ci = readFileSync(join(DIR, "ci.yml"), "utf8");
  const deploy = parseWorkflowJobs(ci).find((j) => j.name === "deploy");
  assert(deploy !== undefined, "the deploy job exists");
  const probeSrc = readFileSync(join(ROOT, "scripts", "lib", "post-deploy-probe.ts"), "utf8");
  const probeMs = Number(
    probeSrc.match(/DEFAULT_VERSION_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, "") ?? NaN,
  );
  assert(
    Number.isFinite(probeMs) && probeMs > 0,
    `the probe's own polling bound is readable (got ${probeMs}); an unreadable one would make the comparison below vacuous`,
  );
  const probeMinutes = probeMs / 60_000;
  assert(
    (deploy?.timeoutMinutes ?? 0) > probeMinutes * 2,
    `the deploy job's timeout (${deploy?.timeoutMinutes}m) clears the probe's own ${probeMinutes}m polling window with room to spare, so a slow propagation is reported by the probe rather than killed by the job`,
  );
}

// --- the gradual deploy's worst case fits inside the job (#3095) -----------------
//
// The deploy now waits for a clear cron window, probes the canary, and probes again
// after promoting. A job killed in the middle of that can leave the split standing
// until its settle step runs, so the bound is sized against the worst case read from
// the code's own constants and the real cron schedule, plus ten minutes for the
// install, the build and the two uploads.
{
  const ci = readFileSync(join(DIR, "ci.yml"), "utf8");
  const deploy = parseWorkflowJobs(ci).find((j) => j.name === "deploy");
  const crons = cronsFromWranglerConfig(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"));
  assert(crons !== null, "the cron schedule is readable, so the wait it can impose is known");
  const worstMs = maxCronWaitMs(crons ?? []) + CANARY_VERSION_TIMEOUT_MS + DEFAULT_VERSION_TIMEOUT_MS;
  const neededMinutes = worstMs / 60_000 + 10;
  assert(
    (deploy?.timeoutMinutes ?? 0) >= neededMinutes,
    `the deploy job's timeout (${deploy?.timeoutMinutes}m) covers the gradual deploy's worst case (${Math.ceil(neededMinutes)}m: the longest cron wait, both probe windows, and ten minutes for install, build and uploads)`,
  );
  const rollback = parseWorkflowJobs(readFileSync(join(DIR, "rollback.yml"), "utf8")).find((j) => j.name === "rollback");
  assert(
    (rollback?.timeoutMinutes ?? 0) > (DEFAULT_VERSION_TIMEOUT_MS / 60_000) * 2,
    `the rollback job's timeout (${rollback?.timeoutMinutes}m) clears the probe's own polling window with room to spare`,
  );
}

finish();

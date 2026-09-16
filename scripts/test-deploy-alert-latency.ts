// The deploy failure alert is timed from the DEPLOY, not from the run (#2402).
//
// `.github/workflows/deploy-alert.yml` fires on `workflow_run: types: [completed]`
// and reads the whole run's conclusion, so it cannot arrive until the LAST job in
// the watched workflow has finished. Coverage sat in that workflow, outlived the
// deploy by about four minutes on every merge, and gated nothing: the one
// notification that production is serving a broken commit waited on a report.
// Measured on six merges to main on 2026-09-15 and 16, the deploy ended between
// 217s and 281s before the run did (runs 35115428061, 35112495998, 35111352989,
// 35105764041, 35102610040, 35018357994).
//
// The invariant is about the GRAPH, not about one job name. Every job in a
// watched workflow either sits in the deploy's own transitive `needs` closure, or
// says in its own body why it may run outside it. A job added later carries no
// marker and fails this, so it is covered by construction rather than by somebody
// remembering to list it here (L96), and the exemption has to carry a reason, so
// it is a decision rather than a default (L129, L233).
//
// Run: node --experimental-strip-types scripts/test-deploy-alert-latency.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWorkflowJobs,
  parseWorkflowTriggers,
  transitiveNeeds,
  readJobMarker,
  type WorkflowJob,
} from "./lib/scan-workflow-jobs.ts";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".github", "workflows");

/** The step command that identifies the job which actually ships to production. */
const DEPLOY_COMMAND = /\bpnpm\s+cf:deploy\b/;
/** The step command that identifies the job which produces the coverage report. */
const COVERAGE_COMMAND = /\bpnpm\s+test:coverage\b/;
/** A job outside the deploy's closure declares why it may outlive nothing. */
const MARKER = "alert-latency-ok";

type Workflow = { file: string; name: string; source: string; jobs: WorkflowJob[] };

function readWorkflows(): Workflow[] {
  return readdirSync(DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((file) => {
      const source = readFileSync(join(DIR, file), "utf8");
      return {
        file,
        name: source.match(/^name:\s*(.+)$/m)?.[1].trim() ?? "",
        source,
        jobs: parseWorkflowJobs(source),
      };
    });
}

/**
 * The jobs in `workflow` that make the alert wait: not the deploy, not anything
 * the deploy waits on, and not carrying the marker. Pure, so the positive
 * controls below can drive it over fixtures where the answer is known.
 */
export function jobsDelayingTheAlert(jobs: WorkflowJob[], deployJob: string): string[] {
  const closure = transitiveNeeds(jobs, deployJob);
  return jobs
    .filter((j) => !closure.has(j.name) && readJobMarker(j.body, MARKER) === null)
    .map((j) => j.name);
}

const workflows = readWorkflows();
assert(
  workflows.length > 0,
  `the workflow directory has files to read (found ${workflows.length}); an empty read must never pass as "nothing delays the alert"`,
);

// --- which workflows the alert waits on, read from the alerter itself -----------
const alerter = workflows.find((w) => w.file === "deploy-alert.yml");
assert(alerter !== undefined, "#2402: deploy-alert.yml exists (it is the alerting for a failed deploy)");

const watchedNames = alerter ? parseWorkflowTriggers(alerter.source).watches : [];
assert(
  watchedNames.length > 0,
  `#2402: the alerter names the workflow(s) it watches (read ${JSON.stringify(watchedNames)}); an unreadable list would make every assertion below vacuous`,
);

const watched = workflows.filter((w) => watchedNames.includes(w.name));
assert(
  watched.length === watchedNames.length,
  `#2402: every workflow the alerter watches (${JSON.stringify(watchedNames)}) exists by that name in ${DIR.replace(ROOT + "/", "")}; a rename here means the alert watches a run that never completes`,
);

// --- the general rule: nothing outside the deploy's path may hold the run open --
let judged = 0;
for (const w of watched) {
  const deployJobs = w.jobs.filter((j) => j.runs.some((cmd) => DEPLOY_COMMAND.test(cmd)));
  assert(
    deployJobs.length === 1,
    `#2402: ${w.file} has exactly one job that deploys (found ${deployJobs.length}: ${JSON.stringify(deployJobs.map((j) => j.name))}); with none, this guard would be comparing against nothing and pass`,
  );
  if (deployJobs.length !== 1) continue;

  const deployJob = deployJobs[0] as WorkflowJob;
  const delaying = jobsDelayingTheAlert(w.jobs, deployJob.name);
  judged++;
  assert(
    delaying.length === 0,
    `#2402: in ${w.file} every job is in \`${deployJob.name}\`'s transitive needs closure or carries a \`# ${MARKER}:\` reason. These do neither, so each one holds the run open after the deploy has already failed: ${JSON.stringify(delaying)}`,
  );

  // An exemption must be a sentence somebody wrote, not an empty marker.
  const closure = transitiveNeeds(w.jobs, deployJob.name);
  for (const job of w.jobs) {
    if (closure.has(job.name)) continue;
    const reason = readJobMarker(job.body, MARKER) ?? "";
    assert(
      reason.length > 10,
      `#2402: ${w.file}: job \`${job.name}\` runs outside the deploy's path, so its \`# ${MARKER}:\` marker states why that does not delay the alert (got "${reason}")`,
    );
  }
}
assert(judged > 0, `#2402: at least one watched workflow was actually judged (judged ${judged})`);

// --- the specific regression: coverage is not in a watched workflow -------------
//
// Derived by finding which workflow RUNS the coverage report rather than by
// naming a file, so moving it back into CI under any job name fails this.
const coverageWorkflows = workflows.filter((w) =>
  w.jobs.some((j) => j.runs.some((cmd) => COVERAGE_COMMAND.test(cmd))),
);
assert(
  coverageWorkflows.length === 1,
  `#2402: exactly one workflow runs the coverage report (found ${coverageWorkflows.length}: ${JSON.stringify(coverageWorkflows.map((w) => w.file))}); zero means this check is looking for something that is not there and would pass on its own blindness`,
);
for (const w of coverageWorkflows) {
  assert(
    !watchedNames.includes(w.name),
    `#2402: the coverage report runs in ${w.file} (workflow "${w.name}"), which the deploy alert does NOT watch. It is in a watched one, so the alert waits about four minutes for a report that gates nothing`,
  );
}

// --- positive controls ----------------------------------------------------------
//
// Every assertion above is satisfied by a scan that found nothing wrong AND by
// one that cannot see the defect at all (L1, L98). These drive the same pure
// function over fixtures where the right answer is known.
{
  const fixture = (extra: string) =>
    parseWorkflowJobs(
      [
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm build",
        "  gate:",
        "    needs: [build]",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo ok",
        "  deploy:",
        "    needs: [gate]",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: pnpm cf:deploy",
        extra,
      ]
        .filter((l) => l.length > 0)
        .join("\n"),
    );

  const clean = fixture("");
  assert(
    jobsDelayingTheAlert(clean, "deploy").length === 0,
    "control: a workflow whose every job feeds the deploy delays the alert by nothing",
  );

  // THE DEFECT ITSELF: coverage back beside the deploy, needed by nobody.
  const withCoverage = fixture(
    ["  coverage:", "    runs-on: ubuntu-latest", "    steps:", "      - run: pnpm test:coverage"].join("\n"),
  );
  assert(
    jobsDelayingTheAlert(withCoverage, "deploy").join(",") === "coverage",
    `control: a report-only coverage job in the watched workflow IS caught (got ${JSON.stringify(jobsDelayingTheAlert(withCoverage, "deploy"))})`,
  );

  // And any OTHER unrelated job, so the rule is not secretly about one name.
  const withStranger = fixture(
    ["  docs:", "    runs-on: ubuntu-latest", "    steps:", "      - run: pnpm docs:publish"].join("\n"),
  );
  assert(
    jobsDelayingTheAlert(withStranger, "deploy").join(",") === "docs",
    "control: a newly added job outside the deploy's path is caught too, with no list to add it to",
  );

  // A marker with a reason exempts it; an EMPTY marker does not count as one.
  const marked = fixture(
    [
      "  docs:",
      "    # alert-latency-ok: finishes long before the deploy does",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm docs:publish",
    ].join("\n"),
  );
  assert(
    jobsDelayingTheAlert(marked, "deploy").length === 0,
    "control: a job declaring why it may run outside the closure is allowed",
  );
  const emptyMarker = fixture(
    [
      "  docs:",
      "    # alert-latency-ok:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm docs:publish",
    ].join("\n"),
  );
  assert(
    jobsDelayingTheAlert(emptyMarker, "deploy").join(",") === "docs",
    "control: a marker with no reason after it is not an exemption",
  );

  // And the closure really is transitive: removing the gate's own dependency
  // must strand `build`, or a one hop reading would call this clean.
  const shallow = parseWorkflowJobs(
    [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm build",
      "  deploy:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: pnpm cf:deploy",
    ].join("\n"),
  );
  assert(
    jobsDelayingTheAlert(shallow, "deploy").join(",") === "build",
    "control: a job the deploy does not wait on is caught even when it looks like part of the pipeline",
  );
}

finish();

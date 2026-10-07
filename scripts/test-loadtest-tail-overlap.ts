// No two `wrangler tail` jobs of a load run may be open at once (#3450).
//
// Stopping one tail on a Worker silences every other tail attached to it. Measured
// 2026-10-06 (all times ET): tail A and tail B both received the 8:30 PM crons, B
// was stopped at 8:30:34 PM, and A then received nothing for two and a half minutes while the every
// minute cron kept firing; one tail alone received a cron every minute. On run
// 37547143303 the archive tail attached while the burst tail was still open, and
// went deaf at 7:49:22 PM ET when the burst tail was stopped, so the startup bar was
// judged on 1 of 24 confirms.
//
// So every pair of jobs that runs `wrangler tail` must be ordered by `needs`, and the
// archive must still start no later than the drive it exists to record.
//
// Run: node --experimental-strip-types scripts/test-loadtest-tail-overlap.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowJobs, transitiveNeeds, type WorkflowJob } from "./lib/scan-workflow-jobs.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const WORKFLOW = join(import.meta.dirname, "..", ".github", "workflows", "loadtest.yml");

/** The jobs whose steps open a tail on the Worker. */
function tailJobs(jobs: WorkflowJob[]): string[] {
  return jobs.filter((j) => j.runs.some((r) => /\bwrangler tail\b/.test(r))).map((j) => j.name);
}

/** The job's `if:` expression, or null when it has none. */
function jobIf(job: WorkflowJob): string | null {
  return /^ {4}if: (.+)$/m.exec(job.body)?.[1]?.trim() ?? null;
}

/** Every way the workflow lets two tails overlap, or the archive start after the drive. */
function tailProblems(source: string): string[] {
  const jobs = parseWorkflowJobs(source);
  const out: string[] = [];
  const tails = tailJobs(jobs);
  for (let i = 0; i < tails.length; i++) {
    for (let k = i + 1; k < tails.length; k++) {
      const a = tails[i]!;
      const b = tails[k]!;
      if (!transitiveNeeds(jobs, a).has(b) && !transitiveNeeds(jobs, b).has(a)) {
        out.push(`${a} and ${b} both run wrangler tail and neither needs the other, so they can be open at once`);
      }
    }
  }
  // The archive records the drive, so it may wait on nothing the drive does not:
  // a job the archive waits for and the drive does not would let the drive start
  // first and its opening minutes go unrecorded.
  const archive = transitiveNeeds(jobs, "archive");
  const drive = transitiveNeeds(jobs, "drive");
  for (const name of archive) {
    if (name !== "archive" && !drive.has(name)) out.push(`the archive waits for ${name} and the drive does not, so the drive can start unrecorded`);
  }
  // A job that waits for the burst tail must still run when the burst tail failed:
  // the tail is a diagnostic, and without `!cancelled()` its failure would skip the
  // steady pass and everything after it (#3222).
  for (const job of jobs) {
    if (!job.needs.includes("burst-tail") || job.name === "judge") continue;
    const cond = jobIf(job) ?? "";
    if (!cond.includes("!cancelled()")) out.push(`${job.name} needs burst-tail without !cancelled(), so a failed burst tail would skip it`);
  }
  return out;
}

const yml = readFileSync(WORKFLOW, "utf8");
const jobs = parseWorkflowJobs(yml);

{
  // The scanner sees the tails it is guarding, so an empty answer below cannot be a
  // scanner that found nothing (L98).
  const tails = tailJobs(jobs).sort();
  eq(tails, ["archive", "burst-tail", "cold"], "the three jobs that tail the Worker are the ones read");
}

{
  const problems = tailProblems(yml);
  eq(problems, [], "no two tails can be open at once, and the archive starts with the drive");
}

{
  // Controls, each planted into the real file so the check is seen to fail on the
  // wiring it exists to refuse (L1).
  const archiveAt = yml.indexOf("\n  archive:\n");
  assert(archiveAt > 0, "control: the archive job is where the plant expects it");
  const afterArchive = yml.slice(archiveAt);
  const needsLine = /\n {4}needs: \[[^\]]*\]/.exec(afterArchive)?.[0] ?? "";
  assert(needsLine.includes("burst-tail"), `control: the archive's needs are readable (${needsLine.trim()})`);

  // 1. The wiring run 37547143303 had: the archive waits only for the burst.
  const asRun = yml.slice(0, archiveAt) + afterArchive.replace(needsLine, "\n    needs: [preflight, setup-burst, burst]");
  const ranProblems = tailProblems(asRun);
  assert(
    ranProblems.some((p) => p.startsWith("archive and burst-tail") || p.startsWith("burst-tail and archive")),
    `control: the archive overlapping the burst tail is refused (got ${JSON.stringify(ranProblems)})`,
  );

  // 2. The archive waiting for the burst tail while the drive does not.
  const driveAt = yml.indexOf("\n  drive:\n");
  const afterDrive = yml.slice(driveAt);
  const driveNeeds = /\n {4}needs: \[[^\]]*\]/.exec(afterDrive)?.[0] ?? "";
  const driveEarly = yml.slice(0, driveAt) + afterDrive.replace(driveNeeds, "\n    needs: [preflight, setup-burst, burst]");
  assert(
    tailProblems(driveEarly).some((p) => p.includes("the drive can start unrecorded")),
    "control: a drive that can start before the archive is refused",
  );

  // 3. A job waiting for the burst tail without `!cancelled()`.
  const strict = yml.slice(0, archiveAt) + afterArchive.replace(/\n {4}if: \$\{\{ !cancelled\(\) && /, "\n    if: ${{ ");
  assert(
    tailProblems(strict).some((p) => p.startsWith("archive needs burst-tail without !cancelled()")),
    "control: a burst tail failure that would skip the archive is refused",
  );
}

// --- every tail stops at its window and keeps what it caught (#3463) ---------------
//
// `timeout` signals only the process it started (`npx`), and `wrangler` beneath it can
// outlive it while holding the step open (L321). On run 37566700055 the archive's
// step ran 36 minutes past a 29 minute window until the job was cancelled, and its
// upload never ran, so the run had no archived log at all. The burst tail and the cold
// job already start the tail under `setsid` and stop its whole process group; every
// job that tails must, and must upload what it caught whatever the step did.

/** Every way a tailing job could hang past its window or lose its file. */
function stopProblems(source: string): string[] {
  const out: string[] = [];
  for (const job of parseWorkflowJobs(source)) {
    const tailRuns = job.runs.filter((r) => /\bwrangler tail\b/.test(r));
    if (tailRuns.length === 0) continue;
    for (const run of tailRuns) {
      if (!/\bsetsid\b[^\n]*\bwrangler tail\b/.test(run)) out.push(`${job.name} runs wrangler tail without setsid, so a stop cannot reach wrangler beneath npx`);
    }
    // The stop is its own command line, so it is looked for across the job's commands.
    if (!job.runs.some((r) => /kill -TERM -- -"\$\w+"/.test(r))) out.push(`${job.name} never signals the tail's process group, so it can run past its window`);
    if (!/- if: always\(\)\n\s+uses: actions\/upload-artifact@/.test(job.body)) out.push(`${job.name} uploads its tail only on success, so a step that hangs loses everything it caught`);
  }
  return out;
}

{
  eq(stopProblems(yml), [], "every tailing job stops its whole process group at its window and uploads whatever happened");
  // Control: the archive as run 37566700055 ran it is refused on all three counts.
  const asRun = yml
    .replace(/\n {4}if: \$\{\{ !cancelled\(\)[^\n]*\n( {4}runs-on: ubuntu-latest\n(?: {4}#[^\n]*\n)* {4}timeout-minutes: \d+\n)/, "\n$1")
    .replace(/(Archive the Worker's logs for the window[\s\S]*?run: \|\n)[\s\S]*?(\n {6}- if: always\(\)\n {8}uses: actions\/upload-artifact@[^\n]+\n {8}with:\n {10}name: tail\n)/, (_m, head: string, upload: string) =>
      `${head}          set -o pipefail\n          mkdir -p results\n          timeout 29m npx wrangler tail --env loadtest --format json > results/tail.jsonl || true\n          wc -l results/tail.jsonl${upload.replace("- if: always()\n        uses", "- uses")}`);
  const ran = stopProblems(asRun).filter((p) => p.startsWith("archive "));
  eq(ran.length, 3, `control: the archive as run 37566700055 had it is refused three ways (got ${JSON.stringify(ran)})`);
}

finish();

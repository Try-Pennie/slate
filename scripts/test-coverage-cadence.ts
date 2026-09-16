// The coverage report is priced, and its price is re-measurable (#2395).
//
// #1593 moved coverage to merges only and recorded the choice as a sentence:
// "about 4m05s", "about 1,000 billed minutes a month", a weekly schedule declined
// because "a per-merge record is worth the difference". Nothing re-measured any of
// it. By 2026-09-16 the job took 8m33s to 9m04s, which bills 9 or 10 minutes, and
// main took about 258 pushes in 15 days, so the real figure was roughly 4,700
// billed minutes a month against the 1,000 the decision was made on. On 10
// September the account's spending limit refused the `ci` fan-in on run
// 34532636820 after all nine legs had passed, so a green merge never deployed.
//
// A premise recorded as a dated sentence expires in silence (L316). This pins it
// as numbers the guard can re-derive: the cadence comes from the cron the workflow
// actually carries, never from the sentence beside it, so the two cannot drift
// apart while each reads as correct alone (L70).
//
// Run: node --experimental-strip-types scripts/test-coverage-cadence.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWorkflowJobs,
  parseWorkflowTriggers,
  monthlyRunsFromCron,
  readCostPremise,
} from "./lib/scan-workflow-jobs.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, ".github", "workflows");

const COVERAGE_COMMAND = /\bpnpm\s+test:coverage\b/;

/**
 * The contiguous run of `#` comment lines containing the line that matches
 * `anchor`, so an assertion about a premise reads the premise's own block and
 * not some unrelated line elsewhere in the file.
 */
export function commentBlockAround(source: string, anchor: RegExp): string {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => anchor.test(l));
  if (at < 0) return "";
  let from = at;
  while (from > 0 && /^\s*#/.test(lines[from - 1] as string)) from--;
  let to = at;
  while (to + 1 < lines.length && /^\s*#/.test(lines[to + 1] as string)) to++;
  return lines.slice(from, to + 1).join("\n");
}

/** Triggers that put a job on the path of a merge, which is what #2395 priced. */
const PER_COMMIT_EVENTS = ["push", "pull_request", "pull_request_target", "merge_group"];

const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
assert(files.length > 0, `the workflow directory has files to read (found ${files.length})`);

const carrying = files
  .map((file) => ({ file, source: readFileSync(join(DIR, file), "utf8") }))
  .filter(({ source }) =>
    parseWorkflowJobs(source).some((j) => j.runs.some((cmd) => COVERAGE_COMMAND.test(cmd))),
  );

// Zero is not a pass. A scan that found no coverage job at all satisfies every
// "it is not on a push" assertion below while proving nothing (L98).
assert(
  carrying.length === 1,
  `#2395: exactly one workflow runs the coverage report (found ${carrying.length}: ${JSON.stringify(carrying.map((c) => c.file))})`,
);

if (carrying.length === 1) {
  const { file, source } = carrying[0] as { file: string; source: string };
  const triggers = parseWorkflowTriggers(source);
  assert(
    triggers.events.length > 0,
    `#2395: ${file}'s \`on:\` block is readable (read ${JSON.stringify(triggers.events)}); an unreadable one would make the trigger assertions vacuous`,
  );

  // --- it is off the merge path -------------------------------------------------
  for (const event of PER_COMMIT_EVENTS) {
    assert(
      !triggers.events.includes(event),
      `#2395: ${file} does not run on \`${event}\`. The whole cost is the cadence: at about 258 pushes to main a fortnight, a 9 minute job on each one is roughly 4,700 billed minutes a month on a budget that has already refused a job`,
    );
  }
  assert(
    triggers.events.includes("schedule"),
    `#2395: ${file} runs on a schedule, so the coverage record still exists rather than being dropped (read ${JSON.stringify(triggers.events)})`,
  );
  assert(
    triggers.events.includes("workflow_dispatch"),
    `#2395: ${file} can be run on demand, so a change whose coverage effect matters need not wait for the schedule`,
  );

  // --- the cadence is priced, and the price is derived from the cron -------------
  assert(triggers.crons.length > 0, `#2395: ${file} carries at least one cron expression`);

  const perCron = triggers.crons.map((c) => ({ cron: c, runs: monthlyRunsFromCron(c) }));
  for (const { cron, runs } of perCron) {
    assert(
      runs !== null,
      `#2395: the cron "${cron}" is one this guard can price. A cadence it cannot read must fail rather than be waved through, or the budget check becomes a reassuring sentence`,
    );
  }
  const derivedRuns = perCron.reduce((sum, p) => sum + (p.runs ?? 0), 0);

  const premise = readCostPremise(source);
  assert(
    premise !== null,
    `#2395: ${file} carries a \`# cost-premise:\` line with runs-per-month, billed-minutes-per-run and ceiling-billed-minutes-per-month. #1593's premise was a dated sentence and nothing re-measured it for three weeks`,
  );

  if (premise) {
    // The declared cadence and the cron are ONE fact with two spellings. Checking
    // them against each other is what stops the premise going stale while the
    // schedule moves underneath it.
    eq(
      premise.runsPerMonth,
      derivedRuns,
      `#2395: the declared runs-per-month matches what ${JSON.stringify(triggers.crons)} actually fires in an average month`,
    );
    assert(
      premise.billedMinutesPerRun > 0,
      `#2395: the declared per run cost is a real number (got ${premise.billedMinutesPerRun})`,
    );
    const monthly = premise.runsPerMonth * premise.billedMinutesPerRun;
    assert(
      monthly <= premise.ceilingBilledMinutesPerMonth,
      `#2395: the priced cost (${premise.runsPerMonth} runs times ${premise.billedMinutesPerRun} billed minutes = ${monthly}) is inside the declared ceiling of ${premise.ceilingBilledMinutesPerMonth} billed minutes a month`,
    );
    // The ceiling has to bind. One set far above the cadence is a number that can
    // never fail, which reads as a budget and is not one.
    assert(
      premise.ceilingBilledMinutesPerMonth <= monthly * 3,
      `#2395: the ceiling (${premise.ceilingBilledMinutesPerMonth}) is close enough to the priced cost (${monthly}) to actually bind; a ceiling nothing can reach is not a budget`,
    );
  }

  // --- the premise says how to re-measure it, not just what it was --------------
  //
  // Scoped to the comment block the premise sits in, not to the whole file: a
  // `gh` line or a long number somewhere else in the workflow would answer for a
  // premise that names neither, and the file would read as sourced (L135).
  const premiseBlock = commentBlockAround(source, /^\s*#\s*cost-premise:/m);
  assert(
    /gh (api|run)\b/.test(premiseBlock),
    `#2395: the \`cost-premise\` block in ${file} names the command that re-measures it, so the next drift is a diff rather than a rediscovery (L316)`,
  );
  assert(
    (premiseBlock.match(/\b\d{11}\b/g) ?? []).length >= 3,
    `#2395: the \`cost-premise\` block in ${file} names the run ids the per run figure was measured from, so a reader can check the measurement rather than trust the sentence`,
  );
}

// --- positive controls ----------------------------------------------------------
//
// The cadence derivation is the load bearing part: a function that returned the
// same number for every cron would satisfy the equality above as long as the
// premise happened to carry that number (L1).
{
  eq(monthlyRunsFromCron("40 5 * * *"), 31, "a daily cron is priced at 31 runs a month");
  eq(monthlyRunsFromCron("20 13 * * 1"), 5, "a weekly cron is priced at 5");
  eq(monthlyRunsFromCron("0 */6 * * *"), 122, "a six hourly cron is priced at 122");
  eq(monthlyRunsFromCron("*/30 * * * *"), 1462, "a half hourly cron is priced at 1462");
  eq(monthlyRunsFromCron("0 6,18 * * *"), 61, "two fixed hours a day is priced at 61");
  eq(monthlyRunsFromCron("0 6 1 * *"), 1, "a monthly cron is priced at 1");

  // Refusals, each of which must be null rather than a guess.
  eq(monthlyRunsFromCron("not a cron"), null, "an unreadable cron is refused, not guessed at");
  eq(monthlyRunsFromCron("0 6 * 3 *"), null, "a cron restricted to one month is refused");
  eq(monthlyRunsFromCron("0 6 1 * 1"), null, "a cron setting BOTH day fields is refused");

  // The premise reader must not accept a partly written line: two thirds of a
  // premise is not a premise, and a null there is what makes the guard say so.
  eq(
    readCostPremise("# cost-premise: runs-per-month=31 billed-minutes-per-run=10\n"),
    null,
    "a premise missing its ceiling reads as no premise at all",
  );
  const full = readCostPremise(
    "# cost-premise: runs-per-month=31 billed-minutes-per-run=10 ceiling-billed-minutes-per-month=400\n",
  );
  eq(full?.runsPerMonth ?? 0, 31, "a complete premise reads its cadence");
  eq(full?.billedMinutesPerRun ?? 0, 10, "and its per run cost");
  eq(full?.ceilingBilledMinutesPerMonth ?? 0, 400, "and its ceiling");
}

// The scan that finds the coverage job must be able to see one. A detector that
// reads every workflow as carrying no run commands reports a clean tree.
{
  const jobs = parseWorkflowJobs(
    [
      "jobs:",
      "  coverage:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Merged coverage report",
      "        run: pnpm test:coverage",
    ].join("\n"),
  );
  assert(
    jobs.some((j) => j.runs.some((cmd) => COVERAGE_COMMAND.test(cmd))),
    "control: the run command scan finds a coverage step when one is there",
  );
  const commented = parseWorkflowJobs(
    [
      "jobs:",
      "  other:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      # this job does NOT run pnpm test:coverage",
      "      - run: pnpm lint",
    ].join("\n"),
  );
  assert(
    !commented.some((j) => j.runs.some((cmd) => COVERAGE_COMMAND.test(cmd))),
    "control: a comment MENTIONING the command is not a job running it",
  );
}

finish();

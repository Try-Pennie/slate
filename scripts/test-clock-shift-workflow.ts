// The daily shifted clock run keeps its shape (#3960).
//
// On 2026-10-20 (run 39402068299) the three passes ran one after another in one job,
// each took about 533s, the 25 minute job limit cut off the third, and the alert said
// that pass "died" and pointed at output it had never printed. So each shift is its
// own job now, with its own time limit, and one report job reads them all. The rules
// that make that work are easy to undo one edit at a time, each edit reading as a
// tidy up, so each is checked against the real file AND against a copy broken in
// exactly that way, so a checker that stopped reading the file cannot pass (L1).
//
// Run: node --experimental-strip-types scripts/test-clock-shift-workflow.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { parseWorkflowJobs, type WorkflowJob } from "./lib/scan-workflow-jobs.ts";

const root = join(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github/workflows/clock-shift.yml"), "utf8");

/** One pass of the node suite on a runner, measured on run 39402068299 (+1d 533.24s,
 *  +3mo 532.10s). A pass's own limit has to leave it room to grow (L315). */
const MEASURED_PASS_SECONDS = 533;
/** The least room a pass's limit must leave over the measured pass. */
const PASS_HEADROOM = 1.5;
/** What the job must hold beyond the pass's limit: setup took 21s on that run, plus
 *  timeout's kill grace, the marker and the upload, so the steps that tell the report
 *  how the pass ended still run inside the job's own limit. */
const JOB_MARGIN_MINUTES = 5;

function job(jobs: WorkflowJob[], test: (j: WorkflowJob) => boolean): WorkflowJob | undefined {
  return jobs.find(test);
}

/** Each step's text in one job body, split at the six space step marker. */
function steps(body: string): string[] {
  return body.split(/\n {6}- (?=name:|uses:|if:|id:|run:)/).slice(1);
}

function problems(text: string): string[] {
  const out: string[] = [];
  const jobs = parseWorkflowJobs(text);
  const code = text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  // ONE list of shifts, at the workflow level, so the matrix that runs them and the
  // report that judges them read the same thing (L41). Every other mention of the
  // name reads it from there rather than writing it out again.
  const assignments = [...code.matchAll(/^(\s*)CLOCK_SHIFTS:\s*(.+)$/gm)];
  const literals = assignments.filter((m) => !/\$\{\{\s*env\.CLOCK_SHIFTS\s*\}\}/.test(m[2] ?? ""));
  if (literals.length !== 1) {
    out.push(`the shift list is written ${literals.length} times, not once`);
  } else if ((literals[0]?.[1] ?? "").length !== 2) {
    out.push("the shift list is not in the workflow level env, so a job could miss it");
  }

  // The shift job's matrix comes from the plan job, which builds it from that list.
  const shifted = job(jobs, (j) => /^\s*matrix:/m.test(j.body));
  if (!shifted) {
    out.push("no job runs the shifts as a matrix");
    return out;
  }
  const from = /^\s*shift:\s*\$\{\{\s*fromJSON\(needs\.([\w-]+)\.outputs\.([\w-]+)\)\s*\}\}/m.exec(shifted.body);
  if (!from) {
    out.push("the matrix is not read from a plan job's output, so it is a second copy of the list");
  } else {
    const plan = job(jobs, (j) => j.name === from[1]);
    if (!shifted.needs.includes(from[1] as string)) out.push("the shift job does not need the job its matrix reads");
    if (!plan) out.push(`the matrix reads a job named ${from[1]} that does not exist`);
    else {
      if (!new RegExp(`^\\s*${from[2]}:\\s*\\$\\{\\{\\s*steps\\.`, "m").test(plan.body)) {
        out.push("the plan job does not publish the output the matrix reads");
      }
      if (!plan.runs.some((r) => /\$CLOCK_SHIFTS\b/.test(r))) {
        out.push("the plan job does not build the matrix from the shift list");
      }
      if (plan.timeoutMinutes === null) out.push("the plan job has no timeout");
    }
  }

  // One shift failing must not cancel the others: two findings are two findings.
  if (!/^\s*fail-fast:\s*false\s*$/m.test(shifted.body)) out.push("the matrix can cancel a sibling (fail-fast is not off)");

  // Each pass has its own limit, well clear of a pass, and the job holds room past it
  // for the steps that say how the pass ended.
  const limit = /^\s*PASS_LIMIT_MINUTES:\s*"?(\d+)"?\s*$/m.exec(shifted.body);
  const passLimit = limit ? Number(limit[1]) : null;
  if (passLimit === null) out.push("the pass has no PASS_LIMIT_MINUTES of its own");
  if (!shifted.runs.some((r) => /\btimeout\b[^|]*\$\{?PASS_LIMIT_MINUTES\}?m\b[^|]*pnpm test:node/.test(r))) {
    out.push("the suite is not run under the pass's own time limit");
  }
  if (passLimit !== null && passLimit * 60 < MEASURED_PASS_SECONDS * PASS_HEADROOM) {
    out.push(`a ${passLimit} minute pass limit leaves under ${PASS_HEADROOM}x the measured ${MEASURED_PASS_SECONDS}s pass`);
  }
  if (shifted.timeoutMinutes === null) out.push("the shift job has no timeout");
  else if (passLimit !== null && shifted.timeoutMinutes < passLimit + JOB_MARGIN_MINUTES) {
    out.push(
      `the shift job's ${shifted.timeoutMinutes} minutes leave under ${JOB_MARGIN_MINUTES} past the ${passLimit} minute pass limit`,
    );
  }

  // The log streams as the pass runs, so a pass that is stopped has still printed
  // what it got through (the 2026-10-20 pass printed nothing).
  if (!shifted.runs.some((r) => /pnpm test:node.*\|\s*tee\b/.test(r))) {
    out.push("the suite's output is not streamed as it runs, so a stopped pass prints nothing");
  }

  // The marker and the upload run whatever happened, or a stopped pass leaves the
  // report nothing to read.
  const shiftSteps = steps(shifted.body);
  const marker = shiftSteps.find((s) => /limit_minutes=/.test(s));
  if (!marker) out.push("no step records how the pass ended");
  else if (!/^\s*if:\s*always\(\)/m.test(marker)) out.push("the step recording how the pass ended does not always run");
  const upload = shiftSteps.find((s) => /uses:\s*actions\/upload-artifact@[0-9a-f]{40}\b/.test(s));
  if (!upload) out.push("the shift job does not upload its log with a sha pinned upload");
  else {
    if (!/^\s*if:\s*always\(\)/m.test(upload)) out.push("the log upload does not always run");
    if (!/name:\s*clock-shift-\$\{\{\s*matrix\.shift\s*\}\}/.test(upload)) {
      out.push("the log artifact is not named for its shift");
    }
  }

  // ONE report, which always runs, and reads every shift's log.
  const report = job(jobs, (j) => j.runs.some((r) => /scripts\/notify-clock-shift\.ts/.test(r)));
  if (!report) {
    out.push("no job runs the report");
    return out;
  }
  if (report === shifted) out.push("the report runs inside a shift job, so it runs once per shift");
  if (!report.needs.includes(shifted.name)) out.push("the report does not wait for the shift jobs");
  if (!/^ {4}if:\s*always\(\)\s*$/m.test(report.body)) out.push("the report job does not always run");
  if (report.timeoutMinutes === null) out.push("the report job has no timeout");
  if (report.runs.some((r) => /pnpm install/.test(r))) out.push("the report job installs dependencies (#1598)");
  if (!report.runs.some((r) => /^node --experimental-strip-types scripts\/notify-clock-shift\.ts$/.test(r))) {
    out.push("the report does not run on bare node");
  }
  const download = steps(report.body).find((s) => /uses:\s*actions\/download-artifact@[0-9a-f]{40}\b/.test(s));
  if (!download) out.push("the report does not download the logs with a sha pinned download");
  else {
    if (!/pattern:\s*clock-shift-\*/.test(download)) out.push("the report does not download every shift's log");
    if (!/merge-multiple:\s*true/.test(download)) out.push("the logs do not land in one directory");
  }
  return out;
}

// --- the real workflow keeps its shape ----------------------------------------
{
  const found = problems(workflow);
  for (const p of found) console.error(`  ${p}`);
  eq(found.length, 0, "clock-shift.yml runs each shift in its own job and reports once");
  assert(parseWorkflowJobs(workflow).length === 3, "it has a plan, a shift and a report job");
}

// --- and each rule catches its own breakage ----------------------------------
const broken: [string, string, RegExp][] = [
  [
    "the list written out again for the matrix",
    workflow.replace(/shift: \$\{\{ fromJSON\(needs\.plan\.outputs\.shifts\) \}\}/, 'shift: ["+1d", "+3mo", "+13mo"]'),
    /not read from a plan job's output/,
  ],
  [
    "a second copy of the list on the report step",
    workflow.replace("CLOCK_SHIFTS: ${{ env.CLOCK_SHIFTS }}", 'CLOCK_SHIFTS: "+1d +3mo"'),
    /written 2 times/,
  ],
  ["fail fast left on", workflow.replace("fail-fast: false", "fail-fast: true"), /fail-fast is not off/],
  ["no pass limit", workflow.replace(/\n\s*PASS_LIMIT_MINUTES: "?\d+"?/, ""), /no PASS_LIMIT_MINUTES/],
  ["a pass limit too tight", workflow.replace(/PASS_LIMIT_MINUTES: "?\d+"?/, 'PASS_LIMIT_MINUTES: "10"'), /leaves under 1\.5x/],
  [
    "a job limit with no room past the pass",
    workflow.replace(/(\n  shifted:[\s\S]*?\n    timeout-minutes:) \d+/, "$1 19"),
    /leave under 5 past/,
  ],
  ["the suite not under the limit", workflow.replace(/timeout --kill-after=\S+ "\$\{PASS_LIMIT_MINUTES\}m" /, ""), /not run under the pass's own time limit/],
  ["the output held back", workflow.replace(/ 2>&1 \| tee "[^"]+"/, ' > "$CLOCK_SHIFT_LOG_DIR/$SHIFT.log" 2>&1'), /not streamed/],
  [
    "the marker skipped on a stopped pass",
    workflow.replace(/(- name: Record how the pass ended\n\s*)if: always\(\)\n/, "$1"),
    /recording how the pass ended does not always run/,
  ],
  [
    "the upload skipped on a stopped pass",
    workflow.replace(/(- name: Keep the log for the report\n\s*)if: always\(\)\n/, "$1"),
    /log upload does not always run/,
  ],
  ["the report skipped when a shift fails", workflow.replace(/(\n  report:[\s\S]*?\n    )if: always\(\)\n/, "$1"), /report job does not always run/],
  ["the report not waiting for the shifts", workflow.replace("needs: [plan, shifted]", "needs: [plan]"), /does not wait for the shift jobs/],
  ["the report with no timeout", workflow.replace(/(\n  report:[\s\S]*?\n    )timeout-minutes: \d+[^\n]*\n/, "$1"), /report job has no timeout/],
  ["the report reading only one log", workflow.replace("pattern: clock-shift-*", "name: clock-shift-+1d"), /every shift's log/],
  ["the plan job not using the list", workflow.replace(/--arg s "\$CLOCK_SHIFTS"/, '--arg s "+1d"'), /does not build the matrix from the shift list/],
];
for (const [what, text, expect] of broken) {
  assert(text !== workflow, `the breakage "${what}" changed the file`);
  assert(problems(text).some((p) => expect.test(p)), `caught: ${what}`);
}

finish();

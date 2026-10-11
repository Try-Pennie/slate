// #3615: the daily reroute drill, wired. The drill and its exit table are tested on their own
// (test-demotion-drill.ts, test-reroute-drill-run-outcome.ts); this checks what makes it a DAILY
// verdict rather than a command somebody might run (L3, L27): the workflow runs it, reports it, and
// stamps `verdict:reroute-drill` only on a run that concluded; the heartbeat endpoint accepts the
// lane; and the staleness bound is derived from the workflow's own schedule (L614).
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-reroute-drill-schedule.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { REROUTE_DRILL_VERDICT_LANE } from "../src/lib/monitor/verdict-freshness.ts";
import { verdictBlindAlertText } from "../src/lib/monitor/lane-copy.ts";
import { parseWorkflowSchedules, cronCadenceMs } from "./lib/scan-workflow-schedules.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "burst-counter.yml");
const PLAIN = /^[\x20-\x7E\n]*$/;

eq(REROUTE_DRILL_VERDICT_LANE, "verdict:reroute-drill", "the lane is named as the workflow and the heartbeat allowlist name it");

assert(existsSync(WORKFLOW_PATH), "the daily proofs workflow exists");
const yml = readFileSync(WORKFLOW_PATH, "utf8");
const crons = parseWorkflowSchedules(yml);
eq(crons.length, 1, "it declares exactly one cron, shared by every proof in it");
const cadenceMs = cronCadenceMs(crons[0] as string);
assert(cadenceMs !== null, "the cron is one a cadence can be read from");
const timeoutMin = Number(yml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);
assert(Number.isFinite(timeoutMin), "the job declares an explicit timeout (L313)");
// The drill can wait up to its command's five minute deadline, so the job must leave room for
// it beside the proofs before it, or a slow drill would be cut off mid cleanup.
assert(timeoutMin >= 15, `the job's timeout leaves room for the drill beside the other proofs (${timeoutMin} minutes)`);

{
  const bound = VERDICT_STALE_BOUNDS_MS[REROUTE_DRILL_VERDICT_LANE];
  assert(typeof bound === "number", "the lane is watched by a staleness bound");
  const earliestHonest = 2 * (cadenceMs as number) + 3 * 60 * 60_000 + timeoutMin * 60_000;
  assert((bound as number) >= earliestHonest, `the bound clears two cadences, the lateness and the timeout (bound ${bound}ms, derivation ${earliestHonest}ms)`);
  assert((bound as number) <= earliestHonest + 2 * 60 * 60_000, `and is the derivation plus a rounding hour, not an arbitrary large number (bound ${bound}ms)`);
}

// The heartbeat endpoint must accept the lane, or every stamp is a 400 and the lane never stamps.
{
  const heartbeat = readFileSync(join(ROOT, "src/app/api/smoke/heartbeat/route.ts"), "utf8");
  assert(heartbeat.includes(`"${REROUTE_DRILL_VERDICT_LANE}"`), "the heartbeat endpoint accepts the drill's lane");
}

// Built is not wired (L3).
{
  const step = (name: string): string => {
    const start = yml.indexOf(`- name: ${name}`);
    assert(start !== -1, `the step "${name}" is where this expects it`);
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {6}- name:/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const verify = step("Run the reroute drill");
  assert(/verify-reroute-on-ineligibility-live\.ts/.test(verify), "the workflow runs the drill's command");
  assert(/continue-on-error: true/.test(verify), "which does not fail the job, or its reporter would be skipped");
  assert(/cancelled\(\)/.test(verify), "and states its own status condition, so an earlier proof's failure cannot skip it (L53)");
  const summaryPath = verify.match(/REROUTE_DRILL_SUMMARY_FILE:\s*(\S+)/)?.[1];
  assert(summaryPath !== undefined && !/burst|confirm/.test(summaryPath), "writing its OWN summary file");

  const report = step("Say what the reroute drill found");
  assert(/notify-reroute-drill\.ts/.test(report), "its reporter runs");
  eq(report.match(/REROUTE_DRILL_SUMMARY_FILE:\s*(\S+)/)?.[1], summaryPath, "reading the path the drill wrote");
  assert(/if: always\(\)/.test(report), "whatever the drill step did");
  const reportId = report.match(/id:\s*(\S+)/)?.[1];
  assert(reportId !== undefined && !["report", "confirm_line_report"].includes(reportId), "under its own step id");

  const stamp = step("Stamp the reroute drill verdict");
  const stampLine = /lane=verdict:reroute-drill(?![\w:-])/;
  assert(stampLine.test(stamp), "the stamp step stamps this lane");
  assert(!stampLine.test(stamp.replace(/lane=verdict:reroute-drill/g, "lane=elsewhere")), "control: the same read over a renamed copy finds nothing");
  assert(new RegExp(`steps\\.${reportId}\\.outputs\\.concluded == '1'`).test(stamp), "gated on THIS reporter's measured verdict");
  assert(/if: always\(\)/.test(stamp), "and carries always(), so a failed Slack post cannot leave a measured verdict unstamped (L53)");
}

// The page a reader gets when the drill stops concluding.
{
  const never = verdictBlindAlertText({
    lane: REROUTE_DRILL_VERDICT_LANE,
    ageMs: Infinity,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[REROUTE_DRILL_VERDICT_LANE] as number,
    unreadable: false,
  });
  assert(/never/i.test(never), "the never concluded page says so plainly");
  assert(PLAIN.test(never), "the page is plain ASCII");
  assert(!never.includes(REROUTE_DRILL_VERDICT_LANE), "it names the detector in words, not by its lane key");
  assert(/reroute/i.test(never), "it says which detector went blind");
  assert(/burst-counter workflow|Actions tab/.test(never), "and names where the answer would have come from (L111)");
}

finish();

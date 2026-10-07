// The daily proof that the shared confirm line answers, and the verdict it stamps (#3340).
//
// THE DEFECT THIS GUARDS. The confirm path falls back to the isolate's own line whenever
// the shared one cannot be used (#3325), so a `CONFIRM_LINE` object that is bound and does
// not answer reads as healthy until a crowd for one slot arrives and every isolate forms
// its own line again, which is the 2026-10-05 load run that started all this. Only a load
// run would notice, and a load run is not something anybody does every day (L557).
//
// So `pnpm verify:confirm-line` runs daily beside the burst counter's proof, in
// `.github/workflows/burst-counter.yml`, and stamps `verdict:confirm-line`. Three things
// have to hold for that to be worth anything, and this file drives them:
//
//  1. ONLY A MEASURED VERDICT STAMPS. Most endings mean the command never got to ask the
//     object anything, and a stamp there would report the detector concluding while it
//     is blind (L98, L331).
//  2. THE BOUND IS DERIVED FROM THE SCHEDULE it shares with the burst counter, read out of
//     the workflow file rather than typed beside it (L614).
//  3. THE RUN SPEAKS when it found something, and says nothing on the good day.
//
// No network, no clock, no real workflow dispatch.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-confirm-line-schedule.ts
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { CONFIRM_LINE_VERDICT_LANE } from "../src/lib/monitor/verdict-freshness.ts";
import { verdictBlindAlertText } from "../src/lib/monitor/lane-copy.ts";
import { parseWorkflowSchedules, cronCadenceMs } from "./lib/scan-workflow-schedules.ts";
import {
  CONFIRM_LINE_EXIT,
  RUN_JUDGEMENT,
  CONCLUDING_EXITS,
  decideConfirmLineReport,
} from "./lib/confirm-line-run-outcome.ts";
import { writeRunSummary, readRunSummary } from "./lib/run-summary-file.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = "burst-counter.yml";
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", WORKFLOW);
/** Printable ASCII only: no dash or emoji can be in a message (written as a range). */
const PLAIN = /^[\x20-\x7E\n]*$/;

eq(CONFIRM_LINE_VERDICT_LANE, "verdict:confirm-line", "the lane is named as the issue and the heartbeat allowlist name it");

// --- the workflow exists and this file can really read it ----------------------------
assert(existsSync(WORKFLOW_PATH), `${WORKFLOW} exists`);
const yml = readFileSync(WORKFLOW_PATH, "utf8");
const crons = parseWorkflowSchedules(yml);
eq(crons.length, 1, "the workflow declares exactly one cron line, shared by both proofs");
eq(
  parseWorkflowSchedules(yml.replace(/^ *- cron: .*$/gm, "")).length,
  0,
  "control: the same parse over a copy with the cron removed finds nothing, so the count above measured something",
);
const cadenceMs = cronCadenceMs(crons[0] as string);
assert(cadenceMs !== null, "the cron is one a cadence can be read from");
const timeoutMin = Number(yml.match(/^ {4}timeout-minutes:\s*(\d+)/m)?.[1] ?? NaN);
assert(Number.isFinite(timeoutMin), "the job declares an explicit timeout (L313)");

// --- the bound is DERIVED from that schedule (L614) ------------------------------------
{
  const bound = VERDICT_STALE_BOUNDS_MS[CONFIRM_LINE_VERDICT_LANE];
  assert(typeof bound === "number", "the lane is watched by a staleness bound");
  // One dropped run must not page (GitHub drops scheduled runs, and there is no gap
  // filler here), the run after it may be late by the 3h this repo has measured, and the
  // stamp lands at the END of the job, so its timeout is part of the gap.
  const earliestHonest = 2 * (cadenceMs as number) + 3 * 60 * 60_000 + timeoutMin * 60_000;
  assert((bound as number) >= earliestHonest, `the bound clears two cadences, the lateness and the timeout (bound ${bound}ms, derivation ${earliestHonest}ms)`);
  assert((bound as number) <= earliestHonest + 2 * 60 * 60_000, `and is the derivation plus a rounding hour, not an arbitrary large number (bound ${bound}ms)`);
}

// --- which endings COUNT as a measured verdict ------------------------------------------
{
  const codes = Object.values(CONFIRM_LINE_EXIT);
  for (const code of codes) assert(RUN_JUDGEMENT[code] !== undefined, `exit ${code} has a deliberate judgement`);
  for (const key of Object.keys(RUN_JUDGEMENT)) {
    assert(codes.includes(Number(key) as (typeof codes)[number]), `the judgement table names exit ${key}, which the command can end on`);
  }
  // The object answered, and what it answered is a definite reading of the line, good or bad.
  const measured = [
    CONFIRM_LINE_EXIT.passed,
    CONFIRM_LINE_EXIT.objectUnreachable,
    CONFIRM_LINE_EXIT.idleNotLed,
    CONFIRM_LINE_EXIT.ledBeside,
    CONFIRM_LINE_EXIT.fullNotSettled,
    CONFIRM_LINE_EXIT.notFullNotHandedOn,
    CONFIRM_LINE_EXIT.abandonedFreedLate,
    CONFIRM_LINE_EXIT.abandonedNotFreed,
    CONFIRM_LINE_EXIT.leftHeld,
    // #3460: the pool grouping directory answered (or, like the line, was bound and did
    // not), so each is a definite reading of the object, good or bad.
    CONFIRM_LINE_EXIT.directoryUnreachable,
    CONFIRM_LINE_EXIT.directoryNotStored,
    CONFIRM_LINE_EXIT.directoryOlderWon,
    CONFIRM_LINE_EXIT.groupingAbsent,
    CONFIRM_LINE_EXIT.groupingUnusable,
    // #3481: asked after its sleep and answered without the grouping, a definite reading.
    CONFIRM_LINE_EXIT.directoryLostAfterIdle,
  ];
  eq(
    [...CONCLUDING_EXITS].sort((a, b) => a - b).join(","),
    [...measured].sort((a, b) => a - b).join(","),
    "exactly the endings where the object was asked and answered conclude",
  );
  assert(!RUN_JUDGEMENT[CONFIRM_LINE_EXIT.bindingMissing].concluded, "nothing bound never exercised the answering half, so it stamps nothing however definite it feels");
  assert(!RUN_JUDGEMENT[CONFIRM_LINE_EXIT.checkErrored].concluded, "a probe that threw measured nothing about the object");
  assert(!RUN_JUDGEMENT[CONFIRM_LINE_EXIT.incompleteReply].concluded, "a reply this command cannot fully read measured nothing it can stand on");
  assert(!RUN_JUDGEMENT[CONFIRM_LINE_EXIT.unauthorized].concluded, "a refused key measured nothing");
  assert(!RUN_JUDGEMENT[CONFIRM_LINE_EXIT.endpointMissing].concluded, "a deployment older than the endpoint measured nothing");
  assert(
    !RUN_JUDGEMENT[CONFIRM_LINE_EXIT.directoryWakeUnobserved].concluded,
    "a directory that never woke where the probe could see it left the wake half unmeasured, so it stamps nothing, or the verdict stays fresh for as long as the platform keeps it awake",
  );
}

// --- what it SAYS -----------------------------------------------------------------------
const RUN_URL = "https://github.com/Try-Pennie/slate/actions/runs/1234";
{
  const good = decideConfirmLineReport({ exit: CONFIRM_LINE_EXIT.passed, detail: "every check passed" }, RUN_URL);
  assert(good.concluded, "the good day concludes");
  eq(good.alert, null, "and says nothing");

  for (const exit of [...CONCLUDING_EXITS].filter((e) => e !== CONFIRM_LINE_EXIT.passed)) {
    const d = decideConfirmLineReport({ exit, detail: "the command's own sentence about what it measured" }, RUN_URL);
    assert(d.concluded, `exit ${exit} concludes`);
    assert(d.alert !== null && d.alert.includes("the command's own sentence about what it measured"), `exit ${exit} is spoken about with the command's OWN sentence (L41)`);
    assert((d.alert as string).includes(RUN_URL), `exit ${exit} says where to look`);
  }

  const died = decideConfirmLineReport(null, RUN_URL);
  assert(!died.concluded && died.alert !== null, "a run that wrote no verdict concluded nothing, and says so");
  const unknown = decideConfirmLineReport({ exit: 99, detail: "something new" }, RUN_URL);
  assert(!unknown.concluded && (unknown.alert as string).includes("99"), "an exit nothing here judges is reported by its code and never counts as a verdict");
  assert((decideConfirmLineReport(null, "").alert as string).includes("Actions tab"), "with no run URL the message still says where to look");

  const spoken = Object.values(CONFIRM_LINE_EXIT)
    .map((exit) => decideConfirmLineReport({ exit, detail: `detail for ${exit}` }, RUN_URL).alert)
    .filter((t): t is string => t !== null);
  eq(spoken.length, Object.values(CONFIRM_LINE_EXIT).length - 1, "every ending but the pass is spoken about");
  for (const text of spoken) {
    assert(PLAIN.test(text), "message is plain ASCII: no dash, no emoji");
    assert(!/undefined|NaN|\[object Object\]/.test(text), "message renders no placeholder leak");
    assert(!text.startsWith("Slate"), "message does not open with Slate, which Slack already shows");
    assert(/confirm line/i.test(text.split("\n")[0] as string), "and its first line names the confirm line, since it posts beside the burst counter's");
  }
  const headlines = spoken.map((t) => t.split("\n")[0] as string);
  eq(new Set(headlines).size, headlines.length, "each ending gets its own opening sentence (L11)");
}

// --- the summary file, written by the command and read by the reporter ------------------
{
  const dir = mkdtempSync(join(tmpdir(), "confirm-line-summary-"));
  try {
    const path = join(dir, "summary.json");
    const w = writeRunSummary(path, { exit: CONFIRM_LINE_EXIT.ledBeside, detail: "B led beside A" });
    assert(w.written, "the verdict is written where the lane reads it");
    eq(JSON.stringify(readRunSummary(path)), JSON.stringify({ exit: CONFIRM_LINE_EXIT.ledBeside, detail: "B led beside A" }), "and read back exactly");
    const none = writeRunSummary("", { exit: 0, detail: "x" });
    assert(!none.written && none.why.length > 0, "a hand run sets no path, writes nothing and says why");
    const bad = writeRunSummary(join(dir, "no", "such", "dir.json"), { exit: 0, detail: "x" });
    assert(!bad.written && bad.why.length > 0, "a write that cannot land is reported rather than thrown");
    eq(readRunSummary(join(dir, "absent.json")), null, "an absent file is no verdict");
    eq(readRunSummary(""), null, "and so is no path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- built is not wired (L3) --------------------------------------------------------------
{
  assert(/verify-confirm-line-live\.ts/.test(yml), "the workflow runs the confirm line proof");
  assert(/notify-confirm-line\.ts/.test(yml), "and its reporter");
  const stampLine = /lane=verdict:confirm-line(?![\w:-])/;
  assert(stampLine.test(yml), "and stamps its verdict lane");
  assert(!stampLine.test(yml.replace(/lane=verdict:confirm-line/g, "lane=elsewhere")), "control: the same read over a renamed copy finds nothing");

  const step = (name: string): string => {
    const start = yml.indexOf(`- name: ${name}`);
    assert(start !== -1, `the step "${name}" is where this expects it`);
    const rest = yml.slice(start + 1);
    const next = rest.search(/\n {6}- name:/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  const verify = step("Prove the shared confirm line answers");
  assert(/continue-on-error: true/.test(verify), "the proof step does not fail the job, or its reporter would be skipped and the finding would sit unread");
  assert(/cancelled\(\)/.test(verify), "and states its own status condition, so a failed Slack post for the burst counter above cannot skip it (L53)");
  const summaryPath = verify.match(/CONFIRM_LINE_SUMMARY_FILE:\s*(\S+)/)?.[1];
  assert(summaryPath !== undefined && !/burst/.test(summaryPath), "it writes its OWN summary file, not the burst counter's");

  const report = step("Say what the confirm line proof found");
  eq(report.match(/CONFIRM_LINE_SUMMARY_FILE:\s*(\S+)/)?.[1], summaryPath, "and the reporter reads the same path the proof wrote");
  assert(/if: always\(\)/.test(report), "the reporter runs whatever the proof step did");
  const reportId = report.match(/id:\s*(\S+)/)?.[1];
  assert(reportId !== undefined && reportId !== "report", "the reporter has its own step id, not the burst counter's");

  const stamp = step("Stamp the confirm line verdict");
  assert(stampLine.test(stamp), "the stamp step is the one that stamps this lane");
  assert(new RegExp(`steps\\.${reportId}\\.outputs\\.concluded == '1'`).test(stamp), "the stamp is gated on THIS reporter's measured verdict, never the burst counter's");
  assert(/if: always\(\)/.test(stamp), "and carries always(), so a failed Slack post cannot leave a measured verdict unstamped (L53)");
}

// --- the page a reader gets when the proof stops concluding -----------------------------
{
  const never = verdictBlindAlertText({
    lane: CONFIRM_LINE_VERDICT_LANE,
    ageMs: Infinity,
    maxStaleMs: VERDICT_STALE_BOUNDS_MS[CONFIRM_LINE_VERDICT_LANE] as number,
    unreadable: false,
  });
  assert(/never/i.test(never), "the never concluded page says so plainly");
  assert(PLAIN.test(never), "the page is plain ASCII");
  assert(!never.includes(CONFIRM_LINE_VERDICT_LANE), "it names the detector in words, not by its lane key");
  assert(/confirm line/i.test(never), "it says which detector went blind");
  assert(/burst-counter workflow|Actions tab/.test(never), "and names where the answer would have come from (L111)");
}

finish();

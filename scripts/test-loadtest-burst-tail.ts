// The burst tail (#3416): the bursts' own Worker log, streamed from before the first
// burst's moment until the last burst's lines are in.
//
// Run 37520312761 failed two of its three bursts at about ten seconds a confirm, and
// nobody could say which stage ate the time: the archive's tail starts after the
// burst job (it needs it), so no burst confirm's log line was kept. The burst tail is
// its own job, started beside the bursts and stopped at a moment DERIVED from the
// plan, and its own file, read by the judge for the burst section only. These pin
// the stop moment, the wait that holds the tail open, and the wiring: the job's
// needs, its timeout, its artifact, the judge reading it, and the startup bar's
// population still coming from the archive alone (burst confirms are a different
// load shape and must not join it, the same way the cold leg's are kept out).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-burst-tail.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AFTER_RESPONSE_CANCEL_MS,
  BURST_GRACE_DEFAULT_MS,
  BURST_LEGS,
  BURST_SEQUENCE,
  BURST_SPACING_MS,
  BURST_TAIL_AFTER_LAST_MOMENT_MS,
  DRIVE_JOB_SETUP_MINUTES,
  REQUEST_TIMEOUT_MS,
  TAIL_DELIVERY_MARGIN_MS,
  burstMoments,
  burstTailMinutesNeeded,
  burstTailStopAtMs,
  burstTailWait,
  type BurstPlan,
} from "./loadtest/book-plan.ts";
import { BURST_TAIL_FILE } from "./loadtest/burst-breakdown.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const T0 = 1_791_316_778_917;
const plan: BurstPlan = {
  bursts: burstMoments(T0, BURST_LEGS, BURST_SPACING_MS).map((startAtMs, i) => ({
    kind: BURST_SEQUENCE[i]!,
    codes: ["120", "121"],
    slot: `2026-10-0${7 + i}T17:40:00.000Z`,
    startAtMs,
    perDriver: 3,
    capacity: { ladderRoster: 74, rung0Free: 1, ladderFree: 40 },
  })),
};
const lastMoment = plan.bursts[plan.bursts.length - 1]!.startAtMs;

// --- when the tail stops ----------------------------------------------------------------
{
  eq(
    BURST_TAIL_AFTER_LAST_MOMENT_MS,
    BURST_GRACE_DEFAULT_MS + REQUEST_TIMEOUT_MS + AFTER_RESPONSE_CANCEL_MS + TAIL_DELIVERY_MARGIN_MS,
    "the margin past the last moment is derived: a driver's lateness, a request's own bound, the work after the answer, the stream's lag",
  );
  eq(burstTailStopAtMs(plan), lastMoment + BURST_TAIL_AFTER_LAST_MOMENT_MS, "the tail stops that margin past the LAST burst's moment");
  // The slowest burst answer seen (14119ms, a VERIFY_UNAVAILABLE on run 37520312761)
  // and the deferred work after it must both be inside the window, or the slowest
  // confirm's lines, the ones this exists for, are the ones lost.
  assert(
    burstTailStopAtMs(plan) - lastMoment > 14_119 + AFTER_RESPONSE_CANCEL_MS,
    "the window covers the slowest burst answer seen and the work the platform allows after it",
  );
  // Control: a stop taken from the FIRST moment would end before the last burst fired.
  assert(burstTailStopAtMs(plan) > lastMoment + REQUEST_TIMEOUT_MS, "control: the stop is past the last burst's own answers, not the first's");
  const needed = burstTailMinutesNeeded(300);
  eq(
    needed,
    Math.ceil((300_000 + (BURST_LEGS - 1) * BURST_SPACING_MS + BURST_TAIL_AFTER_LAST_MOMENT_MS) / 60_000),
    "the most minutes the tail streams is the lead, the spacing to the last burst and the margin past it",
  );
  assert(burstTailMinutesNeeded(900) > needed, "control: a longer lead needs a longer tail");
}

// --- holding the tail open until then ---------------------------------------------------
{
  const raw = JSON.stringify(plan);
  const onTime = burstTailWait({ rawPlan: raw, rawCeilingMinutes: "10", nowMs: T0 - 240_000 });
  assert(onTime.ok && onTime.waitMs === burstTailStopAtMs(plan) - (T0 - 240_000), `a tail started before the first moment waits until the stop (got ${JSON.stringify(onTime)})`);
  assert(onTime.ok && onTime.exit === 0, "and covers every burst, so it exits 0");
  const late = burstTailWait({ rawPlan: raw, rawCeilingMinutes: "10", nowMs: T0 + 5_000 });
  assert(late.ok && late.exit === 3 && late.lines.some((l) => /after burst 1's moment/.test(l)), `a tail that started after the first moment says so and exits 3 (got ${JSON.stringify(late)})`);
  const short = burstTailWait({ rawPlan: raw, rawCeilingMinutes: "1", nowMs: T0 - 240_000 });
  assert(
    short.ok && short.exit === 3 && short.waitMs === 60_000 && short.lines.some((l) => /BURST_TAIL_CEILING_MINUTES/.test(l)),
    `a ceiling that ends before the stop holds the tail only to the ceiling, names it and exits 3 (got ${JSON.stringify(short)})`,
  );
  const after = burstTailWait({ rawPlan: raw, rawCeilingMinutes: "10", nowMs: burstTailStopAtMs(plan) + 1 });
  assert(after.ok && after.waitMs === 0 && after.exit === 3 && after.lines.some((l) => /covered no burst/.test(l)), `a tail that started after the stop waits for nothing, says it covered no burst and exits 3 (got ${JSON.stringify(after)})`);
  for (const bad of ["", "{", JSON.stringify({ bursts: [] }), JSON.stringify({ bursts: [{ ...plan.bursts[0]!, kind: undefined }] })]) {
    const r = burstTailWait({ rawPlan: bad, rawCeilingMinutes: "10", nowMs: T0 });
    assert(!r.ok && /BURST_PLAN/.test(r.why), `an unreadable plan ${JSON.stringify(bad)} is refused by name (got ${JSON.stringify(r)})`);
  }
  for (const bad of ["", "ten", "0", "2.5", "-3"]) {
    const r = burstTailWait({ rawPlan: raw, rawCeilingMinutes: bad, nowMs: T0 });
    assert(!r.ok && /BURST_TAIL_CEILING_MINUTES/.test(r.why), `an unreadable ceiling ${JSON.stringify(bad)} is refused by name, never NaN (got ${JSON.stringify(r)})`);
  }
}

// --- the command itself, with its imports resolved --------------------------------------
{
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-paths.mjs", "scripts/loadtest/burst-tail-wait.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  const refused = run({ BURST_PLAN: "{", BURST_TAIL_CEILING_MINUTES: "10" });
  assert(refused.status === 1 && /BURST_PLAN/.test(refused.stderr), `an unreadable plan stops the wait at once by name (got ${refused.status}: ${refused.stderr.trim()})`);
  // A plan whose every moment is long past: nothing to wait for, said, and red.
  const past: BurstPlan = { bursts: [{ ...plan.bursts[0]!, startAtMs: 1_000 }] };
  const late = run({ BURST_PLAN: JSON.stringify(past), BURST_TAIL_CEILING_MINUTES: "10" });
  assert(late.status === 3 && /after burst 1's moment/.test(late.stdout + late.stderr), `a tail started after every burst exits 3 and says why (got ${late.status}: ${(late.stdout + late.stderr).trim()})`);
}

// --- the wiring ------------------------------------------------------------------------------
function job(yml: string, name: string): string {
  return new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|(?![\\s\\S]))`, "m").exec(yml)?.[1] ?? "";
}

function needsOf(body: string): string[] {
  const raw = /^ {4}needs:\s*(.+)$/m.exec(body)?.[1] ?? "";
  return raw.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

const LEAD_DEFAULT = (yml: string) => Number(/burst_lead_seconds:[\s\S]*?default:\s*"(\d+)"/.exec(yml)?.[1] ?? NaN);

function burstTailWiringProblems(yml: string, runJudge: string): string[] {
  const out: string[] = [];
  const tail = job(yml, "burst-tail");
  if (tail === "") return ["there is no burst-tail job"];
  const needs = needsOf(tail);
  if (needs.join(",") !== "setup-burst") out.push(`the burst tail must need only setup-burst, so it starts BEFORE the bursts (needs ${needs.join(",") || "nothing"})`);
  if (!/^ {4}if: \$\{\{ !cancelled\(\) && needs\.setup-burst\.result == 'success' \}\}$/m.test(tail)) out.push("the burst tail does not run exactly when the burst plan was made");
  const timeout = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(tail)?.[1] ?? NaN);
  const ceiling = Number(/BURST_TAIL_CEILING_MINUTES: "(\d+)"/.exec(tail)?.[1] ?? NaN);
  const lead = LEAD_DEFAULT(yml);
  if (!Number.isFinite(ceiling)) out.push("the burst tail's ceiling is not set");
  else if (ceiling < burstTailMinutesNeeded(lead)) out.push(`the burst tail's ceiling (${ceiling}m) ends before the last burst's lines at the default lead (${burstTailMinutesNeeded(lead)}m needed)`);
  if (!Number.isFinite(timeout)) out.push("the burst tail job has no timeout");
  else if (timeout < ceiling + DRIVE_JOB_SETUP_MINUTES || timeout > 60) out.push(`the burst tail job's timeout (${timeout}) does not cover its ceiling plus the runner's setup within the 60 every job is held to`);
  if (!tail.includes("BURST_PLAN: ${{ needs.setup-burst.outputs.burst_plan }}")) out.push("the burst tail is not handed the burst plan its stop is derived from");
  if (!tail.includes(`setsid timeout "\${BURST_TAIL_CEILING_MINUTES}m" npx wrangler tail --env loadtest --format json > results/${BURST_TAIL_FILE} 2> results/burst-tail.err &`)) {
    out.push("the burst tail is not streamed in the background in its own process group, under its ceiling, to its own file with its stderr apart");
  }
  if (!tail.includes('kill -TERM -- -"$tail_pid"')) out.push("the burst tail is not stopped by its process group, so wrangler would hold the step open (L321)");
  if (!/wait "\$tail_pid" 2>\/dev\/null \|\| true/.test(tail)) out.push("the burst tail's stop is not waited on");
  if (!/scripts\/loadtest\/burst-tail-wait\.ts \|\| rc=\$\?/.test(tail)) out.push("the wait for the stop moment is not run with its exit kept, so a refusal would leave the tail running");
  if (!/- if: always\(\)\n\s+uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+name: burst-tail\n/.test(tail)) out.push("the burst tail is not ALWAYS uploaded as its own artifact, burst-tail");
  const judge = job(yml, "judge");
  if (!needsOf(judge).includes("burst-tail")) out.push("the judge does not wait for the burst tail");
  // Every artifact, unless the step names some: then the burst tail must be among them.
  const download = /uses: actions\/download-artifact@[^\n]+\n {8}with:\n((?: {10}\S.*\n)+)/.exec(judge)?.[1] ?? "";
  if (download === "" || (/\bname:|\bpattern:/.test(download) && !/burst-tail/.test(download))) out.push("the judge does not download the burst tail's artifact");
  if (!judge.includes("-name '*.jsonl'")) out.push("the judge's gather does not copy the .jsonl logs, the burst tail among them");
  const archive = job(yml, "archive");
  if (!needsOf(archive).includes("burst")) out.push("the archive no longer waits for the bursts, so burst confirms would join the startup bar's population");
  if (!/npx wrangler tail --env loadtest --format json > results\/tail\.jsonl/.test(archive)) out.push("the archive's tail no longer writes tail.jsonl, the startup bar's population");
  // The judge reads the burst tail for the burst section ONLY.
  const burstReads = runJudge.split("\n").filter((l) => l.includes("BURST_TAIL_FILE") || l.includes(BURST_TAIL_FILE));
  if (!burstReads.some((l) => /readBurstTailFile\(/.test(l))) out.push("the judge never reads the burst tail");
  if (burstReads.some((l) => /readConfirmStartup|readDeferredSpans|readScheduledFromArchive/.test(l))) out.push("the burst tail is handed to a reader of the startup bar's population");
  const startupReads = runJudge.split("\n").filter((l) => /readConfirmStartup\(/.test(l));
  for (const l of startupReads) {
    if (/burst/i.test(l)) out.push("readConfirmStartup is handed something named for the bursts");
  }
  if (!/^#\s+burst-tail\s/m.test(yml)) out.push("the workflow's header does not list the burst-tail job");
  return out;
}

{
  const yml = readFileSync(join(ROOT, ".github/workflows/loadtest.yml"), "utf8");
  const runJudge = readFileSync(join(ROOT, "scripts/loadtest/run-judge.ts"), "utf8");
  eq(burstTailWiringProblems(yml, runJudge), [], "the burst tail is wired as its measurement needs");
  const controls: [string, string, string, RegExp][] = [
    ["a tail that waits for the bursts", yml.replace(/(^ {2}burst-tail:\n {4}needs: )setup-burst/m, "$1[setup-burst, burst]"), runJudge, /starts BEFORE the bursts/],
    ["a tiny ceiling", yml.replace(/BURST_TAIL_CEILING_MINUTES: "\d+"/, 'BURST_TAIL_CEILING_MINUTES: "1"'), runJudge, /ends before the last burst/],
    ["a timeout under the ceiling", yml.replace(/(^ {2}burst-tail:\n[\s\S]*?^ {4}timeout-minutes:\s*)\d+/m, "$11"), runJudge, /timeout/],
    ["a tail killed by its pid alone", yml.replace(/(^ {2}burst-tail:\n[\s\S]*?)kill -TERM -- -"\$tail_pid"/m, '$1kill -TERM "$tail_pid"'), runJudge, /process group/],
    ["the burst tail into the archive's file", yml.replace(`> results/${BURST_TAIL_FILE} 2>`, "> results/tail.jsonl 2>"), runJudge, /own file/],
    ["no artifact", yml.replace(/name: burst-tail\n/, "name: burst-logs\n"), runJudge, /burst-tail/],
    ["a judge that does not wait", yml.replace(/(^ {4}needs: \[preflight, baseline, setup-burst, drive, burst, )burst-tail, /m, "$1"), runJudge, /does not wait for the burst tail/],
    ["an archive that no longer waits for the bursts", yml.replace(/(^ {2}archive:\n {4}needs: \[preflight, setup-burst), burst, burst-tail\]/m, "$1, burst-tail]"), runJudge, /startup bar's population/],
    ["the burst tail fed to the startup reader", yml, runJudge.replace(/readBurstTailFile\(/, "readConfirmStartup(readBurstTailFile("), /startup bar's population/],
    ["a judge that never reads it", yml, runJudge.replace(/readBurstTailFile\(/g, "readNothing("), /never reads the burst tail/],
    ["a download filtered to other artifacts", yml.replace(/(uses: actions\/download-artifact@[^\n]+\n {8}with:\n)/, "$1          pattern: driver-*\n"), runJudge, /does not download/],
  ];
  for (const [what, brokenYml, brokenJudge, says] of controls) {
    assert(brokenYml !== yml || brokenJudge !== runJudge, `control (${what}): the copy really was broken`);
    const problems = burstTailWiringProblems(brokenYml, brokenJudge);
    assert(problems.some((p) => says.test(p)), `control (${what}): caught (got ${JSON.stringify(problems)})`);
  }
}

finish();

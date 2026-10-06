// #3354 item 4: the diagnostic leg that redeploys N times with one confirm after
// each, for a cold sample large enough to say what a fresh server's first confirm
// costs. A load run yields about ten cold confirms, so its cold p95 is its slowest
// one, and one slow confirm decides a run. Thirty or more cold samples, all taken the
// same way, give a distribution to judge a change against. Not a bar.
//
// These pin the plan's pure parts: how many samples, how long the job may run, which
// version each deploy made, and which slots the confirms book.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-cold-plan.ts
import {
  readColdSamples,
  coldJobTimeoutMinutes,
  deployedVersionOf,
  chooseColdSlots,
  runColdLeg,
  COLD_SETTLE_MS,
  COLD_SAMPLES_MAX,
  COLD_SAMPLES_TARGET,
  COLD_SAMPLE_SECONDS,
  COLD_JOB_SETUP_MINUTES,
} from "./loadtest/cold-plan.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

// --- how many samples ---------------------------------------------------------------
{
  const off = readColdSamples(undefined);
  assert(off.ok && off.n === 0, "unset is off: the leg is a diagnostic somebody asks for");
  const zero = readColdSamples("0");
  assert(zero.ok && zero.n === 0, "0 is off");
  const thirty = readColdSamples("30");
  assert(thirty.ok && thirty.n === 30, "30 is thirty samples");
  eq(COLD_SAMPLES_TARGET, 30, "the target is the thirty the plan asked for");
  for (const bad of ["-1", "3.5", "lots", " 30", `${COLD_SAMPLES_MAX + 1}`]) {
    const r = readColdSamples(bad);
    assert(!r.ok && r.why.includes(JSON.stringify(bad)), `${JSON.stringify(bad)} is refused by name rather than guessed at (got ${JSON.stringify(r)})`);
  }
  const most = readColdSamples(String(COLD_SAMPLES_MAX));
  assert(most.ok && most.n === COLD_SAMPLES_MAX, "the most it takes is allowed");
}

// --- how long the job may run --------------------------------------------------------
// Every job carries an explicit timeout (L313), and this one's grows with the samples,
// so it is derived rather than typed: a fixed one would cut a long leg short.
{
  eq(coldJobTimeoutMinutes(30), COLD_JOB_SETUP_MINUTES + Math.ceil((30 * COLD_SAMPLE_SECONDS) / 60), "the timeout is the setup plus each sample's share");
  // scripts/test-workflow-timeouts.ts holds every job at 60 minutes or less, since a
  // bound larger than that reads the same as none. The most samples must fit inside it.
  assert(coldJobTimeoutMinutes(COLD_SAMPLES_MAX) <= 60, `the most samples (${COLD_SAMPLES_MAX}) fit inside the repo's 60 minute job bound (got ${coldJobTimeoutMinutes(COLD_SAMPLES_MAX)})`);
  assert(COLD_SAMPLES_MAX >= COLD_SAMPLES_TARGET, "and the most it takes is at least the target");
  // One sample is a deploy (about 20s measured on run 37390071571's fault leg), the
  // settle and one confirm under its 30s request timeout, so its share holds all three.
  assert(COLD_SAMPLE_SECONDS * 1_000 >= 20_000 + COLD_SETTLE_MS + 30_000, "a sample's share holds a deploy, the settle and a confirm's whole timeout");
}

// --- which version each deploy made ----------------------------------------------------
{
  const out = [
    "Total Upload: 16234.11 KiB / gzip: 3412.80 KiB",
    "Uploaded slate-loadtest (14.21 sec)",
    "Deployed slate-loadtest triggers (1.05 sec)",
    "  https://slate-loadtest.example.workers.dev",
    "Current Version ID: 5239f06d-1c2e-4b8a-9f3d-0a1b2c3d4e5f",
  ].join("\n");
  eq(deployedVersionOf(out), "5239f06d-1c2e-4b8a-9f3d-0a1b2c3d4e5f", "the version is read from wrangler's own line");
  eq(deployedVersionOf("Uploaded slate-loadtest (14.21 sec)"), null, "an output with no version line reads as unknown, never as a version");
  eq(deployedVersionOf("Current Version ID: not-a-uuid"), null, "and so does one that is not a version id");
}

// --- which slots the confirms book ------------------------------------------------------
// Every confirm needs a time nobody else takes, and the slots are read ONCE, before the
// first deploy, so no read warms a new version's isolate ahead of its confirm.
{
  const offered = [
    { code: "112", slots: ["2026-10-08T14:00:00Z", "2026-10-08T14:30:00Z"] },
    { code: "221", slots: ["2026-10-08T15:00:00Z"] },
    { code: "331", slots: [] },
  ];
  const picked = chooseColdSlots(offered, 3);
  assert(picked.ok, "three slots are found across the codes");
  if (picked.ok) {
    eq(picked.slots.length, 3, "one per sample");
    eq(new Set(picked.slots.map((s) => `${s.code}@${s.start}`)).size, 3, "every one distinct");
    eq(picked.slots[1]?.code, "221", "taken across codes in turn, so no one bucket is emptied first");
  }
  const short = chooseColdSlots(offered, 4);
  assert(!short.ok && short.why.includes("3") && short.why.includes("4"), `fewer offered times than samples is refused, saying both counts (got ${JSON.stringify(short)})`);
}

// --- the leg itself: read once, then deploy, settle and one confirm, N times -----------
// Nothing may reach a new version between its deploy and its confirm, or the confirm is
// no longer that version's first request: the events are pinned in order.
async function legWith(opts: { n: number; failDeploys?: number[]; offered?: Record<string, string[]> }) {
  const events: string[] = [];
  const offered = opts.offered ?? { "112": ["s1", "s2", "s3"], "212": ["s4", "s5"] };
  let deploys = 0;
  const result = await runColdLeg({
    n: opts.n,
    codes: Object.keys(offered),
    readSlots: async (code) => {
      events.push(`read:${code}`);
      return offered[code] ?? [];
    },
    deploy: async () => {
      deploys += 1;
      events.push(`deploy:${deploys}`);
      if (opts.failDeploys?.includes(deploys)) return { ok: false, output: "Error: the upload was refused" };
      return { ok: true, output: `Current Version ID: 0000000${deploys}-1c2e-4b8a-9f3d-0a1b2c3d4e5f` };
    },
    sleep: async (ms) => void events.push(`sleep:${ms}`),
    confirm: async (slot, i) => {
      events.push(`confirm:${i}:${slot.code}@${slot.start}`);
      return { status: 200, outcome: "created" };
    },
    now: () => 1_000,
  });
  return { events, result };
}

// --- the workflow's cold job, wired so it measures what it says ------------------------
// Read as findings so the same check runs on the real workflow AND on broken copies (L1).
function coldWiringProblems(yml: string): string[] {
  const out: string[] = [];
  const job = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S)`, "m").exec(yml)?.[1] ?? "";
  const cold = job("cold");
  if (cold === "") return ["the workflow has no cold job"];
  if (!/^ {6}cold_samples:/m.test(yml)) out.push("the workflow takes no cold_samples input");
  if (!/^ {8}default: "0"$/m.test(/^ {6}cold_samples:\n([\s\S]*?)(?=^ {6}\S)/m.exec(yml)?.[1] ?? "")) {
    out.push("cold_samples does not default to 0, so the leg would run on every dispatch");
  }
  const needs = /^ {4}needs:\s*(.+)$/m.exec(cold)?.[1] ?? "";
  // After the main archive's tail has stopped, or its confirms would join the startup
  // bar's own population; and after the fault leg, which redeploys too.
  for (const dep of ["preflight", "archive", "fault"]) if (!needs.includes(dep)) out.push(`the cold job does not wait for ${dep}`);
  const cond = /^ {4}if:\s*(.+)$/m.exec(cold)?.[1] ?? "";
  if (!cond.includes("inputs.cold_samples != '0'")) out.push("the cold job does not stand down when cold_samples is 0");
  if (!cond.includes("needs.preflight.result == 'success'")) out.push("the cold job does not require the preflight");
  const timeout = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(cold)?.[1] ?? NaN);
  if (timeout !== coldJobTimeoutMinutes(COLD_SAMPLES_MAX)) {
    out.push(`the cold job's timeout is ${timeout}, not the ${coldJobTimeoutMinutes(COLD_SAMPLES_MAX)} derived for the most samples it takes`);
  }
  if (!/setsid timeout \d+m npx wrangler tail --env loadtest --format json > results\/cold-tail\.jsonl/.test(cold)) {
    out.push("the cold job's tail is not its own archive, started as its own process group");
  }
  if (!/kill -TERM -- -"\$tail_pid"/.test(cold)) out.push("the cold job does not stop its tail's whole process group (L321)");
  if (!cold.includes("scripts/loadtest/cold-after-deploy.ts")) out.push("the cold job does not run the leg");
  if (!/name: cold-0$/m.test(cold)) out.push("the cold job does not upload its results as cold-0");
  const judge = job("judge");
  if (!(/^ {4}needs:\s*(.+)$/m.exec(judge)?.[1] ?? "").includes("cold")) out.push("the judge does not wait for the cold job");
  if (!judge.includes("EXPECT_COLD_SAMPLES: ${{ inputs.cold_samples }}")) out.push("the judge is not told how many cold samples were asked for");
  return out;
}

{
  const yml = readFileSync(join(import.meta.dirname, "..", ".github/workflows/loadtest.yml"), "utf8");
  eq(coldWiringProblems(yml), [], "the cold job is wired as its measurement needs");
  const controls: [string, string, RegExp][] = [
    ["no archive dependency", yml.replace(/^( {4}needs: \[preflight, )archive, (fault\])/m, "$1$2"), /wait for archive/],
    ["a fixed timeout", yml.replace(/(^ {2}cold:\n[\s\S]*?^ {4}timeout-minutes:\s*)\d+/m, "$11"), /timeout/],
    ["the tail killed by its pid alone", yml.replace(/kill -TERM -- -"\$tail_pid"/, 'kill -TERM "$tail_pid"'), /process group/],
    ["a judge never told", yml.replace("EXPECT_COLD_SAMPLES: ${{ inputs.cold_samples }}", ""), /not told/],
  ];
  for (const [what, broken, says] of controls) {
    assert(broken !== yml, `control (${what}): the copy really was broken`);
    assert(coldWiringProblems(broken).some((p) => says.test(p)), `control (${what}): caught (got ${JSON.stringify(coldWiringProblems(broken))})`);
  }
}

(async () => {
  {
    const { events, result } = await legWith({ n: 3 });
    eq(
      events.join(" "),
      `read:112 read:212 deploy:1 sleep:${COLD_SETTLE_MS} confirm:1:112@s1 deploy:2 sleep:${COLD_SETTLE_MS} confirm:2:212@s4 deploy:3 sleep:${COLD_SETTLE_MS} confirm:3:112@s2`,
      "every slot is read before the first deploy, and each deploy is followed by nothing but the settle and its one confirm",
    );
    assert(result.ok, "a leg that ran every sample is ok");
    if (result.ok) {
      eq(result.result.planned, 3, "it records how many were asked for");
      eq(result.result.attempts.map((a) => a.version?.slice(0, 8)).join(","), "00000001,00000002,00000003", "and the version each deploy made");
      eq(result.result.attempts.map((a) => a.status).join(","), "200,200,200", "and each confirm's answer");
    }
  }
  {
    const { events, result } = await legWith({ n: 3, failDeploys: [2] });
    assert(!events.includes("confirm:2:212@s4"), "a deploy that failed sends no confirm, since it would land on the old version and read warm");
    assert(result.ok, "the leg carries on past one failed deploy");
    if (result.ok) {
      const second = result.result.attempts[1];
      assert(second?.deployOk === false && second.status === null && second.version === null, `the failed deploy is recorded with no confirm and no version (got ${JSON.stringify(second)})`);
      eq(result.result.attempts.filter((a) => a.status !== null).length, 2, "and the other two still confirmed");
    }
  }
  {
    const { events, result } = await legWith({ n: 6 });
    assert(!result.ok && result.why.includes("5") && result.why.includes("6"), `too few offered times refuses before any deploy (got ${JSON.stringify(result)})`);
    assert(!events.some((e) => e.startsWith("deploy")), "and deploys nothing");
  }
  finish();
})();

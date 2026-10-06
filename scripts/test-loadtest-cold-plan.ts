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
  COLD_SLOT_GAP_MS,
  runColdLeg,
  coldLegOutcome,
  coldSampleCounts,
  makeColdDeploy,
  COLD_SETTLE_MS,
  COLD_DEPLOY_TIMEOUT_MS,
  COLD_SAMPLES_MAX,
  COLD_SAMPLES_TARGET,
  COLD_SAMPLE_SECONDS,
  COLD_JOB_SETUP_MINUTES,
  readColdResult,
} from "./loadtest/cold-plan.ts";
import { spawnSync } from "node:child_process";
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
  // A leading zero is refused, never read as the number: the workflow stands the cold
  // job down only on the exact string "0", so "00" would start the job while the leg
  // read it as off, a whole job's charge for nothing.
  for (const bad of ["-1", "3.5", "lots", " 30", `${COLD_SAMPLES_MAX + 1}`, "00", "030"]) {
    const r = readColdSamples(bad);
    assert(!r.ok && r.why.includes(JSON.stringify(bad)), `${JSON.stringify(bad)} is refused by name rather than guessed at (got ${JSON.stringify(r)})`);
  }
  const most = readColdSamples(String(COLD_SAMPLES_MAX));
  assert(most.ok && most.n === COLD_SAMPLES_MAX, "the most it takes is allowed");
}

// --- the input is checked before the job spends an install and a build on it ----------
// The workflow can only stand the job down on the exact strings "0" and "", so any other
// value starts it. The check runs on bare node before the install, so a mistyped value
// costs seconds and is refused by name rather than after a full build.
{
  const runCheck = (value: string) =>
    spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "loadtest", "check-cold-samples.ts")], {
      env: { PATH: process.env.PATH ?? "", COLD_SAMPLES: value },
      encoding: "utf8",
    });
  for (const bad of ["31", "00", " 30", "lots"]) {
    const r = runCheck(bad);
    assert(r.status === 1 && r.stderr.includes(JSON.stringify(bad)), `${JSON.stringify(bad)} stops the job by name (got ${r.status}: ${r.stderr.trim()})`);
  }
  const good = runCheck("30");
  assert(good.status === 0, `30 lets the job go on (got ${good.status}: ${good.stderr.trim()})`);
}

// --- the leg's results file: absent, read, or unreadable, each said apart --------------
// A corrupt or truncated file must not read as "the results never arrived" (L11).
{
  const absent = readColdResult(() => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  });
  eq(absent.kind, "absent", "no file is absent, the normal state when the leg was not asked for");
  const truncated = readColdResult(() => '{"mode":"cold","planned":3,"attem');
  assert(truncated.kind === "unreadable" && /JSON/.test(truncated.why), `a truncated file is unreadable, with the parser's reason (got ${JSON.stringify(truncated)})`);
  const denied = readColdResult(() => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  });
  assert(denied.kind === "unreadable" && /EACCES/.test(denied.why), `a file that is there and cannot be read is unreadable, never absent (got ${JSON.stringify(denied)})`);
  const wrong = readColdResult(() => JSON.stringify({ mode: "steady", planned: 3, attempts: [] }));
  assert(wrong.kind === "unreadable" && /not a cold leg result/.test(wrong.why), `a file of another shape is refused by name (got ${JSON.stringify(wrong)})`);
  const ok = readColdResult(() => JSON.stringify({ mode: "cold", planned: 1, attempts: [] }));
  assert(ok.kind === "read" && ok.result.planned === 1, "a cold leg result is read");
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
  assert(COLD_SAMPLE_SECONDS * 1_000 >= COLD_DEPLOY_TIMEOUT_MS + COLD_SETTLE_MS + 30_000, "a sample's share holds a deploy at its own deadline, the settle and a confirm's whole timeout");
  // A deploy has a deadline of its own (L110): one that hangs is a failed sample, not
  // the whole leg waiting on the job's timeout. Measured at about 20s, so 2.5 times that.
  assert(COLD_DEPLOY_TIMEOUT_MS >= 2 * 20_000, "the deploy deadline leaves room over the measured 20s");
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
    { code: "112", slots: ["2026-10-08T14:00:00Z", "2026-10-08T16:00:00Z"] },
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
  // The same instant under two codes is ONE slot: buckets can share an advisor, so a
  // second confirm there would be refused as taken rather than measured.
  const shared = chooseColdSlots(
    [
      { code: "112", slots: ["2026-10-08T14:00:00Z", "2026-10-08T15:00:00Z"] },
      { code: "212", slots: ["2026-10-08T14:00:00Z", "2026-10-08T16:00:00Z"] },
    ],
    3,
  );
  assert(shared.ok && new Set(shared.slots.map((x) => x.start)).size === 3, `a time offered under two codes is taken once (got ${JSON.stringify(shared)})`);
  const short = chooseColdSlots(offered, 4);
  assert(!short.ok && short.why.includes("3") && short.why.includes("4"), `fewer offered times than samples is refused, saying both counts (got ${JSON.stringify(short)})`);

  // Two samples closer together than a call and its buffers can land on one advisor, so
  // the later one is refused as taken and measures a refusal rather than the confirm
  // path. The picked times are held COLD_SLOT_GAP_MS apart across every code, since
  // buckets can share an advisor.
  const near = [
    { code: "112", slots: ["2026-10-08T14:00:00Z", "2026-10-08T14:10:00Z", "2026-10-08T15:00:00Z"] },
    { code: "212", slots: ["2026-10-08T14:20:00Z"] },
  ];
  const spaced = chooseColdSlots(near, 2);
  assert(
    spaced.ok && spaced.slots.map((x) => x.start).join(" ") === "2026-10-08T14:00:00Z 2026-10-08T15:00:00Z",
    `times closer than the gap are passed over, on every code (got ${JSON.stringify(spaced)})`,
  );
  if (spaced.ok) {
    const ms = spaced.slots.map((x) => Date.parse(x.start));
    assert(ms[1]! - ms[0]! >= COLD_SLOT_GAP_MS, "and the two picked are at least the gap apart");
  }
  const tooFew = chooseColdSlots(near, 3);
  assert(
    !tooFew.ok && tooFew.why.includes(`${COLD_SLOT_GAP_MS / 60_000} minutes apart`),
    `too few times far enough apart is refused, naming the gap (got ${JSON.stringify(tooFew)})`,
  );
  const unreadable = chooseColdSlots([{ code: "112", slots: ["not a time", "2026-10-08T14:00:00Z"] }], 2);
  assert(!unreadable.ok, `an offered time that does not parse is never picked, so it cannot stand in for a sample (got ${JSON.stringify(unreadable)})`);
  // The gap clears the seed's 20 minute call on its 10 minute grid (scripts/loadtest/seed.ts),
  // and production's 20 minute call with 10 minutes either side (#2989), should the
  // seed ever take production's buffers.
  assert(COLD_SLOT_GAP_MS >= (20 + 10 + 10) * 60_000, "the gap is at least a call and both its buffers");
}

// --- the leg itself: read once, then deploy, settle and one confirm, N times -----------
// Nothing may reach a new version between its deploy and its confirm, or the confirm is
// no longer that version's first request: the events are pinned in order.
// Offered times an hour apart, so the chooser's gap passes over none of them.
const [s1, s2, s3, s4, s5] = [14, 16, 18, 15, 17].map((h) => `2026-10-08T${h}:00:00Z`);
async function legWith(opts: { n: number; failDeploys?: number[]; offered?: Record<string, string[]> }) {
  const events: string[] = [];
  const offered = opts.offered ?? { "112": [s1!, s2!, s3!], "212": [s4!, s5!] };
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
  const checkAt = cold.indexOf("scripts/loadtest/check-cold-samples.ts");
  const installAt = cold.indexOf("pnpm install");
  if (checkAt === -1 || installAt === -1 || checkAt > installAt) out.push("the cold job does not check cold_samples before it installs anything");
  else if (!/COLD_SAMPLES: \$\{\{ inputs\.cold_samples \}\}[\s\S]*?check-cold-samples\.ts/.test(cold.slice(0, installAt))) {
    out.push("the cold_samples check is not handed the input");
  }
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
    ["no early check", yml.replace("scripts/loadtest/check-cold-samples.ts", "scripts/loadtest/nothing.ts"), /before it installs/],
  ];
  for (const [what, broken, says] of controls) {
    assert(broken !== yml, `control (${what}): the copy really was broken`);
    assert(coldWiringProblems(broken).some((p) => says.test(p)), `control (${what}): caught (got ${JSON.stringify(coldWiringProblems(broken))})`);
  }
}

// --- what the leg exits with: every sample deployed AND answered, or it says what failed ---
{
  const a = (i: number, deployOk: boolean, status: number | null, outcome: string | null) => ({
    i, slot: { code: "112", start: `s${i}` }, deployOk, version: deployOk ? `v${i}` : null, sentAtMs: status === null ? null : i, status, outcome,
  });
  // One count of what each sample came to, shared by the leg's own exit line and the
  // judge's report, so the two can never disagree about one population (L41).
  const counts = coldSampleCounts({ mode: "cold", planned: 4, attempts: [a(1, true, 200, "created"), a(2, true, 0, "transport: TimeoutError"), a(3, false, null, null), a(4, true, 409, "SLOT_TAKEN")] });
  eq(JSON.stringify(counts), JSON.stringify({ planned: 4, deployed: 3, deployFailed: 1, answered: 2, created: 1, noAnswer: 1 }), "each sample is counted once, by what it came to");
  const all = coldLegOutcome({ mode: "cold", planned: 3, attempts: [a(1, true, 200, "created"), a(2, true, 409, "SLOT_TAKEN"), a(3, true, 200, "created")] });
  eq(all.exit, 0, "every sample deployed and got an answer, so the leg passed, whatever the answer was");
  assert(/3 of 3 samples answered/.test(all.text) && /2 created/.test(all.text) && /1 refused/.test(all.text), `and it says how many were created and refused (got ${all.text})`);
  const lost = coldLegOutcome({ mode: "cold", planned: 3, attempts: [a(1, true, 0, "transport: TimeoutError"), a(2, false, null, null), a(3, true, 200, "created")] });
  // The leg is a diagnostic that never fails the run, so a lost sample is reported, not a
  // red job: one bad deploy among thirty must not turn a run's conclusion red.
  eq(lost.exit, 0, "a sample with no answer, or no deploy, is reported rather than failing the job");
  assert(/1 of 3 samples answered/.test(lost.text) && /1 deploy failed/.test(lost.text) && /1 confirm got no answer/.test(lost.text), `naming each way a sample was lost (got ${lost.text})`);
  // But a leg that measured nothing at all is red, so it never reads as a quiet one (L98).
  const none = coldLegOutcome({ mode: "cold", planned: 2, attempts: [a(1, false, null, null), a(2, true, 0, "transport: TimeoutError")] });
  eq(none.exit, 1, "a leg where no sample got an answer fails, since it measured nothing");
  assert(/0 of 2 samples answered/.test(none.text) && /measured nothing/.test(none.text), `and says it measured nothing (got ${none.text})`);
}

// --- one deploy: the load test Worker only, the run's arm kept, under its own deadline ---
{
  const calls: { cmd: string; args: string[]; timeout: number | undefined }[] = [];
  const answer = (r: { status: number | null; stdout?: string; stderr?: string; error?: { code?: string; message: string } }) => {
    const deploy = makeColdDeploy({
      arm: "reads-only",
      wranglerBin: "/repo/node_modules/.bin/wrangler",
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, timeout: opts.timeout });
        return { stdout: "", stderr: "", ...r };
      },
    });
    return deploy();
  };
  const ok = await answer({ status: 0, stdout: "Current Version ID: 5239f06d-1c2e-4b8a-9f3d-0a1b2c3d4e5f" });
  assert(ok.ok && ok.output.includes("Current Version ID"), "a deploy that exits 0 is a deploy, carrying wrangler's output");
  eq(calls[0]?.args.join(" "), "deploy --env loadtest --var SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE:reads-only", "it deploys the load test Worker only, keeping the run's arm");
  // wrangler's own binary, not `npx wrangler`: a deadline kills the process it started,
  // and through npx that is only the wrapper, leaving wrangler deploying into the next
  // sample with the pipes held open (L321).
  eq(calls[0]?.cmd, "/repo/node_modules/.bin/wrangler", "it runs wrangler itself, so the deadline stops wrangler and not a wrapper around it, at the path it is handed rather than one relative to wherever it was started");
  eq(calls[0]?.timeout, COLD_DEPLOY_TIMEOUT_MS, "under the deploy's own deadline (L110)");
  const hung = await answer({ status: null, error: { code: "ETIMEDOUT", message: "spawnSync npx ETIMEDOUT" } });
  assert(!hung.ok && hung.output.includes(`did not finish within ${COLD_DEPLOY_TIMEOUT_MS}ms`), `a deploy that hits its deadline is a failed sample that says so (got ${JSON.stringify(hung)})`);
  const refused = await answer({ status: 1, stderr: "Error: the upload was refused" });
  assert(!refused.ok && refused.output.includes("upload was refused") && !refused.output.includes("did not finish"), "a deploy that fails is a failed sample carrying its own error, not called a timeout");
}

(async () => {
  {
    const { events, result } = await legWith({ n: 3 });
    eq(
      events.join(" "),
      `read:112 read:212 deploy:1 sleep:${COLD_SETTLE_MS} confirm:1:112@${s1} deploy:2 sleep:${COLD_SETTLE_MS} confirm:2:212@${s4} deploy:3 sleep:${COLD_SETTLE_MS} confirm:3:112@${s2}`,
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
    assert(!events.includes(`confirm:2:212@${s4}`), "a deploy that failed sends no confirm, since it would land on the old version and read warm");
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

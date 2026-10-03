// The deploy refuses a commit unless `ci` passed on that exact sha (#3088).
//
// Drives the decision (scripts/lib/deploy-ci-gate.ts) and the runner
// (scripts/check-ci-before-deploy.ts) through hand written GitHub replies, with no
// network and no real sleep, and checks the deploy job really runs it before it
// builds anything.
//
// Run: node --experimental-strip-types scripts/test-deploy-ci-gate.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeCiForDeploy, parseCheckRuns, type CheckRun } from "./lib/deploy-ci-gate.ts";
import { runGate, type GateFetch } from "./check-ci-before-deploy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function run(over: Partial<CheckRun> = {}): CheckRun {
  return {
    id: 100,
    name: "ci",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    ...over,
  };
}

const reason = (v: ReturnType<typeof judgeCiForDeploy>) => (v.ok ? "pass" : v.reason);

// --- the decision, both directions (L1, L159) ----------------------------------

eq(reason(judgeCiForDeploy(SHA, [run()])), "pass", "a green ci run on this exact sha passes");
eq(reason(judgeCiForDeploy(SHA, [])), "no-ci-run", "no ci run at all refuses");
eq(
  reason(judgeCiForDeploy(SHA, [run({ head_sha: OTHER })])),
  "no-ci-run",
  "a green ci run on ANOTHER sha cannot vouch for this one",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ name: "build" })])),
  "no-ci-run",
  "a green leg that is not the fan-in does not count",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ app: { slug: "some-other-app" } })])),
  "no-ci-run",
  "a check named ci from another app does not count, since any app with checks write can make one",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ conclusion: "failure" })])),
  "ci-not-green",
  "a red ci run refuses",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ conclusion: "cancelled" })])),
  "ci-not-green",
  "a cancelled one is not a pass",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ conclusion: "skipped" })])),
  "ci-not-green",
  "nor a skipped one",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ status: "in_progress", conclusion: null })])),
  "ci-not-finished",
  "a ci run still going refuses on its own reason",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ id: 1, conclusion: "failure" }), run({ id: 2 })])),
  "pass",
  "the NEWEST run decides, so a flaked fan-in re-run to green may deploy",
);
eq(
  reason(judgeCiForDeploy(SHA, [run({ id: 2, conclusion: "failure" }), run({ id: 1 })])),
  "ci-not-green",
  "and an older green run cannot vouch for a newer red one, whatever order GitHub lists them in",
);
eq(reason(judgeCiForDeploy("main", [run()])), "bad-sha", "a ref name is not an exact commit");
eq(reason(judgeCiForDeploy(SHA.slice(0, 7), [run()])), "bad-sha", "nor is a short sha");

// --- parsing a reply -------------------------------------------------------------

{
  const p = parseCheckRuns({ total_count: 1, check_runs: [run()] });
  assert(p.ok && p.runs.length === 1, "a real reply shape parses");
  eq(parseCheckRuns({ message: "Not Found" }).ok, false, "a reply with no list is refused, not read as empty");
  eq(parseCheckRuns({ check_runs: [{ id: "x" }] }).ok, false, "and so is a list of the wrong shape");
  eq(parseCheckRuns(null).ok, false, "and an empty body");
}

// --- the runner: every exit code is reachable and distinct ----------------------

function fakeFetch(replies: Array<{ status: number; body?: unknown } | Error>): {
  fetchImpl: GateFetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl: GateFetch = async (url) => {
    calls.push(url);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.body };
  };
  return { fetchImpl, calls };
}

const ENV = { REPO: "Try-Pennie/slate", HEAD_SHA: SHA, GH_TOKEN: "t" };
const sleeps: number[] = [];
const noSleep = async (ms: number) => {
  sleeps.push(ms);
};

async function gate(env: Record<string, string | undefined>, f: ReturnType<typeof fakeFetch>) {
  const lines: string[] = [];
  const code = await runGate(env, { fetchImpl: f.fetchImpl, sleep: noSleep, log: (l) => lines.push(l) });
  return { code, out: lines.join("\n") };
}

{
  const f = fakeFetch([{ status: 200, body: { check_runs: [run()] } }]);
  const r = await gate(ENV, f);
  eq(r.code, 0, "the runner passes a green ci on this sha");
  assert(f.calls[0]!.includes(`/commits/${SHA}/check-runs`), "and it asked about this exact sha");
  assert(f.calls[0]!.includes("check_name=ci"), "for the ci check by name");
}

{
  const f = fakeFetch([{ status: 200, body: { check_runs: [run({ conclusion: "failure" })] } }]);
  const r = await gate(ENV, f);
  eq(r.code, 3, "a red ci exits 3, the refusal");
  assert(/Deploy refused/.test(r.out) && /ci-not-green/.test(r.out), "and says why, by reason");
}

{
  const f = fakeFetch([{ status: 200, body: { check_runs: [] } }]);
  eq((await gate(ENV, f)).code, 3, "no ci run at all exits 3 too: GitHub answered, and nothing passed");
}

{
  const f = fakeFetch([{ status: 502 }, { status: 502 }, { status: 502 }]);
  sleeps.length = 0;
  const r = await gate(ENV, f);
  eq(r.code, 2, "a read that never succeeds exits 2, distinct from a refusal");
  eq(f.calls.length, 3, "after three attempts");
  eq(sleeps.length, 2, "sleeping between them, never after the last");
  assert(/re-run this job/.test(r.out), "and tells the reader the remedy is a re-run");
}

{
  const f = fakeFetch([new Error("socket hang up"), { status: 200, body: { check_runs: [run()] } }]);
  eq((await gate(ENV, f)).code, 0, "a blip that recovers on the retry passes");
}

{
  const f = fakeFetch([{ status: 200, body: { check_runs: [run()] } }]);
  const r = await gate({ ...ENV, GH_TOKEN: "" }, f);
  eq(r.code, 1, "a missing token exits 1");
  eq(f.calls.length, 0, "having read nothing");
  assert(/GH_TOKEN/.test(r.out), "and names what is missing");
}

// --- wired, not merely written (L3) ---------------------------------------------
//
// Judged on STEPS with comments stripped, never on the job's raw text: the comment
// above the gate step names the script, so a check that searched the text would
// pass with the step deleted (L135). The control below plants exactly that.

/** The deploy job's text with comment lines removed. */
function deployJob(ci: string): string {
  const lines = ci.split("\n");
  const start = lines.findIndex((l) => l === "  deploy:");
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[\w-]+:$/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => !/^\s*#/.test(l)).join("\n");
}

/** What the wiring checks found, so a planted control can be judged the same way. */
function wiring(job: string) {
  const [header = "", body = ""] = job.split(/^ {4}steps:\n/m);
  const steps = body.split(/^(?= {6}- )/m).filter((st) => /^ {6}- /.test(st));
  const gate = steps.findIndex((st) => /^\s*run: node [^\n]*scripts\/check-ci-before-deploy\.ts\s*$/m.test(st));
  // The step that ships: the gradual deploy since #3095 (its settle step, which also
  // names the script, comes after it and must not be mistaken for it).
  const ship = steps.findIndex((st) => /^\s*(?:run: )?(?:pnpm cf:deploy|node [^\n]*scripts\/deploy-gradual\.ts)\s*$/m.test(st));
  const install = steps.findIndex((st) => /^\s*run: pnpm install\b/m.test(st));
  return {
    gate,
    beforeDeploy: gate >= 0 && ship > gate,
    beforeInstall: gate >= 0 && (install < 0 || gate < install),
    sha: gate >= 0 && /HEAD_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/.test(steps[gate]!),
    checksRead: /^\s*checks:\s*read\s*$/m.test(header),
  };
}

{
  const ci = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  const job = deployJob(ci);
  assert(job.length > 0, "ci.yml has a deploy job");
  const w = wiring(job);
  assert(w.gate >= 0, "the deploy job has a step whose run line invokes the ci gate");
  assert(w.beforeDeploy, "BEFORE the step that deploys");
  assert(w.beforeInstall, "and before the install, so a refusal spends nothing");
  assert(w.sha, "against the sha this run is about to ship, set on that step");
  assert(w.checksRead, "with a token allowed to read check runs");

  // Positive control: the gate STEP deleted from the real ci.yml in memory, its
  // explanatory comment left in place. Every wiring check must notice.
  const raw = ci.split("\n");
  const at = raw.findIndex((l) => /- name: Refuse unless ci passed on this exact commit/.test(l));
  assert(at > 0, "control: the real gate step is there to delete");
  let stop = at + 1;
  while (stop < raw.length && !/^ {6}- /.test(raw[stop]!)) stop++;
  const planted = [...raw.slice(0, at), ...raw.slice(stop)].join("\n");
  assert(/scripts\/check-ci-before-deploy\.ts/.test(planted), "control: the comment naming the script survives the deletion");
  const pw = wiring(deployJob(planted));
  eq(pw.gate, -1, "control: with the step gone, no step invokes the gate, whatever the comment says");
  assert(!pw.beforeDeploy && !pw.beforeInstall && !pw.sha, "control: and every wiring check fails");
}

finish();

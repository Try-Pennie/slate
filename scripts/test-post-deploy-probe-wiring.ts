// Repo invariant (#1037): the deploy job actually probes what it just deployed.
//
// Built is not wired, and wired is not proven (L3). The probe logic is unit tested
// next door, but logic that nothing invokes protects nothing, and this is precisely
// the kind of step that gets dropped in a YAML edit months later with no test going
// red. Three things are pinned:
//
//   1. the stamp runs BEFORE the build, so the bundle carries the real commit,
//   2. the build runs before the gradual deploy (#3095) that uploads and probes it,
//      and a settle step after it ends any split a cancelled run left standing,
//   3. the probe fails loud rather than skipping green when its key is absent.
//
// Run: node --experimental-strip-types scripts/test-post-deploy-probe-wiring.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stamp, normalizeCommit } from "./stamp-build-info.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

// The deploy job body, up to the next top-level job (or end of file), with comment
// lines removed: the comments around these steps name every script in them, so a
// match that could land in a comment would pass with the step deleted (L135).
const deployJob = (ci.match(/^  deploy:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "")
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
assert(deployJob.trim().length > 0, "the deploy job exists in ci.yml");

/** The steps of the deploy job, each as its own text. */
const steps = (deployJob.split(/^ {4}steps:\n/m)[1] ?? "").split(/^(?= {6}- )/m).filter((st) => /^ {6}- /.test(st));
const stepIndex = (re: RegExp) => steps.findIndex((st) => re.test(st));

const stampAt = stepIndex(/run: node [^\n]*scripts\/stamp-build-info\.ts/);
const buildAt = stepIndex(/run: pnpm cf:build\s*$/m);
const deployAt = stepIndex(/^\s*node --experimental-strip-types scripts\/deploy-gradual\.ts\s*$/m);
const settleAt = stepIndex(/run: node --experimental-strip-types scripts\/deploy-gradual\.ts --settle\s*$/m);

assert(stampAt !== -1, "the deploy job stamps the build with the deploying commit");
assert(buildAt !== -1, "the deploy job builds through pnpm cf:build, which carries the bundle env guard (#3078)");
assert(deployAt !== -1, "the deploy job deploys gradually (#3095)");
assert(settleAt !== -1, "the deploy job has the step that settles a split left standing");

// ORDER IS THE WHOLE POINT of these.
assert(
  stampAt < buildAt,
  "the stamp runs BEFORE the build, or the bundle ships the 'dev' placeholder and the probe verifies nothing",
);
assert(buildAt < deployAt, "the build runs BEFORE the gradual deploy uploads it");
assert(deployAt < settleAt, "the settle step comes after the deploy it cleans up after");
assert(
  /if:\s*\(failure\(\) \|\| cancelled\(\)\)/.test(steps[settleAt] ?? ""),
  "and runs only when the job failed or was cancelled, which is when a split can be left standing",
);
{
  // And only once the deploy step itself started: after a ci gate refusal or a failed
  // build nothing touched production, and a settle there would page about a
  // deployment it merely could not read.
  const id = /^\s*id:\s*(\S+)\s*$/m.exec(steps[deployAt] ?? "")?.[1];
  assert(id !== undefined, "the deploy step has an id the settle step can ask about");
  assert(
    id !== undefined &&
      (steps[settleAt] ?? "").includes(`steps.${id}.outcome == 'failure'`) &&
      (steps[settleAt] ?? "").includes(`steps.${id}.outcome == 'cancelled'`),
    "the settle step runs only when the deploy step itself failed or was cancelled",
  );
}
assert(
  !/opennextjs-cloudflare deploy|pnpm cf:deploy\s*$/m.test(deployJob),
  "nothing in the deploy job still deploys straight to 100% (`opennextjs-cloudflare deploy`)",
);

// The settle step decides from what the deploy step recorded, so both must name the
// SAME state file; two spellings would leave settle reading a file nobody wrote and
// reporting nothing to settle with a split standing.
{
  const fileOf = (st: string) => /DEPLOY_STATE_FILE:\s*(.+)$/m.exec(st)?.[1].trim();
  const written = fileOf(steps[deployAt] ?? "");
  assert(written !== undefined, "the deploy step records to a state file");
  assert(written !== undefined && fileOf(steps[settleAt] ?? "") === written, "and the settle step reads that same file");
}

// The deploy step needs the booking key and the commit, or its probes cannot run.
const deployStep = steps[deployAt] ?? "";
assert(
  /BOOKING_API_KEY_CANARY:\s*\$\{\{\s*secrets\.BOOKING_API_KEY_CANARY\s*\}\}/.test(deployStep),
  "the deploy step is given BOOKING_API_KEY_CANARY (#2822, the canary's own key; the version endpoint is key-authed)",
);
assert(/GITHUB_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/.test(deployStep), "the deploy step is told which commit to expect");

// The gradual deploy runs the SAME probe, through the shared reads, with a run of
// confirmations, and the canary probe through the override header.
const gradualSrc = readFileSync(join(ROOT, "scripts", "deploy-gradual.ts"), "utf8");
assert(/runProbe\(/.test(gradualSrc) && /httpProbeDeps\(/.test(gradualSrc), "the gradual deploy runs the post-deploy probe through the shared HTTP reads");
assert(/confirmations:\s*CONFIRMATIONS/.test(gradualSrc), "with a run of confirmations, since both versions answer during the split");
assert(/versionOverride:\s*stage === "canary"/.test(gradualSrc), "and pins the canary probe to the canary through the override header");

// A deploy and a rollback are never queued behind each other. GitHub keeps one PENDING
// run per concurrency group and cancels the older with no alert, so a shared group
// would let either silently drop the other. The rollback's group is unique per run,
// and the deploy job declares none of its own (the deploy guards against a rollback by
// re-reading what is serving, pinned in scripts/test-gradual-deploy.ts).
{
  const rollback = readFileSync(join(ROOT, ".github", "workflows", "rollback.yml"), "utf8");
  const rollbackGroup = /^concurrency:\n {2}group:\s*(.+)$/m.exec(rollback)?.[1] ?? "";
  assert(rollbackGroup.includes("${{ github.run_id }}"), `the rollback's concurrency group is unique per run, so it is never queued or dropped (got ${JSON.stringify(rollbackGroup)})`);
  assert(!/^ {4}concurrency:/m.test(deployJob), "the deploy job has no concurrency group a rollback could share");
}

// #766 regression shape: the probe must never pass green having checked nothing.
const probeSrc = readFileSync(join(ROOT, "scripts", "post-deploy-probe.ts"), "utf8");
assert(
  /if \(!key\)/.test(probeSrc) && /process\.exit\(1\)/.test(probeSrc),
  "the probe EXITS 1 when its key is missing, rather than skipping green while claiming to have verified the deploy",
);
assert(
  /::error title=post-deploy probe/.test(probeSrc),
  "a probe failure emits a GitHub error annotation so it is impossible to miss in the run",
);

// The stamped file must still be stampable: a rename or a reformat of the literal
// would make the CI stamp a silent no-op, and the probe would then compare the
// placeholder forever.
const buildInfo = readFileSync(join(ROOT, "src", "lib", "build-info.ts"), "utf8");
assert(
  /export const BUILD_COMMIT = "dev";/.test(buildInfo),
  "build-info.ts holds the 'dev' placeholder in git (it is stamped only at deploy time)",
);
const stamped = stamp(buildInfo, "abc1234def");
assert(
  stamped.includes('export const BUILD_COMMIT = "abc1234def";'),
  "the stamp helper can still find and replace the declaration in the real file",
);
assert(
  !stamped.includes('BUILD_COMMIT = "dev"'),
  "and the placeholder is gone afterwards, so a stamped build cannot report 'dev'",
);
// The stamp must FAIL rather than silently no-op if the declaration ever moves.
let threw = false;
try {
  stamp("export const SOMETHING_ELSE = 1;", "abc1234");
} catch {
  threw = true;
}
assert(threw, "the stamp THROWS when the declaration is missing, instead of silently doing nothing");

// A commit id is validated before being written into a source file that is then
// compiled: a stray value must not reach the bundle.
eq(normalizeCommit("0123456789abcdef0123"), "0123456789ab", "a long sha is shortened");
eq(normalizeCommit("abc1234"), "abc1234", "a 7-char sha is accepted as-is");
for (const bad of ["", "main", "not-hex!", "abc", undefined]) {
  let rejected = false;
  try {
    normalizeCommit(bad as string | undefined);
  } catch {
    rejected = true;
  }
  assert(rejected, `a non-sha value (${JSON.stringify(bad)}) is refused, not stamped`);
}

finish();

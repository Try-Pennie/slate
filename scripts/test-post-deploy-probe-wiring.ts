// Repo invariant (#1037): the deploy job actually probes what it just deployed.
//
// Built is not wired, and wired is not proven (L3). The probe logic is unit tested
// next door, but logic that nothing invokes protects nothing, and this is precisely
// the kind of step that gets dropped in a YAML edit months later with no test going
// red. Three things are pinned:
//
//   1. the stamp runs BEFORE the deploy (cf:deploy builds, so a stamp afterwards
//      would ship the "dev" placeholder and the probe would compare nothing),
//   2. the probe runs AFTER the deploy,
//   3. the probe fails loud rather than skipping green when its key is absent.
//
// Run: node --experimental-strip-types scripts/test-post-deploy-probe-wiring.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stamp, normalizeCommit } from "./stamp-build-info.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

// The deploy job body, up to the next top-level job (or end of file).
const deployJob = ci.match(/^  deploy:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
assert(deployJob.trim().length > 0, "the deploy job exists in ci.yml");

const stampAt = deployJob.indexOf("scripts/stamp-build-info.ts");
const deployAt = deployJob.indexOf("pnpm cf:deploy");
const probeAt = deployJob.indexOf("scripts/post-deploy-probe.ts");

assert(stampAt !== -1, "the deploy job stamps the build with the deploying commit");
assert(deployAt !== -1, "the deploy job still runs pnpm cf:deploy");
assert(probeAt !== -1, "the deploy job runs the post-deploy probe");

// ORDER IS THE WHOLE POINT of these two.
assert(
  stampAt < deployAt,
  "the stamp runs BEFORE cf:deploy; cf:deploy builds, so stamping after it would ship the 'dev' placeholder and the probe would verify nothing",
);
assert(
  probeAt > deployAt,
  "the probe runs AFTER cf:deploy; probing first would measure the previous version",
);

// The probe needs the booking key and the commit, or it cannot do its job.
assert(
  /BOOKING_API_KEY:\s*\$\{\{\s*secrets\.BOOKING_API_KEY\s*\}\}/.test(deployJob),
  "the probe step is given BOOKING_API_KEY (the version endpoint is key-authed)",
);
assert(
  /GITHUB_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/.test(deployJob),
  "the probe step is told which commit to expect",
);

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

// A hand-run deploy that verifies itself, the same way CI's does (#1190).
//
// `pnpm cf:deploy` uploads straight to production with no commit stamp and no probe,
// so the live site reports commit `dev` and nothing confirms the new version went
// live or that the site is healthy afterwards. The realistic occasion for a hand
// deploy is an urgent fix when the pipeline is unavailable or too slow, which is
// exactly when an unverified release is most expensive.
//
// This runs the same three steps in the same order as the CI deploy job, and calls
// the SAME two scripts rather than reimplementing them, so the two paths cannot
// drift into verifying different things:
//
//   1. stamp the commit into the bundle (scripts/stamp-build-info.ts),
//   2. `pnpm cf:deploy`, with the version tagged by its commit (#3178) so the
//      Rollback workflow can confirm it later without being told the commit,
//   3. poll the live version and then judge health (scripts/post-deploy-probe.ts).
//
// It restores src/lib/build-info.ts afterwards, whatever happened. The stamp writes
// into a tracked source file, and CI does not care (a fresh checkout every time)
// but a laptop does: leaving it modified means the next commit quietly carries a real
// sha where the repo expects the "dev" placeholder.
//
// Run: BOOKING_API_KEY_CANARY=<key> pnpm cf:deploy:verified
//      APP_URL=... to target something other than production.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStep, planVerifiedDeploy } from "./lib/deploy-verified.ts";
import { OBJECT_WORKER_CONFIGS } from "./lib/gradual-deploy.ts";

const ROOT = join(import.meta.dirname, "..");
const BUILD_INFO = join(ROOT, "src", "lib", "build-info.ts");

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Clean, dirty, or unknown. The three states the plan distinguishes. */
function dirtyState(): boolean | null {
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return status === null ? null : status !== "";
}

const plan = planVerifiedDeploy({
  githubSha: process.env.GITHUB_SHA,
  headSha: git(["rev-parse", "HEAD"]),
  // Tracked files only: an untracked scratch file is not something that ships.
  // null when git could not be asked, which is NOT the same as a clean tree: `?? ""`
  // here would have scored an unreadable status as clean and quietly skipped the
  // dirty-tree refusal on exactly the runs least able to vouch for the stamp.
  dirty: dirtyState(),
  bookingApiKey: process.env.BOOKING_API_KEY_CANARY,
  appUrl: process.env.APP_URL,
  allowDirty: process.env.ALLOW_DIRTY_DEPLOY === "1",
});

if (!plan.ok) {
  console.error(`\n  Not deploying: ${plan.reason}\n`);
  process.exit(plan.code);
}

if (process.env.ALLOW_DIRTY_DEPLOY === "1") {
  console.warn(
    `\n  ALLOW_DIRTY_DEPLOY is set. The bundle will be stamped ${plan.commit}, and the` +
      `\n  working tree has changes that commit does not contain, so the version the live` +
      `\n  site reports will NOT describe what is running. Say so wherever this deploy is` +
      `\n  recorded.` +
      (plan.deployArgs.includes("--tag")
        ? ""
        : `\n  The version is NOT tagged with the commit, so a later rollback to it cannot` +
          `\n  confirm which commit serves without being told.`) +
      `\n`,
  );
}

console.log(`\n  Deploying ${plan.commit} to ${plan.appUrl}, then verifying it.\n`);

// Each step inherits stdio and this process's environment, with its own `env` added
// (`makeStep`, driven by scripts/test-deploy-verified.ts).
const step = makeStep({ spawn: spawnSync, root: ROOT, baseEnv: process.env, log: (line) => console.log(line) });

const original = readFileSync(BUILD_INFO, "utf8");
let failure: unknown = null;
try {
  step("stamp the deploying commit", "node", [
    "--experimental-strip-types",
    "scripts/stamp-build-info.ts",
    plan.commit,
  ]);
  // #3500, #3555: Slate's bindings name these workers, so they go first.
  for (const config of OBJECT_WORKER_CONFIGS) {
    step(`deploy the object worker ${config}`, "pnpm", ["exec", "wrangler", "deploy", "-c", config]);
  }
  // pnpm appends these to the script's last command, `opennextjs-cloudflare deploy`,
  // which hands unrecognised flags through to `wrangler deploy`.
  step("build and deploy", "pnpm", ["run", "cf:deploy", ...plan.deployArgs]);
  // #3363: told which commit was stamped, since outside CI there is no GITHUB_SHA.
  step("post-deploy probe", "node", [
    "--experimental-strip-types",
    "scripts/post-deploy-probe.ts",
  ], plan.probeEnv);
} catch (err) {
  failure = err;
} finally {
  // Always, on every path: a half-run deploy must not leave a stamped source file
  // behind for the next commit to pick up.
  writeFileSync(BUILD_INFO, original);
}

if (failure) {
  console.error(`\n  ${failure instanceof Error ? failure.message : String(failure)}`);
  console.error(
    "  The deploy may or may not have landed. Check https://slate.trypennie.app/api/health" +
      "\n  and the version endpoint before deciding whether to retry or roll back (DEPLOY.md).\n",
  );
  process.exit(1);
}

console.log("\n  Deployed and verified: the live site is serving this commit and is healthy.\n");

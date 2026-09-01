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
//   2. `pnpm cf:deploy`,
//   3. poll the live version and then judge health (scripts/post-deploy-probe.ts).
//
// It restores src/lib/build-info.ts afterwards, whatever happened. The stamp writes
// into a tracked source file, and CI does not care (a fresh checkout every time)
// but a laptop does: leaving it modified means the next commit quietly carries a real
// sha where the repo expects the "dev" placeholder.
//
// Run: BOOKING_API_KEY=<key> pnpm cf:deploy:verified
//      APP_URL=... to target something other than production.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planVerifiedDeploy } from "./lib/deploy-verified.ts";

const ROOT = join(import.meta.dirname, "..");
const BUILD_INFO = join(ROOT, "src", "lib", "build-info.ts");

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const plan = planVerifiedDeploy({
  githubSha: process.env.GITHUB_SHA,
  headSha: git(["rev-parse", "HEAD"]),
  // Tracked files only: an untracked scratch file is not something that ships.
  dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "",
  bookingApiKey: process.env.BOOKING_API_KEY,
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
      `\n  recorded.\n`,
  );
}

console.log(`\n  Deploying ${plan.commit} to ${plan.appUrl}, then verifying it.\n`);

/** Run a step, inheriting stdio so its own output is the output. */
function step(name: string, cmd: string, args: string[]): void {
  console.log(`  --- ${name}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`${name} failed (exit ${res.status ?? "signal"})`);
  }
}

const original = readFileSync(BUILD_INFO, "utf8");
let failure: unknown = null;
try {
  step("stamp the deploying commit", "node", [
    "--experimental-strip-types",
    "scripts/stamp-build-info.ts",
    plan.commit,
  ]);
  step("build and deploy", "pnpm", ["run", "cf:deploy"]);
  step("post-deploy probe", "node", [
    "--experimental-strip-types",
    "scripts/post-deploy-probe.ts",
  ]);
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

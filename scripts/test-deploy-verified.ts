// #1190: a hand-run deploy verifies itself the way CI's does.
//
// The #1037 verification (the commit stamp, and the probe that confirms the new
// version is actually serving before it judges health) lived entirely in the CI
// deploy job. A hand-run `pnpm cf:deploy` is a documented, supported path and had
// neither, so the live site reported commit `dev` and nothing confirmed the release.
// The occasion for a hand deploy is an urgent fix when the pipeline is unavailable,
// which is exactly when an unverified release is most expensive.
//
// Every refusal is driven here with no git, no network and no deploy. Each carries its
// OWN exit code, so a shell caller can branch on which one it met and two different
// problems never read the same (L11).
//
// Run: node --experimental-strip-types scripts/test-deploy-verified.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planVerifiedDeploy, DEFAULT_APP_URL } from "./lib/deploy-verified.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CLEAN = {
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  dirty: false,
  bookingApiKey: "k",
};

// --- the happy path ----------------------------------------------------------
{
  const plan = planVerifiedDeploy(CLEAN);
  assert(plan.ok, "a clean tree with a key and a commit deploys");
  if (plan.ok) {
    eq(plan.commit, "abcdef123456", "the commit is shortened the same way the stamp does");
    eq(plan.appUrl, DEFAULT_APP_URL, "and production is the default target");
  }
}
{
  // GITHUB_SHA wins, so behaviour is identical if CI ever calls this.
  const plan = planVerifiedDeploy({ ...CLEAN, githubSha: "1111111111111111111111111111111111111111" });
  assert(plan.ok && plan.commit === "111111111111", "GITHUB_SHA takes precedence over HEAD");
}
{
  const plan = planVerifiedDeploy({ ...CLEAN, appUrl: "https://staging.example.com/" });
  assert(plan.ok && plan.appUrl === "https://staging.example.com", "a trailing slash is trimmed");
}

// --- the refusals, each with its own code ------------------------------------
const refusals: [string, ReturnType<typeof planVerifiedDeploy>][] = [
  ["no commit anywhere", planVerifiedDeploy({ ...CLEAN, headSha: null })],
  ["a commit that is not a sha", planVerifiedDeploy({ ...CLEAN, headSha: "my-branch" })],
  ["a dirty tree", planVerifiedDeploy({ ...CLEAN, dirty: true })],
  ["a tree it could not read", planVerifiedDeploy({ ...CLEAN, dirty: null })],
  ["no booking key", planVerifiedDeploy({ ...CLEAN, bookingApiKey: "" })],
  ["a non-https target", planVerifiedDeploy({ ...CLEAN, appUrl: "http://slate.trypennie.app" })],
];
for (const [what, plan] of refusals) {
  assert(!plan.ok, `refuses: ${what}`);
  if (!plan.ok) {
    assert(plan.code > 0, `${what} exits non-zero`);
    assert(plan.reason.length > 20, `${what} says why, in a sentence`);
  }
}

{
  // An UNREADABLE tree is its own state, distinct from a dirty one, and this is the
  // assertion that stops it collapsing back. `git status` returning nothing means a
  // clean tree; `git status` FAILING means nothing at all, and scoring that as clean
  // is how this refusal silently stops applying, on exactly the runs least able to
  // vouch for the stamp (L11). Its message must not say "commit first" either, which
  // is useless advice to somebody whose git is not answering.
  const unreadable = planVerifiedDeploy({ ...CLEAN, dirty: null });
  const dirty = planVerifiedDeploy({ ...CLEAN, dirty: true });
  assert(!unreadable.ok, "a tree it cannot read is refused, not assumed clean");
  assert(
    !unreadable.ok && !dirty.ok && unreadable.code !== dirty.code,
    "and it carries a different exit code from a dirty tree",
  );
  assert(
    !unreadable.ok && /could not read/i.test(unreadable.reason),
    "its message says it could not measure, rather than claiming the tree is dirty",
  );
  assert(
    !unreadable.ok && !/commit first/i.test(unreadable.reason),
    "and does not give advice that cannot help",
  );
  // The override covers it, for the same reason it covers a dirty tree: refusing
  // outright would make the command unusable in the emergency it exists for.
  assert(
    planVerifiedDeploy({ ...CLEAN, dirty: null, allowDirty: true }).ok,
    "ALLOW_DIRTY_DEPLOY proceeds on an unreadable tree too",
  );
}

{
  // The dirty tree and the missing key are the two a caller most needs to tell apart:
  // one is "commit first", the other is "you cannot verify at all".
  const dirty = planVerifiedDeploy({ ...CLEAN, dirty: true });
  const noKey = planVerifiedDeploy({ ...CLEAN, bookingApiKey: "" });
  assert(
    !dirty.ok && !noKey.ok && dirty.code !== noKey.code,
    "a dirty tree and a missing key have different exit codes",
  );
}

// --- the dirty override -------------------------------------------------------
{
  // Refusing outright would make the one command with a safety net unusable in the
  // exact emergency it exists for. The override is allowed, and the runner warns that
  // the stamp does not describe what shipped.
  const plan = planVerifiedDeploy({ ...CLEAN, dirty: true, allowDirty: true });
  assert(plan.ok, "ALLOW_DIRTY_DEPLOY proceeds");
  assert(plan.ok && plan.commit === "abcdef123456", "and still stamps HEAD, since there is nothing else");
}
{
  // The override must NOT rescue the other refusals: it says something about the tree,
  // not about whether the deploy can be verified.
  const plan = planVerifiedDeploy({ ...CLEAN, dirty: true, allowDirty: true, bookingApiKey: "" });
  assert(!plan.ok, "the dirty override does not waive the missing key");
}

// --- the two paths must stay the same three steps ----------------------------
// Built is not wired (L3). These pin that the runner drives the SAME scripts CI does,
// in the same order, rather than a second implementation that could verify less.
{
  const runner = readFileSync(join(import.meta.dirname, "deploy-verified.ts"), "utf8");
  // Anchored on the step() CALLS, not on the script names: the file's own header
  // comment lists all three in order, so a name search would pass on the comment
  // while the code did something else entirely (L103).
  const stampAt = runner.indexOf('step("stamp the deploying commit"');
  const deployAt = runner.indexOf('step("build and deploy"');
  const probeAt = runner.indexOf('step("post-deploy probe"');
  assert(stampAt !== -1, "the runner stamps the commit");
  assert(deployAt !== -1, "the runner deploys");
  assert(probeAt !== -1, "the runner probes");
  assert(
    runner.includes("scripts/stamp-build-info.ts") &&
      runner.includes("scripts/post-deploy-probe.ts") &&
      runner.includes('"cf:deploy"'),
    "and it drives CI's own scripts rather than a second implementation",
  );
  assert(
    stampAt < deployAt && deployAt < probeAt,
    "and in that order: a stamp after the build ships the placeholder, and a probe " +
      "before the deploy judges the previous version",
  );
  assert(
    !/dirty:\s*\(git\(\[.*\]\)\s*\?\?\s*""\)/.test(runner),
    "the runner does not collapse an unreadable git status into a clean tree",
  );
  assert(
    runner.includes("function dirtyState()") && runner.includes("=== null ? null :"),
    "it reports clean, dirty or unknown as three states",
  );
  assert(
    runner.includes("finally") && runner.includes("writeFileSync(BUILD_INFO, original)"),
    "build-info.ts is restored on every path, so a failed deploy leaves no stamped file behind",
  );

  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert(
    (pkg.scripts["cf:deploy:verified"] ?? "").includes("scripts/deploy-verified.ts"),
    "pnpm cf:deploy:verified runs it",
  );
}

// --- DEPLOY.md tells somebody it exists --------------------------------------
{
  // A verified path nobody knows about is not a safety net. The runbook is where a
  // person in an incident actually looks.
  const deployDoc = readFileSync(join(import.meta.dirname, "..", "DEPLOY.md"), "utf8");
  assert(
    deployDoc.includes("cf:deploy:verified"),
    "DEPLOY.md names the verified command",
  );
}

finish();

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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeStep,
  planVerifiedDeploy,
  DEFAULT_APP_URL,
  HAND_RELEASE_MESSAGE_PREFIX,
} from "./lib/deploy-verified.ts";
import { normalizeCommit } from "./stamp-build-info.ts";
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

// --- the version is tagged with its commit (#3178) ---------------------------
// The Rollback workflow (#3165) reads a version's `workers/tag` annotation to know
// which commit it should report once it serves. An untagged hand deploy left it
// unable to confirm the rollback without somebody typing the commit in.
{
  const plan = planVerifiedDeploy(CLEAN);
  assert(plan.ok, "a clean tree deploys");
  if (plan.ok) {
    eq(
      plan.deployArgs,
      ["--tag", "abcdef123456", "--message", `${HAND_RELEASE_MESSAGE_PREFIX}abcdef123456`],
      "a clean deploy is tagged with the commit the bundle is stamped with",
    );
    assert(
      plan.deployArgs.every((a) => !/[\s'"]/.test(a)),
      "no value needs quoting: the adapter joins wrangler's arguments into one shell line",
    );
  }
}
{
  // A dirty tree's stamp does not describe what shipped, so the tag must not vouch
  // for it either: the rollback then reports it could not confirm the commit, which
  // is the truth, rather than confirming a commit the version does not hold.
  for (const dirty of [true, null]) {
    const plan = planVerifiedDeploy({ ...CLEAN, dirty, allowDirty: true });
    assert(plan.ok, `an overridden ${dirty === null ? "unreadable" : "dirty"} tree still deploys`);
    if (plan.ok) {
      assert(!plan.deployArgs.includes("--tag"), `and is NOT tagged (dirty: ${dirty})`);
      assert(
        plan.deployArgs.some((a) => a.startsWith(HAND_RELEASE_MESSAGE_PREFIX)),
        "but still carries the release message, so it is never mistaken for a canary",
      );
    }
  }
}
{
  // CONTROL: the tag tracks the commit rather than being a constant.
  const plan = planVerifiedDeploy({ ...CLEAN, headSha: "1234567890ab1234567890ab1234567890ab1234" });
  assert(plan.ok && plan.deployArgs[1] === "1234567890ab", "a different commit gets a different tag");
}
// Composes with the gradual deploy (#3165): the release annotation the rollback reads
// must be the one the gradual deploy writes. Before that change merges there is
// nothing to compare against; the moment scripts/lib/gradual-deploy.ts exists this
// requires the hand path to annotate exactly as a gradual release does.
{
  const gradualPath = join(import.meta.dirname, "lib", "gradual-deploy.ts");
  if (existsSync(gradualPath)) {
    const gradual = (await import(gradualPath)) as {
      RELEASE_MESSAGE_PREFIX: string;
      uploadArgs: (kind: "release", commit: string) => string[];
    };
    eq(HAND_RELEASE_MESSAGE_PREFIX, gradual.RELEASE_MESSAGE_PREFIX, "the hand release uses the gradual release prefix");
    const plan = planVerifiedDeploy(CLEAN);
    if (plan.ok) {
      eq(plan.deployArgs, gradual.uploadArgs("release", plan.commit), "and the same annotation flags");
    }
  } else {
    eq(HAND_RELEASE_MESSAGE_PREFIX, "slate-release-", "the release prefix #3165 writes and its rollback reads");
  }
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
    /step\("build and deploy",\s*"pnpm",\s*\["run",\s*"cf:deploy",\s*\.\.\.plan\.deployArgs\]\)/.test(runner),
    "the deploy step hands the planned tag and message through to wrangler (#3178)",
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

// --- #3363: the probe is told which commit was deployed ----------------------------
// The probe reads its expected commit from PROBE_COMMIT or GITHUB_SHA, and outside CI
// neither is set. On 2026-10-05, the first real hand deploy (#3344, version b92b44cc)
// went live and its probe refused at once with `refusing to stamp "" as a commit`,
// having checked nothing. So the plan carries the commit the stamp step writes, and
// the probe step runs with it.
{
  const plan = planVerifiedDeploy(CLEAN);
  assert(plan.ok, "a clean tree plans a deploy");
  if (plan.ok) {
    eq(plan.probeEnv.PROBE_COMMIT, plan.commit, "the probe is told the commit the stamp step writes");
  }
  const viaCi = planVerifiedDeploy({ ...CLEAN, githubSha: "1111111111111111111111111111111111111111" });
  assert(viaCi.ok && viaCi.probeEnv.PROBE_COMMIT === "111111111111", "and under CI it is the same commit the stamp uses");

  // The command must hand that environment to the probe step itself. Read only that
  // step's own call, so a mention elsewhere in the file cannot answer for it (L135).
  const script = readFileSync(join(import.meta.dirname, "deploy-verified.ts"), "utf8");
  const probeCall = (source: string): string => {
    const at = source.indexOf('step("post-deploy probe"');
    return at === -1 ? "" : source.slice(at, source.indexOf(");", at) + 2);
  };
  assert(probeCall(script) !== "", "the probe step is found in the command");
  assert(probeCall(script).includes("plan.probeEnv"), `and it runs with the plan's probe environment (got: ${probeCall(script)})`);
  const unwired = script.replace(/,\s*plan\.probeEnv/, "");
  assert(unwired !== script, "positive control: the wiring was removed from a copy of the real command");
  assert(!probeCall(unwired).includes("plan.probeEnv"), "positive control: a probe step without it is caught (L1)");

  // The step must ADD that environment to the one it inherits. A step that dropped
  // its `env` argument would leave the probe without PROBE_COMMIT exactly as before,
  // while the call above still read as wired. So the real helper is driven through a
  // spawn that records what it was given, rather than its spelling being matched
  // (L103): an equivalent rewrite must pass and a dropped env must not.
  {
    const seen: { cmd: string; args: string[]; env: Record<string, string | undefined> | undefined }[] = [];
    const step = makeStep({
      spawn: (cmd, args, opts) => {
        seen.push({ cmd, args, env: opts.env });
        return { status: 0 };
      },
      root: "/repo",
      baseEnv: { PATH: "/usr/bin", GITHUB_SHA: undefined },
      log: () => {},
    });
    step("post-deploy probe", "node", ["scripts/post-deploy-probe.ts"], { PROBE_COMMIT: "abcdef123456" });
    eq(seen[0]?.env?.PROBE_COMMIT, "abcdef123456", "the step hands the probe the commit it was given");
    eq(seen[0]?.env?.PATH, "/usr/bin", "on top of the environment this process already has");
    step("stamp the deploying commit", "node", ["scripts/stamp-build-info.ts"]);
    eq(seen[1]?.env?.PROBE_COMMIT, undefined, "and a step given nothing adds nothing");
    let threw = "";
    try {
      makeStep({ spawn: () => ({ status: 2 }), root: "/repo", baseEnv: {}, log: () => {} })("build and deploy", "pnpm", []);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert(threw.includes("build and deploy failed (exit 2)"), `a step that fails stops the command, naming itself and its exit (got: ${threw})`);
  }
  assert(/const step = makeStep\(/.test(script), "and the command runs its steps through that helper, not a copy of it");

  // And the probe must read that commit as the one it expects. It prefers
  // PROBE_COMMIT to GITHUB_SHA and normalises with the stamp's own function, so the
  // commit handed over has to survive that normalisation unchanged.
  for (const p of [plan, viaCi]) {
    if (p.ok) eq(normalizeCommit(p.probeEnv.PROBE_COMMIT), p.commit, `the probe's normaliser reads the handed commit as the stamped one (${p.commit})`);
  }
  const probe = readFileSync(join(import.meta.dirname, "post-deploy-probe.ts"), "utf8");
  const reads = /normalizeCommit\(process\.env\.PROBE_COMMIT \?\? process\.env\.GITHUB_SHA\)/;
  assert(reads.test(probe), "the probe reads PROBE_COMMIT before GITHUB_SHA, so a hand run's commit is the one it checks");
  const swapped = probe.replace(reads, "normalizeCommit(process.env.GITHUB_SHA ?? process.env.PROBE_COMMIT)");
  assert(swapped !== probe && !reads.test(swapped), "positive control: a probe preferring GITHUB_SHA is caught (L1)");
}

finish();

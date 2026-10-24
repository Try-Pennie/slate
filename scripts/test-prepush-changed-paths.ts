// #3898 (lesson L784): the pre-push hook's list of the files a branch changed is taken
// from the branch's MERGE BASE with main, never from the tip of anything upstream.
//
// The hook passes that list to two decisions: whether the workflow settings check runs
// (.githooks/lib/workflow-settings-guard.sh) and which files the security review
// reminder names as this change's (.githooks/lib/security-review-reminder.sh). It used
// to read `git diff --name-only @{push}..HEAD`, a two dot diff from the branch's last
// pushed tip. Once a pushed branch is rebased onto (or merges in) a main that has moved,
// that diff names every file main changed in between and the reminder blames them on
// this branch: a docs only change was told it touched src/app/api and wanted a security
// review.
//
// This builds that history with REAL git in a temp directory (an origin reached by path,
// no network, nothing written to the tree) and asks the hook's own helper. The first
// assertion is the control: the old expression must name main's file here, or this
// fixture is not the situation it claims to reproduce (L1).
//
// Run: node --experimental-strip-types scripts/test-prepush-changed-paths.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(repoRoot, ".githooks/lib/push-changed-paths.sh");
const HOOK = join(repoRoot, ".githooks/pre-push");

const root = mkdtempSync(join(tmpdir(), "slate-push-changed-paths-"));

// The machine's git config must not decide what this test sees, and the pre-push hook's
// GIT_DIR must not reach these calls (#848, scripts/test-git-env-isolation.ts).
const gitEnv = {
  ...scrubbedGitEnv(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function must(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`fixture: git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}
/** Commit `path` in one of the two clones under the temp root. */
function commitFile(clone: "work" | "other", path: string, body: string, message: string): void {
  const file = join(root, clone, path);
  mkdirSync(join(root, clone, dirname(path)), { recursive: true });
  writeFileSync(file, body);
  must(join(root, clone), ["add", path]);
  must(join(root, clone), ["commit", "-q", "-m", message]);
}
/** What the hook's helper prints in `cwd`, as a sorted list of lines. */
function helperPaths(cwd: string): { code: number; paths: string[] } {
  const r = spawnSync("bash", [HELPER], { cwd, env: gitEnv, encoding: "utf8" });
  const paths = (r.stdout ?? "").split("\n").filter(Boolean).sort();
  return { code: r.status ?? -1, paths };
}

const MAIN_FILE = "src/app/api/main-change.ts";
const BRANCH_FILE = "docs/branch-change.md";

try {
  // --- origin and a working clone with one commit on main -------------------------
  const origin = join(root, "origin.git");
  must(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const work = join(root, "work");
  must(root, ["clone", "-q", origin, work]);
  must(work, ["checkout", "-q", "-b", "main"]);
  commitFile("work", "README.md", "base\n", "base");
  must(work, ["push", "-q", "origin", "main"]);

  // A second clone stands for everybody else merging to main.
  const other = join(root, "other");
  must(root, ["clone", "-q", origin, other]);

  // --- a branch, pushed once ------------------------------------------------------
  must(work, ["checkout", "-q", "-b", "feature", "origin/main"]);
  commitFile("work", BRANCH_FILE, "a docs change\n", "branch change");

  {
    // Never pushed: the helper names the branch's own file and nothing else.
    const r = helperPaths(work);
    eq(r.code, 0, "the helper exits 0 on a branch that was never pushed");
    eq(r.paths, [BRANCH_FILE], "a never pushed branch: the helper names only the branch's own file");
  }

  must(work, ["push", "-q", "-u", "origin", "feature"]);

  // --- main moves, touching a file the security reminder watches -------------------
  commitFile("other", MAIN_FILE, "export const x = 1;\n", "main change");
  must(other, ["push", "-q", "origin", "main"]);
  must(work, ["fetch", "-q", "origin"]);

  // --- the branch is rebased onto the new main, as it would be to clear a conflict ---
  must(work, ["rebase", "-q", "origin/main"]);

  {
    // The control (L1): the expression the hook used to run names main's file as this
    // branch's. If it did not, this fixture would prove nothing about the fix.
    const old = must(work, ["diff", "--name-only", "@{push}..HEAD"]).split("\n").filter(Boolean).sort();
    assert(
      old.includes(MAIN_FILE),
      `control: the old two dot diff from @{push} names main's ${MAIN_FILE} after a rebase (got ${JSON.stringify(old)})`,
    );
  }
  {
    const r = helperPaths(work);
    eq(r.code, 0, "the helper exits 0 on a rebased branch");
    eq(r.paths, [BRANCH_FILE], "a rebased branch: the helper names only the branch's own file, never main's");
  }

  // --- the same branch merging main in instead of rebasing --------------------------
  must(work, ["checkout", "-q", "-b", "feature-merge", "feature@{1}"]);
  commitFile("other", "src/lib/auth/other-change.ts", "export const y = 2;\n", "another main change");
  must(other, ["push", "-q", "origin", "main"]);
  must(work, ["fetch", "-q", "origin"]);
  must(work, ["merge", "-q", "--no-edit", "origin/main"]);
  {
    const r = helperPaths(work);
    eq(r.paths, [BRANCH_FILE], "a branch that merged main in: the helper names only the branch's own file");
  }

  // --- an unreadable base is UNKNOWN, never an empty list ---------------------------
  // An empty list would read as "this push touched nothing" and take the workflow
  // check's skip in silence (#1436); UNKNOWN makes the check run.
  must(work, ["update-ref", "-d", "refs/remotes/origin/main"]);
  {
    const r = helperPaths(work);
    eq(r.code, 0, "the helper exits 0 when origin/main cannot be read");
    eq(r.paths, ["UNKNOWN"], "no origin/main to find a merge base with: the helper says UNKNOWN");
  }

  // --- the hook reads its list from the helper, and no longer from @{push} ----------
  const hook = readFileSync(HOOK, "utf8");
  const code = hook
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert(!code.includes("@{push}"), "the pre-push hook no longer diffs from @{push}");
  assert(
    /changed_paths="\$\("\$root_dir\/\.githooks\/lib\/push-changed-paths\.sh"\)"/.test(code),
    "the pre-push hook takes changed_paths from .githooks/lib/push-changed-paths.sh",
  );
  const helperAt = code.indexOf("push-changed-paths.sh");
  const staleMainAt = code.indexOf("stale-main-guard.sh");
  assert(
    staleMainAt >= 0 && helperAt > staleMainAt,
    "the changed paths are read after the stale main guard has fetched origin/main, so the merge base is current",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

finish();

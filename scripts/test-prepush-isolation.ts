// Tests for .githooks/lib/isolate-pushed-tree.sh (#490).
//
// The pre-push hook used to run tsc/lint/test/cf:build against the WORKING TREE,
// so untracked/uncommitted files on disk could make the checks pass locally yet
// fail CI, which only ever sees the committed tree (this bit PR #489: a committed
// test imported an untracked source file (green locally, TS2307 in CI).
//
// The fix runs those checks inside an isolated `git worktree` of the exact commit
// being pushed. The load-bearing property this file locks: that isolated tree
// contains ONLY committed files. An untracked file, or a staged-but-uncommitted
// file, must NOT leak in, otherwise the whole gate is defeated again.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-prepush-isolation.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { assert, finish } from "./lib/harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const helper = resolve(repoRoot, ".githooks/lib/isolate-pushed-tree.sh");

// When git runs a hook (like pre-push, which is what invokes this test on a real
// push), it exports GIT_DIR and friends into the environment. An inherited
// GIT_DIR overrides `cwd`, so a `git commit` meant for the throwaway repo below
// would instead land in the REAL repo on the branch being pushed (#848: this
// leaked an "add tracked" commit onto seven branches at once). Every git and
// bash subprocess this test spawns must therefore run with those vars stripped
// (scrubbedGitEnv, scripts/lib/git-env.ts), so the throwaway repo is always
// fully self-contained.
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: scrubbedGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A throwaway source repo standing in for the pushed branch.
const parent = mkdtempSync(join(tmpdir(), "prepush-iso-"));
const srcRepo = join(parent, "src-repo");
mkdirSync(srcRepo);

// A sentinel repo standing in for the REAL repo the hook environment points at.
// We poison GIT_DIR/GIT_WORK_TREE to it for the duration of the test, exactly as
// the pre-push hook environment would, and assert nothing ever leaks into it.
const sentinel = join(parent, "sentinel.git");
spawnSync("git", ["init", "--bare", "-q", sentinel], { env: scrubbedGitEnv() });
const savedGitDir = process.env.GIT_DIR;
const savedGitWorkTree = process.env.GIT_WORK_TREE;
process.env.GIT_DIR = sentinel;
process.env.GIT_WORK_TREE = srcRepo;

try {
  git(srcRepo, "init", "-q");
  git(srcRepo, "config", "user.email", "t@example.com");
  git(srcRepo, "config", "user.name", "T");

  // Committed file that imports a sibling, mirroring the #489 shape.
  writeFileSync(join(srcRepo, "tracked.ts"), "import { x } from './helper';\nexport const y = x;\n");
  git(srcRepo, "add", "tracked.ts");
  git(srcRepo, "commit", "-qm", "add tracked");

  // The forgotten import: present on disk, never committed.
  writeFileSync(join(srcRepo, "helper.ts"), "export const x = 1;\n");
  // A staged-but-uncommitted file: the bad-amend / forgot-to-commit class.
  writeFileSync(join(srcRepo, "staged.ts"), "export const s = 2;\n");
  git(srcRepo, "add", "staged.ts");

  const dest = join(parent, "isolated");
  const head = git(srcRepo, "rev-parse", "HEAD");
  const r = spawnSync("bash", [helper, head, dest], { cwd: srcRepo, encoding: "utf8", env: scrubbedGitEnv() });
  assert(r.status === 0, `helper exits 0 (stderr: ${r.stderr})`);

  // The committed file is there...
  assert(existsSync(join(dest, "tracked.ts")), "committed file is present in the isolated tree");
  // ...but nothing that wasn't committed (the whole point of #490).
  assert(!existsSync(join(dest, "helper.ts")), "untracked file does NOT leak into the isolated tree (#489/#490)");
  assert(!existsSync(join(dest, "staged.ts")), "staged-but-uncommitted file does NOT leak into the isolated tree");

  // #848: nothing may have leaked into the inherited GIT_DIR. Without the env
  // scrub above, the throwaway repo's `git commit` would have landed in the
  // sentinel instead, and this count would be non-zero.
  const leaked = spawnSync(
    "git",
    ["--git-dir", sentinel, "rev-list", "--all", "--count"],
    { encoding: "utf8", env: scrubbedGitEnv() },
  ).stdout.trim();
  assert(leaked === "0", `no commit leaks into an inherited GIT_DIR (#848; sentinel commit count ${leaked})`);
} finally {
  // Restore the environment we poisoned, then drop the worktree and temp parent.
  if (savedGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = savedGitDir;
  if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = savedGitWorkTree;
  spawnSync("git", ["worktree", "remove", "--force", join(parent, "isolated")], { cwd: srcRepo, env: scrubbedGitEnv() });
  rmSync(parent, { recursive: true, force: true });
}

finish();

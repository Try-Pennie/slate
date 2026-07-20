// Guard (#853): no node test may spawn `git` while inheriting the pre-push
// hook's GIT_* env vars. A git subprocess that inherits GIT_DIR/GIT_WORK_TREE
// operates on the real repo the hook points at, not its own cwd: a write leaks
// a commit onto the branch being pushed (#848), and a read resolves against the
// wrong tree. The rule: any scripts/test-*.ts that spawns git must route its env
// through scrubbedGitEnv (scripts/lib/git-env.ts). This keeps that from eroding.
// Run: node --experimental-strip-types scripts/test-git-env-isolation.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unscrubbedGitSpawn } from "./lib/scan-git-spawns.ts";
import { assert, finish } from "./lib/harness.ts";

const SCRIPTS = import.meta.dirname;
const testFiles = readdirSync(SCRIPTS).filter((f) => /^test-.*\.ts$/.test(f));

for (const f of testFiles) {
  const reason = unscrubbedGitSpawn(f, readFileSync(join(SCRIPTS, f), "utf8"));
  assert(reason === null, reason ?? `${f} isolates any git subprocess`);
}

// Positive controls: the scanner must actually have teeth. A test that spawns
// git with NO scrub must be flagged; the same spawn made scrub-aware must not.
{
  const bad = `import { spawnSync } from "node:child_process";\nspawnSync("git", ["commit", "-m", "x"], { cwd });`;
  assert(
    unscrubbedGitSpawn("synthetic-bad.ts", bad) !== null,
    "positive control: a git spawn with no scrub is flagged",
  );
  const good = `import { scrubbedGitEnv } from "./lib/git-env.ts";\nspawnSync("git", ["commit"], { env: scrubbedGitEnv() });`;
  assert(
    unscrubbedGitSpawn("synthetic-good.ts", good) === null,
    "positive control: a scrub-aware git spawn passes",
  );
  // A test that never touches git is out of scope (must not be flagged).
  const noGit = `import { spawnSync } from "node:child_process";\nspawnSync("node", ["run.ts"]);`;
  assert(
    unscrubbedGitSpawn("synthetic-nogit.ts", noGit) === null,
    "positive control: a non-git spawn is not flagged",
  );
}

finish();

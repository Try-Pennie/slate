// Scan logic for the git-env isolation guard (#853), kept beside its test so it
// is unit-testable with positive controls.
//
// The hazard (#848): a node test that spawns `git` while inheriting the pre-push
// hook's GIT_DIR/GIT_WORK_TREE operates on the real repo, so a write leaks onto
// the pushed branch and a read resolves against the wrong tree. The rule this
// scanner enforces: any scripts/test-*.ts that spawns git must route its env
// through `scrubbedGitEnv` (scripts/lib/git-env.ts), directly or via a wrapper
// that does. The check is file-level (spawns git AND references scrubbedGitEnv),
// not per-call: a test that imports and uses the shared scrubber is trusted to
// use it for its git spawns, the same coarseness the other repo guards accept.

/** A git subprocess spawn: spawnSync("git", ...), execFileSync("git", ...), etc. */
const GIT_SPAWN_RE =
  /(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["']git["']/;

export function spawnsGit(source: string): boolean {
  return GIT_SPAWN_RE.test(source);
}

export function usesScrubbedGitEnv(source: string): boolean {
  return source.includes("scrubbedGitEnv");
}

/** A reason string if `source` spawns git without the scrub, else null. */
export function unscrubbedGitSpawn(name: string, source: string): string | null {
  if (spawnsGit(source) && !usesScrubbedGitEnv(source)) {
    return (
      `${name} spawns git but does not route its env through scrubbedGitEnv ` +
      `(scripts/lib/git-env.ts). Under the pre-push hook an inherited GIT_DIR ` +
      `would make it operate on the real repo, not its cwd (#848/#853).`
    );
  }
  return null;
}

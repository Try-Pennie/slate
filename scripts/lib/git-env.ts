// Shared git-subprocess isolation for the node test suite (#848/#853).
//
// When git runs a hook (pre-push is what runs `pnpm test` on a real push), it
// exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (and friends) into the
// environment. A git subprocess that inherits those vars operates on the REAL
// repo the hook points at, not its own cwd: a `git commit` in a throwaway repo
// lands on the branch being pushed (#848 leaked a commit onto seven branches at
// once), and even a read like `git check-ignore` resolves against the wrong
// tree. Every git subprocess a test spawns must therefore run with these
// stripped. `scripts/test-git-env-isolation.ts` enforces that any test spawning
// git routes its env through here.

export const GIT_HOOK_ENV_VARS = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
] as const;

/** A copy of `base` (defaults to the live env) with the hook's GIT_* vars removed. */
export function scrubbedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of GIT_HOOK_ENV_VARS) delete env[k];
  return env;
}

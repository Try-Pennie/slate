# The pre-push gate, the git workflow and parallel agents

How a change gets from a branch to main here: the branch rule, what the
pre-push hook runs and why in that order, the bundle record, and the playbook
for running several agents in worktrees at once.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## Git workflow: never reuse a merged PR branch

PRs here are reviewed and **merged within seconds**, then auto-deploy. So a
follow-up commit pushed to a branch whose PR already merged gets **stranded**:
it never reaches main. Always start new work on a **fresh branch off `origin/main`**
(`git checkout -b <name> origin/main`); to continue work after a PR merges,
branch fresh and cherry-pick. A `pre-push` hook (`.githooks/pre-push`, enabled by
the `prepare` script) blocks pushing onto an already-merged/closed PR branch;
override only when intentional with `ALLOW_MERGED_PUSH=1`. That local hook fails
open (no `gh`, no `hooksPath`, non-interactive contexts), so a server-side
backstop (`.github/workflows/merge-gap.yml`, #113) also fires on every push to a
non-main branch and fails the run when the branch has a merged/closed PR and no
open one. `ALLOW_MERGED_PUSH=1` bypasses only the local hook, not the backstop.

The same hook also runs CI's checks before every push: `tsc --noEmit`,
`pnpm lint`, `pnpm test` (the unit suite, which includes the copy/dash lint and
the migration invariants), and `pnpm cf:build` (the full Cloudflare/OpenNext
build, #412), so a CI-only failure (including a build-only break) is caught
locally instead of breaking main after merge. Skip it in a pinch with
`SKIP_PREPUSH_CHECKS=1`.

Once that build has finished, the hook also **weighs the client bundle** it left in
the isolated tree (#2571) against a record **committed in the repo**,
`.githooks/bundle-budget.txt` (#2676). Two rules: the pushed commit's record must
carry what that commit builds to, within 1 KB, or the push is refused and prints
`pnpm bundle:record <total>` to commit; and growth past 3% AND 10 KB over the
record at the **merge base** with main is refused unless `ACCEPT_BUNDLE_GROWTH=1`.
So the change that moves the bundle moves the record. The old record in
`~/.claude/state` moved only on an acceptance, so each change inside the margin
left it behind and the next one paid (it sat 11 KB behind main). Two PRs that both
move it conflict on that line: rebase and let the gate print the right number.
`SKIP_BUNDLE_BUDGET_CHECK=1` skips it, said out loud first. The global
`check-bundle-budget.sh` still prints "stale, nothing judged" here and is not the
budget. `scripts/test-prepush-bundle-budget.ts` pins the rule and the step.

**It takes about 40s, not the ~20s this file used to claim** (#1594). Measured end
to end on 2026-08-29: 60s before the overlap below, 40s after. There is no "warm
cache" number to quote, because the isolated worktree (#490) deliberately pays a
fresh install, a cold typecheck and a cold build on every push: that isolation is
the whole reason the gate sees what CI sees rather than what your working tree
happens to contain, and it stays. Budget 40s.

`tsc` runs first and alone, then the Cloudflare build runs CONCURRENTLY with lint
and the tests. The ordering is load bearing, not incidental: `next build`
generates `.next/types`, and `tsconfig.json` includes `.next/types/**/*.ts`, so a
build overlapping tsc has tsc reading a directory the build is writing (the same
coupling the hook's `rm -rf .next/types` exists for). Overlapping them would
reintroduce it as a gate that fails at random, and the response to a random
failure is to re-run rather than to look. Lint and the tests are safe alongside it
because neither reads what it writes: eslint ignores `**/.next/**` and
`**/.open-next/**`, and vitest collects only `src/**/*.test.{ts,tsx}`. Those
ignores are `**/`-prefixed on purpose and it is not cosmetic: root-anchored
versions matched only the repo's own build output and missed the identical
directories inside `.claude/worktrees/agent-*`, so eslint walked every abandoned
agent checkout. On 2026-08-29 to 31 that meant 14 worktrees, 18 GB, and a
`pnpm lint` that reported 734,754 problems and OOMed before finishing, i.e. a
gate leg that could not run. CI never saw it, because a fresh checkout has no
worktrees, so it stayed invisible to the pipeline while being fatal locally.
`scripts/test-eslint-ignores.ts` asks eslint itself whether each path is ignored
and carries a positive control, so a config that ignored everything cannot pass.
**Remove an agent worktree once its PR merges** (`git worktree remove`), or they
accumulate silently. The build's
output goes to a log and is printed in full only if it fails, so a failure still
reads as one thing at a time, and a check that fails while the build is still
running cancels it and says so. `scripts/test-prepush-overlap.ts` pins all of
that, including the `wait` on the build: an `&` with no `wait` would make the gate
pass while checking nothing.

## Parallel-agent dispatch playbook (worktree fan-out)

This repo is often worked in fan-out mode: dispatch several subagents at once,
each in its own git worktree (`isolation: "worktree"`, created under
`.claude/worktrees/`), one small issue per agent. The rules below get
re-derived by hand every time and one was missed once (a branch-contamination
scare in the first wave), so they live here now.

- **Pick disjoint issues.** Give each agent an issue whose files do **not**
  overlap another agent's. Overlapping edits collide at merge and undo the point
  of parallelism. If two issues touch the same file, run them in sequence, not in
  the same wave.
- **Each worktree starts with no `node_modules`.** A fresh worktree does not
  inherit the main checkout's install, so nothing (`tsc` / `lint` / `pnpm test` /
  `cf:build`, or the pre-push gate) can run until it has one. Seed it fast with
  **`bash scripts/seed-worktree-node-modules.sh`** (run from inside the worktree,
  #852): on APFS it clones the main checkout's `node_modules` copy-on-write in a
  few seconds instead of a multi-minute sandboxed `pnpm install`. It is idempotent
  (skips an already-seeded worktree) and refuses (non-zero, telling you to run
  `pnpm install`) when it can't seed safely, e.g. the branch changed `pnpm-lock.yaml`
  so the clone would be stale. Fall back to `pnpm install` (with the sandbox network
  override) only when the helper exits non-zero. A symlinked `node_modules` is NOT
  an option: Turbopack's `next build` rejects one (see `.githooks/pre-push`).
- **Verify each branch against its own merge-base, not `origin/main`.** Under a
  live fleet `origin/main` advances while the wave runs, so diffing a branch
  against current `origin/main` shows other agents' merged work as if it were
  this branch's. Diff against the branch's merge-base
  (`git diff $(git merge-base origin/main <branch>)..<branch>`) to see only what
  this agent actually changed.
- **A branch built on a stale `origin/main` is refused at push time** (#1612).
  The rule above was stated here for months and enforced by nothing, and on
  2026-08-29 it broke twice in one day: two branches were cut from a stale ref,
  carried another change's already-merged commits, and had to be thrown away and
  rebuilt (#1603 as #1606, #1605 as #1607); in the second case the branch tip
  even carried the other change's title. So `.githooks/lib/stale-main-guard.sh`
  now fetches `origin/main` on every push and refuses when `git cherry` reports
  the branch carrying commits already upstream, naming them. The match is by
  **patch id**, not by sha, because a squash, rebase or cherry pick gives a
  commit a new sha and a sha comparison would miss exactly this case. It fails
  OPEN with no network and says so rather than skipping in silence, and it can
  see a single-commit squash merge but not a multi-commit one (whose combined
  patch matches none of the originals). Override a deliberate case, once, with
  `ALLOW_STALE_MAIN=1 git push ...`, and say why out loud;
  `scripts/test-stale-main-guard.ts` drives the decision without a remote.
- **Never trust an agent's self-reported "clean."** A subagent will report a
  branch green that never had `node_modules` and so never ran the gate. Confirm
  each branch yourself (gate ran, diff is scoped, tests pass) before merging.

Refs: `.githooks/pre-push`, `scripts/seed-worktree-node-modules.sh` (#852, pre-seed
node_modules), #853 (audit tests for real git/fs writes under the hook).

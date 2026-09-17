<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Git workflow: never reuse a merged PR branch

PRs here are reviewed and **merged within seconds**, then auto-deploy. So a
follow-up commit pushed to a branch whose PR already merged gets **stranded** —
it never reaches main. Always start new work on a **fresh branch off `origin/main`**
(`git checkout -b <name> origin/main`); to continue work after a PR merges,
branch fresh and cherry-pick. A `pre-push` hook (`.githooks/pre-push`, enabled by
the `prepare` script) blocks pushing onto an already-merged/closed PR branch;
override only when intentional with `ALLOW_MERGED_PUSH=1`. That local hook fails
open (no `gh`, no `hooksPath`, non-interactive contexts), so a server-side
backstop (`.github/workflows/merge-gap.yml`, #113) also fires on every push to a
non-main branch and fails the run when the branch has a merged/closed PR and no
open one. `ALLOW_MERGED_PUSH=1` bypasses only the local hook, not the backstop.

The same hook also runs CI's checks before every push — `tsc --noEmit`,
`pnpm lint`, `pnpm test` (the unit suite, which includes the copy/dash lint and
the migration invariants), and `pnpm cf:build` (the full Cloudflare/OpenNext
build, #412) — so a CI-only failure (including a build-only break) is caught
locally instead of breaking main after merge. Skip it in a pinch with
`SKIP_PREPUSH_CHECKS=1`.

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

# `pnpm cf:build` refuses a bundle carrying your `.env` files (#2335)

The Cloudflare adapter reads every `.env*` file in the build tree and writes their
VALUES into `.open-next/cloudflare/next-env.mjs`, which ships inside the Worker
bundle; at runtime the wrapper fills in every name the Worker's own bindings did
not set. So a build run in a checkout holding `.env.local` deploys those
credentials, to whatever environment it is deployed to. On 2026-09-14 that put
production's Slack token on the load test Worker and paged the real alerts channel
for six minutes about a roster that did not exist.

`cf:build` now runs `scripts/check-bundle-env.ts` after the build and fails on any
name in that file that is not `NEXT_PUBLIC_*`, naming the offenders and the `.env`
file they came from, never their values. It is wired to the BUILD because wrangler
has no predeploy hook, so this is the last place one check stands in front of every
deploy. CI and the pre-push gate build from the committed tree, which holds no
`.env*` at all, so both are unaffected; **a build in your own checkout is the case
this fails**, and that is the case it exists for. `ALLOW_ENV_IN_BUNDLE=1` gets one
local build through and says loudly that the result must not be deployed.

It asks a SECOND question in the same step: whether the CLIENT chunks NAME any
deployment setting. That is not the same fault (a name is not a credential; what
leaks is the inventory of what Slate integrates with) and only a real build can
answer it, since the names are in the source either way and nothing but the build
says which bundle a module landed in. It exists because the first version of the
#2335 runtime refusal put the whole list into `publicSupabaseUrl()`, and all
twenty three names shipped in a public chunk.

The decisions are in `scripts/lib/scan-bundle-env.ts`, driven by fixtures in
`scripts/test-bundle-env-guard.ts` (which deliberately does not read the real
`.open-next`: the gate runs the suite alongside the build that writes it, L461).
The load run's own three layers are in `scripts/loadtest/RUNBOOK.md`.

# Main is guarded by detection, not prevention (free-plan constraint)

Native GitHub branch protection (require a PR, require passing checks before a
push reaches main) needs a **paid org plan**; Try-Pennie is on the free plan, so
nothing server-side *prevents* a direct push to main or the merge of a red PR.
The compensating control is **detective**: `.github/workflows/main-push-guard.yml`
(#1027) fires on every push to main, resolves whether the commit came from a
merged PR whose CI passed (`scripts/check-main-push.ts` +
`scripts/lib/main-push-guard.ts`), and on a violation **fails the run and posts a
Slack alert** so a human can revert. Because it runs *after* the push (and the
deploy), it is a safety net, not prevention: that is the accepted residual risk
until the org upgrades. A **deliberate** direct push (an admin hotfix) must carry
`[allow-direct-push]` in its commit message to stay silent; otherwise it pages.

# Parallel-agent dispatch playbook (worktree fan-out)

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

# Applying a database migration

Deploys do **not** apply Supabase migrations. Every schema change is a deliberate
`supabase db push` **before** the matching PR merges (the CI `migration-drift` job
and the `deploy` job both fail while a committed migration is unapplied, and the
prod monitor pages if code ships ahead of its schema). Bump
`SHIPPED_MIGRATION_VERSION` in the same commit, and never apply through the Supabase
MCP tool (it records a timestamp version that silently disables the lag monitor).
The full step by step is **`docs/migrations-runbook.md`**; follow it rather than
reasoning the order out per PR.

Writing a **function** in a migration has one non-obvious rule: every Slate
function pins its `search_path`, and a pinned path cannot reach an **extension**
schema, so an unqualified pgcrypto / uuid-ossp / vault call is unreachable and
errors on every call at runtime only (#1125: `digest()` under
`search_path = public`). Use a `pg_catalog` built-in (`sha256`, `gen_random_uuid`),
or schema-qualify (`extensions.digest`), or widen the pin.
`scripts/test-definer-search-path.ts` enforces it, with a
`-- search-path-ok: <reason>` escape hatch; the reasoning is in the runbook's
"Writing a function with a pinned search_path" section (#1126).

A **SECURITY DEFINER** function has a second rule, and the naive form of it does
not work. Such a function bypasses RLS, and TWO grants hand it to a client side
role: Postgres's own EXECUTE to PUBLIC on every new function, and 0121's default
privileges, which grant EXECUTE **directly** to `anon` and `authenticated` at
creation time. `revoke ... from public` does not remove a direct grant (L541), so
the PUBLIC only revoke that reads like the fix leaves the function callable
through `/rest/v1/rpc/<function>` with the publishable key that ships in the
client bundle. Write the form all seventeen existing sites use,
`revoke execute on function f(args) from public, anon, authenticated;`, in the
SAME migration. `scripts/test-migration-grants.ts` enforces it (the scan is
`scanDefinerExecuteGrants` in `scripts/lib/scan-migration-grants.ts`), with an
`-- anon-execute-ok: <reason>` escape hatch that is refused when it carries no
reason; the runbook's "Writing a SECURITY DEFINER function" section has the why
(#2391).

# Three ways a Google calendar can fail, not two

A failed calendar read is classified `gone`, `not-provisioned`, or `transient`
(`src/lib/google/reachability-classify.ts`), and the distinction decides what a
message tells the reader to DO:

- **gone** (a 4xx: account removed from the Workspace, delegation revoked, calendar
  not found) is a credential or membership repair: re-auth, or take them out of the
  pool.
- **not-provisioned** (`403 notACalendarUser`, #1396) is an account that has never
  been given Calendar at all. Retrying can never fix it and nothing is wrong with
  the credentials; a Workspace admin has to give the person Calendar. At least one
  real agent is in this state, and new hires reaching Slate before their Google
  provisioning completes make it the expected direction of travel.
- **transient** (5xx, timeout, rate limit) usually self-heals.

**Never branch on `kind === "gone"`.** Use `isDefinitiveFailure`
(`src/lib/google/sync-health.ts`, kept there so the every-minute sync coalescer can
reach it without pulling a Google dependency behind it). A literal comparison
treats `not-provisioned` as transient, which fails OPEN: the rotation retries a
hopeless account every minute on a shared budget, and the activation gate refuses
it with "retry shortly", advice that can never work. A null kind is definitive too,
matching #916, so an unclassified streak never goes quiet.

Adding a fourth kind means giving it its own label AND its own instruction;
`scripts/test-google-not-provisioned.ts` drives that off the list of kinds and
fails when two share either.

# The monitor lane's shared setup reads

Every check on the monitor lane runs inside its own boundary (`steps.run`, #1281),
and since #1395 so does every SHARED READ at the top of the handler: the bucket
list, the cached slot rows, the org's business hours, the agents' working hours,
and the booking horizon. A throw in one of those used to end the tick before a
single check ran, taking out the availability probe and the cal.com override
sweep, neither of which needs most of them.

The part that matters is the FALLBACK. Each contained read resolves to **null**,
never to an empty or default value, because a default would let a check answer
confidently instead of skipping: zero buckets makes the whole ladder look like a
dead end, an empty week does the same (#1296), no working-hours rules makes every
agent look off shift, and a guessed horizon has the scan compare a probe against a
row computed over a different window and call the difference drift (#216).

Which check depends on which read lives in ONE pure place,
`src/lib/monitor/setup-gates.ts` (`monitorSetupGates`), node-tested with each read
turned off one at a time and asserting both directions. Two guards keep it honest,
both in `scripts/test-monitor-step-coverage.ts`: a handler-level `const x = await`
outside `steps.run` fails the build (so a sixth read is covered by construction),
and each gated check must consult its gate rather than a hand-rolled condition.

## Containment REPORTS now, it does not only log (#2382)

Containment removed a signal and did not replace one. A step that threw was caught,
named in the cycle log line, and the lane stamped its heartbeat anyway, so a check
that failed on every tick for a month went unreported: Cloudflare logs have no
alerting on top of them and nothing in `src/lib` read `steps_failed`. Before #1281
the same throw killed the tick, the heartbeat lapsed, and the watchdog paged one
`monitor` bound later.

`judgeMonitorSteps` (`src/lib/monitor/step-failure.ts`) keeps a per step
consecutive-failure streak off `steps.outcomes()` and pages on
`monitor_step_failing:<step>` after `MONITOR_STEP_FAILING_TICKS`. That number is
DERIVED from `LANE_STALE_BOUNDS_MS.monitor`, four ticks at today's values, so the
replacement is never slower than the lapsed heartbeat it replaces. The all clear
takes the same streak the other way (L160), and a step the tick never RAN moves
neither: "we did not see it fail" is not a measured healthy result. A failing
`setup_*` read also names the checks it took down, asked of `monitorSetupGates`
rather than listed again.

**The judgement is deliberately NOT a `steps.run` step**, which is why it carries a
named exemption in `scripts/test-monitor-step-coverage.ts`: containing the reporter
behind the fault it reports is the same defect one level up. It runs BEFORE
`recordHeartbeat("monitor")`, so a fault nobody predicted inside it lapses the stamp
and pages, exactly as an uncontained throw did.

**`lane_watchdog` is the widest case**, since the dead man's switch for every other
lane is itself one of these steps. `alertOnStaleLanes` returns
`{ judged, stale }` rather than a bare list (an empty list is what a healthy fleet
returns AND what a failed heartbeat read returned, L215), and the monitor lane
stamps `verdict:lane-watchdog` only on `judged: true`, so a watchdog that threw or
could not read goes stale like any other detector that has stopped concluding.

# A workflow reference to a repo setting that does not exist

GitHub does NOT fail when a workflow references `${{ vars.X }}` or
`${{ secrets.X }}` for a setting nobody created: it interpolates the **empty
string**, so the step runs misconfigured while the file reads as fully
configured. On 2026-08-14 that took the production canary down eleven minutes
after the merge that introduced it (#1495 wired `SLATE_BASE_URL` to a variable
that did not exist, and the smoke run died on
`Failed to parse URL from /api/availability?bucket=SMOKE`).

Both halves of the wiring are guarded, and each is blind where the other looks:

- **the consuming half** (#1498): a wired env name may not be read with a
  non-empty `??` fallback, because `??` catches only null and undefined and the
  default it promises never applies to `""`. Enforced offline by
  `scripts/test-workflow-env-coverage.ts`.
- **the referenced half** (#1500): `pnpm check:workflow-settings` compares every
  `vars.`/`secrets.` reference in `.github/workflows/` against the settings that
  actually exist, and names the ones that do not with the `gh` command to create
  them. `GITHUB_TOKEN` is exempt (GitHub mints it per run).

**It runs in the pre-push hook, not in CI, and that is a token limitation rather
than a preference.** Listing repo variables or secret names needs a token with
Actions variables/secrets read access; the default `GITHUB_TOKEN` does not have
it and it cannot be granted through the `permissions:` key, so a CI job would
need a PAT secret. The hook fails OPEN without `gh`, like the merge-gap guard
above it, and SAYS so rather than skipping in silence, and it only runs when the
push touches a workflow. Skip a false positive with
`SKIP_WORKFLOW_SETTINGS_CHECK=1`. The decision lives in
`.githooks/lib/workflow-settings-guard.sh` so it can be driven by
`scripts/test-workflow-settings-guard.ts` without a remote.

The decision logic (what counts as a reference, what is built in, what counts as
missing) is pinned offline in `scripts/test-workflow-env-coverage.ts`, so the
rule is tested even where the listing is not available.

## A setting that is PROVISIONED PER RUN (#2293)

The rule above is right about the fault it was built for and wrong about a
workflow whose settings are created for one run and destroyed with it.
`loadtest.yml` (#2244) points at a throwaway Supabase branch and a Worker its own
teardown job deletes, so between runs its seven `LOADTEST_*` settings genuinely do
not exist, and the check refused every push that touched ANY workflow. The
documented way through was `SKIP_WORKFLOW_SETTINGS_CHECK=1`, which is a guard
whose routine remedy is to override it (L36), and which waves a REAL missing
setting on another workflow through in the same breath. It blocked work twice in
one session.

So a workflow DECLARES, in its own file, which of its settings are of that kind:

```yaml
# settings-provisioned-per-run: LOADTEST_BASE_URL, LOADTEST_WORKER_NAME,
#   LOADTEST_BOOKING_API_KEY
#   because each one is created by whoever dispatches a run, against a throwaway
#   Supabase branch and a Worker deployment the teardown job deletes, so between
#   runs their absence is the normal state rather than a misconfiguration.
```

Four things keep that from being the guard switched off, and each was the obvious
cheaper option:

- **The names are EXACT and listed one by one** (L129). A `LOADTEST_*` wildcard
  would exempt a TYPO in a reference, which is the fault being guarded.
- **The reason is what is CHECKED**, not the presence of the marker. It is
  introduced by `because` and must begin with a word and run to at least three of
  them, so the surrounding syntax cannot satisfy it (L675). It is written as the
  reason for exempting rather than as the case, so it keeps covering the next
  workflow of that kind (L362). A declaration with no reason fails the run.
- **It covers only the DECLARING file.** "Provisioned per run" is a fact about one
  workflow's dispatcher, so a second workflow reading the same setting on a
  schedule is still a finding, named against that file.
- **Only a workflow that runs ONLY on `workflow_dispatch` may declare.** The
  settings are created by hand before a run, so a schedule or a push would fire on
  empty strings with nothing to say about it, which is the #1495 failure itself. An
  `on:` block the scan cannot read refuses rather than reading as dispatch only.
- **A declaration naming a setting the file does not reference fails**, so a stale
  entry cannot sit there reading as a considered decision (L346).

An absent one is **REPORTED**, never silently passed: the checker prints a
`note:` line naming every setting it did not judge and the reason, and the
pre-push hook echoes any output carrying one, so the narrowing is visible at the
push rather than only to whoever runs the command by hand (L98). One that EXISTS
is judged exactly like any other reference, so this is permission for absence and
not an exclusion from the check. The summary line says how many of how many were
judged, so "no differences" can never be read off a run that compared nothing.

`WORKFLOW_SETTINGS_DIR` points the checker at a fixture tree, which is how the
grammar is driven end to end by `scripts/test-workflow-settings-checker.ts`
without committing a broken workflow to prove the guard catches it. A directory
holding no workflow still refuses.

This does NOT change the token limitation above: listing variables and secrets
still needs a PAT, so the check still runs in the hook rather than in CI. It does
remove the blocker under #2264, which proposes running it in CI: as things stood
that job would have failed on every load test change.

# An alerting workflow carries no dependency install (#1524, #1598)

Three workflows run a script on **bare node**, with no `pnpm install` and no
`--import ./scripts/register-paths.mjs`: the main push guard (#1027), the deploy
failure alert (#122) and the smoke canary's alert step (#525). Each of them is the
thing that has to still work when something else has already gone wrong, and every
dependency it carries is another way for it to be unavailable in exactly those
conditions. That is not hypothetical: on 2026-08-17 run 32039856279 died at
`Failed to download action 'pnpm/action-setup'` with a 429 and the only control over
main never ran.

So an alerter posts through **`scripts/lib/slack-post.ts`**, which imports nothing,
rather than the app's notifier (`postSlack` reaches `defaultAlertsChannel`, which
reaches `supabaseAdmin`, which reaches `@supabase/supabase-js`). The channel comes
from `SLACK_ALERTS_CHANNEL` and an empty one is refused by name, since the database
lookup that would supply a default is the very thing being avoided. The WORDING is
still built in one place per alert, so no copy is duplicated (L41): only the HTTP
call is local.

**The invariant is about the script's imports, not about the workflow file.** A check
that the workflow no longer says `pnpm install` passes happily while the script still
imports the app, which is a check on a proxy for the quantity being protected (L63).
`scripts/test-dependency-free-scripts.ts` therefore walks the real transitive import
graph (`scripts/lib/scan-local-import-graph.ts`) from every entry a workflow runs on
bare node, and fails on any edge that leaves `scripts/`: a package, a `@/` alias, a
file outside the tree, or a relative specifier that resolves to nothing. The entry
list is DERIVED from the workflows (`scripts/lib/scan-workflow-node-scripts.ts`), so
a newly added bare node script is covered by construction rather than exempt from the
guard meant to catch it (L96), and the three alerters are ALSO declared by name, so a
workflow that quietly put the alias hook back fails rather than removing its own
script from the guard's reach.

Its positive controls are what keep it from rotting into a no-op: synthetic fixtures
for each way an edge can leave the local set, plus an overlay of the REAL tree that
puts `@/lib/notify/slack` back into each alerter and a package import into the shared
poster one module deeper, both of which must be caught and blamed on the right file.
The overlay replaces a file's content in memory, so nothing is written to the repo. It
also runs the deploy alerter on bare node with Slack deliberately unconfigured and
requires it to reach its own refusal, which node can only report once every import
resolved.

# The scripts tree is typechecked, but only for what breaks at runtime

`tsconfig.json` excludes `scripts` and `worker`, so `pnpm build` and
`npx tsc --noEmit` never look at the ~280 node test suites or at the canary
scripts that run against live prod every 30 minutes. That cost two things: an
undefined `failureLogPath` shipped in `scripts/smoke-booking-api.ts` and tsc
reported clean, and an undefined `calls` inside a test fake threw before the
fake recorded anything, so the guard for "a block-lookup read error aborts with
ZERO inserts" passed on its own typo and would have stayed green through a
regression into mass-inserting busy blocks (#1504, #1505).

The tree carries roughly 100 errors, almost all nullable and shape mismatches in
test fakes, so it is **not** demanded to be clean. `tsconfig.scripts.json` plus
`scripts/test-scripts-typecheck.ts` (in `pnpm test`, so in the pre-push gate and
CI) run tsc over `scripts/` and fail on the two classes that ship broken:

- `TS2304`, an undefined name, which throws the moment the line executes;
- `TS2307`, an unresolved import, which throws on load.

The list lives in `scripts/lib/scan-scripts-typecheck.ts` (`BREAKING_CODES`).
Widen it by fixing a class and adding its code, which is a deliberate act rather
than a silent no-op. The guard plants a real undefined identifier in the tree and
requires itself to catch it, because a tsc run that never looked at `scripts/`
and a clean tree produce the same empty error list (L1, L98).

**The escape hatch** is `// typecheck-ok: <why>` on, or in the `//` block
directly above, the line, and it must carry a reason. The one use today is the
`?bust=1` cache-busting dynamic import in `test-alert-preview-coverage.ts`, which
no resolver can follow and which is the entire point of that check.

`worker/` is covered too now (#1050), and it is the file that most needed it:
`worker/index.ts` is what `wrangler.jsonc` points `main` at, so every request and
every cron tick passes through it, and esbuild bundles it without checking types.
`tsconfig.worker.json` uses `@cloudflare/workers-types` (scoped to that config, so
the Workers globals never enter the app's program) and
`scripts/test-worker-typecheck.ts` runs it, failing on the same two classes and
planting an undefined identifier to prove the run actually read the tree.

`TS2578` (an unused `@ts-expect-error`) is deliberately out of scope there. The entry
imports `../.open-next/worker.js`, which does not exist until
`opennextjs-cloudflare build` has run; the import carries an `@ts-expect-error`, so
it is silent either way, but the DIRECTIVE flips between used and unused depending on
whether somebody has built recently. A check whose verdict depends on that would pass
locally and fail in CI, and the response to a check that disagrees with itself is to
stop reading it.

# Where a new test goes

Slate runs two test harnesses on purpose. They are not interchangeable, and the
boundary is by **capability, not by subject**: the same domain can legitimately
have tests in both.

**Vitest** (`src/**/*.test.ts`, `src/**/*.test.tsx`, run by `pnpm test:components`)
is for code that imports through the `@/` alias and needs **module mocking**
(`vi.mock`): React components, route handlers, and lib code whose collaborators
are mocked rather than injected.

**Node scripts** (`scripts/test-*.ts`, run by `pnpm test`) are for **pure logic**
reached through hand written fakes with no module mocking, and for
**repo invariant guards**: migration hygiene, deploy env coverage, the copy and
dash lint, and the vitest environment rule below. Each file is its own process
that exits 0 or 1. Shared fakes live beside them (`scripts/lib/`), never inside a
`test-*.ts` file, because the runner globs that pattern as a suite.

If you are unsure: reach for `vi.mock` and it belongs in vitest; otherwise write
it as a node script, which is cheaper and starts faster.

## jsdom is opt in

The vitest default environment is **`node`**. jsdom costs roughly a second per
file and only the component tests need a DOM, so a file that needs one declares
it on the first line:

```ts
// @vitest-environment jsdom
```

Every `*.test.tsx` must declare it. A plain `*.test.ts` may only declare it if it
is on the exception list in `scripts/test-vitest-environment.ts`, which currently
holds one entry (`widget-embed.test.ts`, which drives the real `widget.js` in a
browser environment). That guard fails the build if the boundary erodes again.
Making jsdom opt in cut the vitest suite from about 8.2s to about 4.3s (#608).

# What CI covers, and the deliberate no-browser-layer decision

CI green here means **unit logic + a full production build**, not a browser or
end to end pass. The pyramid is intentionally bottom heavy: ~120 node script
suites (`pnpm test`) plus the vitest suites (`pnpm test:components`, glue and a
handful of component tests) all run in the pre-push gate and in CI, and
`pnpm cf:build` proves the Worker actually builds. There is **no Playwright config
in the repo** and **no automated browser test in CI**, on purpose (#611, audit
AUD-037). Visual and DOM checks are done with the Playwright MCP against a running
dev server during development, not wired into CI.

**Why not CI Playwright (yet):** `next dev` screenshots are unstable to automate
(the `.pn-*` entrance/pulse keyframes never settle and font loading stalls a
full page shot, see the screenshotting section below), so a headless browser job
would be flaky for the payoff. The risky mock seams that a browser layer would
guard, the Supabase query chains and the Google Calendar shapes, and the embed
(`widget.js`) contract and full booking funnel, are covered a different way:

**There IS one browser check, and it is post deploy rather than pre merge (#1006).**
The canary's 6-hourly full pass drives the DEPLOYED `widget.js` in headless
chromium against live prod (`scripts/smoke-embed-render.ts`) and asserts the
embedded booker actually draws. None of the instability above applies: it never
touches `next dev`, and it waits on the booker's own heading rather than on a
settled animation. It deliberately does NOT demand that slots are offered, because
before cutover the roster is dark (#1272) and a check that demanded times would be
red every run from the day it shipped; it asserts the booker SAYS SOMETHING, since
a working embed either offers times or states in its own words why it has none.
The verdict rules live in `scripts/lib/embed-render-check.ts` and are pinned
offline by `scripts/test-embed-render-check.ts`, so they are tested where no
browser exists. Full pass only, because this is a private repo and Actions minutes
are billed: a browser on every 30 minute tick is about 48 runs a day against 4 for
a fault that arrives with a deploy rather than drifting in.

The rest:

- **The scheduled production canary** (`.github/workflows/smoke-canary.yml`, the
  #455 / #483 / #525 cluster) runs the real smoke scripts against **live prod** on
  the isolated SMOKE test agents and buckets (#396, so they can never touch a real
  agent): a side effect free dry run health tick every 30 min, and every 6h a full
  `SMOKE_STRICT` pass plus the reschedule smoke, which is the only automated proof
  that a booking can be made, rescheduled, and cancelled end to end. Any failure
  posts a Slack alert.
- **A dead man's switch**: each pass stamps a heartbeat, and the lane watchdog
  pages if the schedule silently stops firing (GitHub drops scheduled runs under
  load), with a separate `smoke-canary-full` heartbeat so a dropped 6h run also
  goes stale and pages (#982). The Worker monitor lane refires the workflow via
  the GitHub API when the heartbeat goes stale (`src/lib/monitor/canary-trigger.ts`).

So the safety net for the funnel lives **post deploy** (canary + alert), not
pre merge (browser CI). If you are tempted to add a Playwright CI job, read this
section and #611 first: the decision is deliberate, and the compensating canary is
the thing to keep healthy instead.

# A detector the roster cannot exercise (`pnpm verify:availability-truth`)

The availability-truth probe (#1315) asks whether the times Slate is OFFERING are
really free on the live calendars. It is built to fail safe: a calendar it cannot
read is scored `unverified` and it stays silent, because scoring Google's own
errors as drift would page about our cache every time Google had a bad minute.

That correct choice has a cost. **A probe whose calendar reads never succeed is
indistinguishable from a probe finding nothing wrong**, and production confirmed
the sharper version of that on 2026-08-11 (#1377): every tick since deploy
skipped with `why="bucket is offering no times to check"`, because 2 of 126 users
are bookable while the roster is dark before cutover (#1272), and the rotation
excludes the two test buckets that do have slots. The live half had never
executed once.

So the probe cannot prove itself from production traffic, and mocks cannot either
(L52: a fake agrees with our assumption about Google's interface by
construction). **`pnpm verify:availability-truth` is the proof.** It reads one
agent's calendar live and, from GOOGLE'S OWN ANSWER rather than from
`busy_blocks` (which is written by the very reads under test, L58), builds two
windows: one Google reports as occupied, one it reports as clear. It then asks
the probe's own `verifySlotLive` about each. Busy must come back `drift`, free
must come back `free`. **Both directions, or it proves nothing**: a one-sided
control is satisfied by a probe hard-wired to a single answer (L1).

It writes nothing and is deliberately NOT named `test-*.ts`, because that glob is
the offline unit suite and this one needs live Google plus the Supabase secret
key from `.env.local` / `.dev.vars`. Point it at an agent who has real meetings:

```
TRUTH_CONTROL_EMAIL=someagent@trypennie.com pnpm verify:availability-truth
```

Every way it can fail to build a control (an empty calendar, a calendar busy for
the whole horizon, an unreadable bound, a refused calendar) exits **non-zero**
with the reason. Finding nothing to check is never a pass (L98). Its decision
logic is pinned offline by `scripts/test-availability-truth-live-control.ts`.

**Re-run it before arming the probe (#1371), and after any change to the Google
read path or the delegated identity.** As of 2026-08-11 it passes against real
agents (37 and 38 live busy periods read, both directions correct), so
domain-wide delegation and cross-agent free/busy are confirmed working.

## The general case: a detector that has never once concluded (#1394)

That blindness is not specific to the truth probe. Any fail safe detector, one
that reports `unverified` / `skipped` / `insufficient` rather than guessing, can
sit permanently blind while looking healthy, because "nothing to report" and
"could not check anything" render the same in a dashboard and identically in
silence. The lane heartbeats cannot see it: they prove a lane RAN, and this lane
ran faithfully every five minutes for weeks.

So three detectors now carry a SECOND stamp, written only when they reach a
MEASURED verdict: `verdict:availability-truth`, `verdict:booking-failure-rate`
and `verdict:low-booking-volume`, in the same `lane_heartbeats` table the lane
watchdog already reads once per tick (so watching them costs no extra query on
the budget four cron lanes share). Which outcomes count is decided in one place,
`src/lib/monitor/verdict-freshness.ts`, and nothing else may stamp: `checked`
alone is not enough, because a sample too small to judge also reports `checked`.

They are judged by `VERDICT_STALE_BOUNDS_MS` with `neverIsStale` ON, because
"has never once reached a verdict" is the exact state the family exists to
notice. Bounds are set by each detector's longest LEGITIMATE silence: 24h for the
truth probe (about five passes of the bucket rotation), 4 days for the two
traffic fed checks (which are properly silent from Friday evening to Monday
morning). A blind detector re-pages daily rather than hourly, since before
cutover it can legitimately stay blind for days.

# Proving the burst counter answers (`pnpm verify:burst-counter`)

The same shape as the truth probe above, on the burst ceiling (#1564).

The monitor lane reports the burst counter missing from a deployment (#1558) by
resolving the `BURST_LIMITER` namespace as a **property read**, and it stops
there deliberately: asking the object whether it ANSWERS would create it, spend a
subrequest out of the invocation four cron lanes share, and give it an alarm to
clean up on every tick forever. The cost of that correct choice is that a counter
which is **bound but unreachable reads as fine**, and stays that way until one
caller crosses the escalation threshold, which before cutover could be months
away. Injected fakes cannot close it either: a fake agrees with our assumption
about the Durable Object by construction (L52).

**`pnpm verify:burst-counter` is the proof.** It reports a FIXED monitor key to
the real `BURST_LIMITER` object, reads the count back, reports it again, and
requires the count to have **RISEN inside one window**. Both halves, or it proves
nothing (L1): a counter hard wired to a single answer, or one that replies
without counting, satisfies a check that only asks whether it replied. It judges
on the COUNT and never on a substring of the output, because every failure the
deployment can report quotes the same binding name the success case does (L156).

It writes one count, against a key no real caller's `burstKey` can produce (the
argument for why lives in `src/lib/monitor/burst-counter-probe.ts`, and
`scripts/test-burst-counter-live-control.ts` walks the shipped `EDGE_LIMITERS`
table so a limiter that ever adopted that key space fails the build). The object
its own alarm deletes two windows after the last report.

A Durable Object is reachable only through a binding inside the Worker, so the
command's one step into the deployment is `POST /api/smoke/burst-counter`, a
key-authed endpoint on the same Bearer key as `/api/smoke/version` and
`/api/smoke/heartbeat`. The key it reports is a **constant in that route and is
never taken from the request**: a caller who could name the key could report
requests against a real lead's count and push them toward a ceiling.

```
BOOKING_API_KEY=<the key the deployment holds> pnpm verify:burst-counter
```

`SLATE_BASE_URL` picks the deployment (default prod). Finding nothing to check is
never a pass (L98): every way of learning nothing exits non-zero on **its own
code**, so a shell caller can branch on which one it met.

| exit | what it met | what to do |
|---|---|---|
| 0 | the count rose | nothing |
| 1 | no base URL or no `BOOKING_API_KEY` here | set them; nothing was attempted |
| 2 | no reply at all | check the base URL and that the deployment serves |
| 3 | a reply this command cannot read | something other than the endpoint answered |
| 4 | the key was refused | the deployment does not hold this key |
| 5 | the endpoint is disabled | the deployment has no booking API key configured |
| 6 | not found | the deployment predates this endpoint; deploy and re-run |
| 7 | the Worker could not read its own context | not a missing binding; a local dev server reads like this |
| 8 | `BURST_LIMITER` is not bound | a deploy shipped without the `durable_objects` block |
| 9 | bound, and the object did not answer | **the state the monitor lane cannot see**; the ceiling is failing open |
| 10 | it answered with no count | reachable, wrong reply shape: a code fault |
| 11 | the two readings fell in different windows | nothing is wrong; run it again |
| 12 | two readings in one window and it did not rise | it answers and does not count |

Like the truth probe, it talks to a live deployment, so it is deliberately NOT
named `test-*.ts`: that glob is the offline unit suite. Its decision logic is
pinned offline by `scripts/test-burst-counter-live-control.ts`, which drives every
refusal through hand written replies and asserts no two of them share a code or a
message.

## It runs DAILY, because asking people to re-run it did not work (#2392)

This section used to say, in bold, to re-run the command after any change to the
burst path (`src/lib/rate-limit-burst.ts`, `src/lib/rate-limit.ts`,
`worker/burst-limiter.ts`) or to the `BURST_LIMITER` binding in `wrangler.jsonc`.
Nothing enforced it. Between the command shipping on 2026-08-31 and this change
the path moved five times (`182d4b7d`, `81d3385c` and three `wrangler.jsonc`
edits) and not one of the five PR bodies mentions the command, because a rule that
lives only in a prompt is a hope (L27). The command had never run outside the
session that wrote it, which is a check that has never once concluded (L557).

**`.github/workflows/burst-counter.yml` runs it every day at 10:50 UTC**, and a
hand dispatch is the same run, so somebody who has just changed the burst path can
still get an answer now rather than tomorrow.

**It stamps `verdict:burst-counter`**, in the `VERDICT_STALE_BOUNDS_MS` family
(#1394), judged with `neverIsStale` ON: a proof that has never once concluded is
the exact state this issue was about, and the default leniency would make the
watch structurally unable to see it.

Two things about that stamp are the whole design:

- **Only a run that MEASURED whether the counter answers and counts may write it.**
  The command has thirteen endings and most of them mean it never got to ask: a
  refused key, a deployment older than the endpoint, a Worker that could not read
  its own context. Three endings conclude, and two of those are bad news: exit 9
  (bound and not answering) and exit 12 (answering and not counting) are definite
  readings of the thing under test, so they stamp AND are posted to Slack. Exit 8
  (nothing bound) deliberately does NOT stamp, although it feels like the most
  definite answer of all: the half this command exists to prove is the ANSWERING
  half, and a deployment with nothing bound never exercised it, so a stamp there
  would keep the verdict fresh for as long as the binding stayed missing. That case
  is already paged by the monitor lane's own presence read (#1558). The mapping is
  in `scripts/lib/burst-counter-run-outcome.ts`, one entry per exit code.
- **The bound is 52 hours and every part of it is derived** (L614): 24h of cadence,
  doubled so one dropped run does not page (GitHub drops scheduled runs, and on a
  daily cadence a drop costs the whole day), plus the 3h worst lateness this repo
  has measured, plus the job's own 10 minute timeout, because the stamp lands at
  the END of a run. `scripts/test-burst-counter-schedule.ts` re-derives all of it
  FROM the workflow file, so editing the cron or the timeout without revisiting the
  bound fails the build, and it also refuses a bound with days of slack in it.

There is deliberately **no gap filler** for a run GitHub drops, unlike the canary
and the parity sweep: the bound above survives a dropped run instead. A fourth
entry in `GAP_FILL_PASSES` (`src/lib/monitor/canary-trigger.ts`) is #2466's
question rather than this one's.

**The run speaks from the runner** (`scripts/notify-burst-counter.ts`, bare node
like the other alerters), which is the opposite of the choice `schedule-parity`
made. That one reports back into Slate because drift sits for days and so needs a
cooldown and an all clear, both of which need a memory a runner has none of. This
one is a rare fault somebody fixes the day they read it, so the message says what
silence means instead: it repeats once a day until a run passes, and a run that
passes says nothing.

# Proving an approved time off blocks (`pnpm verify:ooo-protection`)

The third command in this family, and the closest mirror of the truth probe two
sections up: that one asks whether the times Slate OFFERS are really free, this
one asks whether the times it has promised to PROTECT are really blocked (#1478).
Both rest on the same rule. Asking whether an approved time off is really
blocking the agent means asking GOOGLE, because everything Slate stores about it
was written by the very code under test (L58).

#1464 is what that costs. A busy block was deleted 31 seconds after it was
written, `ooo_requests.side_effects` went on reading `ok (slate fallback)` for
weeks, and both Slack messages read as healthy. Any check built on the stored
record would have agreed with them.

**Two reads, and both are required.** Google's free/busy alone cannot answer it,
because busy periods MERGE: a neighbouring meeting makes an oversized, mistimed
or entirely absent time off event read as a perfectly occupied window. So the
command reads the EVENT itself by the id Slate recorded, checks its start and end
against the request, and separately asks free/busy whether that window really
reads as occupied. Free/busy is asked over the agent's PRIMARY calendar only,
which is where Slate writes the event; counting another calendar's busy time
would let something unrelated to the request answer for it.

It WRITES NOTHING (no calendar, no database, no alert) and is deliberately not
named `test-*.ts`, because that glob is the offline unit suite and this needs
live Google plus the Supabase secret key from `.env.local` / `.dev.vars`.

```
pnpm verify:ooo-protection                                  # sweep
OOO_VERIFY_REQUEST_ID=<uuid> pnpm verify:ooo-protection     # one request
```

`OOO_VERIFY_INCLUDE_UNHANDLED=1` also checks the imported rows Slate never ran a
step for (#1485), which are excluded by default and counted out loud;
`OOO_VERIFY_TOLERANCE_MINUTES` (default 1) is how far an event bound may sit from
the record before the two are called different windows, and a value that is not a
number exits `tolerance-unreadable` rather than becoming a NaN every comparison
reads as a mismatch.

**Only `verified` passes, and every other outcome exits non-zero with its own
reason.** Finding nothing to check is never a pass (L98), and one message
answering for another is how a blind check reads as a healthy one (L11):

- `no-approved-future-requests`, `only-unhandled-requests`: the sweep had nothing
  it could check, for two different reasons.
- `request-not-found`, `request-not-approved`, `request-window-passed`,
  `request-unhandled`: a named request that cannot be the subject of this check,
  each said separately so nobody hunts for a typo that is not there.
- `event-never-recorded-window-free` / `-busy`, `event-gone-window-free` /
  `-busy`: no event covering the window, split by whether Slate ever held an id
  and by what free/busy said. The `-busy` pair still FAIL: an occupied window with
  no event of its own can be the neighbouring meeting.
- `event-window-uncovered`, `event-window-wider`, `event-window-unreadable`,
  `event-cancelled`, `event-marked-free`, `event-matches-but-window-free`: the
  event exists but does not prove the window is blocked.
- `calendar-refused`, `calendar-not-provisioned`, `calendar-unreadable`: the three
  ways a calendar read fails, each carrying its own instruction (see "Three ways a
  Google calendar can fail, not two" above); `busy-unreadable`,
  `request-window-unreadable`, `no-agent`.

There is one SKIP, and it is deliberately neither proof nor damage.
`agent-deactivated` is an approved future window belonging to somebody who has
left the pool: nothing can be booked with them, and their Google account is
routinely unlicensed on the way out, so asking Google would report a provisioning
repair nobody should make. It is asked BEFORE the Google call rather than after,
so the run does not spend one. A skip is still not a pass: a run whose every
request was skipped exits `nothing-judged`, because judging nothing proves
nothing (L98). The point of the skip is that one departed agent must not leave the
sweep permanently red, which is how a check stops being read at all (L36).

Its decision logic is pinned offline by
`scripts/test-ooo-protection-live-check.ts`, which drives every one of those
verdicts through hand written fakes and fails if a declared verdict is one no case
can produce.

**As of 2026-08-31 a full sweep passes**: 24 approved future requests looked at,
22 verified against live Google, and 2 skipped as `agent-deactivated`. Those two
belong to one agent who left the pool on 2026-08-24, and before the skip existed
they came back `calendar-not-provisioned` (`403 notACalendarUser`), which is what
Google says for a revoked licence as well as for an account that never had one.
Reading that as a provisioning ticket would have sent somebody to re-license a
departed employee, and left the sweep red forever while they did not.

# Comparing Slate against cal.com (`pnpm verify:calcom-parity`)

The fourth command in the family above, and the one that only makes sense while
BOTH systems are live. During the parallel run (`docs/parallel-run-plan.md`)
Slate computes availability nobody can book while cal.com keeps taking every
lead. This is what turns that silence into a measurement (#1731, rebuilt as a
schedule comparison in #1754, membership added in #1911).

It asks TWO questions, together, because they are one question to whoever reads
the answer:

- **MEMBERSHIP: do the two systems hold the same roster?** Nothing reconciled
  them, so one could be six weeks ahead of the other with no signal. Slate
  deactivated an agent on 2026-07-21 and had no Low plus Beyond agent from that
  date, while cal.com went on routing her every Low plus Beyond lead for six more
  weeks (28 of 28 bookings), then removed her, leaving 11 upcoming calls with a
  host who no longer existed there.
- **HOURS: for every agent bookable in Slate, does cal.com hold the same week?**
  Nothing re-checked the 97 schedules imported on 2026-09-02, and five days later
  21 of 102 agents had drifted.

The hours half cannot see the membership half, which is why both are here: it
iterates the agents who ARE bookable in Slate, so somebody missing from Slate is
never in the loop, and a bucket empty in Slate but served by one person in
cal.com reads as ordinary under-offering.

**It is not a correctness check.** cal.com is the incumbent, not the source of
truth: a week both systems hold can be wrong in both. That question belongs to
`verify:availability-truth`, which asks Google. This one catches CONFIGURATION
drift, which is invisible from inside Slate alone.

## The slot comparison it replaced could never run

The first probe narrowed cal.com's answer to one bucket's agents with
`routedTeamMemberIds[]` on `GET /v2/slots`. That parameter does not exist on that
endpoint: it is a strict whitelist, so every spelling answers 400 and zero pins
answers 200 with the whole pool. It belonged to `/v2/slots/available`, which is
now 404. So the probe was merged, documented here with fifteen exit codes, and
structurally incapable of executing a single comparison. Re-measured live on
2026-09-07, still 400.

**The pin was the load-bearing capability and it was the last thing measured**,
which is the mistake worth not repeating. Both halves now rest on endpoints
measured before anything was built on them, and both were confirmed live first:
`GET /v2/organizations/{org}/users/{id}/schedules`, which the OOO dual-write
already exercises daily, and `GET /v2/organizations/{org}/teams/{team}/event-types`,
whose `hosts[]` names who can take a booking.

Two neighbouring paths that look right and are not, so nobody spends an
afternoon on them again: `GET /v2/event-types/{id}` answers 404 (use the
team-scoped listing), and `GET /v2/organizations/{org}/users/{id}/attributes`
answers 404, so **cal.com will not tell you a user's attribute values**. That is
why the check reads routing attributes from Slate, which takes them from
Salesforce, the same source cal.com does.

## Two design decisions, both made because the first live run misled somebody

**The hours comparison is EXACT**, which departs from what #1754 asked for. The
slot probe bucketed to the hour because the two systems carry different slot
intervals, durations and buffers, so demanding equal instants would have been red
from the day it shipped for reasons nobody should fix (L36). None of that applies
to a schedule: both sides store a weekday plus start and end minutes, so the
values compare directly, and hour bucketing would HIDE the commonest drift on
this roster rather than tolerate noise. Real windows sit on half and quarter
hours, and 09:00 against 09:30 opens the same hour.
`scripts/test-schedule-parity.ts` carries that as a control: patching the
comparison to bucket by the hour makes it fail.

**A difference that changes nothing a lead sees is ranked below every real
finding.** Two of them:

- A zone NAME that keeps the same clock. The first live sweep reported ten agents
  as `timezone-differs`, and every one was such a pair: nine `America/Denver`
  against `America/Boise`, one `America/New_York` against
  `America/Indiana/Indianapolis`. Sampled hourly over 400 days those differ on 0
  of 9,600 hours, while Denver against Phoenix differs on 5,711. One of the ten
  was hiding a genuine Saturday-for-Friday swap under the zone label.
- The nine admins, managers and team leads who host in cal.com and are correctly
  not bookable in Slate. Those rank LEVEL WITH AGREEMENT and cannot fail a run at
  all, because nothing will ever change them and a permanently red check is one
  nobody reads by the second week.

The second is an exemption, so it is NAMED (`DELIBERATELY_QUIET` in
`scripts/lib/calcom-parity-outcome.ts`) rather than achieved by leaving a verdict
out of a table (L129). It is enforced in the type as well as the list, so `tsc`
fails both a verdict that quietly has no exit code and an exemption for a verdict
nothing produces.

## Running it

```
pnpm verify:calcom-parity                                   # sweep the roster
PARITY_AGENT=someone@trypennie.com pnpm verify:calcom-parity  # one agent's hours
```

`CALCOM_API_KEY` is required, and so are the three Twilio variables that say who
cal.com withholds (`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`,
`TWILIO_WORKSPACE_SID`, the same TaskRouter scoped key `verify:twilio-parity` uses).
The cal.com key is a wrangler secret on the deployment, so it has to
be in `.env.local` to run this. `CALCOM_ORG_ID` defaults to 19474,
`CALCOM_TEAM_ID` to 19546 (Loan Consultation), `CALCOM_EVENT_TYPE_ID` to 1314152
(the review event the landing pages use), and `CALCOM_PACE_MS` to 250. The pacing
is not cosmetic: cal.com meters the schedules endpoint hard and the first import
run met 429 on 89 of 103 agents without it. The retry ladder rides out a rate
limit on the server's own `Retry-After`, and is finite, because a read that
retries forever hangs the run (L110). `PARITY_AGENT` narrows the HOURS half only:
membership is a comparison of two whole rosters and means nothing scoped to one
person.

**Only agreement passes, and every other outcome exits on its own code.** Finding
nothing to compare is never a pass (L98), and the report says how many agents had
a week on BOTH sides, so "no differences" can never be read as "no problems" when
the real answer is that nothing was compared.

| exit | what it met |
|---|---|
| 0 | the two rosters agree and every agent holds the same week |
| 1 | no `CALCOM_API_KEY`, or no Twilio credentials, here; nothing was attempted |
| 2 | no bookable agents in Slate, or the named agent does not exist |
| 4 | cal.com did not answer (the org listing, or the team's event types) |
| 5 | cal.com answered with something unreadable |
| 6 | the event type is not on that team, or named no hosts at all |
| 7 | **Twilio could not be read**, so who cal.com withholds is unknown |
| 9 | a zone name differs and keeps the same clock |
| 10 | an agent bookable in Slate has no cal.com account |
| 11 | a cal.com account holds no schedule, or one with no windows set |
| 12 | **a bookable agent has no hours in Slate**, so they are offered nothing |
| 13 | cal.com would not answer for an agent (rate limit, or a refusal) |
| 14 | cal.com answered for an agent with a payload this cannot read |
| 15 | **hours differ** |
| 16 | **days differ** |
| 17 | **the timezone differs** |
| 21 | not bookable in Slate, hosts in cal.com, and no bucket's criteria can match them |
| 22 | a cal.com host with no Slate record at all |
| 23 | **bookable in Slate and not a cal.com host at all**, so Slate offers somebody the incumbent never routes to |
| 24 | **an agent Slate will not route who cal.com still can** |
| 25 | **somebody who has left Slate and can still be booked in cal.com** |
| 26 | **bookable in Slate while cal.com withholds them from every routed decision** |
| 27 | an hours, days or timezone difference on a week the AGENT set themselves, which the lane will not overwrite |

The ordering across the two halves lives in ONE table
(`OUTCOME_ORDER`), written out rather than folded together from the two halves'
own rank scales: the cross-family judgements are the interesting ones and should
be a decision somebody made, not an accident of two numbers picked months apart.
The sweep exits on its worst row, so one departed host among a hundred
agreements is the finding, and an agent wrong in two ways is named by the more
severe one while still carrying BOTH reasons.

**Being a host is not the same as being routable, and reading the host list alone was
wrong in both directions** (#2088). The event type's `hosts[]` says who CAN take a
booking; six of the seven live routing forms then carry `Redistribute Team (does not
equal) yes` on every route, so the pool cal.com actually routes to is narrower. Until
2026-09-08 that meant two agents Slate correctly held back were paged on daily (exit
24) while twelve agents Slate offers and cal.com never routes to read as agreement.
**The withheld set comes from Twilio** (#2153). cal.com will not report per-user
attribute values (`/organizations/{org}/users/{id}/attributes` answers 404 on both
API versions) and the routing forms give the condition without saying who satisfies
it, so the set was a hand-typed constant for two days, read out of the cal.com UI on
2026-09-08. Nothing maintained it, and by 2026-09-10 it was wrong in both directions:
Twilio tagged 22 people, 8 of whom it had never heard of, while 2 of its entries
carried no tag at all. The Pipedream job that reads those tags is what puts
`Redistribute Team = YES` on the cal.com member in the first place, so the command
reads the tags and needs `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and
`TWILIO_WORKSPACE_SID` alongside the cal.com key. A Twilio read it cannot make is
**exit 7 and no comparison at all**: an empty withheld set turns every withheld agent
into agreement, which is the false agreement #2088 fixed. The run still says how many
withheld addresses cal.com no longer hosts, and that count now measures Twilio
against cal.com rather than a person's snapshot against cal.com.

Not `users.attributes.redistribute`, which is a different fact. That key is Slate's
record of whom IT took out of the bookable pool because of the tag, so an agent who
was already not bookable when the tag appeared is never marked: measured 2026-09-10
it covered 13 of the 22 tagged people, and using it would have reported the other 9
as routable.

**Exit 21 asks whether a bucket can match them, not whether they carry attributes**
(#2094). The looser question paged daily on an agent whose only attribute was
`{"role":"Sales"}`, which no bucket keys on. It is answered by calling the shipped
pool predicate over the live criteria (`matchableAgentIds`), and the run REFUSES with
exit 2 on a bucket list it could not read, because an empty one makes every agent look
unreachable and takes the whole roster half quiet.

The states where an agent cannot be compared each get their own code, on purpose:
"no cal.com account", "no schedule in cal.com", "the read failed" and "the payload
changed shape" send four different people to do four different things, and one
message answering for another is how somebody spends an afternoon on a rate limit
(L11).

An empty host list, or an event type that is not on the team, REFUSES the run
rather than reporting it. Either would otherwise turn every bookable Slate agent
into `bookable-not-hosting`: a hundred findings about one broken read.

## Where the code lives

Decision logic is pinned offline by `scripts/test-schedule-parity.ts`,
`scripts/test-roster-parity.ts`, `scripts/test-calcom-parity-outcome.ts` and
`scripts/test-calcom-roster.ts`, which drive every verdict, the retry ladder and
the default-schedule choice through hand written fixtures with no network and no
real clock. The reads it shares with `pnpm import:calcom-schedules` live in
`scripts/lib/calcom-roster.ts`, deliberately in one place: two copies of "who is
a bookable agent" drift, and the drift is silent in the worst direction, since
the command would then report agreement about a roster the importer never wrote
to.

## The daily lane CORRECTS the drift, it does not only report it (#2092)

`.github/workflows/schedule-parity.yml` runs `APPLY=1 pnpm import:calcom-schedules`
**before** it sweeps, so an hours, days or timezone difference is repaired by the
lane rather than paged to a person. Detection was automatic and repair was not,
and that gap cost something measurable: across three passes the roster went 97 out
of step, then 21 after five days, then 4 after one, because people actively edit
schedules in cal.com while it is still the system taking every real lead.

**The ordering is the change, not an implementation detail.** Applying first and
sweeping second means the message reports the state AFTER the repair, measured
independently by the sweep, rather than a subtraction computed from the writer's
own read-back. Sweeping first and applying second costs the same two cal.com
passes and leaves the report making a claim instead of taking a reading. It also
pages about drift that the apply has already fixed.

**What the lane will not write is the whole safety of it.**
`hoursOverwriteRefusal` (`scripts/lib/calcom-schedule-import.ts`) refuses any
schedule whose `availability_schedules.hours_source` is `agent`, and refuses a
source it does not recognise, so a writer added later defaults to leaving people's
hours alone. cal.com is the authority for these values ONLY while it is the system
people maintain, and an agent who has set their own week in Slate has stopped
being one of those people. That guard is also what retires this safely: once
agents set their own hours (#1454) every one of those rows is stamped `agent` by
construction and the import stops touching them, with nobody having to remember.

`admin`, `seed`, `calcom-import` and an UNSTAMPED row are all overwritable. Dan's
rule, 2026-09-10: "it just needs to not overwrite a changed hours. If I changed
them or another import changed them, that's fine." The unstamped case is not a
loophole, it is the roster: measured 2026-09-10, **79 of 90 bookable agents carry
no stamp at all**, because migration 0117 shipped six days after the import that
wrote them. Refusing those would leave the lane inert for 88 percent of the roster
while the daily page went on naming exactly the agents it would not fix (L662).

A difference the lane refuses to correct gets its OWN verdict,
`hours-set-by-agent`, classified `standing` so it is counted and named and never
pages. Without it, an agent who sets their own hours in Slate and differs from
cal.com would page every morning forever, which is how a check stops being read by
the second week (L36). It is produced by `reclassifyAgentOwnedHours`, deliberately
a separate step from `compareAgentSchedule`: the comparison answers "do the two
systems agree", which is a question about two weeks, and the reclassification
answers "is this ours to fix", which is a question about who wrote the Slate side.

**The alert says what the lane wrote**, and the remedy line depends on whether an
apply ran at all. `corrected` ABSENT means no apply happened (the step died, or
somebody swept by hand), so the message still names
`APPLY=1 pnpm import:calcom-schedules`. `corrected` present, including a zero,
means the import DID run, so naming that command would be a dead instruction
(L111) and the message says what is left needs a person instead. Those two are
kept apart on the wire, in `parseParitySweep`, and in the copy.

**This retires at cutover (#65)**, since it only means anything while both
systems are live. The hand-run command still finds what it finds on the day
somebody runs it; the scheduled lane is what makes it daily.

# Does Slate hold the same facts as cal.com's source? (`pnpm verify:twilio-parity`)

The sixth command in the family above, and the one that measures a divergence the
other five structurally cannot see (#2096).

**Slate and cal.com used to take the same routing facts from different systems, and
since #2152 they do not.** Slate read each agent's debt tiers and backend service
from Salesforce booleans (`LowDebt__c` and friends) while cal.com was fed the same
facts by a Pipedream job reading each **Twilio TaskRouter** worker's `teams` tags.
Nothing reconciled the two, so every agreement `verify:calcom-parity` reported rested
on somebody keeping them in step, and a divergence there looked like a Slate defect
while both syncs were working perfectly. Dan settled the seven agents they disagreed
about on 2026-09-09 (#2148) with a standing rule, "let's use twilio as the source of
truth", and #2152 put that rule in the sync instead of in a person's memory: the
hourly roster job reads the tags and writes `debt_team` and `backend_service` onto
`users.attributes` (`src/lib/twilio/sync.ts`). Salesforce keeps what Twilio does not
carry, which is the profile and manager of record (#2099).

**So this command agrees by construction about the facts Twilio owns**, and its
remaining job is roster MEMBERSHIP: a Twilio worker with no Slate row, a Slate row no
worker carries the address of, a duplicated worker, a tag nobody mapped. Those are
the states a shared source cannot make agree, and they are still worth a run.

The Twilio tag to attribute mapping is copied deliberately from the live Pipedream
workflow rather than invented (`TEAM_TO_DEBT_TIER` and `TEAM_TO_BACKEND` in
`src/lib/twilio/roster.ts`), so Slate stores what cal.com ACTUALLY receives. A tag
the mapping does not know is REPORTED rather than dropped, because a tier added in
Twilio would otherwise be invisible to the check written to notice drift, and
`scripts/test-routing-attribute-vocabulary.ts` holds the mapping against the routing
vocabulary in BOTH directions, so a tier no tag can produce (an agent who can never
hold it, and buckets that are permanently empty) fails the build.

**Three things the mirror does deliberately**, each measured against production
before it shipped on 2026-09-10, when 129 of 129 in scope rows had a Twilio worker
and two differed:

- A tag that has gone TAKES ITS VALUE WITH IT. A merge would leave an agent in a pool
  the source says they are not in, which is the failure the issue was opened about.
- A row Twilio holds NO worker for keeps its stored tiers and is written nothing at
  all. Silence about somebody is not a source saying their tiers are gone (L214),
  and emptying every pool an agent belongs to on a partial read is not recoverable.
  The count is reported as `withoutWorker`, because doing nothing is otherwise
  invisible.
- A FIRST debt tier makes somebody bookable, through the same activation gate the
  Salesforce half uses (#2071). The transition belongs to whoever writes the fact
  that causes it: a sync that wrote the tier and left the flip to the other half
  would detect nothing, because by the time that half read the row the tier would
  already be there, and "has a tier and is not bookable" is the shape of somebody an
  admin deliberately held back (L60). A refused activation keeps its pending mark and
  the Salesforce half retries it, so one intent has one owner.

**`Redistribute` is why it was written.** That tag means an agent should not be taking
booked calls at all (Dan, 2026-09-08), and it exists ONLY in Twilio: the Salesforce
User object carries 14 custom fields and none is this one, and cal.com will not report
per-user attribute values (`/organizations/{org}/users/{id}/attributes` answers 404 on
both API versions). So Twilio is the only place Slate can read it, and until this
command there was no way to see it from inside Slate at all.

**It writes nothing**: no Slate row, no Twilio worker, no cal.com attribute, no alert.
It is deliberately not named `test-*.ts`, because that glob is the offline unit suite
and this needs live Twilio plus the Supabase secret key from `.env.local`.

```
pnpm verify:twilio-parity
```

Needs `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and `TWILIO_WORKSPACE_SID` in
`.env.local`. The key must be TaskRouter scoped; it is used as basic auth exactly as
the Pipedream job does.

**Only agreement passes, and it says how many addresses it compared**, because zero is
the shape of a broken read and never a healthy roster (L98). Every other outcome exits
on its own code, worst first.

| exit | what it met |
|---|---|
| 0 | Slate and Twilio agree on every address compared |
| 1 | no Twilio credentials here; nothing was attempted |
| 2 | no workers, no Slate users, or nothing with facts on both sides |
| 3 | Twilio did not answer, or refused the credentials |
| 4 | Twilio answered with something unreadable |
| 11 | in Slate and no Twilio worker carries their address, so cal.com is fed nothing for them |
| 12 | two or more Twilio workers share one address, and their tags were unioned to compare |
| 13 | a Twilio tag this mapping does not know |
| 14 | a Twilio worker with no Slate record at all |
| 16 | **the backend service differs** |
| 17 | **the debt tiers differ** |
| 18 | **carries Redistribute in Twilio and is still bookable in Slate** |
| 20 | **manager of record differs** |
| 21 | the team tag names somebody Slate has no user for |
| 22 | Twilio names a manager and Slate has nobody linked |
| 23 | Slate names a manager and the worker carries no team tag |
| 24 | one worker carries two or more team tags |

Exit 18 is ranked worst because it is the only finding here that misroutes a lead the
day it appears rather than being latent. The two Twilio configuration faults (12 and
13) rank BELOW every difference about a person on purpose, so a duplicated worker
cannot bury a real disagreement. The exit codes name the outcome and the ranking
decides which one names a run; they are two different questions, which is why the
numbers and the order do not match.

**Manager of record is compared, never moved (#2099).** Twilio carries manager
assignment as a `Team <Manager Name>` tag and Slate takes it from Salesforce's
`Agent_Manager__c`, which stays the recorded owner: the OOO approver chain is built
on it, and this notices a divergence rather than resolving one. Names are matched on
case and surrounding space. The five outcomes are separate because they send five
different people to do five different things, and the four about a person rank BELOW
every difference about what somebody can be routed for, since a wrong approver sends
a time off request astray and does not misroute a lead.

Two silences are agreement rather than findings. A worker carrying no team tag for
somebody Slate has no manager for is quiet, which is what keeps this off the twenty
workers who legitimately carry none: sixteen are managers and admins with no manager
of their own. And exit 21 fires only when the roster was actually supplied to check
against, because an unrecognised name is only unrecognised once somebody has looked.
The known-name set deliberately includes departed users, since a tag naming somebody
who left explains itself and is not a typo to hunt for.

Measured live 2026-09-09, with every other fact forced to agree so the manager half
is not masked by a higher ranked verdict: 128 agree and one finding, jlodato@, whose
Slate manager is Brad Lawrence and whose Twilio worker carries no team tag.

**Legal eligibility was retired outright (#2218).** Slate mirrored the `Legal
Eligible` and `Not Legal Eligible` tags onto `users.attributes` and compared them
here, on two exit codes. Dan retired the attribute on 2026-09-10: the ten bucket
criteria keyed on it matched zero bookable agents, so nothing routed on it and
nothing stores it now. The TAGS still exist in Twilio and still reach cal.com
through the Pipedream job; they are simply not Slate's business, and they arrive
here as ordinary unmapped tags.

A departed Slate agent ranks level with agreement and can never name a run: their
Twilio tags are not a disagreement about somebody taking calls.

Decision logic is pinned offline by `scripts/test-twilio-parity.ts`, which drives
every verdict, the tag mapping, the duplicate union and the ranking through hand
written fixtures with no network. Its control that matters: exit 18 must NOT fire once
Slate has the agent not bookable, or the check would report the fix as the fault.

**This does NOT retire at cutover**, unlike the rest of the family. Twilio stays the
place managers tag agents after cal.com is off, so this comparison becomes the way
Slate learns about `Redistribute` rather than a parallel-run check.

# Replaying real leads through Slate's ladder (`pnpm verify:router-replay`)

The seventh command in the family above, and the only measurement of Slate's
ROUTING that exists before cutover (#2240).

cal.com has taken every real lead for months. Slate has routed nothing, so there
is no traffic of its own to judge it by. But every cal.com routing form response
records both the code the lead carried and the agent cal.com chose, so the same
lead can be put to Slate and the two answers compared. That is what this does:
about 25,000 routed leads over 30 days, replayed through `resolveRequestedCode`,
`tierLadder` and the booker's own pool predicate.

**It is not a correctness check.** cal.com is the incumbent, not the source of
truth, and a lead both systems would send to the same person can be wrong in both.

## Three things it reports separately, because they are three different findings

**LADDER agreement** is the question only this command asks: given a host Slate
would route to, does Slate's ladder place them in the pool the lead asked for?
Measured live 2026-09-11: **100 percent of 119 leads in the primary window and 100
percent of 149 in the secondary**, one of which needed a rung dropped.

**The chance baseline** sits beside every rate, and without it the first number
means nothing. With the legal digit retired (#2218) the big pools hold most of the
roster: the measured baseline is **54 to 58 percent**, so a coin flip agrees more
than half the time and only the distance above it is evidence.

**ROSTER differences** are counted and reported and **cannot fail a run**. These
are leads cal.com routed to somebody Slate will not: 30 of 150 sampled in the
primary window, every one `host-not-bookable`, and **zero** in the 30 days before
it, which says the divergence is recent. `pnpm verify:calcom-parity` owns that
question and pages on it under exits 23 to 26, and a second command failing daily
on the same finding is how both stop being read (L36). What they must never do is
hide inside the agreement rate: folding them in put the first live headline at
89.6 percent, which reads as Slate routing leads differently when not one lead
disagreed about the ladder.

## What agrees by construction, and the report says so at the top

Since #2152 Slate's debt tiers and backend service come from the same Twilio tags
the Pipedream job feeds cal.com, so the ATTRIBUTES both systems route on are ONE
source. What is actually under test is everything downstream: the code resolution,
the tier ladder with its Beyond overflow, and the pool predicate. A reader told
only the agreement rate would take it as evidence about the half that was never in
doubt.

The attributes and pools are also TODAY'S while the leads are historical, which is
why the primary window starts on **2026-09-10**, the day the attribute source
became shared. The secondary window is the 30 days BEFORE that, never the 30 days
including it: two overlapping windows cannot be compared, because the second is
mostly the first.

## Three things the live runs changed, each caught by running it

- **The cap must be invisible to every rate.** A run is capped
  (`REPLAY_MAX_FETCH`, default 2,000) against a window of 25,000 leads, so most
  leads are never asked about. Folding those into the resolution rate made it a
  measurement of the cap: the first run reported "only 10.5 percent of leads had a
  readable host" when the truth was that 150 had been asked about and 139 agreed
  (L209). An unsampled lead now moves nothing and is counted out loud.
- **The sample must not be ordered by the reads.** Taking the head of a per form
  list put every resolved host in one form, so the by form table showed two forms
  with zero agreements rather than two forms nobody had asked about. Leads are
  sorted newest first across every form before the cap.
- **The budget is SPLIT between the two windows.** Newest first across 30 days
  spends every read inside the primary window, and the secondary was reported with
  exactly the primary's numbers: a copy wearing a second heading. Half the budget
  goes to leads older than the primary start, and a half with nothing left to ask
  about hands its remainder to the other.

## Running it

```
pnpm verify:router-replay
```

`CALCOM_API_KEY` is required (a wrangler secret on the deployment, so it has to be
in `.env.local`), plus the Supabase secret key. `CALCOM_ORG_ID` defaults to 19474,
`REPLAY_MAX_FETCH` to 2,000, `REPLAY_SINCE` to 2026-09-10, `REPLAY_CACHE` to a file
under `$TMPDIR`.

**`REPLAY_PACE_MS` defaults to 550 and the number was MEASURED**, not guessed:
cal.com answers `x-ratelimit-limit-default: 120` on a 60 second reset, so the
sustainable rate is two reads a second. At 100ms the responses listing met a 429
the retry ladder could not ride out, on the fourth of eight forms, and the run
correctly refused rather than reporting rates about whichever forms happened to
answer. Budget roughly ten minutes per thousand bookings, and run the first pull
outside business hours: the key is shared with the OOO dual-write.

A booking is cached under `$TMPDIR` and re-read when its start is still in the
future (it can move or be cancelled) or when the entry is more than two days old.
The cache holds host emails, times and status and **never the attendee**: the
lead's own details have no business in a file on a laptop.

**Only agreement passes, and every other outcome exits on its own code.** Finding
nothing to judge is never a pass (L98).

| exit | what it met |
|---|---|
| 0 | Slate's ladder places the leads cal.com routed |
| 1 | no `CALCOM_API_KEY` or no Supabase credentials here; nothing was attempted |
| 2 | no routed leads, no bookable agents, no buckets, or nothing judged |
| 3 | a Slate read failed, so the pools to compare against are not known |
| 4 | cal.com would not answer for the forms or their responses (a 429 here means the pacing is too fast) |
| 5 | too few of the leads it ASKED about had a readable host |
| 6 | too many leads fell to the catch-all, which is what a broken code lookup looks like |
| 7 | **the ladder disagrees** |
| 8 | not ONE booking could be read, which is a broken read rather than a thin sample |

Exit 6 is a ceiling rather than a curiosity: catch-all leads are excluded from the
agreement denominator, so a bug that pushed every lead into it would leave a tiny,
flattering sample behind and RAISE the headline. Exit 8 is kept apart from exit 5
because a wrong API version answers exactly like it for every uid, and calling that
"too few hosts resolved" sends somebody to look at the data.

Decision logic is pinned offline by `scripts/test-router-replay.ts`, which drives
every class, both rates and the whole exit table through hand written fixtures with
no network and no clock.

## It runs WEEKLY, and the cache is what makes that worth more than one run (#2263)

`.github/workflows/router-replay.yml` runs it every Monday at 13:20 UTC, an hour
after the parity sweep so the two cal.com consumers never pace against each other
on one key. Weekly rather than daily because a pass is roughly ten minutes per
thousand bookings on a key shared with the OOO dual write, and this retires at
cutover.

**The booking cache is persisted through `actions/cache`, and that is the half
that makes a schedule mean something.** A capped run reaches at most
`REPLAY_MAX_FETCH` bookings against roughly 25,000 routed leads, and the cache
accumulates backwards across runs, so repeated runs are what eventually cover the
window. A runner's `$TMPDIR` is gone when the job ends, so without it every
scheduled run would re-read the same newest leads and look identical every week
while covering no more of the window. The key carries the run id and
`restore-keys` picks up the newest previous entry; a fixed key would be written
once and then frozen at whatever the first run happened to read. The cache holds
host emails, times and status and never the attendee, by the command own design.

**It speaks from the runner**, which is a deliberate difference from
`schedule-parity`. That one is daily, so a finding that sits needs a cooldown and
an all clear, and both need a memory a runner has none of. At weekly cadence on
something that retires at cutover the condition machinery costs more than it buys:
one message a week at most, and only when there is something to say. Agreement
says nothing at all, because a weekly all-is-well is how the messages that matter
stop being read (L36).

**The heartbeat is stamped only on a USABLE verdict.** `agree` and `disagreement`
stamp `router-replay`; `nothing-judged`, `resolution-too-low` and
`catchall-too-high` are each a run that LOOKED and could not conclude, so they
report and leave the heartbeat to go stale against its 9 day bound. A blind
detector keeping its heartbeat fresh is exactly the state #1394 exists to notice.
The three states are told apart by the SUMMARY FILE the command writes when it
decides, so an absent file is evidence that the run died before deciding rather
than an inference from an exit code (L98). The decision lives in
`scripts/lib/router-replay-report.ts` and is pinned offline by
`scripts/test-router-replay-report.ts`.

**This retires at cutover (#65)** with the rest of the family: once Slate routes
the leads there is no second system to replay them through.

# Proving the booking kill switch really refuses (`pnpm verify:kill-switch`)

The eighth command in the family above, and the one whose subject fails CLOSED (#2365).

#2297 shipped the public booking kill switch and nothing had ever thrown it in
production. Every path was covered by tests and the setting was confirmed present in
the live database, but the PAUSED state had never once run against the deployed
Worker. That matters more here than it would for most features: this gate refuses the
booking when it cannot READ its own flag, so the fault nobody would see coming is the
one where it refuses EVERYTHING, and the only signal would be the booking failure rate
window firing under `booking_pause_unreadable` after real leads had been turned away.

**It creates no booking.** The gate sits ahead of body parsing, so a deliberately
malformed body answers 400 while open and 503 while paused, and the difference between
those two IS the gate. Nothing reaches the booking path in either half.

**Both directions or it proves nothing** (L1): a route hard wired to 503 satisfies a
check that only pauses, and one hard wired to 400 satisfies a check that only looks
while open. The 503 is then separated by the COPY it carried, compared against the
shipped `BOOKING_ERROR_COPY` builder rather than a pattern written in the command
(L41), because `booking_paused` and `booking_pause_unreadable` are both lead facing
sentences on the same status and one answering for the other would report the fault
this was opened about as a working switch (L11).

**It also asserts what the switch leaves ALONE**, which is half its design:
availability keeps answering while bookings are paused. Compared open against paused
rather than demanded to be non zero, because before cutover a real bucket legitimately
offers no times (#1272) and a check that demanded them would be red from the day it
shipped (L36).

**What it writes** is one column, twice: `booking_settings.public_booking_paused` on,
then off. The restore is in a `finally` and is tried twice, and a run that could not
restore exits non-zero and shouts, because what it leaves behind is PUBLIC BOOKING
STOPPED (L514, L515). It REFUSES to start at all when bookings are already paused:
finishing would turn them back on for somebody who stopped them on purpose.

```
pnpm verify:kill-switch
```

Needs the Supabase secret key from `.env.local` to flip the flag. `SLATE_BASE_URL`
picks the deployment (default prod) and `KILL_SWITCH_BUCKET` the bucket whose
availability is read (default `111`). **Not a test bucket**: SMOKE and SMOKE2 are
invisible without a bearer token (#396, #601), so an unauthenticated read of one 404s
in both halves and the run learns nothing about the half it is there to check. The
first live run did exactly that and reported the switch as having closed availability,
which was the command accusing its subject of a fault its own read had caused.

| exit | what it met |
|---|---|
| 0 | the switch refuses while on, takes the request while off, and leaves availability alone |
| 1 | no Supabase credentials, no settings row, or bookings already paused; nothing was attempted |
| 2 | **the flag is STILL ON**: public booking is stopped and a person must clear it |
| 3 | the switch was on and the booker took the request anyway |
| 4 | **the booker refused while the flag was OFF**, so it is turning leads away by itself |
| 5 | it refused with the copy it uses when it cannot READ its flag: the fail closed fault |
| 6 | availability stopped serving while paused, which the switch must not touch |
| 7 | no reply at all |
| 8 | the rate limiter answered first, so the gate was never reached; run it again |
| 9 | the booking route failed while the switch was off |
| 10 | this deployment has no public booking route |
| 11 | something this command cannot read answered |
| 12 | availability could not be read in EITHER half, so that half is unmeasured |

Exit 2 outranks every other finding, because it is the only one that goes on turning
real leads away after the command exits: a reader sent to investigate "the switch does
not refuse" while bookings are silently off has been sent to the wrong problem. Exit 12
is kept apart from exit 6 for the reason the first live run showed.

**Measured live 2026-09-16 against prod: PASSED.** A request reached the booker while
the flag was off, the same request was refused with the paused copy while it was on,
availability offered 319 times throughout, and the flag was confirmed back off by a
direct database read rather than by the command's own.

Decision logic is pinned offline by `scripts/test-kill-switch-live-control.ts`, which
drives every verdict, the ordering and the whole exit table through hand written
replies with no network and no database.

# Is the shadow run trustworthy today? (`pnpm verify:parallel-run-readiness`)

The fifth command in the family above, and the one to run right before the pilot
bookings (#2066). On 2026-09-07 answering "is the parallel run trustworthy today"
took a database query plus reading eight issues, because each precondition is
measured somewhere in Slate and nowhere together. This reads production, writes
nothing, and judges five things through the code that already owns each of them
(L107): no alert cooldown stretched above its default, the daily cal.com comparison
fresh and not reporting drift, nobody waiting to become bookable behind a refused
activation, every bookable agent's calendar present and hydrated to the booking
horizon (the hydration monitor's own judge), and no real bucket empty (the empty
bucket alarm's own eligibility predicate).

```
pnpm verify:parallel-run-readiness
```

**Only READY passes, and it says how many agents and buckets it measured**, because
zero of either is the shape of a broken read and never a healthy morning (L98). Every
other outcome exits on its own code, worst first, and lists every finding rather
than only the worst, so a reader is not sent to fix a cooldown while three buckets
have nobody in them. The judgement lives in `scripts/lib/parallel-run-readiness.ts`
and is pinned offline by `scripts/test-parallel-run-readiness.ts`.

| exit | what it met |
|---|---|
| 0 | READY |
| 1 | no Supabase credentials here; nothing was read |
| 2 | a section could not be read, so nothing beneath it is vouched for |
| 3 | zero bookable agents or zero real buckets: nothing was judged |
| 4 | **a real bucket has nobody to route to** |
| 5 | **a bookable agent has no calendar row**, so they read as free all day |
| 6 | a calendar is not hydrated to the booking horizon |
| 7 | an alert cooldown is stretched above its default |
| 8 | the cal.com comparison is reporting drift |
| 9 | the cal.com comparison has not reached a verdict inside its 30 hour bound |
| 10 | somebody is waiting to become bookable behind a refused activation |

A deliberately dropped check, so nobody adds it back by accident: a bookable agent
sitting on the seeded default week is NOT reported. The seeded week is also a real
week some agents genuinely keep, so the proxy would be a standing false finding;
telling the two apart needs the stamp #1753 asks for, and belongs there.

**It retires at cutover (#65)** with the rest of the family.

# One availability compute per POOL, not per bucket code (#2245)

Sixty bucket codes resolve to **fifteen** distinct pools, measured against
production on 2026-09-11. The legal digit stopped routing (#2218) and backend
digits 0 (None) and 1 (Both) never set `backend_service` at all, so six codes per
tier carry identical criteria. The every minute recompute lane was running the
whole multi agent availability compute sixty times to produce fifteen answers, on
the lane whose headroom already pages (#2021).

The lane now groups before it dispatches (`groupByPool`, `poolsDueForRecompute`,
`recomputePool`), computes once per pool, and writes **every code in that pool its
own row**. Two things about that are load bearing:

- **`bucket_slots` still holds one row per code and each row keeps its OWN bucket
  identity.** The stored payload is read back for the routing trace's effective
  code, the test bucket gate and the empty bucket alert key, so a shared row
  would have five codes reporting a sixth's bucket. Collapsing the table to
  fifteen rows was weighed and DEFERRED (Dan, 2026-09-11): it needs a bucket
  lookup back on the booker's hot path and moves four monitors into pool space,
  for a saving of forty five small writes. Do not do it without re-reading #2245.
- **Freshness is asked of the POOL, never of each code.** The jitter (#1247)
  gives every code its own deadline inside the window, so a pool has six; writing
  all six rows at the first of them resets the clock into the next deadline a
  minute later, and the lane would recompute a pool roughly every quarter window.
  `scripts/test-pool-due.ts` drives three windows a minute at a time and catches
  exactly that: the naive version refreshes nine times where the correct one
  refreshes three.

Anything that starts feeding the compute must be added to `PoolInput`
(`src/lib/availability/pool-key.ts`) in the same change, or the lane will serve
one pool's times under another pool's code.

**`pnpm verify:pool-slot-parity`** is the proof, and it asks a question that
holds at any instant: do the codes that share a pool offer the same times? A
before and after diff of one code's slots cannot work, because the booking window
walks with the clock and nobody could tell that from a regression. It reads
production and the deployed app and writes nothing. Measured BEFORE this shipped:
59 of 60 codes across all 15 pools agreed (one code met the endpoint's 30 a
minute throttle). It paces itself to that throttle, sampling each pool's codes
together so the window cannot move between two codes about to be compared, so a
full sweep takes a few minutes. Exit codes are in
`scripts/lib/pool-slot-parity.ts`, pinned offline by
`scripts/test-pool-slot-parity.ts`; comparing nothing exits non-zero, never as a
pass (L98).

## One page per empty POOL, not one per code (#2237)

The same grouping, applied to the no-eligible-agents sweep. A tier with nobody in
it is ONE finding; it used to arrive as six near identical pages, each naming a
code and none naming the thing to fix, and a three code pool arrived as three,
which is under the aggregate threshold and so never folded.

- `BucketCoverage` carries the pool key and the pool's NAME, both required so
  `tsc` names every construction site.
- A pool pages on its **lowest** code, so the key is the same on every sweep
  whatever order the rows arrive in, and the codes it speaks for are settled
  silently. An unstable key would page under a new name each time and never clear
  the old.
- The page names the pool AND lists every code it covers, because the pool is
  what a person fixes and the codes are what the landing pages send.
- **`AGGREGATE_EMPTY_THRESHOLD` counts pools now, and that re-aimed it** (L220).
  Five of sixty CODES was reached by a single unstaffed tier, which is one
  staffing problem and exactly what the per bucket page was for. Five of fifteen
  POOLS is a third of the routing matrix. The number is unchanged; the question
  is not.
- The pool's NAME comes from the criteria through `DEBT_TIER` and `BACKEND`
  (`src/lib/availability/pool-label.ts`), the same vocabulary the bucket names and
  the roster use, and `collidingPoolLabels` fails the build if two pools ever
  render the same name: they would read as one on every surface at once while
  every test about a single label still passed.

The sweep reads `bucket_members` and keys on the SAME `PoolInput` the recompute
lane, the tiers page and the staffing depth use (#2253). It shipped with a coarser
key that left manual members out, because it resolves eligibility per bucket and
had no member list to hand, and `emptyPools` reports a pool only when EVERY code
in it is empty: a genuinely unstaffed bucket sharing a pool with one staffed by a
hand named member was neither paged nor cleared, but fell out of the sweep
entirely. An alarm going quiet about the thing it watches is the worst direction
for one to fail, and the admin page offers to name a person on any row, so it was
one click from live. The member read is `unwrap`ped like the roster read, because
a swallowed error arrives as "nobody is named on any bucket", which restores the
coarse key silently on the one run that could not check.

## The screens report pools too (#2237)

- **`/admin/tiers`** shows fifteen rows, each naming the pool and every bucket
  code it serves, and its counts count pools: "5 on a single agent today" used to
  mean five CODES, which is not five problems.
- **The thin tier notice** lists pools. Its list caps at eight names, so ONE thin
  pool consumed six slots and hid every other finding behind "(and N more)" while
  the headline read six times the number of real problems.
- **`/admin/buckets` keeps a row per bucket** and gains a **Pool** column, placed
  right of the three digits so a reader sees the decomposition and then sees that
  the Legal digit does not change the pool. The rows stay because each is a
  record somebody edits on that page, and collapsing them would take that away.
  Its summary reports both numbers ("60 buckets across 15 routing pools"); it
  used to print the ROW count under the word "pools", which said "60 pools".

`groupRowsByPool` (`src/lib/admin/pool-rows.ts`) is the shared collapse, and
`sameTierReading` is the one predicate that decides whether two rows may share a
row or a line. A pool whose rows DISAGREE is not collapsed at all: showing one
number under a heading covering six would drop five readings on a screen whose
job is to report them. That cannot happen while the pool key covers every input,
which is exactly why it is guarded.

# Does production hold a table no migration created? (`pnpm verify:table-drift`)

Every table guard in this repo enumerates from the MIGRATION FILES: the RLS scan, the
grants scan (#2271), `applied-content.lock`. A table that exists only in the database is
exempt from all of them by construction, and invisibly, because a scan that never reached
it and a scan that found nothing wrong produce the same empty result (L96, L456, L98).
#2271's blanket `grant ... on all tables in schema public` reaches such a table while
nothing says whether its RLS is right.

`pnpm verify:table-drift` compares the two sides. It reads production and writes nothing.
The live list comes from PostgREST's own root document, so it needs no function added to
the database to ask a question about the database, and the declared list goes through the
repo's own `parseDeclaredTables`, so the two sides cannot disagree about what declared
means. Measured 2026-09-17: 41 live, 40 declared, one difference.

That one is `availability_rules_backup_1255`, the snapshot the roster hours backfill took
before rewriting every agent's week. It is RECORDED in `KNOWN_UNDECLARED_TABLES`
(`scripts/lib/table-drift.ts`) with a reason and the issue that removes it, rather than
excused by a filter: an entry whose table has since gone is reported as dead config, so a
record cannot outlive what it covers. Dropping a safety copy is somebody's decision, which
is why the command records it rather than acting.

Exits: 0 agreement, 1 no credentials, 2 nothing read (an empty list on either side is a
read or a parse that did not work, never a database or a repo with no tables), 3 the live
read failed, 4 a table nothing declared and nothing records, 5 a table the migrations
declare and production does not have, 6 a record covering a table that is gone. It exits on
its worst finding and reports every one, so a departed table cannot hide an undeclared one.
Decision logic is pinned offline by `scripts/test-table-drift.ts`.

# Capped single-page reads (the `// cap-safe:` convention)

PostgREST returns at most **one 1000-row page** per list read. Code that then
does `.length`, `.filter()`, `.map()`, or `.reduce()` on the result treats a
truncated page as the whole set, and the read silently under-counts. This class
shipped as #35 / #166 (the availability cache came back short and the booker
over-offered slots) and false-passed a #440 soak invariant. Two static guards,
both run by `pnpm test`, block a **new** capped read from reaching main:

- **`scripts/test-capped-reads.ts`** (#730) scans `scripts/loadtest/**` and
  `scripts/smoke-*.ts` for the raw `fetch(...select=...)` shape (and wrappers
  like `pgGet` / `getJson`) whose result feeds a count or aggregate. Cap-safe
  here means the read goes through the paginating `listAll` or server-side
  `count` helper (`scripts/loadtest/invariants.ts`), carries an explicit
  `limit=`, is a single-row `rows[0]` grab rather than an aggregate, or carries
  the opt-out below.

- **`scripts/test-src-capped-reads.ts`** (#822) scans production `src/` for the
  supabase-js `.from("t").select(...)` shape that the fetch detector cannot see.
  It only flags reads on a **growth table** (see below).

The scan logic for each lives beside it in `scripts/lib/scan-capped-reads.ts`
and `scripts/lib/scan-src-capped-reads.ts`, so both are unit-testable, and each
guard carries a positive control proving it still catches the bad pattern.

**To fix a flagged `src/` read**, paginate it (`selectAllPages`,
`src/lib/supabase/paginate.ts`) or give the chain a bounding signal. A
growth-table SELECT is cap-safe when it carries ONE of:

- `.single()` / `.maybeSingle()` (at most one row),
- `.limit(...)` / `.range(...)` (an explicit bounded or paginated page),
- `.csv()` (streamed, not a row array),
- `{ ..., head: true }` (a server-side count, no rows returned),
- `.eq("id", ...)` / `.in("id", ...)` (a primary-key lookup, bounded set).

A write (`.insert` / `.update` / `.delete` / `.upsert` reached before any
`.select`) is not a read and is never flagged. A reused builder
(`let q = db.from(...).select(...); ...; await q.range(...)`) is handled: a bound
applied on a later line still counts.

**The escape hatch** (both guards) is a one-line opt-out sitting on, or in the
block of `//` comment lines directly above, the read:

```ts
// cap-safe: idempotency_key is unique, so this returns at most one row
const rows = await pgGet("booking_reservations?select=id&idempotency_key=eq.abc");
```

Use it only when the set genuinely can never exceed one page, and say why.

**Growth vs roster-bounded.** The `src/` guard is table-aware. Roster-bounded
config, singleton, and lock tables are capped by the design target (100 to 200
agents, ~60 buckets) or a fixed key space, so they can never fill a page and are
never flagged. The allowlist (`SAFE_TABLES` in `scan-src-capped-reads.ts`) holds
`organizations`, `users`, `buckets`, `bucket_members`, `availability_schedules`,
`agent_calendars`, `event_types`, `webhook_endpoints`,
`monitor_settings`, `monitor_alert_config`, `alert_state`, `bucket_slots`,
`sync_locks`, `rate_limits`, `reschedule_locks`, `lane_heartbeats`, and
`selfheal_scan_cursor`. **Every other table defaults to a growth table (flagged):
a new table must be justified, not silently unguarded.** When you add a table
whose row count is bounded by the roster rather than by booking volume or time,
add it to `SAFE_TABLES`; otherwise leave it off and make each read cap-safe.

# Swallowed-error reads (the `// error-ok:` convention)

A read that destructures `const { data } = await db.from("t").select(...)` and
ignores `error` fails silently: when the query errors (a missing column on a
half-applied migration), `data` comes back null, the availability pool collapses
to empty, and the booker shows NO times, a broken deploy that looks like a quiet
day. That was #277; it routed the availability-critical reads through **`unwrap`**
(`src/lib/db/result.ts`), which throws on a real error and passes a not-found
(`data: null, error: null`) through unchanged.

**`scripts/test-swallowed-error-reads.ts`** (#315) keeps that invariant from
eroding. It scans `src/lib/availability/*`, `src/lib/booking/*`,
`src/lib/google/*`, `src/lib/routing/*`, `src/lib/salesforce/*`,
`src/lib/webhooks/*`, `src/lib/ooo/*`, `src/lib/monitor/*`, `src/lib/provision.ts`
and the whole `src/app/admin/**`, `src/app/me/**` and `src/app/api/cron/**` trees,
and fails on an awaited SELECT whose `error` is never consulted. The scan logic lives in
`scripts/lib/scan-swallowed-error-reads.ts` (unit-testable), and the guard carries
positive controls (stripping the opt-outs from the real `booking/service.ts`, and
reverting `staffing-depth-load.ts`'s four unwraps, must both be caught) so it can
never rot into a no-op.

**It reads FOUR shapes, and each was added because the previous set read a live
instance of the bug as a clean tree.** Until #1629 it saw only
`const { data } = await ...`. The second shape is the result object bound whole
and read later:

```ts
const [usersRes, bucketsRes] = await Promise.all([...]);
const users = (usersRes.data ?? []) as User[];   // and usersRes.error read NOWHERE
```

`src/lib/routing` had been in the scanned paths since #865 with
`staffing-depth-load.ts` reading four tables exactly that way, and the guard
reported clean over it on every run: a scanner blind to the shape and a clean tree
produce the same empty result (L98). So widening the paths alone would have fixed
nothing, and widening the shape alone would have left the admin surface (where the
empty answer is most convincing) unguarded. Both were widened together.

The third and fourth shapes (#1641) are the ones where the result never gets a
name at all, so no earlier shape could reach them:

```ts
const buckets = ((await db.from("buckets").select("*").in("id", ids)).data ?? []) as Bucket[];

const results = await Promise.all(queries);
for (const r of results) for (const row of (r.data ?? []) as Booking[]) byId.set(row.id, row);
```

The second of those is the weak-match booking lookup on the booking hot path. A
failed query resolved to an empty candidate list, which is not "no failure" but
the specific answer "this lead has no call booked", so the dedupe gate passed and
a SECOND booking was created for someone who already had one. There is no
compliant way to write an inline `(await ...).data` (nothing can consult an
`error` on a result that never exists as a value), so it is `unwrap` or the
opt-out.

**One shape stays deliberately out of scope**, and is named in the scanner's own
header so the next instance of it is not assumed covered: an array destructure of
object patterns, `const [{ data: a }, { data: b }] = await Promise.all([...])`.

A read is **compliant** when it does ONE of:

- routes through `unwrap(await ...)` (or a paginating helper like
  `selectAllPages`), so a real error throws;
- also destructures `error` (`const { data, error } = ...`) and checks it;
- is a write, not a list read (a `.insert`/`.update`/`.delete`/`.upsert` reached
  before the `.select(`, the "update ... returning" shape); or
- carries the `// error-ok:` escape hatch below.

**The escape hatch** is a one-line opt-out on, or in the `//` block directly
above, the destructure, for a read that DELIBERATELY tolerates a null/empty result
on error:

```ts
// error-ok: best-effort worklist; a read error skips this tick and the lane retries
const { data } = await db.from("pending_event_deletions").select("*").limit(n);
```

Use it only when a swallowed error degrades to a genuinely SAFE path (a retry next
tick, a re-route, a caller null/empty branch), and say why. A read whose swallowed
error would silently show no availability must use `unwrap` instead. On the
result-object shape the opt-out may sit above the binding OR above the `.data`
read, because the two are routinely tens of lines apart and the reason belongs
where the reader of the empty value is.

### The count-shaped twin: `unwrapCount` (#1165)

The same defect wears a second shape. A query asked for `{ count: "exact" }`
returns `count: null` when it FAILS, and the `count ?? 0` every call site writes
turns that into a healthy-looking **"0 rows"**. A `delete({ count: "exact" })`
that never ran then reports `blocksDeleted: 0`, indistinguishable from having had
nothing to clean, which is how stale cached busy time survived the #248 backstop.

Use **`unwrapCount`** (`src/lib/db/result.ts`), the count-shaped sibling of
`unwrap`: it throws on a real `error` and passes a null count with no error
through as 0. `scripts/test-swallowed-count-results.ts` scans **all of `src/`**
and fails on an awaited supabase chain destructured for `count` without also
binding `error`. Two deliberate differences from the read guard: a **write is
flagged too** (the delete case is the headline), and `.select(` is not required.
The same `// error-ok:` escape hatch applies, and the same question decides
whether you may use it (below).

## Ask what the EMPTY result means downstream, not just what the read does

The question that decides `error-ok` vs `unwrap` is not "can this read fail
harmlessly", it is **"can anything downstream read the empty result as an
answer?"** Two classes, and the comment must say which one it is:

- **Empty degrades to a safe path.** Nothing acts on the emptiness: the tick
  skips, the caller re-routes, the value falls back to a documented default, the
  next run retries. `error-ok` is correct. Say what the safe path IS
  ("the 1-min cron backstop reconverges", "the guard re-routes"), not just
  "best effort".
- **Empty is indistinguishable from healthy, or from within-limits.** Something
  downstream treats the empty result as a real answer. Then it must fail loud
  (`unwrap`) or return an explicit unknown (`null`), never `[]` or `0`.

The second class keeps shipping because the read looks local and the consequence
is three files away. Every instance so far:

- **#277** an availability read returned empty, the pool collapsed, the booker
  showed no times and a broken deploy looked like a quiet day.
- **#1134** `loadFailingAgents` returned `[]`, which meant "no agents failing",
  which posted "calendar sync has recovered" off a query that never ran.
- **#1165** a pool-exit prune reported `blocksDeleted: 0` for a delete that
  errored, which reads as "nothing needed cleaning"; the last-admin guard scored
  a failed count as zero admins and refused with a claim it never measured; and
  the header's pending-approvals badge vanished on a broken read exactly as it
  does when the queue is empty.
- **#1629** the admin page read six tables as `(res.data ?? [])`, so an unreadable
  table drew the same screen an empty one draws (no agents, no buckets, nobody in
  any pool, nothing ever sent to Regal), and two of those blanks sat beside a
  control that would have written them back as fact. The same read shape in
  `loadTierDepths` returned an empty depth list, which `/admin/tiers` rendered as
  "No tiers yet" and which the availability canary scored as **zero staffed
  buckets** and answered a healthy **200** on. `loadTierDepths` throws now, and
  every caller maps that to an explicit unknown: the canary answers 503 with
  `staffedBuckets: null` rather than `0`.
- **#1641** the weak-match booking lookup read its query wave as
  `for (const r of results) ... (r.data ?? [])`, so a failed read arrived as "this
  lead has no call booked", the one-call-per-person gate passed, and a second
  booking was created: a second invite, a second slot consumed, `booking.created`
  fired twice. The confirmation-screen warning that was supposed to catch it runs
  the SAME query on the SAME table, so it was blind in exactly that failure
  (L345). The read `unwrap`s now and the booker REFUSES with a retriable 503,
  reversing the fail-open this path shipped with.
- **#1152** three self-heal worklist reads returned `[]`, the resulting count of
  zero read as "under the cap", and that posted "the backlog has cleared, no
  action is needed" while clearing the streak that would have paged. The same
  audit found `agentActiveBookingStartsMs` returning `[]`, which counts as "no
  bookings that day" and quietly waived an agent's daily cap.
- **#2383 and #2511** widened the scanned paths to the monitoring tree and the
  cron lanes together, because a path list grown one incident at a time leaves
  everything not yet on it exempt from the check meant to catch it (L96), and
  fixing either surface alone would have left the other reading as covered. The
  two daily time off lanes were the live cost: the approvals digest answered
  `{ sent: false, count: 0 }` under a comment saying "Skip silently on empty
  days" and the pending digest answered `{ sent: 0, pending: 0 }`, so a failed
  `ooo_requests` read at 7am or 9am ET meant no CSV and no manager nudged on a
  200 that looked like a quiet morning, with no second attempt: the approvals
  window is yesterday relative to the clock, so a dropped day falls out of every
  later run. Their two `users` reads degraded into a CSV naming nobody and a
  whole queue posted to the fallback channel as unrouted. All four `unwrap` now.
  The fifth, the monitor lane's cal.com override retry, returned "failed: agent
  has no email" for a read that never ran, a claim about the agent nothing
  measured (L11) that was written into `side_effects` and quoted in Slack; it
  gets its own outcome, which is still a failure, so the row stays in the
  candidate set and no all-clear is cleared off it.

Note the asymmetry that keeps catching people out: **`null` and `[]` are not
interchangeable.** `busyIntervalsForAgent` returns `null` for "could not tell" and
its caller re-routes on it; the daily-cap read next to it returned `[]`, borrowed
that comment, and meant the opposite.

Two guards cover the alerting end of this, both in `pnpm test`:
`scripts/test-swallowed-error-reads.ts` (the read shape) and
`scripts/test-all-clear-failure-coverage.ts` (#1152: every module that sends a
recovery notice must carry a test proving it stays silent when its health signal
cannot be read, or point at the suite that does with `// all-clear-proof:`).

# Unchecked writes in a server action (the `// write-ok:` convention)

The same defect wearing its third shape, and the one the two guards above were
blind to by construction. A server action that awaits a WRITE and throws the
result away:

```ts
await db.from("booking_settings").upsert({ id: 1, public_booking_paused: paused }, { onConflict: "id" });
await recordAudit({ action: "booking.settings", details: { public_booking_paused: paused } });
redirect(`/admin/business-hours${savedQuery("booking-paused")}`);
```

supabase-js does not throw on a statement Postgres refuses; it resolves
`{ error }`. So on a refusal (a half applied migration, an RLS or grant change, a
statement timeout) that runs to completion: the admin is shown "Online booking is
stopped", the audit trail records `public_booking_paused: true`, and the embed
keeps taking bookings. The record written to answer "were we taking bookings at
3am" answers it with a confident wrong value, which is the one question it exists
for (#2379, L529, L12). **The kill switch is the headline and the role change is
its twin**: `setUserRole` recorded `admin` to `agent` for a role that never
changed, so a revoked admin kept admin. Eleven writes in
`src/app/admin/actions.ts` were written this way.

**The class was invisible, and that is the part worth remembering.**
`scripts/test-swallowed-error-reads.ts` skips a chain whose mutator is reached
before its `.select(`, and said in its own header that a write is "a different
concern". True, and with nothing on the far side of that boundary it read as a
class somebody had handled (L400).

`scripts/test-unchecked-writes.ts` is the guard, and it is the sibling of the
read one: that one asks whether an `error` was BOUND, this one asks whether the
result of the write went anywhere at all. It scans every `src/app/**/actions.ts`
(walked, never a hand written list, so a new action file is covered by
construction) and flags an awaited Supabase chain carrying `.insert(` /
`.update(` / `.upsert(` / `.delete(` that appears as a bare EXPRESSION
STATEMENT. The result of one has nowhere to go, so nothing anywhere can consult
its `error`. Scan logic in `scripts/lib/scan-unchecked-writes.ts`.

Compliant shapes: bind `{ error }` and refuse, bind the whole result to a name,
or return it to the caller.

**Refuse BEFORE the audit entry, before `revalidatePath`, and before the success
redirect**, and say so on the page the form is on. The wording is built in one
place, `writeRefused` in `src/app/admin/actions.ts`, which also logs the full
error: eleven saves must not drift into eleven ways of saying the same thing
(L41). Which mechanism to use is decided by the ACTION, not by this rule: an
action that already refuses with `redirect(...?error=)` does that, and one that
already throws throws. A third pattern on one form is worse than either.

**The escape hatch is `// write-ok: <why>`**, on or in the `//` block directly
above the statement, for a write nothing downstream reads as having happened: no
audit entry claiming the value, no success notice, no cache invalidation standing
in for the change.

It is deliberately NOT the siblings' `// error-ok:`. Putting a second rule behind
an existing suppression token silently widens every existing use of it (L448),
and an `// error-ok:` is written about a READ: it would then exempt a write
sitting under the same comment block, which is exactly the pairing an action that
reads a row and then writes it produces. A fixture pins that.

**Scope, so a green run is never read as more than it is.** This sees the
DISCARDED result and nothing else. A result bound to a name and then never
consulted (`const res = await db.from(...).update(...)` with `res.error` read
nowhere) is the same defect and is NOT flagged: it is the result-object shape the
read scanner already covers for reads, and it has not appeared once on this
surface. If one turns up, widen the shape there rather than assuming it is
covered here.

# Raw `Date.parse` on a timestamp (the `// parse-ok:` convention)

`Date.parse` returns **NaN** for anything it cannot read, and every comparison
with NaN is false. So the check lands on the healthy / permissive branch with no
error raised anywhere: not stale, not expired, not due for retry, **does not
overlap**. #1169 found ten monitoring sites like this; #1171 found the same class
on the verify-on-book path, where an unreadable busy interval from Google read as
**free time** on the last check before a booking.

Use **`parseStampMs`** (`src/lib/date/stamp.ts`), which returns a number or
`null` and forces you to map `null` to the fail-safe side (stale for a heartbeat,
due for an expiry, "never sent" for a cooldown). For a pair of interval bounds,
`isReadableInterval` (`src/lib/booking/core.ts`) is the single judge of whether
Google gave us something usable.

`scripts/test-date-parse-guard.ts` (#1171) scans the surface where an unreadable
stamp is **indistinguishable from healthy**: `src/lib/monitor`, `src/lib/notify`,
`src/lib/snowflake`, `src/lib/google`, `src/app/api/cron`, `src/app/api/health`,
and `src/lib/booking/core.ts`. A site is compliant when it routes through
`parseStampMs`, is judged on the same line by `Number.isFinite` / `Number.isNaN`
/ `isNaN`, or carries a **`// parse-ok:`** opt-out (per line, like its siblings)
saying why NaN is impossible or safe there.

The wider booking / availability domain is deliberately **out of scope**: ~40
parses there read our own NOT NULL `timestamptz` columns, and blanket-annotating
them would trade real thought for mechanical comments (the same call made for the
table-aware capped-read guard). That boundary is stated in the guard's header so
it is never read as broader coverage than it has.

When you write the opt-out, say which way it fails. `hasBlockingBusy` fails
**closed** (a NaN bound makes the block read as blocking, never free) and that
rests entirely on its `Math.max` / `Math.min` and `os >= oe` ordering, which is
why a test pins it. Do not restructure that comparison without rechecking it.

# Backfilling a mirrored table (the `export-cursor-ok:` convention)

The Snowflake export walks each mirrored table on a **strictly forward** keyset over
its watermark (`export_cursor`), so a row committed with a watermark EARLIER than
the cursor is never fetched again and the mirror never gets it. A backfill or
correction is exactly when someone writes rows with old timestamps: on 2026-08-03 a
269 row OOO audit backfill stranded 251 rows this way, and the only symptom was a
drift page hours later (#1231).

**A backfill owns its own reachability: rewind that table's `export_cursor` in the
same change as the write.** Re-exporting is safe (the load is a MERGE on `id` with
no DELETE). `scripts/sql/backfill-ooo-audit-1220.sql` is the worked example and
`docs/migrations-runbook.md` has the statement plus the temporary retention pause it
causes.

`scripts/test-mirror-backfill-cursor.ts` fails a migration or script that writes a
mirrored table's watermark column with no rewind in the same file. DML inside a
`$tag$ ... $tag$` function body is out of scope (it runs with a current watermark),
as is `src/` runtime code. The escape hatch is `-- export-cursor-ok: <why>` (`//` in
TS) on or above the write. Hand-run SQL is out of reach of any repo scan, so the
6-hourly reconcile lane also counts rows strictly behind the cursor against the
warehouse count, which pages on a single stranded row with no tolerance.

# Departing and returning an agent (the `// lifecycle-write-ok:` convention)

One module decides which columns a departure and a return move:
**`src/lib/offboarding/lifecycle-write.ts`**. Leaving the pool stamps
`deactivated_at` AND clears `bookable`, in one statement; returning writes
`bookable` false, so re-entry to the routing pool always goes through the
activation gate.

That last clause is the part that reaches a lead. The calendar reachability probe
and the pool entry bootstrap live ONLY on the `bookable` flip
(`applyBookableByUserId`, `onboardIntoPool`), so a row that never stopped being
bookable is routable the instant somebody clears `deactivated_at`, with no probe,
no bootstrap, an empty availability cache and a retained sync token that keeps
every minute lane on an incremental pass. Dan's rule, 2026-09-14: no agent is
bookable until every one of their calendars READS.

It is a guard rather than only a helper because the rule has already been copied
badly once. #1324 fixed the offboarding service and wrote the rule down; the
hourly Salesforce reap kept its own `update({ deactivated_at })` for six weeks
(#2386), so every leaver it processed stayed marked bookable and every count of
the bookable pool overstated itself. A shared constant would not have stopped
that, because the copy never reached for the shared thing (L370).
`scripts/test-deactivation-write.ts` fails the build on a `.update(` naming
`deactivated_at` anywhere else in `src/`, following one hop through a local
`const`. The escape hatch is `// lifecycle-write-ok: <why>` on, or in the `//`
block above, the write, and it is refused when it carries no reason.

The two callers' QUERIES legitimately differ and stay with them: the lifecycle
service writes one row as a compare and swap and reads it back, the reap writes a
batch of ids. What may not differ is which columns move.

# Adding a webhook event (#1459)

`emitWebhook` delivers only to endpoints whose stored `events` array **contains**
the event (`.contains("events", [event])`). Zero matches is not an error: the map
over the empty endpoint list resolves, the outbox step is marked done, and the
event is gone with no failure, no alert, and no delivery row. So adding a value to
the `WebhookEvent` union ships it **inert**, and it stays inert until somebody
remembers a database update that lives nowhere in the repo.

The subscription is a database column no code change touches, so **both halves are
guarded, each blind where the other looks**:

- `scripts/test-webhook-event-subscribers.ts` compares the union against the
  migration **DEFAULT**, which is what a NEW endpoint is created with. It can say
  nothing about the endpoint that already exists.
- the monitor lane's `webhook_subscribers` step reads the **live rows**, which is
  the only thing that can notice the existing endpoint was never updated. The one
  live Regal endpoint predates every event added from here on.

So adding an event means three things, not one: the union in `src/lib/db/types.ts`,
the map in `src/lib/webhooks/events.ts` (a `Record<WebhookEvent, true>`, so `tsc`
names the omission), and a **`webhook_endpoints.events` update on the live row**.
`src/lib/webhooks/regal.ts` also keys its label map on the union, so `tsc` catches
that one too.

To ship an event deliberately unsubscribed, add it to `DELIBERATELY_UNSUBSCRIBED`
(`src/lib/webhooks/events.ts`) with a reason **and the issue that will subscribe
it**; both guards then stay quiet about it and the guard rejects an entry with no
issue number. Delete the entry in the change that subscribes it.

# Read alert copy before it ships (`pnpm preview:alerts`, #1153)

Alert copy is a contract with a person holding a phone mid-incident, and it was
the one user-facing surface in Slate that could not be looked at before it
shipped. The 2026-07-28 page proved the cost: eight lines of raw Google JSON cut
off mid-word, advice to re-authenticate an account the same message called
self-healing, and "1 of 97 bookable agent". Unit tests assert substrings, so none
of that was visible until Slack rendered it at 7am.

**Run `pnpm preview:alerts` before changing any alert wording, and read the diff
in review.** It prints every alert, grouped by key, in each state that reads
differently (singular and plural, measured and unreadable, page and all-clear).

The rule that makes it trustworthy: **the preview CALLS the real copy builders,
it never holds its own copy of the wording.** That is why alert text lives in
pure builders (`*/alert-copy.ts`, `lane-copy.ts`, the `format*` functions) rather
than inline at the send site: a preview showing text that is not what ships would
be worse than no preview (L41).

`scripts/test-alert-preview-coverage.ts` keeps it honest: every catalog key has a
rendered state, every condition previews its all-clear too, the render is
deterministic (so a diff means the copy changed, not the clock), and no message
renders `undefined`, `NaN`, `[object Object]`, a leaked null, or a raw JSON blob.
A new alert cannot ship unreadable.

Note the guard also fails an alert that OPENS with the word **Slate**. In Slack
every one of these arrives under Slate's own app name and icon, so a "Slate:" (or
"Slate routing check:") label repeats the header and pushes the one fact worth
having further along a line read on a phone. Naming Slate inside a sentence is
fine and often necessary.

# Read lead-facing copy before it ships (`pnpm preview:booker`, #1343)

The copy a CUSTOMER reads had the same gap alert copy did: no way to look at it
before it shipped. The 2026-08-07 design session was a person clicking through a
mockup one screen at a time, catching a policy sentence that made the panel about
us, a message saying "pick another" without saying another what, dates in British
order, a pronoun we cannot know, and two sentences running together on one line.
None of it could have been found by reading the code.

**Run `pnpm preview:booker` before changing any wording on the booker or the manage
page, and read the diff in review.** It prints every string a lead can read (68
lines across 13 screens), grouped by screen and by the state that produces it,
including the lines only assistive tech hears.

The rule that makes it trustworthy is the same one as `preview:alerts`: it CALLS
the real copy builders and holds no wording of its own (L41). That is why the copy
lives in `src/lib/booking/booker-copy.ts` and `manage-copy.ts` rather than inline
in the components. **A string a lead can read belongs in those files**; the
component keeps the markup (a link, a tabular-nums span, a heading level), the
builder keeps the words.

Two guards, and each is blind where the other looks:

- `scripts/test-booker-preview-coverage.ts` (node): every state renders a real
  string, nothing leaks `undefined` / `NaN` / a raw blob, the render is
  deterministic (a builder reading the clock fails the build), the copy rules hold
  (no dashes, no emoji), and **no literal may be assigned to a `text` in the
  preview**.
- `src/components/copy-preview-parity.test.tsx` (vitest): mounts the real
  components and asserts the BUILDER's exact output is on screen. A static scan
  cannot mount React, so without this a component could go back to holding its own
  inline sentence while the preview rendered happily from the builder, showing text
  that no longer ships. That is worse than no preview, because it would be believed.

## A copy builder takes its clock (the `// clock-ok:` convention, #2497)

A sentence naming a day ("today", "tomorrow", "Thursday") is a relationship
between the appointment and the reader's present, so a builder that pins one end
and reads the other for itself renders a different sentence every day from the
same input. `dayWord` in `src/lib/booking/reminder.ts` did exactly that: its test
pinned the clock to a constant, the suite passed on the day it merged and went red
at midnight on 2026-09-17 with no code change, which skipped main's deploy and left
#2484's monitoring floor merged and not live.

**The determinism check that was supposed to catch it structurally could not.**
Rendering twice and comparing cannot see a clock read, because the clock does not
move between two renders a millisecond apart, so it read clean over the defect it
is named for (L713). `scanCopyClockReads` (`scripts/lib/scan-copy-clock-reads.ts`)
is the half that works: it reads the SOURCE of every copy module in
`src/lib/booking` plus `reminder.ts`, enumerated by GLOB rather than a hand written
list, so a module added tomorrow is covered by construction (L96).

It matches four spellings as text (`Date.now(`, `new Date()`, `DateTime.now(`,
`DateTime.local(`) and says in its own header what it cannot see: a clock reached
through an imported helper or an injected collaborator is not flagged.

**The escape hatch is `// clock-ok: <why>`**, on or in the `//` block directly
above the line, refused when it carries no reason, and a refused one is reported as
an unreasoned hatch rather than as a plain clock read, since the two send a reader
to do different things. It is deliberately its OWN token and not `error-ok` or
`parse-ok`: those are written about a database read or write, and putting a second
rule behind an existing suppression widens every existing use of it (L448).

**The alert copy preview still has the blind spot** (#2502): it proves determinism
by the same repeat and scans no builders. Its builders are clean today.

# Condition vs incident: which alerts get an all-clear (#1151)

Every alert key Slate can send is classified in **`src/lib/notify/alert-catalog.ts`**
as one of three things, and the classification decides whether it may ever send a
recovery notice:

- **condition**: an ongoing state that is true until something changes it (a lane
  is quiet, a mirror has drifted, retention is stopped, an endpoint is
  dead-lettering). Someone reads the page and then needs to know when it is over,
  so a condition **must** have a `resolveAlert` (or `resolveRecovered`) on the
  same key.
- **incident**: a finished event with no healthy state to observe (this booking's
  event insert failed, this reassign was abandoned, this request 500'd). An
  all-clear here would say "the thing that already happened has stopped
  happening", which is noise. An incident carries **no** recovery and records why.
- **info**: a `sendThrottledInfo` whisper that never needed action, so it must
  never resolve either.

The test that decides it: **if this cleared, what would the all-clear SAY?**

`scripts/test-alert-recovery-coverage.ts` checks the catalog against the code both
ways: every key the code sends is classified and on the right channel, every
condition really resolves, no info or incident does, and no catalog entry names a
key nothing sends (so a rename cannot leave a stale classification looking like
coverage). A key the scanner cannot read is a hard failure; declare it with
`// alert-key: <key or prefix:*>` on or above the call.

One shape defeated that scanner for three releases and is worth knowing (#1400).
A pure check sends through an injected seam (`deps.notify(SOME_KEY, ...)`) and the
route wires the dispatcher in. If the wiring is an ARROW
(`notify: (key, ms, text) => sendThrottledAlert(key, ms, text)`) that arrow is a
call whose key cannot be read, and an unannotated opaque site is a hard failure,
so it was always covered. If the wiring is a bare REFERENCE
(`notify: sendThrottledAlert`) it is not a call at all, produced no site, and the
key was invisible: **nine keys** lived in that gap, eight with no catalog entry
and one (`sync_staleness`) paging with no way to say it had ended. Both forms are
scanned now, and both require an `// alert-key:` declaration at the wiring.

Two rules that fall out of this, both of which have already been violated once:

- **Hang the all-clear off the MEASURED healthy result, never off "we did not
  alert this run".** A run that skipped, threw, or could not read its signal
  measured nothing and must clear nothing (#1134, #1152). Every module that
  resolves must prove that silent path; `scripts/test-all-clear-failure-coverage.ts`
  enforces it.
- **Use `resolveRecovered` from an every-minute lane** when clearing several keys:
  it settles them all with one `alert_state` read instead of one per key, on a
  subrequest budget four cron lanes share.

# Alert copy never carries a raw error (the `// alert-text-ok:` convention)

An alert is read on a phone, mid-incident, by someone deciding whether to act.
On 2026-07-28 a sync-failure page arrived as eight lines of Google's
pretty-printed JSON, cut off mid-word at `"mess` by a fixed-width slice (#1133).
The one fact worth having, a `503 backendError` that was already self-healing,
was buried in it.

**The alert carries a short human reason; the LOG carries the full text.**
Cloudflare stores every console line with the `Error` serialized, so nothing is
lost by keeping the body out of Slack, and `log.error(tag, fields, err)` is how
you get it back.

One formatter, `src/lib/notify/error-text.ts`:

```ts
shortFailureReason(row.last_sync_error)  // string | null, for a stored error
shortErrorReason(err)                    // string, for a caught unknown
```

It returns the status plus the machine reason for an HTTP failure
(`503 backendError`), and otherwise collapses the text to ONE line and truncates
on a word boundary, so a reader never gets a half word.

`scripts/test-alert-error-text.ts` (#1135) fails the build on a raw error
interpolated into `sendThrottledAlert` / `sendThrottledInfo` / `resolveAlert`
copy. It follows one hop through a local `const`, because the worst instance
built the string a line earlier and passed the name; it does NOT follow more
than that, and says so. The escape hatch, for a value that is already short and
human (a reason string we built ourselves), is `// alert-text-ok: <why>` on or
directly above the line.

Prefer pointing at where the detail lives over pasting any of it:
`Diagnose via booking_outbox.last_error; rows: ...` is the pattern to copy.

# Reading production logs (Cloudflare observability)

Cloudflare captures **every** console method from the deployed Worker, with the
`Error` object serialized. Nothing is dropped: a 250-line canary (#801) came back
100% at every level. So the "detail is kept server-side in the logs" guarantee in
`internalErrorResponse` (`src/lib/api/errors.ts`) is real.

**Never call `console` directly in `src/`** (ESLint `no-console`, error severity).
Every server line goes through **`src/lib/log.ts`** (#808):

```ts
log.info("recompute", { msg: "cycle", refreshed: 3, util_pct: 42 });
log.warn("lane-watchdog", { msg: "stale lane", lane: "outbox" });
log.error("booking", { msg: "insert failed", booking_id: id }, err);  // Error passed THROUGH
```

which emits `slate tag=recompute msg="cycle" refreshed=3 util_pct=42`. Two things
that kept being decided wrongly per call site now live in one place:

- **The level.** `console.log` is unreachable from the helper. It is the one method
  Cloudflare stores with **no `level` field**, so the line is kept but is invisible
  to every level-filtered query, which reads as a total drop. That "console.log
  doesn't come back" belief (and, before it, "console.error doesn't come back") were
  both the same false negative: a query that verified nothing, read as absence.
- **A searchable `tag=`.** Filter on `tag=booking-api` instead of guessing at a
  message substring. Pass the `Error` itself as the third argument so Cloudflare
  serializes its stack rather than it being flattened into text.

**Filter on the bare `message` and `level` fields, never `$metadata.message` /
`$metadata.level`.** The `$metadata.*` fields hold only *invocation* records (the
`GET https://slate.trypennie.app/...` line, or the cron expression for a
scheduled run). App console output lives in the bare `message` / `level` fields.
Query `$metadata.message` for your log text and you get zero rows, which looks
exactly like "Cloudflare is dropping our logs" and is how the false belief
started. Note this contradicts the Cloudflare MCP tool's own docs, which
advertise `$metadata.message` as the preferred key.

More gotchas, every one of which produces a convincing false negative (zero rows
from data that is really there):

- **Preview versions are not logged at all.** A version from `wrangler versions
  upload` serves traffic on its preview URL but emits **no** observability
  events, not even invocation records. Only the deployed version is captured, so
  a canary must run against a real deploy.
- **Any `level` filter hides `console.log`.** Search by `message` alone.
- **A `groupBys` on `level` returns an empty aggregation** even when a `level`
  filter matches those same rows. Filter and count; don't group.
- **The MCP `events` view throws on app log rows** (they have no
  `$workers.outcome`). The schema error means your query matched. Use
  `calculations` + `count`.
- **Ingestion lags a minute or two**, so a count run immediately after emitting
  returns 0, and a too-narrow window undercounts late arrivals.

**Run a positive control before believing any zero** (the every-minute `recompute
cycle` line is always there). If the control is also zero, the query is wrong.

**And check the control is RECENT, not merely present (#1533).** A passing control
proves the query shape, the credentials and the field names; it cannot prove the
query reached the part of the window you are asking about, because a line from
hours ago satisfies it as well as one from a minute ago. Measured on 2026-08-17
the query pipeline ran about **three hours** behind: `tag=recompute` returned 0
over 1h, 50 over 4h and 290 over 8h for a lane that emits every minute, while
`npx wrangler tail` captured lines live that the API reported zero of. That
produced a wrong conclusion the same day, a 4h window covering 14:44 reading as a
trustworthy absence when its recent end simply held nothing yet.

So the lag is usually small and can be hours. **For anything within the last few
hours use `npx wrangler tail`**, which streams live from the deployed Worker and
was accurate every time it was checked; it only shows traffic while attached, so
for a cron lane attach and wait one cadence. `scripts/logs.ts` now enforces the
rule: it reads the control's newest non-empty bucket and reports UNVERIFIABLE when
that is more than `CONTROL_FRESHNESS_MS` behind the window's end, in its own
wording so a lagging pipeline is never mistaken for a broken query.

**Stitching one request's lines together needs nothing from us.** Workers Logs has an
Invocations view that groups every line from one invocation, so a request's confirm-path
lines are already a unit. What that CANNOT do is join across invocations, and a booking's
side effects live in a later cron invocation: the join key there is `booking_id`, which
works because the outbox row carries it. That is the whole correlation story (#1047); a
generated request id would be worse for the cross-invocation case, since the drain has no
memory of the originating request unless it is persisted on the row, which is a schema
cost for no gain over the id already there. Some lines deliberately carry no identity at
all: contact data does not go in logs, so a pre-booking failure names the slot and the
agent rather than the lead.

Retention is 7 days and there is no alerting on top of it, so logs are for
forensics after the fact. Anything that must page someone still needs a real
sink (a Slack alert or an `alert_state` row); see the fail-loud rule.

Full detail, plus the Worker CPU and subrequest ceilings and the queries that
actually work, is in **`docs/cloudflare-platform-notes.md`**. Read it before
investigating a limits question or concluding the logs are broken.

# Screenshotting the dev UI (Playwright/Peekaboo)

Screenshots against `next dev` hang and time out — element shots wait forever on
CSS animations to "settle" (the `.pn-*` entrance/pulse keyframes never do), and
full-page shots stall on font loading. Before capturing, freeze motion by
injecting this style via `browser_evaluate`, then take the shot:

```js
const s = document.createElement('style');
s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
document.head.appendChild(s);
```

A JPEG capture also succeeds where PNG times out. Save outside the repo root
(or delete after) so stray images aren't committed.

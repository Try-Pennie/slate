# This is NOT the Next.js you know

This version has breaking changes: APIs, conventions and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` (resolved from that file's own directory) before
writing any code, and heed deprecation notices.

Next writes this advice into AGENTS.md itself when `next dev` starts, inside a
pair of `nextjs-agent-rules` markers, and its wording carries a character the
repo's style gate refuses. Every dev server run therefore re-added an unexplained
modification that blocked the next push, three times in one session on 2026-09-10
(#2201). `agentRules: false` in `next.config.ts` turns that off, this paragraph is
Slate's own copy of what the block said, and
`scripts/test-agent-rules-generation.ts` holds both halves: that the setting is
there, and that Next's installed generator really would still write a banned
character.

# This file has a size budget, and it is measured (#2393)

`CLAUDE.md` is loaded into every session and its first line is `@AGENTS.md`, so
every character here is paid on every request of every session. It grew from
51,740 characters on 2026-08-29 to 157,711 on 2026-09-17, a paragraph at a time,
with nothing measuring the total, which is how a file nobody decided to make
enormous becomes enormous.

**What the ceiling actually is, measured against Claude Code 2.1.274 rather than
assumed.** There is no per file character cut a rules file can reach: a probe
memory file carrying an unguessable end of file nonce was read in full at 400,105
characters, and at 2,000,043 characters the whole file was still counted into the
request rather than trimmed. What binds is the **request**, which is refused above
200,000 tokens with the memory payload counted inside it alongside the system
prompt, the tool definitions and the work. The exchange rate was measured on this
file: an otherwise identical session cost 61,314 prompt tokens with an eight
character memory file and 103,544 with AGENTS.md as it stood, so this file alone
cost 42,230 tokens, 3.73 characters per token and 21 percent of the whole limit.

So the budget is a share of the window: **125,000 characters for `CLAUDE.md` plus
everything it imports**, about 33,500 tokens, one sixth of the request. The
session also has to carry the machine's global config, the tool definitions and
the work itself. `scripts/test-auto-loaded-docs-budget.ts` measures it in
`pnpm test` and says how far over it is.

**When it fires, move a runbook section into `docs/` and leave the rule here with
a pointer**, the way the `verify:` commands went to `docs/verify-commands.md`. A
rule belongs here; an exit code table, a set of flags and a record of what one
live run measured belong beside the code, because they are wanted on the day
somebody runs the thing. Raising the number is a decision about what share of the
window this repo's rules may take, and it is made out loud.

# Git workflow: never reuse a merged PR branch

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
the isolated tree (#2571): the gzipped `.open-next/assets/_next/static/chunks`
total is judged by the shared measurer (`~/.claude/hooks/lib/bundle-budget.py`)
against the same record file the global `check-bundle-budget.sh` guard keeps, and
growth past 3% AND 10 KB refuses the push. The global guard reads the build in the
CHECKOUT, which this gate never builds in, so on every Slate push it still prints
its "build is stale, nothing judged" line; **this in-gate step is the one that
counts here.** A machine without the shared config gets a printed "not weighed"
skip, never a silent pass. `ACCEPT_BUNDLE_GROWTH=1` records the new total and
`SKIP_BUNDLE_BUDGET_CHECK=1` skips the weighing, each for one push and each said
out loud first. `scripts/test-prepush-bundle-budget.ts` pins the step's shape.

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

## The two things a workflow cannot report about itself (#2476, #2229)

Both live on the Worker's monitor lane
(`src/lib/monitor/github-ci-health.ts`, the `ci_health` step), for the reason the
canary gap filler lives there: an Actions workflow cannot report on Actions being
unavailable, because the run that would carry the report is the run that did not
happen. One listing of recent runs answers both, so the cost on the invocation four
cron lanes share is ONE subrequest per five minute tick, plus a second only when the
newest completed run failed.

- **`main_not_deployed`**: the live Worker's stamped commit (`BUILD_COMMIT`, #1037)
  is not main's tip, `DEPLOY_GRACE_MS` after that commit landed. A cancelled run
  never reaches `deploy`, and main only self corrects when another merge follows, so
  **the gap is the last merge of a burst**: merged, closed, `/api/health` green
  because the previous version serves perfectly well, and the fix somebody believes
  shipped is not running (L4). Measured 2026-09-16 during nineteen merges: three runs
  on main were cancelled with `deploy` absent, each covered by a later merge.
  A run that FAILED on main is recorded and does not page here, because
  `deploy-alert.yml` already pages on exactly that and two pagers about one fact is
  how both stop being read (L36).
- **`ci_runs_refused`**: the newest completed run's failed jobs executed **zero
  steps**, so nothing ran and there is no log. On 2026-09-10 that was ten red checks
  on a pull request under an annotation shown in neither `gh pr checks` nor the checks
  list, reading as the change having broken something. The discriminator is the steps
  rather than the annotation, which needs a `checks: read` scope this token is not
  guaranteed and which the message names as the thing to go and read. The verdict is
  "the jobs never started" and not "the account is out of credit", because an
  unallocatable runner looks identical and a message may claim only what its check
  measured (L11). While it lasts **nothing server side is watching main**: the push
  guard and the merge gap backstop are workflows too.

Neither clears on anything but a measured healthy reading: an unreadable or throwing
listing pages nothing and resolves nothing (#1134, #1152). Every verdict is drivable
with no network and no clock by `scripts/test-github-ci-health.ts`.

**The Actions BALANCE is deliberately not here.** #2229 also asks for a floor alert
before the allowance is zero, and the org billing endpoint needs a token carrying
`admin:org`, which neither `GITHUB_TOKEN` nor the canary token has. It waits on the
same fine grained token decision as #2264.

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

## A setting defined on the ORGANISATION (#2342)

`gh variable list` and `gh secret list` are **repo scope only**. A setting defined
on the org is perfectly usable by a workflow here and invisible to that listing, so
every reference to one read as missing. On 2026-09-14 that refused a push naming
seven settings that all existed, and the documented way through was the override,
which is how a guard stops being read (L36).

The check now asks the ORG as well, and a reference absent from repo scope is split
three ways rather than two:

- **present**: the org listing holds it. Not a finding.
- **missing**: the org listing was READ and does not hold it. Still a finding, still
  fails the push, still names the workflow and the `gh` command that creates it.
- **unchecked**: nothing available could answer. Reported as its own `note:` line
  (which the hook echoes) and never as a missing setting, because a reference nobody
  could check and one checked and found absent send two different people to do two
  different things (L11, L98). The summary line says how many of how many were
  judged, so a pass can never be read as more than it measured.

Two things reach `unchecked`, and the second is the one an eager union would get
wrong. The org listing being REFUSED is the obvious one: `gh api
orgs/Try-Pennie/actions/variables` answers 403 for the local token, measured
2026-09-14 and still true. The other is an org setting shared with a **selected**
list of repositories: the listing says how many repos it is shared with and not
WHICH, so counting it as present would wave through exactly the reference that
interpolates an empty string.

A repository owned by a PERSON has no org at all, so the endpoint answers 404. That
is an EMPTY org listing, not an unreadable one: treating it as unreadable would turn
every real finding into an unchecked one while printing reassuring output.

The org is asked only about what is left after the repo listing and the per-run
declarations, so a fully configured repo, and one whose only absences are declared,
both pay no extra round trips. `splitByOrgScope` and `classifyOrgListingError` are
pure and pinned offline by `scripts/test-workflow-env-coverage.ts`; the whole
checker is driven end to end through a stub `gh` by
`scripts/test-workflow-settings-checker.ts`, including a stub that FAILS every org
call, which is how "a configured repo never asks the org" is proved rather than
assumed.

**This is also what #2264's CI job would need.** A token that can read repo scope
and not org scope would report the org-defined settings as unchecked on every run,
so the job would pass while judging less than it looks like it judged.

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
`npx tsc --noEmit` never look at the node test suites (every `scripts/test-*.ts`)
or at the canary scripts that run against live prod every 30 minutes. That cost two things: an
undefined `failureLogPath` shipped in `scripts/smoke-booking-api.ts` and tsc
reported clean, and an undefined `calls` inside a test fake threw before the
fake recorded anything, so the guard for "a block-lookup read error aborts with
ZERO inserts" passed on its own typo and would have stayed green through a
regression into mass-inserting busy blocks (#1504, #1505).

The tree carries hundreds of errors, almost all nullable and shape mismatches in
test fakes, so it is **not** demanded to be clean, and the count is whatever
`npx tsc -p tsconfig.scripts.json --noEmit` reports on the day you ask rather
than a figure kept here (#2398). `tsconfig.scripts.json` plus
`scripts/test-scripts-typecheck.ts` (in `pnpm test`, so in the pre-push gate and
CI) run tsc over `scripts/` and fail on the two classes that ship broken:

- `TS2304`, an undefined name, which throws the moment the line executes;
- `TS2307`, an unresolved import, which throws on load.

The list lives in `scripts/lib/scan-scripts-typecheck.ts` (`BREAKING_CODES`).
Widen it by fixing a class and adding its code, which is a deliberate act rather
than a silent no-op. The guard plants a real undefined identifier and requires
itself to catch it, AND requires the run to have read every file the config
names, because a tsc run that never looked at `scripts/` and a clean tree
produce the same empty error list (L1, L98).

**The control is planted in a temp directory, never in the tree** (#2712).
Planted in `scripts/`, every concurrent suite walking that tree could list it and
fail to open it, which failed CI on unrelated PRs and once skipped a deploy on
main. `tsc -p` cannot add a file outside the config, so both guards drive the
compiler API on the real config (`scripts/lib/typecheck-program.ts`), and
`scripts/test-no-tree-writes.ts` fails any suite that writes a path it has not
proven to be ROOTED in a temp directory: a real `node:os` `tmpdir()` or `node:fs`
`mkdtemp` as the path's base, never merely inside it (`// tree-write-ok: <why>`
to opt out).

That scan reads a suite's own source, so it cannot see a write made by a child
process the suite starts. **`scripts/run-tests.ts` also watches `scripts/`, `src/`
and `worker/` for the whole run** (#2733) and fails it naming each path written,
but only in CI and the pre-push gate's isolated tree (`SLATE_TREE_TRIPWIRE=pre-push`),
because in your own `pnpm test` your editor's saves would trip it. Its first line
and summary say whether it was on; `SLATE_TREE_TRIPWIRE=on` arms it by hand.
Rules and allowed paths: `scripts/lib/tree-write-tripwire.ts`.

**The escape hatch** is `// typecheck-ok: <why>` on, or in the `//` block
directly above, the line, and it must carry a reason. The one use today is the
`?bust=1` cache-busting dynamic import in `test-alert-preview-coverage.ts`, which
no resolver can follow and which is the entire point of that check.

`worker/` is covered too now (#1050), and it is the file that most needed it:
`worker/index.ts` is what `wrangler.jsonc` points `main` at, so every request and
every cron tick passes through it, and esbuild bundles it without checking types.
`tsconfig.worker.json` uses `@cloudflare/workers-types` (scoped to that config, so
the Workers globals never enter the app's program) and
`scripts/test-worker-typecheck.ts` runs it, failing on the same two classes, with
the same out of tree control and the same proof the run read every file.

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
end to end pass. The pyramid is intentionally bottom heavy: the node script
suites (`pnpm test`, which prints how many it ran) plus the vitest suites
(`pnpm test:components`, glue and a handful of component tests) all run in the
pre-push gate and in CI, and
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

# The `pnpm verify:*` commands: proving a fail safe detector is not blind

The hand run `verify:` commands all exist because of one shape. A detector built
to fail safe reports `unverified`, `skipped` or `insufficient` rather than
guessing, and a detector that has NEVER ONCE CONCLUDED renders exactly like one
finding nothing wrong: "nothing to report" and "could not check anything" are the
same silence, in a dashboard and in a heartbeat alike. #1377 is the measured
case. The availability truth probe skipped every tick from the day it deployed
because the roster was dark before cutover, the lane heartbeat went on proving
the lane RAN, and its live half had never executed once.

Four rules hold across all of them, and they are the part worth carrying into a
session:

- **Ask the outside system, never Slate's own record.** What Slate stores about a
  busy block, an approved time off or an agent's routing facts was written by the
  very code under test, so a check built on it agrees with the defect (L58).
  These read Google, cal.com, Twilio or the deployed Worker.
- **Only agreement passes, and finding nothing to check is never a pass** (L98).
  Every other outcome exits on its OWN code, because "no cal.com account", "no
  schedule in cal.com", "the read failed" and "the payload changed shape" send
  four different people to do four different things, and one message answering
  for another is how somebody spends an afternoon on a rate limit (L11).
- **A fake cannot stand in for the live system** (L52), which is why these are
  commands and not suites. They are deliberately NOT named `test-*.ts`: that glob
  is the offline unit suite, and these need live credentials from `.env.local`.
- **Their decision logic is pinned offline anyway.** Each one's verdicts, exit
  codes and ranking are driven through hand written fixtures by a
  `scripts/test-*.ts` sibling, so the rules are tested where no network exists
  and a live run is spent only on the thing a fixture cannot answer.

The blindness is not confined to these commands, and the general remedy is worth
knowing wherever you write a detector. Any fail safe check can sit permanently
blind while looking healthy, so several carry a SECOND heartbeat stamp on top of
the lane's, written only when they reach a MEASURED verdict
(`src/lib/monitor/verdict-freshness.ts`), judged with `neverIsStale` ON because
"has never once reached a verdict" is the exact state this family exists to
notice (#1394). Nothing else may stamp, and `checked` alone is not enough: a
sample too small to judge also reports `checked`. Which detectors stamp, and each
one's bound, are in `docs/verify-commands.md`.

| Command | What it proves |
|---|---|
| `verify:availability-truth` | the times Slate is OFFERING are really free on the live calendars, asked of Google rather than of `busy_blocks` |
| `verify:ooo-protection` | an approved time off is really BLOCKING the agent, read as the event itself plus free/busy, because busy periods merge |
| `verify:pool-entry` | the activation gate's calendar reads work against real Google both ways: a readable agent hydrates every calendar, an unlicensed account is refused as not provisioned |
| `verify:burst-counter` | the `BURST_LIMITER` object is not merely bound but answers AND counts, which the monitor lane deliberately cannot ask |
| `verify:kill-switch` | the booking kill switch really refuses on the deployed Worker, the one gate here that fails CLOSED |
| `verify:calcom-parity` | Slate and cal.com hold the same roster and the same week per agent, which is invisible from inside Slate alone |
| `verify:twilio-parity` | Slate holds the routing facts Twilio is the source of truth for, and notices a `Redistribute` agent still bookable |
| `verify:router-replay` | Slate's ladder agrees with cal.com's choices on real leads, the only measurement of routing that exists before cutover |
| `verify:parallel-run-readiness` | the preconditions of a trustworthy shadow run, each judged by the code that already owns it, including trypennie's key seen from production (exit 13, #2717), plus the low volume alarms' arming preconditions, reported without gating while they are disarmed (exits 14 to 16, #2767) |
| `verify:pool-slot-parity` | the bucket codes sharing one availability pool really offer the same times |
| `verify:table-drift` | production holds no table that no migration created |

**The detail for every one of them, each exit code table, what it writes, which
credentials it needs, what its last live run measured and the decisions behind
it, is in `docs/verify-commands.md`.** Read that before running one, rather than
reasoning the flags out per command. Most of the family retires at cutover (#65),
since it only means anything while both systems are live; `verify:twilio-parity`
does not, because Twilio stays the place managers tag agents afterwards.

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
walks with the clock and nobody could tell that from a regression. How it paces
itself, what it measured before it shipped and its exit codes are in
`docs/verify-commands.md`.

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
`agent_calendars`, `event_types`, `webhook_endpoints`, `monitor_settings`,
`monitor_alert_config`, `business_hours`, `bucket_slots`,
`sync_locks`, `rate_limits`, `reschedule_locks`, `lane_heartbeats`,
`selfheal_scan_cursor`, `booking_failure_rate_state`, `export_cursor`,
`reason_options`, and `booking_settings`. **Every other table defaults to a
growth table (flagged): a new table must be justified, not silently
unguarded.** When you add a table whose row count is bounded by the roster
rather than by booking volume or time, add it to `SAFE_TABLES` (the constant
carries the per table reason); otherwise leave it off and make each read
cap-safe. This list is held against the constant in BOTH directions by
`scripts/test-auto-loaded-doc-claims.ts`, because it had drifted two tables
behind and was telling a reader that `business_hours` was flagged when it was
already on the allowlist (#2398).

`alert_state` was on that list until #2726 and is deliberately NOT any more. It
was roster bounded when it held only cooldowns for lanes and buckets, and stopped
being so the day an alert was keyed by booking (`booking_offsite_origin:<id>`,
`stale_phone_invite:<id>`, `booking_below_lead_tier:<id>`): an incident never
resolves, so those rows only ever accumulated, and the one pattern read over the
table (`firingFamilyMembers`) was a single capped page. Its key reads are
`.eq("key")` / `.in("key")` lookups on the primary key, which the guard accepts
through `PRIMARY_KEYS` in the scanner; a family read pages with `selectAllPages`.
Two halves keep the table from growing again, each blind where the other looks:
every `:*` family in `src/lib/notify/alert-catalog.ts` must declare what its
suffix is (`booking`, `bounded` or `caller`), and the daily
`prune-booking-alert-state` lane deletes the rows of every `booking` family once
that booking started and was made more than a week ago, with the family list
DERIVED from the catalog so a new per booking alert is pruned by construction.
`scripts/test-alert-state-retention.ts` pins both.

# An `in` filter fed from an unbounded list (the `// in-chunk-ok:` convention)

The capped read above is about a response that comes back SHORT. This is the
opposite end of the same table: a request that never goes out at all.

`.in("id", ids)` puts every id in the QUERY STRING, so a long enough list is
**REFUSED at the transport** rather than truncated. Measured against the real prod
PostgREST on 2026-08-04 with 36 character uuids: 350 ids (13,028 bytes) is accepted,
400 (14,878) is refused, 1,000 gives a 400 and 2,000 a 414. `MAX_IN_FILTER_BYTES`
(`src/lib/db/id-batch.ts`) sits at 10,000, well inside proven good territory, which
is roughly **266 uuids** per request.

**Bytes decide, never a row count.** That number was got wrong three times, every
time by carrying a count over from a call site whose ids were a different length
(#1259, #1267, #1268). So split with **`chunkIdsByUrlBudget`**, which measures the
ids it is actually given, and run the split with **`inIdChunks`**, which owns what
happens when request three of five fails.

**Splitting without accounting is the other half of the defect** (#2388). A sweep
that deleted two batches of five and then met a refusal must never answer as though
it finished: the remainder is real work nobody else picks up, and on a redaction lane
the finished batches are irreversibly blanked. `inIdChunks` therefore THROWS a
`PartialIdSweepError` naming how many batches and ids landed, and `destroyVerified`
adds the ROW count on its way past. A per BATCH zero rows check sits inside the loop
for the same reason: a sum cannot see one component collapsing (L367).

**The four retention lanes are covered by construction, not by a comment.** Each one
reads up to `MAX_VERIFY_BATCH` (500) candidates and hands `destroyVerified` a
`destroy(ids)` callback, and 500 uuids is roughly 18.6 KB, so every lane was refused
outright the first night a retention window opened on production volume: nothing
redacted, the same 500 candidates the next night, and the retention gate freezing the
export behind a permanent failure. The split is owned INSIDE `destroyVerified`, so
the callback is handed a batch and a fifth lane cannot be written without it. A rule
every call site must opt into is enforced by nobody (L621).

**The guard** is `scripts/test-unchunked-in-filters.ts`
(`scripts/lib/scan-unchunked-in-filters.ts`), which fails the build on an `.in(` whose
value is built from a list this repo read with `selectAllPages`, or with an exported
function whose own body pages. That reader list is DERIVED by scanning the tree, so a
reader added tomorrow is covered rather than exempt (L96). Its positive control puts
the real defect back into the real monitor route in memory and requires itself to
catch it.

Its sibling `scripts/test-batch-sizes.ts` catches a list that IS split but by a
literal stride. This one catches the list that is not split at all.

**The escape hatch is `// in-chunk-ok: <why>`**, on or in the `//` block directly
above the `.in(` line, and it is refused when it carries no reason. Use it for a set
the ROSTER bounds rather than the growth table it was read from: a deduplicated agent
id list is at most 200 ids at the design target, which is 7,520 bytes against the
10,000 budget. Say which population bounds it, not just that it is small.

What the scan CANNOT see is named in its own header: a list crossing a function
boundary as a callback parameter (which is why `destroyVerified` owns its split), an
array destructure of a `Promise.all` of paginated reads, and a `.limit(n)` above the
ceiling.

# Swallowed-error reads (the `// error-ok:` convention)

A read that destructures `const { data } = await db.from("t").select(...)` and
ignores `error` fails silently: when the query errors (a missing column on a
half-applied migration), `data` comes back null, the availability pool collapses
to empty, and the booker shows NO times, a broken deploy that looks like a quiet
day. That was #277; it routed the availability-critical reads through **`unwrap`**
(`src/lib/db/result.ts`), which throws on a real error and passes a not-found
(`data: null, error: null`) through unchanged.

**`scripts/test-swallowed-error-reads.ts`** (#315) keeps that invariant from
eroding. It scans **all of `src/`** and fails on an awaited SELECT whose `error`
is never consulted. That surface is DERIVED rather than listed (#2542): it used to
be a hand written directory list grown one incident at a time, so everything not
yet on it was exempt from the check meant to catch it (L96), and nine widenings
had not made that stop happening. Eight live reads sat outside the list with the
shipped scanner flagging every one, the booker's own `is_test` refusal among them.
A file leaves the surface only through the NAMED exclusion list in that file, each
entry carrying its reason; today it holds one, `src/lib/db/schema.type-test.ts`,
which is never imported at runtime. The scan logic lives in
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

## Who writes those columns, and why Regal hears about it (#2085)

Every write to `users.bookable` or `users.deactivated_at` goes through ONE
helper, **`writeRoutableState`** in `src/lib/bookable/routable-write.ts`: the
bookable flip (`writeBookable`), the lifecycle departure and return, and the
reap's batch (`deactivateUsersByIds`). It reads the rows before, writes, reads
what it wrote from the same statement, and for every row whose `isRoutable`
value moved records an `agent.bookable_changed` delivery for Regal
(`{"userId": <email>, "traits": {"slateBookable": <bool>}}`), suppressed for an
`is_test` agent. Only on a change, so a reactivation and a flip on a departed row
send nothing. The emit lives inside the write because a rule each writer must
remember is enforced by nothing (L621): `scripts/test-routable-write-owner.ts`
fails the build on any other `src/` or `worker/` writer of either column, with a
`// routable-write-ok: <why>` hatch. SQL run by hand sends nothing;
`pnpm backfill:bookable-trait` is the repair, and what gives Regal its starting state.

A trait send states the agent's value AT THAT SEND (`payloadForSend`,
`src/lib/webhooks/agent-trait.ts`), because retries and replays reorder, and a
stale false retried after a newer true would otherwise win.

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
the family map in `src/lib/webhooks/events.ts` (keyed on the union, so `tsc` names
the omission), and a **`webhook_endpoints.events` update on the live row**. The
FAMILY (`booking.*` or `agent.*`, #2085) decides the payload type and the Regal
body, never the endpoint format: `regal.ts` keys its event names on the booking
events only, since an agent trait carries no name.

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
page, and read the diff in review.** It prints every string a lead can read,
grouped by screen and by the state that produces it, including the lines only
assistive tech hears, and its own last line says how many lines across how many
screens that came to.

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

**The alert preview carries the same scan** (#2502). Its copy cannot be globbed the
way the booker's can, because it lives across the monitoring tree in `*/alert-copy.ts`,
`lane-copy.ts` and a few dozen `format*` builders beside the check they describe, and a
hand written list of those would be exempt the moment somebody added the next one
(L96). So the list is DERIVED from what `src/lib/notify/alert-preview.ts` IMPORTS
(`scripts/lib/scan-alert-copy-modules.ts`): the preview is by construction the one
place naming every builder whose words reach Slack, since a builder it does not call
renders nothing to preview. The preview itself is scanned alongside them, because it
seeds every builder's fixtures.

Direct imports only, one hop, and the WHOLE module rather than the imported binding.
Both are deliberate: transitive coverage reaches most of `src` within three hops and
would flag unrelated runtime clock reads, which is how a guard gets switched off (L36);
and #2497's clock read was in `dayWord`, a local helper the exported builder called, so
a scan narrowed to the binding would have missed the only instance this family has had.
An import that resolves to no file is REPORTED rather than dropped, or a rename would
shrink the scanned set while everything left still read as clean (L98).

It found one live instance, in a module the preview imports one builder from:
`selectCandidates` in `src/lib/monitor/calcom-override-sweep.ts` defaulted `nowMs` to
`Date.now()`. `nowMs` is required now. The default was a seam nobody had to use, and
the one caller that skipped it was a test whose fixture start was pinned to a constant
while its horizon walked with real time, so the pair had drifted out of the window the
assertion names (L130).

# Running the suite at a date that has not happened yet (#2503)

`SLATE_CLOCK_SHIFT=+1d pnpm test:node` runs every node suite with its clock moved
forward. `.github/workflows/clock-shift.yml` does it daily at three shifts and says
what it found.

**Why there is one at all.** A test whose meaning is the relationship between a
fixture and the present pins one end and reads the other, so it passes on the day it
merges and goes red on a later day with nobody having touched the code (L130). Nothing
ran the suite at any date but today, so the first thing to notice was main:
`scripts/test-booking-reminder.ts` meant "tomorrow" when it merged on 2026-09-16 and
"today" from midnight on the 17th, CI went red with no commit behind it, the deploy was
skipped, and #2484's monitoring floor sat merged and not live until #2498.

**How it moves.** `scripts/shift-clock.ts` is an `--import` hook that `run-tests.ts`
puts on each suite's own argv when the variable is set. It replaces the global `Date`
with a subclass whose `now()` and no argument constructor add a FIXED offset, which
also moves Luxon (`Settings.now` resolves the global at call time). A fixed offset
rather than a frozen instant, so elapsed time still flows and no timeout or duration
measurement changes meaning. Calendar units are resolved ONCE against the real now, so
`+13mo` is real calendar arithmetic and the reading stays monotonic. The spec parser
(`scripts/lib/clock-shift.ts`) REFUSES anything it cannot turn into a real movement,
including a zero shift, and the hook throws rather than running unshifted: a run whose
shift quietly did not apply is identical to an ordinary one and would read as a clean
result over exactly the defect it exists to find (L98).

**Where it runs, and why not somewhere cheaper.** Not the pre push gate: it is about
40s and every push pays it, and three more passes to catch a fault that arrives by
CALENDAR rather than by commit is how a gate starts being skipped (L36). Not CI: it
would gate merges on a question the change in front of it did not ask, and a
legitimately date sensitive suite should be fixed deliberately rather than discovered
by somebody trying to merge something else. Daily, at 04:40 UTC, costs three passes of
the node suite sharing one install: about 9 minutes of wall clock and about 9 billed
minutes a day on ubuntu-latest's 1x multiplier. Measured off run 35266508062 (3m7s for
the whole node-tests job), not off the 106s the comment beside that job still claims.

The three shifts are `+1d` (the #2497 shape itself), `+3mo` (a month roll, and from
most dates a clock change) and `+13mo` (a year roll and, from ANY date, both of the
year's clock changes). They live in ONE list in the workflow, read by the loop that
runs them and by the step that judges them, so a shift cannot be run and not judged.

**Finding nothing is not a pass.** `scripts/lib/clock-shift-report.ts` separates three
outcomes, and the third is the one that would otherwise read as the first: agreement, a
date dependent suite (named, with the shift that found it), and a run that measured
nothing. A run measures nothing when it left no summary line, reported no clock or the
wrong one, covered fewer suites than the checkout holds, or produced no log at all. The
expected suite count comes from the checkout through `discoverSuiteNames`, the same
function the runner discovers them with, so it cannot drift from the thing it describes.

**The positive control is in the suite, not in a memory of having tried it once.**
`scripts/test-clock-shift.ts` plants a date dependent test in a temporary directory,
runs it through the real runner twice, and requires it to pass on the real clock and
FAIL a day ahead, plus an unreadable spec to refuse the run outright. Without it a hook
that silently did nothing would report this mechanism working for ever (L1).

**What it cannot see**, so a green run is never read as more than it is (L400): the
vitest suites are NOT shifted. The hook is an `--import` on each node suite's own
process and vitest runs its files in worker threads that do not re-read it. The
measured exposure in #2503 was in the node suites.

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

# The confirmation mark's assets are built, and both are held (#2560)

The check mark a lead sees after booking is drawn by `@lottiefiles/dotlottie-react`
rather than by a `<video>`, because iOS refuses to autoplay video in Low Power
Mode and many iPhone owners leave it on permanently. Two files under
`public/brand/` make that work and NEITHER is hand made:

- `checkmark.lottie` is the check mark half of the animation trypennie ships,
  cut out at build time.
- `dotlottie-player.wasm` is copied out of `node_modules`. Slate serves it
  itself so the last screen a lead sees does not depend on jsdelivr, and naming
  a URL with `setWasmUrl` also turns the player's CDN fallbacks OFF, so a wasm
  the player refuses is not silently rescued: nothing draws.

`pnpm build:confirmation-mark` rebuilds both, and
`scripts/test-confirmation-mark-assets.ts` holds each against what it was built
from. **Bumping `@lottiefiles/dotlottie-react` means rebuilding**, or the served
wasm is a build of a different runtime; that guard is what says so, rather than a
lead's browser. It also fails a STATIC import of the player, which would put
about a megabyte and a half in the booker's first load, where the first screen is
a date picker with no use for it.

The still coin (`checkmark-still.webp`) is always in the tree underneath, and it
is the whole answer to every way the player can be absent: a chunk that never
arrives, a wasm that will not load, and a lead who asked for less motion all
leave the same correct picture rather than an empty panel.

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

Screenshots against `next dev` hang and time out: element shots wait forever on
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

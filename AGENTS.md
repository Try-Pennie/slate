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

**Re-run it after any change to the burst path (`src/lib/rate-limit-burst.ts`,
`src/lib/rate-limit.ts`, `worker/burst-limiter.ts`) or to the `BURST_LIMITER`
binding in `wrangler.jsonc`, and after a deploy that touched either.** Like the
truth probe, it talks to a live deployment, so it is deliberately NOT named
`test-*.ts`: that glob is the offline unit suite. Its decision logic is pinned
offline by `scripts/test-burst-counter-live-control.ts`, which drives every
refusal through hand written replies and asserts no two of them share a code or a
message.

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

# Comparing Slate against cal.com (`pnpm verify:availability-parity`)

The fourth command in the family above, and the one that only makes sense while
BOTH systems are live. During the parallel run (`docs/parallel-run-plan.md`)
Slate computes availability nobody can book while cal.com keeps taking every
lead. This is what turns that silence into a measurement (#1731).

**It is not a correctness check, and the distinction matters.** cal.com is the
incumbent, not the source of truth: a time both systems offer can be busy in
both. That question belongs to `verify:availability-truth`, which asks Google.
This one catches CONFIGURATION drift, which is invisible from inside Slate
alone: working hours never set to the real 8am to 8pm (#1255), a bucket whose
membership does not match cal.com's routing, business hours closing a day
cal.com keeps open, an agent whose calendar never connected.

**The comparison is at the (day, hour) level, deliberately.** The two systems
carry their own slot interval (cal.com offers the review event every 10
minutes), duration, buffers and minimum notice, so demanding equal instants
would be red from the day it shipped for reasons nobody should fix (L36). An
hour either system offers anything in is an hour it considers open, and that
survives every one of those differences while still catching a roster scheduled
9 to 17 against a cal.com week running 8 to 20.

**The pin is the dangerous part.** cal.com narrows the pool with
`routedTeamMemberIds[]`, and when an id is not a host on the event type it
IGNORES the pin and answers **200 with the whole pool**. Against one bucket that
reads as Slate under-offering: a false finding pointing at agents who are fine.
So every pinned read is paired with a bogus-id read whose answer is known to be
the pool, and an identical pair refuses the run rather than reporting it.

```
pnpm verify:availability-parity                     # sweep every active bucket
PARITY_BUCKET=411 pnpm verify:availability-parity   # one bucket
```

`CALCOM_API_KEY` is required (it resolves an agent email to a cal.com user id and
is a wrangler secret on the deployment, so it has to be added to `.env.local` to
run this); `CALCOM_ORG_ID`, `CALCOM_EVENT_TYPE_ID`, `SLATE_BASE_URL`,
`PARITY_DAYS` (default 7) and `PARITY_ZONE` carry working defaults. The slots
read itself needs no key.

**Only agreement passes, and every other outcome exits non-zero on its own
code**, so a shell caller can branch on which one it met. Finding nothing to
compare is never a pass (L98), and both systems offering nothing is the state the
dark roster produces today:

| exit | what it met |
|---|---|
| 0 | every compared bucket agrees on open hours |
| 1 | no `CALCOM_API_KEY`, or an unreadable `PARITY_DAYS`; nothing was attempted |
| 2 | no bucket could be compared (all dark, or the named code does not exist) |
| 3 | Slate did not answer, or answered with no readable slots array |
| 4 | cal.com did not answer |
| 5 | cal.com answered with something unreadable |
| 6 | no member of a bucket exists in cal.com, so nothing could be pinned |
| 7 | **cal.com ignored the pin** and answered with the pool; every verdict built on it would be false |
| 8 | neither system offers anything: perfect agreement, zero information |
| 9 | cal.com offers nothing while Slate does; not ours to fix, and not comparable |
| 10 | **Slate offers nothing** while cal.com offers a week |
| 11 | **Slate under-offers**: hours cal.com opens and Slate does not |
| 12 | Slate over-offers: usually cal.com holding an out of office Slate has not been told about |
| 13 | the two answers cover no day in common, so nothing could be compared |

Under-offering outranks over-offering when a sweep meets both, because the
direction that costs a lead a bookable time is the one somebody must act on;
both are always printed, so the ranking decides only which one names the run.

**The hours are only compared across the range BOTH systems answered for**, and
that is measured rather than assumed. Against live cal.com on 2026-09-02 its pool
reached about two days ahead (43 slots on the second day, nothing beyond) while
Slate's booking horizon runs much further. Comparing over a fixed week would
therefore report Slate over-offering on every run forever, which is the always-red
check this probe exists not to be. Days past either system's reach are printed as
their own fact instead. The clip is by RANGE, never by the set of days each system
holds: clipping to the shared set would excuse the finding that matters most, a day
sitting inside both reaches that one of them offers nothing on.

**It has never reached a real verdict, and cannot until the roster is hot.**
Every real agent is `bookable = false` (#1272), so every real bucket resolves to
an empty pool and the sweep exits 2. That is the honest state and the command
says so rather than passing. The first run that matters is the one taken
immediately after the Phase 1 flip, and its findings ARE the phase's evidence.
Its decision logic is pinned offline by `scripts/test-availability-parity.ts`,
which drives every verdict through hand written fixtures.

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
`src/lib/webhooks/*` and the whole `src/app/admin/**` tree, and fails on an
awaited SELECT whose `error` is never consulted. The scan logic lives in
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

Note the asymmetry that keeps catching people out: **`null` and `[]` are not
interchangeable.** `busyIntervalsForAgent` returns `null` for "could not tell" and
its caller re-routes on it; the daily-cap read next to it returned `[]`, borrowed
that comment, and meant the opposite.

Two guards cover the alerting end of this, both in `pnpm test`:
`scripts/test-swallowed-error-reads.ts` (the read shape) and
`scripts/test-all-clear-failure-coverage.ts` (#1152: every module that sends a
recovery notice must carry a test proving it stays silent when its health signal
cannot be read, or point at the suite that does with `// all-clear-proof:`).

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

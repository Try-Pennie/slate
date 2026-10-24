# GitHub workflows: what guards main, settings, and alerters

The detective control over main, the two facts a workflow cannot report about
itself, how a workflow's `vars.` and `secrets.` references are checked, and why
an alerting workflow carries no dependency install.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## Main is guarded by detection, not prevention (free-plan constraint)

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

### The two things a workflow cannot report about itself (#2476, #2229)

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

## A workflow reference to a repo setting that does not exist

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
Actions variables/secrets read access; the default `GITHUB_TOKEN` does not have it
and it cannot be granted through the `permissions:` key, so a CI job would need a
PAT secret. The hook fails OPEN without `gh`, like the merged branch guard in the
same `pre-push` hook (`docs/push-gate.md`, "Git workflow: never reuse a merged PR
branch"), and SAYS so rather than skipping in silence, and it only runs when the
push touches a workflow. Skip a false positive with
`SKIP_WORKFLOW_SETTINGS_CHECK=1`. The decision lives in
`.githooks/lib/workflow-settings-guard.sh` so it can be driven by
`scripts/test-workflow-settings-guard.ts` without a remote.

The decision logic (what counts as a reference, what is built in, what counts as
missing) is pinned offline in `scripts/test-workflow-env-coverage.ts`, so the
rule is tested even where the listing is not available.

### A setting defined on the ORGANISATION (#2342)

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

### A setting that is PROVISIONED PER RUN (#2293)

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

## An alerting workflow carries no dependency install (#1524, #1598)

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

## Where jobs run: GitHub's runners or the Mac (2026-10-24)

From 2026-10-23 GitHub refused every hosted job in the Try-Pennie org over billing
(a support ticket is open), while self-hosted runners still got jobs. So every job
reads one ORG variable, `PENNIE_CI_RUNNER`:

```yaml
runs-on: ${{ vars.PENNIE_CI_RUNNER == 'pennie-mac' && 'pennie-mac' || 'ubuntu-latest' }}
```

- **`pennie-mac`**: jobs run on the runners on Dan's work MacBook, installed by
  `scripts/mac-runner/setup.sh` as a hidden `cirunner` user that cannot read Dan's
  files (his home folder must be `chmod 700`, since every local user is in `staff`;
  the script refuses otherwise). It also refuses when a tool jobs assume from
  GitHub's image (`aws`, `jq`, `gh` and others) is missing, and its `status` stage
  reports both. Jobs queue while that Mac is asleep or offline. Each runner has its
  own HOME (shared, two jobs at once broke `pnpm/action-setup`), and a job started
  hook fails any job, saying why, while the disk has under 10 GB free
  (`scripts/test-mac-runner-disk-guard.ts`). `setup.sh refresh` applies a settings
  change by restarting the runners, which fails a job running at that moment, so
  run it between jobs.
- **Anything else** (`github`, empty, deleted, a typo): GitHub's `ubuntu-latest`,
  as before. Switching back is that one org setting, with no code change.

Jobs that need Docker (the browser checks, the backup, the database replay) ask
for `pennie-mac-docker` instead. Only one runner carries that label, because two of
those jobs would each start a local Supabase on the same ports of one Docker host.
`loadtest.yml` and `clock-shift.yml` stay on `ubuntu-latest`: they use GNU `timeout`
(and `setsid`), which a Mac lacks, and the test refuses a routed job using either.

Mac specific steps carry `if: runner.os == 'macOS'` beside the unchanged Linux step
(the security scan's gitleaks and semgrep installs), so neither path depends on the
other. `scripts/test-runner-routing.ts` pins all of it: every job, the Docker set,
and the fallback for any value but the exact one.

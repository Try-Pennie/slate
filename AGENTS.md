# This is NOT the Next.js you know

This Next.js version has breaking changes. Read the relevant guide in
`node_modules/next/dist/docs/` before writing Next code, and heed deprecation
notices. `agentRules: false` in `next.config.ts` stops `next dev` rewriting this
file with a block the style gate refuses (#2201,
`scripts/test-agent-rules-generation.ts`).

# This file has a size budget (#2393)

`CLAUDE.md` and everything it imports load into every request of every session.
`scripts/test-auto-loaded-docs-budget.ts` holds them to `BUDGET_CHARS` in
`scripts/lib/auto-loaded-docs.ts`, which records the measurement behind it. **A
rule belongs here; a runbook, exit code table, flag list, incident history or
"what one run measured" goes in `docs/` with a one or two line pointer here that
states the rule.** When the budget fires, move a section out; raising the number
is a decision made out loud. History: `docs/auto-loaded-rules.md`.

# Git workflow: never reuse a merged PR branch

PRs merge within seconds and auto deploy, so **never push to a branch whose PR
merged**: start every change on a fresh branch off `origin/main`
(`git checkout -b <name> origin/main`) and cherry pick to continue. The
`pre-push` hook refuses a merged branch (`ALLOW_MERGED_PUSH=1` overrides only the
hook; `merge-gap.yml` still fails the run server side).

The hook also runs `tsc --noEmit`, `pnpm lint`, `pnpm test` and `pnpm cf:build` in
an isolated tree, about 40s (`SKIP_PREPUSH_CHECKS=1` in a pinch), then weighs the
client bundle against `.githooks/bundle-budget.txt`: the record must match what
the commit builds to (commit the `pnpm bundle:record <total>` it prints), and
growth past 3% and 10 KB needs `ACCEPT_BUNDLE_GROWTH=1` (`SKIP_BUNDLE_BUDGET_CHECK=1`
skips it, said out loud). Why the steps overlap as they do, and the eslint ignore
rule: `docs/push-gate.md`.

# Every merge carries a changelog label (from 2026-10-03)

Slate is in the sales managers' dev update (`/pennie-dev-update`), so from
2026-10-03 a merge is refused unless the pull request carries exactly one of
`changelog/visible`, `changelog/technical` or `changelog/none`
(`~/.claude/hooks/require-changelog-tag.sh`). `changelog/visible` means a manager
or a lead would notice it, and its body needs a `## Changelog` heading with the
sentence a manager reads, in plain words. Add both when you open the pull request,
not when the merge is refused. A deliberate exception is `ALLOW_UNTAGGED_MERGE=1`.

# `pnpm cf:build` refuses a bundle carrying your `.env` files (#2335)

The Cloudflare adapter copies every `.env*` value into the Worker bundle, so a
build in a checkout holding `.env.local` would deploy production credentials.
`cf:build` runs `scripts/check-bundle-env.ts` and fails on any name that is not
`NEXT_PUBLIC_*`, and on client chunks that name a deployment setting. Every
deploying script must build through `cf:build`. A hand deploy passes
`NEXT_PUBLIC_*` in the shell (DEPLOY.md, 2a). `ALLOW_ENV_IN_BUNDLE=1` is for one
local build, never a deploy. Detail: DEPLOY.md, section 3.

# Main is protected by a ruleset, with detection behind it (#4197)

The "Protect main" ruleset (id 25746489, 2026-10-23) refuses deletion, force pushes
and any change that is not a pull request with the `ci` check green (0 approvals, by
Dan's choice), and nobody can bypass it, so `[allow-direct-push]` no longer lets a
push through. **Renaming the `ci` job blocks every PR** unless the ruleset changes in
the same PR. `main-push-guard.yml` (#1027) stays as the backstop if the ruleset is
switched off: it pages Slack for any push to main that is not a merged PR with green
CI, reading the marker from the commit subject only (#4096). The Worker's `ci_health`
step pages when main's tip is not deployed or CI jobs never started
(`docs/alerts-runbook.md`, "A merge has not shipped, or CI cannot run"). Detail:
`docs/workflows.md`.

# Parallel-agent dispatch playbook (worktree fan-out)

- **Disjoint issues per wave.** Two issues touching one file run in sequence.
- **Seed `node_modules` first:** `bash scripts/seed-worktree-node-modules.sh` from
  inside the worktree (copy on write, seconds). If it refuses, `pnpm install`.
  Never symlink `node_modules`; Turbopack rejects it.
- **Diff a branch against its merge base**, never current `origin/main`:
  `git diff $(git merge-base origin/main <branch>)..<branch>`.
- **A branch cut from a stale main is refused at push**
  (`.githooks/lib/stale-main-guard.sh`, matched by patch id; `ALLOW_STALE_MAIN=1`
  once, said out loud).
- **Never trust an agent's "clean"**: confirm the gate ran, the diff is scoped and
  the tests pass before merging.
- **Remove a worktree once its PR merges** (`git worktree remove`).

Detail: `docs/push-gate.md`.

# Applying a database migration

Deploys do not apply migrations. Run `supabase db push` **before** the PR merges,
bump `SHIPPED_MIGRATION_VERSION` in the same commit, and never apply through the
Supabase MCP tool. Follow `docs/migrations-runbook.md` step by step, including its
two function rules (pinned `search_path`, and `revoke execute ... from public,
anon, authenticated` on every SECURITY DEFINER function; opt outs in the table
below).

# Three ways a Google calendar can fail, not two

A failed calendar read is `gone` (credentials or membership: re-auth or remove),
`not-provisioned` (`403 notACalendarUser`: an admin must grant Calendar; retrying
never helps) or `transient` (usually self heals), classified in
`src/lib/google/reachability-classify.ts`. **Never branch on `kind === "gone"`**;
use `isDefinitiveFailure` (`src/lib/google/sync-health.ts`). A new kind needs its
own label and its own instruction (`scripts/test-google-not-provisioned.ts`).
Detail: `docs/architecture.md`.

# The monitor lane's shared setup reads

Every check and every shared setup read runs inside its own `steps.run`. A failed
shared read resolves to **null, never an empty or default value**, and which check
needs which read lives only in `monitorSetupGates` (`src/lib/monitor/setup-gates.ts`).
Settings fall back to the last known values, never the defaults (#2773). A step
failing on consecutive ticks pages `monitor_step_failing:<step>`
(`judgeMonitorSteps`, deliberately not a step itself). A step that stands down (gate
shut, not due, org closed) returns `step.unmeasured(value)`, and one slower than the
tick declares its cadence in `MONITOR_STEP_CADENCE_MS` (#3955). Guard:
`scripts/test-monitor-step-coverage.ts`. Detail: `docs/monitor-lane.md`.

# A workflow reference to a repo setting that does not exist

GitHub interpolates an **empty string** for a `vars.X` or `secrets.X` nobody
created. So never read a wired env name with a non empty `??` fallback, and the
pre-push hook runs `pnpm check:workflow-settings` on any push touching a workflow,
asking repo and org scope (`SKIP_WORKFLOW_SETTINGS_CHECK=1` for a false positive).
A dispatch only workflow whose settings exist only during a run declares them by
exact name with a reason (`# settings-provisioned-per-run:`, table below; its
grammar is in `docs/workflows.md`).

# An alerting workflow carries no dependency install (#1524, #1598)

The main push guard, the deploy alert and the canary alert run on bare node with
no install, so their scripts import nothing outside `scripts/` and post through
`scripts/lib/slack-post.ts` (`scripts/test-dependency-free-scripts.ts`). Detail:
`docs/workflows.md`.

# Where a new test goes

Two harnesses, split by capability. **Vitest** (`src/**/*.test.ts(x)`,
`pnpm test:components`) is for code that needs `vi.mock` or the `@/` alias:
components, route handlers, lib code with mocked collaborators. **Node scripts**
(`scripts/test-*.ts`, `pnpm test`) are for pure logic through hand written fakes
and for repo invariant guards; each exits 0 or 1. Shared fakes live in
`scripts/lib/`, never in a `test-*.ts` file. Unsure? Reaching for `vi.mock` means
vitest; otherwise a node script.

The vitest default environment is `node`. A file needing a DOM starts with
`// @vitest-environment jsdom`; every `*.test.tsx` must, and a plain `*.test.ts`
only if listed in `scripts/test-vitest-environment.ts`.

A suite never writes into the tree (`// tree-write-ok:` in the table below).
`SLATE_CLOCK_SHIFT=+1d pnpm test:node` runs the node suites at a future date
(daily in `clock-shift.yml`). Detail: `docs/testing.md`.

# What CI covers, including the browser layer (reversed 2026-10-03)

CI green means unit logic, a full production build and, when the change touches
what the app is built from, a browser pass (the `browser` leg, PR only, blocks
merge; ADR 0011). Run it locally with `pnpm test:e2e` (Docker and the Supabase CLI)
from a worktree: the runner refuses a checkout holding a `.env*` file, because
`.env.local` points at production. It runs a throwaway local Supabase with every
outside service stubbed or refused, and the job gets no secret
(`scripts/test-browser-checks-gate.ts`). The production canary
(`smoke-canary.yml`) still proves the deployed Worker. Detail: `docs/testing.md`.

# A live test books `PARTNER`, never a real bucket (#2760)

There is no staging, so a hand run test booking lands on production. Book the
`is_test` bucket `PARTNER`: no webhook, no Regal text, no monitor counts it. A
booking on a real bucket is a real lead to every monitor (below tier, failure
rate, offsite origin) and sends live invites and texts. If a test must reach a
real advisor, use the bucket with the most advisors on `/admin/tiers`, never a one
person pool, and cancel it afterwards. Detail: `docs/smoke-test-runbook.md`.

# The `pnpm verify:*` commands: proving a fail safe detector is not blind

A fail safe detector that has never once concluded looks exactly like one finding
nothing; these hand run commands prove the detectors are not blind. Their shared
rules: ask the outside system (Google, cal.com, Twilio, the deployed Worker), never
Slate's own record; only agreement passes, and finding nothing to check is not a
pass; every outcome has its own exit code; they need live credentials, so they are
not `test-*.ts`, and each one's verdicts are pinned offline by a `scripts/test-*.ts`
sibling. **Read `docs/verify-commands.md` before running one** (exit codes,
credentials, what each writes, and which detectors stamp a verdict heartbeat).

| Command | What it proves |
|---|---|
| `verify:availability-truth` | the times Slate is OFFERING are really free on the live calendars, asked of Google rather than of `busy_blocks` |
| `verify:ooo-protection` | an approved time off is really BLOCKING the agent, read as the event itself plus free/busy, because busy periods merge |
| `verify:pool-entry` | the activation gate's calendar reads work against real Google both ways: a readable agent hydrates every calendar, an unlicensed account is refused as not provisioned |
| `verify:burst-counter` | the `BURST_LIMITER` object is not merely bound but answers AND counts, which the monitor lane deliberately cannot ask |
| `verify:refusal-alerts` | the six booking refusal alerts (API and embed) move from a measured clear to paging and build their message off a monitor only tally row; writes test rows, deletes them (#1726) |
| `verify:confirm-line` | the `CONFIRM_LINE` object answers the confirm path's client by its rules; it cannot prove isolates share it, only the load run can |
| `verify:kill-switch` | the booking kill switch really refuses on the deployed Worker, the one gate here that fails CLOSED |
| `verify:reroute-on-ineligibility` | a Twilio demotion really moves and audits a held call, and the move back holds (a daily drill on test advisors) |
| `verify:calcom-parity` | Slate and cal.com hold the same roster and the same week per agent, which is invisible from inside Slate alone |
| `verify:twilio-parity` | Slate holds the routing facts Twilio is the source of truth for, and notices a `Redistribute` agent still bookable |
| `verify:router-replay` | Slate's ladder agrees with cal.com's choices on real leads, the only measurement of routing that exists before cutover |
| `verify:parallel-run-readiness` | the preconditions of a trustworthy shadow run, each judged by the code that already owns it, including trypennie's key seen from production (exit 13, #2717), plus the low volume alarms' arming preconditions, reported without gating while they are disarmed (exits 14 to 16, #2767) |
| `verify:pool-slot-parity` | the bucket codes sharing one availability pool really offer the same times |
| `verify:table-drift` | production holds no table that no migration created |
| `verify:reroute-live` | every reroute outcome end to end on production's test advisors, leaving nothing behind (#3251) |
| `verify:marcia-rebook` | Marcia's booking MCP books a time, cancels it and books the same time again, each with its own calendar event (#3616) |
| `verify:advisor-photos`, `verify:advisor-photos-sql` | the photo refresh (#3027) against live Google with no writes, and migration 0156 in a real Postgres; why every face goes through `resolveAdvisorPhoto` |
| `verify:agent-link-names`, `verify:replace-user-schedule-guard`, `verify:auth-domain-hook`, `verify:audit-chain-sql`, `verify:migration-replay-sql`, `verify:reroute-holds-sql`, `verify:recreate-missing-busy-blocks-sql`, `verify:program-leads-sql` | in Docker: 0155's link names (lowest free, never reused); 0157's import refusing a mid run edit; auth hook; audit chain; all migrations from empty, RLS per role (#3099); 0166's reroute hold refusing a booking on a held advisor as a lost race (#3247); 0204's busy block re-create skipping a booking whose cancel is in flight (#3592); 0213's placeholder day limit, derived and raced (#4387) |

The reports `report:pilot-split` and `report:pilot-compare` follow the same rules
(`docs/pilot-split-report.md`, `docs/pilot-compare-report.md`).

# One availability compute per POOL, not per bucket code (#2245)

Bucket codes resolve to far fewer routing pools. The recompute lane computes once
per pool and writes **every code its own `bucket_slots` row**, each keeping its
own bucket identity; freshness is judged per pool, never per code. **Anything new
that feeds the compute must join `PoolInput`** (`src/lib/availability/pool-key.ts`)
in the same change, or one pool's times are served under another's code. The empty
pool sweep (#2237), `/admin/tiers` and the thin tier notice report pools
(`groupRowsByPool`, `sameTierReading`); `/admin/buckets` keeps a row per bucket.
Collapsing `bucket_slots` to one row per pool was deferred: re-read #2245 first.
Detail: `docs/architecture.md`.

# The confirm line is shared across isolates (#3325)

Behind `booking_settings.shared_confirm_line`, ONE Durable Object holds the confirm
line for every isolate. Its rules live only in `makeConfirmQueue`, every call but the
lead's ack (#3355) is awaited (`scripts/test-unawaited-line-calls.ts`), and any failure
falls back to the isolate's own line. The rest: **`docs/confirm-line.md`**.

# Repo guard conventions and their opt outs

Each opt out goes on, or in the `//` block directly above, the flagged line, and is
refused without a reason. Guards are in `scripts/`; what each one scans, what it
cannot see and the incidents behind it are in `docs/repo-guards.md`.

| Opt out | The rule it relaxes | Guard |
|---|---|---|
| `// cap-safe: <why>` | a growth table read is bounded or paginated (below) | `test-src-capped-reads.ts`, `test-capped-reads.ts` |
| `// in-chunk-ok: <why>` | an `.in()` list from a paged read is split by BYTES with `chunkIdsByUrlBudget` and `inIdChunks` (`src/lib/db/id-batch.ts`); opt out only for a roster bounded list, naming the population | `test-unchunked-in-filters.ts` |
| `// error-ok: <why>` | a read's `error` is consulted (below) | `test-swallowed-error-reads.ts`, `test-swallowed-count-results.ts` |
| `// write-ok: <why>` | a server action write binds `{ error }` and refuses through `writeRefused` before the audit entry, `revalidatePath` and the redirect | `test-unchecked-writes.ts` |
| `// parse-ok: <why>` | stamps in monitor, notify, Google, cron and health code go through `parseStampMs` (`src/lib/date/stamp.ts`), null mapped to the fail safe side | `test-date-parse-guard.ts` |
| `// clock-ok: <why>` | a copy builder takes its clock and never reads it | `test-booker-preview-coverage.ts`, `test-alert-preview-coverage.ts` |
| `// alert-text-ok: <why>` | alert copy carries `shortFailureReason`/`shortErrorReason`, never a raw error; the log keeps the detail | `test-alert-error-text.ts` |
| `// alert-key: <key>` | declares a key the alert scanner cannot read (required, not optional) | `test-alert-recovery-coverage.ts` |
| `// lifecycle-write-ok: <why>` | departure and return write through `src/lib/offboarding/lifecycle-write.ts` (below) | `test-deactivation-write.ts` |
| `// routable-write-ok: <why>` | `users.bookable` and `users.deactivated_at` are written only by `writeRoutableState` (below) | `test-routable-write-owner.ts` |
| `// any-advisor-ok: <why>` | an advisor list read applies `realAdvisorsOnly`/`withoutPlaceholder` or selects `REAL_ADVISOR_COLUMNS` (`src/lib/advisors/real-advisor.ts`); a bare `.eq("is_test", false)` is refused | `test-real-advisor-reads.ts` |
| `-- export-cursor-ok: <why>` | a backfill of a mirrored table rewinds its `export_cursor` in the same change (`docs/migrations-runbook.md`) | `test-mirror-backfill-cursor.ts` |
| `-- search-path-ok: <reason>` | a SQL function's pinned `search_path` cannot reach extensions: use `pg_catalog` or schema qualify | `test-definer-search-path.ts` |
| `-- anon-execute-ok: <reason>` | a SECURITY DEFINER function revokes EXECUTE from `public, anon, authenticated` | `test-migration-grants.ts` |
| `// typecheck-ok: <why>` | `scripts/` and `worker/` carry no undefined name (TS2304) or unresolved import (TS2307) | `test-scripts-typecheck.ts`, `test-worker-typecheck.ts` |
| `// tree-write-ok: <why>` | a suite writes only under a real `tmpdir()`/`mkdtemp` path | `test-no-tree-writes.ts` |
| `// deadline-ok: <why>` | a server `fetch` names a `signal`; the opt out names what bounds it instead (#3972) | `test-outbound-deadlines.ts` |
| `# settings-provisioned-per-run: NAMES because <reason>` | a dispatch only workflow's settings may be absent between runs | `check:workflow-settings` |

# Capped single-page reads (the `// cap-safe:` convention)

PostgREST returns at most one 1000 row page per list read, so `.length` or an
aggregate over it silently under counts (#35, #166). In `src/`, a SELECT on a
growth table must carry `.single()`/`.maybeSingle()`, `.limit()`/`.range()`,
`.csv()`, `{ head: true }`, or a primary key `.eq("id")`/`.in("id")`, or be
paginated with `selectAllPages` (`src/lib/supabase/paginate.ts`). Roster bounded
tables are listed, each with its reason, in `SAFE_TABLES`
(`scripts/lib/scan-src-capped-reads.ts`); **every other table is a growth table**,
so a new table bounded by the roster is added there. Scripts and load tests use
`listAll` or a server side count.

# Swallowed-error reads (the `// error-ok:` convention)

supabase-js resolves `{ data: null, error }` on a failed query, so an ignored
`error` reads as an empty table. Route a read through `unwrap(await ...)` or a
paginating helper, or bind `error` and check it; a count uses `unwrapCount`
(`src/lib/db/result.ts`), never `count ?? 0`.

**Ask what the EMPTY result means downstream.** That, not whether the read can
fail harmlessly, decides `// error-ok:`. If empty only leads to a safe path (the
tick skips, the caller re-routes, the next run retries), opt out and name that
path. If anything downstream treats empty as "none failing", "no bookings",
"zero admins" or "within limits", fail loud with `unwrap` or return an explicit
unknown (`null`), never `[]` or `0`; `null` and `[]` are not interchangeable. An
all clear hangs only off a measured healthy result
(`scripts/test-all-clear-failure-coverage.ts`).

# Departing and returning an agent

Leaving the pool stamps `deactivated_at` and clears `bookable` in one statement;
returning leaves the agent unbookable, so re-entry always passes the activation
gate (no agent is bookable until every one of their calendars reads).
`writeRoutableState` (`src/lib/bookable/routable-write.ts`) is the only writer of
either column and sends Regal the `agent.bookable_changed` trait; SQL run by hand
sends nothing, so repair with `pnpm backfill:bookable-trait`.

# Adding a webhook event (#1459)

An endpoint receives only events in its stored `events` array, and zero matches is
silent. Adding an event means three changes: the `WebhookEvent` union
(`src/lib/db/types.ts`), the family map (`src/lib/webhooks/events.ts`), and an
update to the **live** `webhook_endpoints.events` row. To ship one unsubscribed,
add it to `DELIBERATELY_UNSUBSCRIBED` with a reason and the issue that will
subscribe it. Detail: `docs/repo-guards.md`.

# Read copy before it ships

Before changing alert wording run `pnpm preview:alerts`; before changing booker or
manage page wording run `pnpm preview:booker`; read the diff in review. Both call
the real builders, so **alert text lives in pure builders** (`*/alert-copy.ts`,
`lane-copy.ts`, `format*`) and **every string a lead can read lives in
`src/lib/booking/booker-copy.ts` or `manage-copy.ts`**, never inline in a
component. An alert never opens with the word "Slate". Detail:
`docs/copy-previews.md`.

# Adding or changing an alert

Classify every key in `src/lib/notify/alert-catalog.ts`: a **condition** (an
ongoing state) must resolve on the same key; an **incident** (a finished event)
and **info** never resolve. Ask: if it cleared, what would the all clear say?
Resolve only off a measured healthy result, never off "did not alert this run";
an every minute lane clears several keys with `resolveRecovered`. A key family
(`name:*`) declares what its suffix is, so per booking rows are pruned
(`scripts/test-alert-state-retention.ts`). A key also needs a procedure in
`docs/alerts-runbook.md` ("Adding an alert" holds the rest, including why alert
copy never carries a raw error).

A condition posts again once a day, and a change at once (#3801). The rule lives
in the dispatcher (`src/lib/notify/repeat-policy.ts`), so no send site opts in.
Repeats are 24h after the last post, hourly for `URGENT_CONDITION_KEYS`, a stored
`cooldown_min` winning for a tunable key. A change is a subject the last post did
not name or a worse band. Pass `{ subjects, band }` to the send; never make a
duration a band.

An alert another one explains (the canary lanes under `ci_runs_refused`) waits
while that one fires: one line in `ALERT_FOLDS` (`src/lib/notify/alert-folds.ts`,
#3802), never a check at the send site.

# The confirmation mark's assets are built (#2560)

`public/brand/checkmark.lottie` and `dotlottie-player.wasm` are generated by
`pnpm build:confirmation-mark`; bumping `@lottiefiles/dotlottie-react` means
rebuilding them (`scripts/test-confirmation-mark-assets.ts`). Never import the
player statically. Detail: `docs/design/confirmation-mark.md`.

# Reading production logs (Cloudflare observability)

Never call `console` in `src/`; log through `src/lib/log.ts`
(`log.error(tag, fields, err)`, passing the `Error` itself). Query the bare
`message` and `level` fields, never `$metadata.*`, and drop any `level` filter to
see `console.log` lines. **Run a positive control before believing any zero, and
check it is recent**: the pipeline can lag hours, so for the last few hours use
`npx wrangler tail`. Read one hour at a time with `scripts/logs.ts` (#3299), never
one wide window. A line names the slot, the agent or the `booking_id` (the join key
across invocations), never the lead's contact details. Preview versions are not
logged; retention is 7 days, and logs never page anyone. Detail and working
queries: `docs/cloudflare-platform-notes.md`.

# Screenshotting the dev UI (Playwright/Peekaboo)

Screenshots against `next dev` hang unless motion is frozen first; the snippet and the
JPEG workaround are in **`docs/screenshotting-dev-ui.md`**.

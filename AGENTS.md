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
locally instead of breaking main after merge. It's ~20s on a warm cache; skip it
in a pinch with `SKIP_PREPUSH_CHECKS=1`.

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
eroding. It scans `src/lib/availability/*` and `src/lib/booking/*` and fails if an
awaited SELECT is destructured for `data` without also consulting `error`. The
scan logic lives in `scripts/lib/scan-swallowed-error-reads.ts` (unit-testable),
and the guard carries a positive control (stripping the opt-outs from the real
`booking/service.ts` must be caught) so it can never rot into a no-op.

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
error would silently show no availability must use `unwrap` instead. The guard
covers the `const { data } = await` object-destructure shape the bug keeps taking;
an array destructure (`const [{ data }] = await Promise.all(...)`) or an inline
`(await ...).data` is out of scope by design (documented in the scanner header).

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

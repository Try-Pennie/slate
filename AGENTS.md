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

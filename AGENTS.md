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
override only when intentional with `ALLOW_MERGED_PUSH=1`.

The same hook also runs CI's checks before every push — `tsc --noEmit`,
`pnpm lint`, `pnpm test` (the unit suite, which includes the copy/dash lint and
the migration invariants), and `pnpm cf:build` (the full Cloudflare/OpenNext
build, #412) — so a CI-only failure (including a build-only break) is caught
locally instead of breaking main after merge. It's ~20s on a warm cache; skip it
in a pinch with `SKIP_PREPUSH_CHECKS=1`.

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

# Reading production logs (Cloudflare observability)

Cloudflare captures **every** console method from the deployed Worker, with the
`Error` object serialized. Nothing is dropped: a 250-line canary (#801) came back
100% at every level. So the "detail is kept server-side in the logs" guarantee in
`internalErrorResponse` (`src/lib/api/errors.ts`) is real.

**`console.log` is banned in `src/`** (ESLint `no-restricted-properties`), because
it is the one method Cloudflare stores with **no `level` field**. The line is kept,
but it is invisible to every level-filtered query, which reads as a total drop.
Use `console.info` for a routine operational line, `warn`/`error` for problems.
That earlier "console.log doesn't come back" belief (and, before it, "console.error
doesn't come back") were both this same false negative: a query that verified
nothing, read as evidence of absence.

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

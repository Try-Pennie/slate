# Testing Slate: harnesses, typechecks, the browser layer and the clock

Where a test goes, what the scripts and Worker typechecks catch, what CI
covers including the browser pass, and how the suite is run at a future date.

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

## Where a new test goes

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

### jsdom is opt in

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

## The scripts tree is typechecked, but only for what breaks at runtime

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
than a figure kept in a doc (#2398). `tsconfig.scripts.json` plus
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
The vitest suites get the same watch from a global setup
(`scripts/vitest-tree-tripwire.ts`, declared in `vitest.config.ts`, #2759), armed by
the same rule; it cannot say WHICH vitest file wrote, only that one did. It costs
about 60ms a run, measured 2026-09-25 by timing the start and end probes
directly on the real tree over 7 runs (medians 9ms and 52ms), and
`scripts/test-vitest-tree-tripwire.ts` plants a write through real vitest to prove it
fails the run. Rules and allowed paths: `scripts/lib/tree-write-tripwire.ts`.

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

## What CI covers, including the browser layer (reversed 2026-10-03)

CI green on a pull request means **unit logic, a full production build, and, when
the change touches anything the app is built from, a browser pass**. `pnpm test`
and `pnpm test:components` run in the pre-push gate and in CI, `pnpm cf:build`
proves the Worker builds, and the `browser` leg of `ci.yml` drives a real browser
before merge (#3079, #3100).

**The no-browser-layer decision (#611) is reversed** (Dan, 2026-10-03; ADR 0011 has
the reasoning). #611's premise was that `next dev` never settles; this runs a
PRODUCTION build (`next build`, `next start`) with motion stopped. It covers sign in
through the real callback, impersonation, the eleven #2379 admin saves (each asserting
the stored row and the `SAVE_OUTCOME_COPY` sentence), a lead booking and the manage
page, and axe over the booker, manage page, sign in, every console nav page
(`adminNavHrefs()`) and `/me`, in light and dark, failing on serious or critical
findings. Two positive controls keep axe honest. Its first run found three defects.

**Run it:** `pnpm test:e2e` (Docker plus the Supabase CLI). `e2e/run.ts` starts a
throwaway local Supabase from the committed migrations on its own ports, seeds it,
builds, serves on `localhost:3100` and runs Playwright. Locally,
`E2E_REUSE_STACK=1` and `E2E_SKIP_BUILD=1` speed iteration; args after `--` go to
Playwright. Run it from a worktree: **the runner refuses a checkout holding any
`.env*` file Next would load, or a `.dev.vars*` file**, because `.env.local` points
at production. `pnpm cf:preview` refuses the same checkout by the same rule
(`scripts/lib/live-env-files.ts`, #3694).
**One run per machine at a time** (#4018): runs share the local Supabase and port
3100, so a second worktree's run is refused naming the one in progress, a server
already on the port (a killed run's leftover, a dev server) is refused, and the run
counts as started only once its OWN server reports listening, never because
something answered on the port (`e2e/run-guards.ts`).

**It cannot touch production (L2)**, by four layers documented in `e2e/env.ts`: an
environment built from nothing, `SLATE_LOADTEST=true` (Google stubbed, Slack,
Salesforce, cal.com and Twilio refused), an egress guard in the server that refuses
and records any off-machine connection and fails the run on one, and a browser that
aborts off-machine requests. The run also fails if the guard's log is missing or a
refusal shows in the server's output. The job gets no secret;
`scripts/test-browser-checks-gate.ts` fails the build if one is added and checks the
input list against every file the run reads (L88). Staff sessions are real sign ins (a
PKCE magic link from the local auth server); `/dev/preview` stays dev only.

**It blocks merging** (Dan, 2026-10-03): `browser` is a leg of the `ci` fan-in, pull
request only like security-scan, so main and the deploy never wait on it. It always
starts, and its first step (`scripts/browser-checks-gate.ts`) passes in seconds when
the diff touches no input; an unreadable diff runs it. About 6 billed minutes a build.

**The production canary stays**, because a local stack cannot prove the deployed
Worker, real calendars or the real embed host: `.github/workflows/smoke-canary.yml`
runs the smoke scripts against live prod on the isolated SMOKE agents and buckets
(#396), a dry run every 30 min, every hour a `SMOKE_STRICT` pass and the reschedule
smoke, and every 6h the deployed embed render check (#1006, `scripts/smoke-embed-render.ts`),
with Slack alerts on failure and a heartbeat the lane watchdog pages on when the
schedule stops (#982, refired by `src/lib/monitor/canary-trigger.ts`).

## Running the suite at a date that has not happened yet (#2503)

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
by somebody trying to merge something else. Daily, at 04:40 UTC.

**One job per shift (#3960).** A pass took about 533s on 2026-10-20 (run 39402068299),
so three in one job were about 27 minutes, the 25 minute limit cut off the third, and
the alert pointed at output that pass never printed. Now a plan job turns the list into
a matrix, each shift runs in its own job under its own 18 minute pass limit (`timeout`,
about twice a pass) inside a 25 minute job, streams its log as it runs and uploads it
with a marker saying how the pass ended, and one report job (always runs, bare node)
reads them all. A pass stopped by its limit is reported as exactly that. Cost: about 32
billed minutes a day on ubuntu-latest's 1x multiplier (three 10 minute shift jobs, a
minute each for plan and report), about 4 more than one job, for about 11 minutes of
wall clock instead of 27. `scripts/test-clock-shift-workflow.ts` pins the shape.

The three shifts are `+1d` (the #2497 shape itself), `+3mo` (a month roll, and from
most dates a clock change) and `+13mo` (a year roll and, from ANY date, both of the
year's clock changes). They live in ONE list in the workflow's env, read by the plan job
that builds the matrix and by the report that judges it, so a shift cannot be run and
not judged.

**Finding nothing is not a pass.** `scripts/lib/clock-shift-report.ts` separates three
outcomes, and the third is the one that would otherwise read as the first: agreement, a
date dependent suite (named, with the shift that found it), and a run that measured
nothing. A run measures nothing when it hit its time limit, was cancelled, left no
summary line, reported no clock or the wrong one, covered fewer suites than the checkout
holds, or its job left no log at all. The
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

# Task 5.3: Functional Regression + Build/Deploy Safety

## Objective

Prove the visual redesign changed **nothing functional** and that the app still builds, lints,
tests, books, embeds, and deploys. Specifically: `pnpm build` + `pnpm lint` + `pnpm test` all
green; the booking flow works **end-to-end** in both the standalone Booker and the embed; a
**git-diff review** confirms only CSS/markup/asset changes (no booking logic, availability
cache, Google sync, round-robin, webhooks, auth, server actions, or DB touched); the **cal.com
drop-in embed contract** is intact (`Cal()` API, `data-cal-*` triggers, URL params, the
`slate:resize`/`slate:bookingSuccessful` postMessage contract); and OpenNext / Cloudflare
Workers deployability is sanity-checked (`pnpm build` as the proxy; optional `cf:build`).

## Context

5.1 captured visuals, 5.2 ran the a11y gates. 5.3 is the functional + safety gate: it enforces
the single hardest constraint of the whole project — **D5: this is visual-only; NO functional/
logic changes**. The git-diff review is the load-bearing check here: it's the evidence that the
redesign stayed in its lane. This task feeds 5.4 (sign-off), which records build/test status and
the diff-review verdict. Runs on the same `pnpm dev` server 5.1/5.2 left up (for E2E), plus
fresh `pnpm build`/`lint`/`test` runs.

This is a **VERIFICATION task** (D5). You run commands and review the diff. If `build`/`lint`/
`test` fails or the diff shows a logic change, log it as a FAIL in the report and flag the owning
phase task — do not "fix" logic here (and if a restyle genuinely required a logic change, that's
a scope violation to escalate, not patch).

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash | `pnpm build`, `pnpm lint`, `pnpm test`; optional `pnpm cf:build`; `git diff` review |
| Browser | Playwright MCP | E2E booking flow standalone + embed; watch console for postMessage contract |
| Files | Read | Read `widget.js` + `public/embed-example.html` to confirm cal.com contract surface unchanged |

## Dependencies

- Tasks 5.1 + 5.2 — running `pnpm dev`, auth session, `manage_token`, evidence baseline.
- All of Phases 1–4 (the redesign work whose diff is being reviewed).

## Blocked By

- 5.2 (a11y audit). Run after 5.2 so the contrast guard added/confirmed there is part of the
  `pnpm test` run here.

## Research Findings

Key findings relevant to this task:

- From DISCOVERY.md D5 (scope): OUT of scope — booking logic, availability cache (`busy_blocks`),
  Google Calendar sync, round-robin, webhooks (Regal/Cadence), auth/RBAC, server actions, DB.
  "If a restyle seems to require a logic change, STOP and flag it." This is the diff-review spec.
- From DISCOVERY.md D15 / `slate-embed-contract` skill: widget.js stays vanilla/dependency-free;
  must NOT break `Cal()` API, `data-cal-*` triggers, URL params (`xbc`/`external_id`/`embed`/
  `theme`/`brand`), or the `slate:resize`/`slate:bookingSuccessful` postMessage contract. The
  ResizeObserver posts `scrollHeight` — height animation breaks resize (animate opacity/transform
  only).
- From DISCOVERY.md D19 (CF compat): verified stack Tailwind 4.3.0, Next 16.2.7, OpenNext 1.19.11
  — all build-time, CF-compatible. `pnpm build` is the deployability proxy.
- From `research/verification-toolchain-execution.md`: `pnpm test` is the node-native
  `scripts/test-*.ts` loop (must stay dependency-light, browser-free, CF-safe); the contrast
  guard is the one a11y check in it. Perf numbers from `pnpm dev` are meaningless — for any real
  perf figure run `pnpm build && pnpm start`. Booking E2E: pick day → slot → form → confirmation,
  standalone AND embed; watch the console during the embed click for the cal contract firing.
- From CLAUDE.md (project): canonical booking URL `/book?xbc=411`; the only live Google call on
  the hot path is the single-agent verify-on-book at confirm time (observe it works, don't touch).
- From the orchestration memory: Slate hosts on CF Workers via OpenNext; `googleapis`→fetch,
  edge middleware, cron triggers are the known CF gotchas — `cf:build` (if present) exercises the
  OpenNext adapter more than `next build`.

## Execution Plan

### Step 1: Build, lint, test (the code gate)

**Surface:** [code]

- [code] `cd /Users/danhankins-wright/Documents/Slate && pnpm build` → expect exit 0. Capture
  the tail of the log to `reports/build.log` (`pnpm build 2>&1 | tee reports/build.log`). Watch
  for type errors, missing assets (vendored fonts/SVGs from Phase 1), or font-loading errors.
- [code] `pnpm lint` → expect clean (exit 0, no errors). Save to `reports/lint.log`.
- [code] `pnpm test` → expect all `scripts/test-*.ts` green, **including** the
  `# scripts/test-contrast.ts` block ending `ALL PASSED`. Save to `reports/test.log`.

**Verification:**
- All three exit 0; logs saved; contrast block present and passing in the test log.

### Step 2: git-diff review — prove NO logic changed (the load-bearing check)

**Surface:** [code]

- [code] Get the full diff of the redesign branch vs the pre-redesign base:
  ```bash
  git fetch origin
  git --no-pager diff --stat origin/main...HEAD
  git --no-pager diff origin/main...HEAD
  ```
  (Use the actual base ref the redesign branched from if not `origin/main`.)
- [code] Classify every changed file. **Allowed** (visual-only): `*.css` (globals/tokens),
  `*.tsx`/`*.ts` changes that are purely className/style/markup/inline-SVG/icon-component/copy,
  `src/app/fonts/*`, `public/brand/*`, `public/widget.js` (chrome literals only),
  `public/embed-example.html`, `src/app/icon.*`/`apple-icon.*`, `scripts/test-contrast.ts`,
  `reports/*`, `next.config`/`tsconfig` only if font/asset wiring.
- [code] **Forbidden** (D5 — flag as FAIL if touched): anything under booking logic
  (`src/lib/booking/*`, `service.ts`), availability cache (`busy_blocks`), Google sync
  (`/api/google/*`, `/api/cron/sync`), round-robin / agent selection, webhooks (Regal/Cadence),
  auth/RBAC (`src/app/login` `signIn()` body, middleware auth, role checks), server actions, DB
  schema/migrations (`src/lib/db/*`, `supabase/migrations/*`). Styling-only edits to the *markup*
  of these pages' components are allowed; changes to their *logic/handlers/data flow* are not.
- [code] For each changed `.tsx` in a logic-adjacent area (e.g. `Booker.tsx`, `admin/page.tsx`,
  `me/page.tsx`, `login/page.tsx`, `ManageBooking.tsx`), read the diff hunks and confirm they
  only alter `className`/style/JSX-structure/copy/icons — the conditions, handlers, fetch calls,
  state logic, and data bindings are byte-identical (ternary *conditions* preserved even if the
  *color tokens* they pick changed — per Phase 3.2 guidance).
- [file] Write the classification to `reports/diff-review.md`: a table of changed files →
  category (visual / asset / verification / **FORBIDDEN**) → one-line justification.

**Verification:**
- Every changed file classified visual/asset/verification; ZERO files in the forbidden set;
  `reports/diff-review.md` written. Any forbidden touch = FAIL → escalate (do not patch).

### Step 3: Booking flow E2E — standalone

**Surface:** [browser]

- [browser] On the live server, navigate `/book?xbc=411&theme=light`. Complete a full booking:
  pick a day → pick a slot → fill name/email/phone → submit → reach the confirmation. Confirm the
  booking actually succeeds (confirmation renders with the warm copy + the agent/time), i.e. the
  existing booking logic still works behind the restyle.
- [browser] Capture the `manage_token` if 5.1 didn't (for the manage page) — and to prove the
  write path works.

**Verification:**
- Standalone booking completes; confirmation renders; a real booking is created (token returned).

### Step 4: Booking flow E2E — embed + cal.com contract

**Surface:** [browser][file]

- [browser] Navigate `/embed-example.html`; open the browser console. Click the
  `data-cal-*` trigger ("Schedule your call"). Confirm the modal opens, the Booker loads inside
  the iframe, and complete a booking through to the in-iframe confirmation (SVG puck).
- [browser] Watch the console / network: confirm the **cal.com contract fires** —
  `Cal()` API initialized, `slate:resize` postMessages adjust iframe height (ResizeObserver
  posting `scrollHeight`), and `slate:bookingSuccessful` fires on completion. No errors.
- [file] Read `public/widget.js` and `public/embed-example.html` and confirm the contract
  surface is intact: `Cal()` function, `data-cal-*` attribute handling, the URL params
  (`xbc`/`external_id`/`embed`/`theme`/`brand`) passed through, and the `slate:resize`/
  `slate:bookingSuccessful` message names unchanged. Confirm widget.js has no new dependency
  (still vanilla) and the brandColor default = Pennie sky with host override preserved.

**Verification:**
- Embed booking completes; `slate:resize` + `slate:bookingSuccessful` fire (console);
  `data-cal-*` triggers work; widget.js still vanilla; brandColor default sky + override intact;
  no height-animation resize jump.

### Step 5: OpenNext / Cloudflare deployability sanity check

**Surface:** [code]

- [code] `pnpm build` (Step 1) succeeding is the primary deployability proxy (Next 16 +
  Tailwind 4 + the new font/asset wiring all resolve at build time).
- [code] **Optional but recommended**: if a `cf:build` (or `opennextjs-cloudflare build`) script
  exists in `package.json`, run it → expect exit 0. This exercises the OpenNext adapter more than
  `next build` (catches `googleapis`→fetch / edge-middleware / static-asset issues). Save to
  `reports/cf-build.log`. If no such script, note that `pnpm build` is the proxy and `cf:build`
  was not run.
- [code] Confirm the vendored fonts (`src/app/fonts/PPMori/*.woff2`) and brand assets
  (`public/brand/*`) are present and referenced (no 404s in the build output) — a missing asset
  would break the CF deploy.

**Verification:**
- `pnpm build` exit 0; `cf:build` exit 0 if present (else documented as not-run with `pnpm build`
  as proxy); fonts + brand assets present and resolved.

### Step 6: Write the functional-regression summary

**Surface:** [file]

- [file] Append a "Functional + build/deploy" section to `reports/checklist.md` (or a dedicated
  `reports/functional-regression.md`) recording: build/lint/test exit codes + log paths, the
  diff-review verdict (link to `reports/diff-review.md`), standalone + embed E2E results, the
  cal.com contract verdict, and the deployability check. PASS/FAIL each.

**Verification:**
- The summary exists with explicit PASS/FAIL per check and evidence paths.

## Artifacts to Create

- `reports/build.log`, `reports/lint.log`, `reports/test.log` — command outputs — [code]
- `reports/cf-build.log` — if `cf:build` exists — [code]
- `reports/diff-review.md` — changed-file classification proving no logic touched — [file]
- `reports/functional-regression.md` (or appended section in `reports/checklist.md`) — summary — [file]

## Artifacts to Modify

- `reports/checklist.md` — append functional/build/deploy results — [file]
- (Do NOT modify app logic. A forbidden diff or a failing build/test is escalated, not patched.)

## Contracts

### Provides (for downstream tasks)

- `reports/diff-review.md`: the no-logic-changed proof — 5.4 cites it for the D5 sign-off.
- Build/lint/test exit codes + logs: 5.4 records the green-build clause of D21.
- cal.com-contract-intact verdict + deployability verdict: 5.4 sign-off (D15/D19).
- A confirmed second `manage_token` if needed.

### Consumes (from upstream tasks)

- 5.1/5.2: running server, auth session, `manage_token`, `scripts/test-contrast.ts` (run inside
  `pnpm test` here).
- Phases 1–4: the diff under review.

## Acceptance Criteria

- [ ] `pnpm build` exits 0 (log saved); no missing-asset / font-load errors.
- [ ] `pnpm lint` clean (exit 0, log saved).
- [ ] `pnpm test` green, including the `scripts/test-contrast.ts` `ALL PASSED` block (log saved).
- [ ] git-diff review classifies every changed file as visual/asset/verification; **ZERO**
      forbidden (logic/cache/sync/round-robin/webhook/auth/server-action/DB) files touched;
      `reports/diff-review.md` written.
- [ ] Standalone booking completes E2E (day → slot → form → confirmation; real booking created).
- [ ] Embed booking completes E2E; `slate:resize` + `slate:bookingSuccessful` postMessages fire;
      `data-cal-*` triggers + `Cal()` API + URL params intact; widget.js still vanilla;
      brandColor default = sky with host override preserved; no resize jump.
- [ ] OpenNext/CF deployability sanity-checked (`pnpm build` proxy; `cf:build` if present);
      vendored fonts + brand assets resolve.
- [ ] Functional-regression summary written with PASS/FAIL + evidence paths.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build` → exit 0; `pnpm lint` → exit 0; `pnpm test` → exit 0 + contrast block `ALL PASSED`.
- `git --no-pager diff --stat origin/main...HEAD` + per-file hunk review → no forbidden files.
- `pnpm cf:build` (if present) → exit 0.

#### [browser] Web Verification
- Standalone: `/book?xbc=411` → pick day → slot → form → submit → confirmation renders.
- Embed: `/embed-example.html` → click trigger → modal opens → book through to in-iframe
  confirmation; console shows `slate:resize` + `slate:bookingSuccessful`, no errors.

#### [file] File Verification
- Read `public/widget.js` + `public/embed-example.html` → `Cal()` API, `data-cal-*`, URL params,
  postMessage names unchanged; widget.js dependency-free.
- Read `reports/build.log`/`test.log` tails → success markers present.
- Confirm `src/app/fonts/PPMori/*.woff2` + `public/brand/*` exist.

### Cross-Surface Coherence
- The booking created via the standalone flow (Step 3) and the embed flow (Step 4) both write
  through the same path — confirm both reach a real confirmation (same backend, two entries).
- The `manage_token` minted here resolves the same manage page 5.1 screenshotted — confirms the
  visual surface sits on a working data path.
- The contrast guard run in `pnpm test` (Step 1) reads the same `globals.css` tokens that 5.2's
  axe/Lighthouse audited and 5.4's coherence grep checks — single source of truth.

## Skills to Read

- `slate-embed-contract` — the exact cal.com drop-in contract (Cal() API, data-cal-*, URL params,
  postMessage) that Step 4 must confirm intact; the ResizeObserver / no-height-animation rule.
- `slate-ui-verification` — dev-server warm-up (§2), E2E booking walk (§3.3), acceptance gate
  (§10: build/lint/test green + booking E2E + contract intact).

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` —
  `pnpm test` convention, E2E booking + embed console-watch procedure, dev-vs-build perf note.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` — D5 (scope/forbidden), D15 (embed
  contract), D19 (CF compat) — the spec for the diff review and deployability check.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

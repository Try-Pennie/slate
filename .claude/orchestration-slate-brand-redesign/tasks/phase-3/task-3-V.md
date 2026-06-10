# Task 3.V: Phase 3 Verification Sweep (Internal pages)

## Objective

Re-verify every Phase 3 deliverable — login (3.4), admin (3.2), me (3.3), landing (3.5), and the
shared shell + theme toggle (3.1) — on its surface in BOTH themes; run the code gates
(`pnpm build`/`lint`/`test`); grep the two page files (`admin/page.tsx`, `me/page.tsx`) and the
other restyled files for stray bright/grayscale color classes; confirm zero logic/auth/RBAC/form
changes; and record evidence in `reports/`. Resolve the admin/me OAuth auth path before signing off
those surfaces.

## Context

This is the gate that closes Phase 3 and (with 2.V) unblocks Phase 4 tasks 4.4/4.5 and feeds
Phase 5. It does not introduce new styling — it proves the four pages render correctly, are
accessible, build clean, and changed nothing functional. Where a Phase 3 task left a verification
gap due to the auth blocker, this sweep is where that gap is closed (logged-in session/seed) or
explicitly recorded as an outstanding item.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Browser | Playwright MCP | Screenshot all four pages both themes + mobile; axe; Lighthouse a11y; theme-toggle + persistence |
| Code | Bash | `pnpm build`/`lint`/`test`; grep for stray colors; git-diff logic safety |
| Files | Read | Read back evidence into `reports/` |

## Dependencies

- Tasks 3.1, 3.2, 3.3, 3.4, 3.5 complete.

## Blocked By

- 3.1, 3.2, 3.3, 3.4, 3.5

## Research Findings

- From `PHASES.md` (Task 3.V): `[browser]` login/admin/me/landing both themes (resolve admin/me
  auth path first); `[code]` `pnpm build/lint/test` green + grep both admin/me `.tsx` for bright
  color classes; evidence → `reports/`.
- From `PHASES.md` (Auth note): `/admin` and `/me` are Google-OAuth-gated; a headless agent can't
  self-auth. Before 3.V, resolve via a logged-in Playwright profile / injected Supabase session /
  user-supplied screenshots (see `reports/surface-verification.md`).
- From `internal-pages-execution.md` (Verification Strategy + grep): the status-color recolors live
  in JSX ternaries and will NOT be caught by a globals.css hex scan — run
  `grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-" src/app/{login,admin,me,page}.tsx` and
  expect nothing. Compare paired light/dark screenshots against DS `preview/*.html` (navigation,
  forms, cards, badges, cta-block). axe-core 0 serious/critical; contrast-script output; zero
  changes to actions/RBAC/form contracts.
- From `slate-ui-verification` (surface→URL matrix): `/login` (public, OAuth-only sign-in), `/me`
  (auth-gated, redirects without session), `/admin` (auth-gated + `canManageAgents` role), `/`
  landing (public). Port 3000.
- From `wcag-accessibility.md` (tooling): axe-core via `@axe-core/playwright`
  (tags wcag2a/wcag2aa/wcag21aa) per page + both themes; Lighthouse
  `npx lighthouse <url> --only-categories=accessibility` (a11y ≥0.95, D21); reduced-motion
  emulation; verify color is never the sole signal (push dot, bookable pill, webhook pill, errors)
  and 44px targets.
- **S3: the theme-aware focus recipe (graphite outline on light, sky on navy, sky glow decorative
  box-shadow only) is provided by Task 1.2 and inherited by the internal pages.** This sweep VERIFIES
  that the 1.2-provided focus renders on the header toggle, nav tabs, inputs, and buttons in both
  themes; it is not delivered by 3.x or 4.4 (4.4 only sweeps/relaxes any clipping).
- From `DISCOVERY.md` D21: each surface screenshotted in both themes vs DS previews; AA+ checks;
  `pnpm build`+`lint`+`test` green; D5 — no functional/logic changes (this sweep proves it).

## Execution Plan

### Step 1: Resolve the admin/me auth path

**Surface:** [browser]

- [browser] Obtain a logged-in session for the auth-gated pages: a logged-in Playwright profile, an
  injected Supabase session, or user-supplied screenshots + seed data (per
  `reports/surface-verification.md` and the Human Actions table in `internal-pages-execution.md`).
  For full admin coverage, ensure seed data exists (agents, a bucket, a webhook endpoint,
  bookings/deliveries/audit rows) so every status branch renders; for `/me`, have an agent with and
  without working-hours rules.
- If a session cannot be obtained, proceed with the public pages (login, landing) and the code
  gates, and record the admin/me browser gap explicitly in PROGRESS.md + `reports/` rather than
  silently skipping.

**Verification:**
- [browser] Navigating to `/admin` and `/me` renders the dashboards (not a redirect to `/login`).

### Step 2: Code gates

**Surface:** [code]

- [code] Run `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green — includes
  `scripts/test-contrast.ts` if committed in Phase 4.3; if not yet committed, note it and rely on
  the per-page axe/contrast checks).
- [code] Grep for stray colors:
  `grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-" src/app/login/page.tsx src/app/admin/page.tsx src/app/me/page.tsx src/app/page.tsx src/components/AppHeader.tsx src/components/ThemeToggle.tsx src/components/ui/styles.ts src/components/ui/Pill.tsx`
  → expect no matches (intentional `--pennie-*` token refs and the documented 12% rose tint
  `rgba(196,61,61,.12)` are allowed).
- [code] Logic-safety diff: `git diff --stat src/app/admin/actions.ts` → no changes; review
  `git diff` of the four page files + the three new components → only CSS/className/markup/asset
  changes (no `name=`/`value=`/`action=`/`searchParams`/RBAC-gate/`signIn` edits; ternary
  conditions intact).

**Verification:**
- [code] build/lint/test green; grep empty; diff shows no functional changes; `actions.ts`
  untouched.

### Step 3: Browser sweep — all four pages, both themes (+ mobile)

**Surface:** [browser]

- [browser] For each of `/login` (public), `/` (public), `/admin` (session), `/me` (session):
  - `browser_snapshot` + `browser_take_screenshot` in light AND dark (toggle via the 3.1
    `ThemeToggle` where present, else set `data-theme` via `browser_evaluate`).
  - `browser_resize` to 390×844 and screenshot mobile light + dark (login must stack + hide panel;
    landing/me/admin must remain usable; ≥44px targets).
  - axe via `browser_evaluate` (`@axe-core/playwright`, wcag2a/2aa/21aa) → 0 serious/critical.
  - `npx lighthouse <url> --only-categories=accessibility` on the public pages (and admin/me if the
    session allows) → a11y ≥0.95.
- [browser] Theme toggle: on `/admin` (or `/me`), click the toggle → `data-theme` flips, colors
  flip; reload → persists (`localStorage.slate-theme`), no flash.
- [browser] Color-not-sole-signal spot checks: admin push-health dot has `title=`+label; bookable
  pill has `✓`/text; webhook pill has `{d.status}` text; me bookable pill + notice icon; errors are
  rose + icon. 44px targets on toggle, month-nav-free internal controls, inputs, CTAs.

**Verification:**
- [browser] Paired light/dark (+ mobile) screenshots for all four pages → `reports/`; axe 0
  serious/critical each; Lighthouse a11y ≥0.95; toggle flips + persists; non-color signals present.

### Step 4: Cross-surface coherence + evidence

**Surface:** [browser][file]

- [browser] Confirm the same tokens/type/shapes across the four pages: the sky-primary + outlined
  button pair is identical on login, landing, and admin/me actions; the bookable pill is identical
  on admin + me; the charcoal-logo `AppHeader` matches between admin + me; compare each against the
  DS `preview/*.html` (navigation, forms, cards, badges, cta-block).
- [file] Save all evidence (screenshots, axe reports, Lighthouse JSON/HTML, build/lint/test logs,
  grep output) under `reports/` (e.g. `reports/phase-3/`). Update PROGRESS.md with status, evidence
  paths, and any outstanding auth/seed gaps.

**Verification:**
- [file] `reports/` contains the paired screenshots + a11y reports + logs; PROGRESS.md updated.

### Step 5: Fix + re-verify loop

**Surface:** [code][browser]

- If any check fails (stray color, axe violation, Lighthouse <0.95, theme/persistence bug, a
  detected logic change), fix on [code] and re-run the affected verification. Loop Execute → Verify
  → Retry (max 3) → escalate to the user with specifics if still failing.

**Verification:**
- [code][browser] All Phase 3 checks green; no outstanding failures (auth-gap items, if any,
  explicitly recorded for the user to resolve).

## Artifacts to Create

- `reports/phase-3/` (or equivalent) - paired light/dark (+ mobile) screenshots of login/admin/me/
  landing, axe reports, Lighthouse output, build/lint/test + grep logs - [file]

## Artifacts to Modify

- `PROGRESS.md` - Phase 3 status, evidence paths, any outstanding auth/seed gaps - [file]

## Contracts

### Provides (for downstream tasks)

- Phase 3 sign-off (gates Phase 4 4.4/4.5 and feeds Phase 5 5.1/5.2 internal-page coverage).
- Evidence bundle in `reports/` for the Phase 5 comprehensive sweep.

### Consumes (from upstream tasks)

- 3.1–3.5 deliverables (the restyled pages + shared components).
- `scripts/test-contrast.ts` if committed by Phase 4.3 (otherwise note as pending).

## Acceptance Criteria

- [ ] Login, admin, me, landing all render on-brand in BOTH themes (and usable at 390px mobile),
      verified on Browser (admin/me via a resolved session, or gap explicitly recorded).
- [ ] `pnpm build` + `pnpm lint` + `pnpm test` green.
- [ ] `grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-"` over the four page files + new
      components returns nothing (allowed: `--pennie-*` token refs, the 12% rose tint).
- [ ] axe 0 serious/critical and Lighthouse a11y ≥0.95 on each verified page, both themes.
- [ ] Theme toggle flips + persists with no flash; color is never the sole signal anywhere.
- [ ] git diff confirms zero functional changes (actions/RBAC/`name=`/`signIn`/searchParams
      untouched; `actions.ts` unchanged).
- [ ] Evidence saved to `reports/`; PROGRESS.md updated.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green).
- Run the grep above → no matches.
- `git diff --stat src/app/admin/actions.ts` → no changes; review the four page diffs → styling
  only.

#### [browser] Web Verification
- Navigate to `/login`, `/`, `/admin` (session), `/me` (session).
- Snapshot each: expected branded elements present.
- Screenshot each light + dark + mobile (390×844) → `reports/`.
- axe (wcag2a/2aa/21aa) → 0 serious/critical; Lighthouse a11y ≥0.95.
- Toggle theme → flips + persists, no flash; verify non-color signals + 44px targets.

#### [file] File Verification
- Read back `reports/phase-3/` → paired screenshots + a11y reports + logs present.
- Read PROGRESS.md → Phase 3 status + evidence paths + any gaps recorded.

### Cross-Surface Coherence
- Same tokens/type/shapes across all four pages (buttons, pills, header, logo) and vs DS previews.
- The toggle's `localStorage.slate-theme` key matches the foundation no-flash script (no flash).

## Skills to Read

- `slate-ui-verification` - the full verification toolchain (Playwright/axe/Lighthouse/contrast),
  surface→URL matrix, the admin/me auth blocker, evidence/sign-off bar.
- `pennie-design-system-in-slate` - to compare against the DS previews and confirm token fidelity.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/internal-pages-execution.md` - the
  per-page acceptance + verification strategy + grep contract.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - axe/Lighthouse/
  reduced-motion tooling, color-not-sole-signal, 44px.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` - top authority (D21 done bar, D5
  visual-only, D11/D17/D18).
- `reports/surface-verification.md` - route reachability + the admin/me auth blocker resolution.

## Execution Surfaces Reference

Read execution surface definitions and verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

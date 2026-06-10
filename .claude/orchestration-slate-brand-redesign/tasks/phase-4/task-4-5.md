# Task 4.5: Responsive sweep (mobile 390px across all surfaces)

## Objective

Verify and adjust the mobile experience (≤640px stack breakpoint, 390×844 reference viewport) across every restyled surface — Booker (calendar/slots/form/confirmation), internal pages (login, landing, and admin/me where reachable), and the embed modal — so each is fully usable at 390px with no horizontal overflow, readable type, and touch targets ≥44px. This is a visual-only verification-and-tighten pass; the heavy responsive work was done per-surface in Phases 2–4, and this sweep catches the gaps.

## Context

Phase 4 task gating on the Booker (2.V) and internal pages (3.V) being styled and on the embed mobile full-screen (4.2) being in place. Mobile is where a stressed borrower actually books, so this sweep is high-value. The system's stack breakpoint is 640px; the canonical mobile frame is 390×844 (iPhone 12/13 class). Touch-target sizing (≥44px on day cells, slots, month-nav, inputs; primary CTA uses `.pn-btn--big` 56px) was specified in Phase 2/4 — here, measure and fix any that slipped. This is the last polish task before the Phase 4 verification sweep (4.V).

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Browser | Playwright MCP | 390×844 navigation + screenshots + bounding-box measurement of every surface |
| Files / Code | Read / Edit | Tighten any responsive/target-size gaps found (Tailwind responsive classes, min-height/width, padding) |

## Dependencies

- 2.V (Booker styled), 3.V (internal pages styled), 4.1/4.2 (embed chrome restyled + mobile full-screen).

## Blocked By

- 2.V, 3.V

## Research Findings

Key findings from research and DISCOVERY relevant to this task:

- From `research/wcag-accessibility.md` §7 (Touch targets, 44×44 CSS px) — the audit table of current Booker sizing and fixes:
  - Day cell: `aspect-square` in 7-col grid (~32–40px on mobile) — likely NO; enforce `min-height/min-width:44px` per cell or pad the grid.
  - Time slot: `px-3 py-2.5 text-sm` (~40px) — marginal; bump to `py-3`/`min-height:44px`.
  - Confirm button: `py-2.5` (~40px) — use `.pn-btn--big` (56px), passes comfortably.
  - Month nav `‹ ›`: `p-1` (~24px) — worst offenders; pad to 44×44 (`p-2.5`+), glyph centered.
  - 12h/24h toggle: `px-2 py-1` (~26px) — pad to 44px tall, or accept 24px+spacing (AA 2.5.8) for this dense secondary control; target 44.
  - Inputs: `py-2` (~38px) — `py-3` → 44px.
  - The brand's `.pn-btn--big` (56px) and `.pn-btn--small` (40px) bracket the target; primary actions use `--big`.
- From `research/embed-css-isolation.md` §4 (Responsive): below ~640px the embed modal is full-screen (`100dvh`, `border-radius:0`); use `100dvh` not `100vh`. (Implemented in 4.2 — this sweep re-verifies at 390px.)
- From `research/verification-toolchain-execution.md` §2: use a mobile frame **390×844**; Next.js 16 compiles routes on first hit — warm each URL once before screenshotting. Use explicit `?theme=light|dark` (the default is flipping). Store evidence under `reports/screens/` with encoded filenames.
- From DISCOVERY D18: 44px+ touch targets; color never the sole signal (don't regress the Phase 2/3 non-color cues while tightening responsiveness).
- From `slate-ui-verification` skill: the surface→URL matrix, the auth blocker for `/admin` `/me`, and the manage-page real-token requirement.

## Execution Plan

### Step 1: Warm the app and set the mobile viewport

**Surface:** [browser]

- [code] Start dev server: `cd /Users/danhankins-wright/Documents/Slate && pnpm dev`; poll until `/book?xbc=411` responds. Warm each route once (navigate) before measuring (Next 16 on-demand compile).
- [code] S6: `mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}` before any capture. This task's captures use the canonical `…-mobile-4-5.png` names listed in Artifacts.
- [browser] `browser_resize` to 390×844 (the canonical mobile frame). Keep this viewport for the whole sweep unless a surface needs a second check.

**Verification:**
- [browser] Viewport is 390×844; routes respond without a compiling/blank state.

### Step 2: Sweep the Booker at 390px (both themes + interactive states)

**Surface:** [browser]

- [browser] Navigate `/book?xbc=411&theme=light`. Screenshot full-page `reports/screens/book-light-mobile-4-5.png`. Then `&theme=dark` → `reports/screens/book-dark-mobile-4-5.png`.
- [browser] Drive the flow at 390px: click a day → click a time slot → reach the name/email/phone form → submit to reach the confirmation. Screenshot each state (`book-day-mobile`, `book-slot-mobile`, `book-form-mobile`, `confirm-mobile`).
- [browser] **Overflow check:** `browser_evaluate` `document.documentElement.scrollWidth <= window.innerWidth` (no horizontal scroll) on each state.
- [browser] **Target size:** `browser_evaluate` to measure `getBoundingClientRect()` of: a day cell, a time-slot button, a month-nav `‹`/`›`, the 12h/24h toggle, an input, and the confirm CTA. Assert width and height ≥44 (CTA should be ~56 via `.pn-btn--big`). Record any that fail.

**Verification:**
- [browser] No horizontal overflow in any Booker state at 390px; the measured controls meet ≥44px (or the documented 24px+spacing exception only for the dense 12h/24h toggle).

### Step 3: Sweep the embed modal at 390px

**Surface:** [browser]

- [browser] Navigate `/embed-example.html`; open the modal. Confirm it is **full-screen** (`100dvh`, edge-to-edge, `border-radius:0`) per 4.2. Screenshot `reports/screens/embed-mobile-4-5.png`.
- [browser] Drive a booking inside the iframe at 390px (day → slot → form → confirmation with the lightweight SVG puck). Confirm the in-iframe Booker fills the screen and has no overflow; the close button is reachable and ≥44px.
- [browser] `browser_evaluate` overflow + close-button bounding box.

**Verification:**
- [browser] Embed modal is full-screen at 390px, the Booker inside is usable with no overflow, close target ≥44px.

### Step 4: Sweep the internal/public pages at 390px

**Surface:** [browser]

- [browser] **Login** (`/login`, both themes): confirm the marketing split layout stacks correctly (<1024px stacks; panel hidden <640px per Phase 3.4); the Google CTA is full-width and ≥44px; no overflow. Screenshot `reports/screens/login-light-mobile-4-5.png` (+ dark).
- [browser] **Landing** (`/` `page.tsx`, both themes): hero, heading, and the sky-primary + outlined buttons stack and fit; buttons ≥44px; no overflow. Screenshot `reports/screens/landing-light-mobile-4-5.png` (+ dark).
- [browser] **Manage** (`/booking/manage/<token>`): if a real `manage_token` is available (mint one by completing a booking on bucket 411, or from the user), screenshot the manage/reschedule/cancel at 390px and confirm destructive (rose) actions and layout fit. If no token, note the blocker and screenshot the not-found state as an edge case.
- [browser] **Admin / me** (`/admin`, `/me`): auth-gated. If a logged-in Playwright session is available (per the PHASES.md auth note), screenshot both at 390px and confirm the shell/tables/cards stack without overflow and pills/targets are ≥44px. If no session, record the auth blocker and defer these to 4.V/Phase 5 with the session resolved.

**Verification:**
- [browser] Login + landing stack cleanly at 390px with ≥44px CTAs and no overflow; manage/admin/me captured where reachable, blockers recorded otherwise.

### Step 5: Fix any responsive/target-size gaps found

**Surface:** [code]

- [code] For each failure found in Steps 2–4, apply the minimal visual-only fix:
  - Sub-44px controls → add `min-height`/`min-width`, bump padding (`py-3`, `p-2.5`), or switch primary actions to `.pn-btn--big`. Follow the research §7 fix table.
  - Horizontal overflow → fix with responsive Tailwind classes (stack columns, `flex-wrap`, `max-w-full`, `min-w-0`, `truncate` on long strings), never by changing logic or removing content.
  - Day-grid density → enforce `min-height:44px` per cell or pad the grid.
- [code] Re-run the affected browser checks after each fix (Execute → Verify → retry ≤3).
- Do NOT regress the non-color signals (selected day, today, best-match, errors) from Phase 2/3 while tightening layout.

**Verification:**
- [browser] Re-measured controls now meet ≥44px and overflow is gone on the fixed surfaces.

### Step 6: Build/lint/test gate

**Surface:** [code]

- [code] Run `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green, incl. the contrast guard) to confirm the responsive tweaks didn't break anything.

**Verification:**
- [code] All three commands pass.

## Artifacts to Create

- `reports/screens/book-light-mobile-4-5.png`, `book-dark-mobile-4-5.png`, and the interactive-state captures - [browser]
- `reports/screens/embed-mobile-4-5.png` - embed full-screen at 390px - [browser]
- `reports/screens/login-light-mobile-4-5.png` (+ dark), `landing-light-mobile-4-5.png` (+ dark) - [browser]
- `reports/screens/manage-mobile-4-5.png`, `admin-mobile-4-5.png`, `me-mobile-4-5.png` - where reachable; blockers noted otherwise - [browser]

## Artifacts to Modify

- Booker component(s) (`src/components/Booker.tsx` and related) - target-size / overflow fixes (min-height/width, padding, `.pn-btn--big`, responsive stacking) - [code]
- Internal/public page components (login, landing, admin, me, manage) - any responsive/target fixes found - [code]
- `public/widget.js` - only if the mobile full-screen needs a tweak found here (4.2 owns it; touch minimally) - [code]

## Contracts

### Provides (for downstream tasks)

- A verified, tightened mobile experience across all surfaces — consumed by 4.V and Phase 5 (5.1 visual sweep includes 390px captures). Evidence screenshots feed `reports/`.

### Consumes (from upstream tasks)

- 2.V/3.V: the styled surfaces to sweep.
- 4.1/4.2: the embed chrome + mobile full-screen behavior re-verified here.

## Acceptance Criteria

- [ ] Every surface is usable at 390×844 with no horizontal overflow.
- [ ] Touch targets ≥44px on day cells, time slots, month-nav, inputs, and CTAs (primary CTA ~56px via `.pn-btn--big`); the only allowed exception is the dense 12h/24h toggle at ≥24px+spacing.
- [ ] The embed modal is full-screen at 390px; the in-iframe Booker is usable with no overflow.
- [ ] Login + landing stack correctly; manage/admin/me captured where reachable, blockers recorded.
- [ ] Non-color signals from Phase 2/3 are not regressed.
- [ ] `pnpm build`/`lint`/`test` green.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- Resize to 390×844; warm routes.
- Booker (both themes, all states): screenshot + `scrollWidth <= innerWidth` + bounding-box ≥44 on the listed controls.
- Embed modal: full-screen `100dvh`, no overflow inside, close ≥44px.
- Login + landing (both themes): stacked layout, ≥44px CTAs, no overflow.
- Manage/admin/me: capture where a token/session exists; record blockers otherwise.

#### [code] Code Verification
- Run: `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green).
- Run: `git diff --stat` — changes confined to responsive/target-size tweaks (Tailwind classes, min-size, padding); no logic touched.

#### [file] File Verification
- Read back any modified component: the change is visual (classes/sizing), not logic; non-color cues intact.

### Cross-Surface Coherence
- The same 640px stack breakpoint and 44px target rules hold across Booker, embed, and internal pages — confirm consistent behavior (e.g. the Booker stacks identically standalone and inside the embed iframe at 390px).

## Skills to Read

- `slate-ui-verification` - mobile viewport, surface→URL matrix, bounding-box measurement, auth/manage-token blockers.
- `pennie-design-system-in-slate` - `.pn-btn--big`/`--small` sizes, the 640px stack breakpoint, responsive conventions.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - §7 the touch-target audit table and fixes.
- `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md` - §4 the embed mobile full-screen pattern.
- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` - §2 the 390×844 frame, route warming, evidence locations.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

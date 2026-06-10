# Task 5.1: Full Visual + Theme Sweep (all surfaces)

## Objective

Capture deterministic screenshots of **every** redesigned Slate surface (Booker in all
interactive states, manage/reschedule/cancel, login, admin, me, landing, embed modal) in
**both themes** at **desktop 1280×900** and **mobile 390×844**, and confirm each matches the
Pennie Design System `preview/*.html`. This is the first gate of Phase 5 (Comprehensive
Verification): a complete visual evidence set under `reports/screens/` plus a filled
`reports/checklist.md`, proving the redesign renders correctly before the accessibility,
functional, and coherence gates run.

## Context

Phases 1–4 ported the Pennie token system, restyled the Booker, internal pages, and embed,
and added a11y polish. Each phase ran its own verification sweep (`x.V`), but those were
per-phase and incremental. Phase 5 re-verifies **all** deliverables together against the
DISCOVERY.md acceptance bars (D17 contrast, D18 a11y, D21 "done"). Task 5.1 is the visual
half: it produces the canonical screenshot set and snapshot evidence. Task 5.2 (a11y),
5.3 (functional/build), and 5.4 (coherence + sign-off) consume this evidence and build on the
same running dev server + browser session, so leave the server up and the auth session live
when you finish.

This is a **VERIFICATION task** (D5: visual-only redesign). You OBSERVE and CAPTURE. Do not
edit styling here — if a surface looks wrong vs the DS preview, log it as a FAIL in
`reports/checklist.md` with the screenshot and a one-line description, and flag it for the
owning phase task to fix; do not patch it inside this task.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash | Start `pnpm dev` (background), warm routes, create `reports/` tree |
| Browser | Playwright MCP | Navigate, resize, snapshot (a11y tree), screenshot every surface × theme × viewport; walk the booking flow |
| Browser (fallback) | Peekaboo CLI 3.4.0 | OS-window screenshot if Playwright screenshot stalls |
| Files | Read/Write | Fill `reports/checklist.md`; read DS `preview/*.html` for visual parity |

## Dependencies

- Phases 1–4 complete (all surfaces restyled, embed reskinned, a11y polish applied).
- 4.V verification sweep passed.

## Blocked By

- 4.V (Phase 4 verification sweep). Task 5.1 is the first task of Phase 5 and gates 5.2→5.3→5.4.

## Research Findings

Key findings relevant to this task:

- From `research/verification-toolchain-execution.md`: 8 surfaces; theme is driven by the
  `theme` query param on public/booker surfaces (`book/page.tsx` ~line 55, default flipping
  dark→light per D10 — **always pass `theme=` explicitly**). Canonical seed bucket `xbc=411`.
  Next.js 16 compiles routes on first hit under `pnpm dev` — **warm every route once** before
  screenshotting or the first capture shows a compiling/blank state. Deterministic viewports:
  desktop **1280×900**, mobile **390×844** (iPhone 12/13 class). The a11y-tree snapshot is the
  primary structured evidence. Evidence filenames encode `surface-theme-viewport`.
- From `research/verification-toolchain-execution.md`: `/me` + `/admin` are Google-OAuth-only
  and a headless agent can't self-auth → resolve via (a) logged-in PW Chrome profile,
  (b) injected Supabase session cookie, or (c) user-supplied screenshots. `/booking/manage/<token>`
  needs a real `manage_token` (book once on 411 to mint one, or get from user).
- From `research/wcag-accessibility.md`: capture the booking flow real states (day picked, slot
  picked, form, confirmation) — an empty calendar screenshot is insufficient. The
  `overflow-hidden` booker shell can clip focus outlines on edge controls — note if seen.
- From DISCOVERY.md D16: standalone confirmation shows the iridescent 3D graphic; the embed
  iframe shows a lightweight SVG puck — verify the right one renders on each.
- From DISCOVERY.md D21: "done" = each surface screenshotted in both themes and compared to
  DS `preview/*.html`.

## Execution Plan

### Step 1: Start the dev server and warm routes

**Surface:** [code]

- [code] Start the Next 16 dev server in the **background** (do NOT block):
  ```bash
  cd /Users/danhankins-wright/Documents/Slate && pnpm dev
  ```
  Run via Bash with `run_in_background: true`. Serves on `http://localhost:3000`.
- [code] Wait for ready, then warm each route (Next 16 compiles on first hit):
  ```bash
  until curl -sf -o /dev/null http://localhost:3000/book?xbc=411; do sleep 1; done; echo up
  for u in "/book?xbc=411&theme=light" "/book?xbc=411&theme=dark" "/login" "/embed-example.html" "/"; do
    curl -sf -o /dev/null "http://localhost:3000$u"; done; echo warmed
  ```
- [code] Create the evidence tree before any capture writes:
  ```bash
  mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}
  ```

**Verification:**
- `curl` returns 200 for `/book?xbc=411&theme=light`; `reports/screens/` exists.

### Step 2: Resolve the auth blocker for /me and /admin BEFORE the sweep

**Surface:** [code][browser]

`/me` and `/admin` redirect (307) to `/login`, which is **Google-OAuth-only** — a headless
agent cannot self-authenticate (see `reports/surface-verification.md`). Resolve up front so
those two surfaces don't stall mid-sweep. Choose, in priority order:

- **(a) Reuse a logged-in browser profile** — if Playwright MCP drives a persistent Chrome
  profile already signed into Slate, navigate `/me` / `/admin` directly. Cleanest; keeps full
  screenshot + (5.2) axe/Lighthouse fidelity.
- **(b) Inject a Supabase session cookie** — capture `sb-<ref>-auth-token` from a logged-in
  browser (DevTools → Application → Cookies) and add it via `page.context().addCookies(...)`
  before navigating. Fragile across token refresh; use only if (a) is unavailable.
- **(c) User-supplied screenshots** — verify `/login` (public) fully both themes; the user
  logs in and captures `/me` + `/admin` (both themes) manually, dropped into `reports/screens/`
  with the standard filenames; you verify visually. Lowest fidelity (no live axe in 5.2).

If none of (a)/(b)/(c) is available this session, **escalate** (record the blocker in
`reports/checklist.md`, mark `/me` + `/admin` rows as BLOCKED with the reason, and proceed with
all public surfaces). Do not skip silently.

Also mint a `manage_token`: complete one booking via `/book?xbc=411` (Step 5) and reuse the
token from the confirmation/DB, or ask the user for a `/booking/manage/<token>` URL.

**Verification:**
- Either `/me` returns 200 (not 307) under the chosen session strategy, OR a documented BLOCKED
  state with reason. A `manage_token` is in hand (or BLOCKED).

### Step 3: Set deterministic viewports

**Surface:** [browser]

- [browser] `browser_resize` to **1280×900** for all primary desktop captures.
- [browser] `browser_resize` to **390×844** for mobile captures (responsive + embed full-screen
  `<640px` `100dvh`). Switch viewport per the matrix in Step 4.

**Verification:**
- Snapshot/screenshot dimensions match the requested viewport.

### Step 4: Sweep every surface × theme × viewport

**Surface:** [browser][file]

For each surface below, for `theme=light` then `theme=dark`, at desktop then (where noted)
mobile: `browser_navigate` → `browser_snapshot` (paste the a11y-tree text into the checklist
notes) → `browser_take_screenshot` to the explicit path. Use full-page capture where the
surface scrolls. Compare each against the DS `preview/*.html` (read the matching preview file
under `~/Documents/Pennie Branding/Pennie Design System/preview/`) and mark visual parity in
the checklist.

Surface → URL matrix (canonical seed `xbc=411`, port 3000):

| # | Surface | URL | Themes | Viewports | Key check vs DS preview |
|---|---------|-----|--------|-----------|-------------------------|
| 1 | Booker (embed entry) | `/book?xbc=411&theme=light` / `&theme=dark` | light + dark | desktop + mobile | beige-first default, sky CTA, PP Mori |
| 2 | Booker (path entry) | `/booking/<sfId>?xbc=411&theme=light` | light + dark | desktop | same as #1 via path entry |
| 3 | Confirmation (delight) | reach by completing a booking (Step 5) | light + dark | desktop + mobile | standalone = 3D coins graphic in sky-soft panel + warm copy |
| 4 | Manage / reschedule / cancel | `/booking/manage/<token>` | light + dark | desktop | on-brand, destructive = muted rose `#C43D3D` |
| 5 | Login | `/login` | light + dark | desktop + mobile | marketing split: navy panel + cream logo + white form card, sky CTA |
| 6 | `/me` (agent self) | `/me` | light + dark | desktop | branded shell, bookable pill, sky-soft notice (no amber) |
| 7 | `/admin` | `/admin` | light + dark | desktop | beige dashboard, white `.pn-card`, role/status pills, tabular nums |
| 8 | Embed example (modal) | `/embed-example.html` | host (light + brand) | desktop + mobile | Step 6 |
| — | Landing | `/` | light + dark | desktop | single beige hero, sky primary + outline secondary |

Filename convention: `reports/screens/<surface>-<theme>-<viewport>.png`, e.g.
`book-light-desktop.png`, `book-dark-mobile.png`, `login-light-desktop.png`,
`admin-dark-desktop.png`, `me-light-desktop.png`, `landing-light-desktop.png`.

**Verification:**
- One screenshot PNG per (surface × theme × viewport) cell exists at its encoded path; each row
  in `reports/checklist.md` has a screenshot path + snapshot-captured note + parity verdict.

### Step 5: Walk the interactive booking flow (capture real states)

**Surface:** [browser]

An empty calendar is not enough — capture the real states. On `/book?xbc=411&theme=light`
(then repeat for dark):

1. [browser] Click a **day** in the calendar → screenshot `book-day-light-desktop.png`
   (confirm selected-day has a **non-color** signal per D18, not just a color change).
2. [browser] Click a **time slot** → screenshot `book-slot-light-desktop.png` (slot selected
   state; surfaced timezone).
3. [browser] Reach the **name/email/phone form** → screenshot `book-form-light-desktop.png`
   (sky CTA = sky fill + graphite label + arrow; labeled inputs).
4. [browser] Submit a real booking on bucket `411` → reach the **confirmation** delight moment
   → screenshot `confirm-light-desktop.png` (standalone shows the 3D coins graphic + warm copy
   like "You're booked! Sarah will call you Thursday at 2:00."). Capture the `manage_token` from
   the result for Step 4 #4.
5. [browser] Repeat the day/slot/form/confirmation captures for `theme=dark`.

**Verification:**
- Day, slot, form, and confirmation screenshots exist for both themes; a `manage_token` is
  captured for the manage-page row.

### Step 6: Embed modal chrome (host page)

**Surface:** [browser]

- [browser] Navigate `/embed-example.html`, click the "Schedule your call" trigger.
- [browser] Screenshot the injected host-page modal at desktop → `embed-modal-desktop.png`.
  Confirm D15 **literal** chrome (white modal, `border-radius:16px`, `--shadow-pop` literal,
  navy scrim `rgba(29,33,47,0.55)`, sky focus ring) — the modal can't read `--pennie-*` vars, so
  verify literal values via the screenshot/computed styles, not by assuming the cascade.
- [browser] Confirm the **branded loading state** renders and the in-iframe confirmation shows
  the lightweight **SVG puck** (check-badge/smile in a sky-soft puck), NOT the heavy 3D graphic.
- [browser] Resize to 390×844, reopen the modal, screenshot → `embed-modal-mobile.png` (verify
  full-screen `100dvh` on `<640px`).

**Verification:**
- Desktop + mobile embed-modal screenshots exist; literal chrome + branded loading + SVG puck
  confirmed in the checklist notes.

### Step 7: Fill the per-surface checklist

**Surface:** [file]

- [file] Write/append `reports/checklist.md` using the §9 template from the `slate-ui-verification`
  skill — one row block per (surface × theme × viewport). (S13: `reports/checklist.md` is the
  canonical Phase-5 consolidated checklist, shared by 5.1→5.2→5.4 which build on it sequentially;
  the per-phase sweeps use their own `checklist-phase-N.md` / `reports/phase-N/` files so nothing
  clobbers this one.) For Task 5.1, fill the **Screenshot**,
  **a11y-tree snapshot** (captured Y/N + key roles seen), **Notes** (DS-preview parity verdict),
  and **Result** (PASS/FAIL/BLOCKED) columns. Leave the axe / Lighthouse / reduced-motion columns
  for Task 5.2.

**Verification:**
- `reports/checklist.md` has a filled row for every matrix cell with a screenshot path and a
  PASS/FAIL/BLOCKED verdict.

## Artifacts to Create

- `reports/screens/*.png` — one screenshot per (surface × theme × viewport) + the booking-flow
  state captures + the two embed-modal captures — [browser]
- `reports/checklist.md` — filled per-surface visual rows (skill §9 template) — [file]

## Artifacts to Modify

- None. This task captures evidence; it does not edit app code (D5: visual-only, and 5.1 is
  observe-only — log FAILs, don't patch them).

## Contracts

### Provides (for downstream tasks)

- Running `pnpm dev` server (port 3000, warmed) + the auth session strategy: reused by 5.2/5.3.
- `reports/screens/*.png`: the canonical visual evidence set — referenced by 5.4 final report.
- `reports/checklist.md`: the per-surface scaffold — 5.2 fills the axe/Lighthouse/reduced-motion
  columns; 5.4 reads the parity verdicts.
- The minted `manage_token`: reused by 5.2 (a11y on manage page) and 5.3 (E2E observation).
- List of any visual FAILs/BLOCKED surfaces: feeds 5.4 sign-off.

### Consumes (from upstream tasks)

- All restyled surfaces from Phases 1–4 (the things being screenshotted).
- DS `preview/*.html` at `~/Documents/Pennie Branding/Pennie Design System/preview/` — the
  visual-parity reference.

## Acceptance Criteria

- [ ] `pnpm dev` is up on port 3000 and all routes warmed.
- [ ] Every surface (Booker incl. day/slot/form/confirmation states, manage, login, admin, me,
      landing, embed modal) screenshotted in **both themes** at **desktop 1280×900**; Booker,
      login, confirmation, and embed also at **mobile 390×844**.
- [ ] Each screenshot saved at `reports/screens/<surface>-<theme>-<viewport>.png`.
- [ ] a11y-tree snapshot captured (text pasted to checklist notes) for each surface.
- [ ] Standalone confirmation shows the 3D coins graphic; embed iframe shows the SVG puck.
- [ ] Embed modal chrome uses literal Pennie values; mobile modal is full-screen `100dvh`.
- [ ] `/me` + `/admin` either captured (auth resolved) or explicitly marked BLOCKED with reason
      and the user-action needed.
- [ ] Each surface compared to its DS `preview/*.html`; parity verdict recorded.
- [ ] `reports/checklist.md` filled (visual columns) with PASS/FAIL/BLOCKED per row.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- Navigate to each URL in the Step 4 matrix (always with explicit `theme=`).
- Snapshot: confirm expected roles/names appear (event heading, calendar grid, slot list,
  labeled inputs, confirmation heading) — paste into checklist notes.
- Screenshot: capture each surface × theme × viewport to the encoded path.
- User-emulating flow: pick day → pick slot → fill form → submit → land on confirmation; open
  the embed modal from `/embed-example.html`.

#### [file] File Verification
- Read back a sample of `reports/screens/*.png` paths to confirm they were written (non-zero
  size via `ls -la reports/screens`).
- Read the matching DS `preview/*.html` to confirm the parity comparison was grounded in the
  actual design reference.
- Verify `reports/checklist.md` exists and has a row per matrix cell.

#### [code] Code Verification
- `ls -la /Users/danhankins-wright/Documents/Slate/reports/screens/` → expected screenshot
  count present, all non-zero size.

### Cross-Surface Coherence
- Spot-check that the same token-driven palette/type/shape appears across Booker, login, admin,
  me, and landing in the screenshots (full coherence is 5.4's job; here, just flag any obvious
  drift in the checklist notes).
- Confirm light and dark variants of the same surface are consistent transforms of each other
  (semantic vars flipped, not ad-hoc recolors).

## Skills to Read

- `slate-ui-verification` — the surface→URL matrix (§1), dev-server warm-up (§2), Playwright
  capture procedure (§3), auth blocker resolution (§8), and the checklist template (§9). This is
  the primary playbook for this task.
- `pennie-design-system-in-slate` — what each surface should look like (tokens, fonts, shapes)
  so the DS-preview parity comparison is grounded.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` —
  exact surface/URL/viewport/filename procedure and the auth/token gates.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — which interactive
  states to capture and the color-never-sole-signal cues to note while screenshotting.
- `.claude/orchestration-slate-brand-redesign/reports/surface-verification.md` — route
  reachability table + the admin/me auth blocker.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

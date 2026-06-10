# Slate Brand Redesign - Action Phases

**Target**: Self-paced (no hard deadline)
**Execution**: Sequential phases, autonomous subagent execution, verify each surface before moving on
**Authority**: DISCOVERY.md overrides everything (PROJECT-BRIEF.md, research/, skills/ defer to it)

---

## Scope Constraints (from DISCOVERY.md D5)

OUT of scope — do NOT execute:
- Any functional/logic change: booking logic, availability cache (`busy_blocks`), Google
  Calendar sync, round-robin, webhooks (Regal/Cadence), auth/RBAC, server actions, DB.
- Helvetica Now Display (PP Mori only).
- Shipping the personal-use OTFs (use the licensed woff2, 400+600 only).
- Recreating the logo in code (use SVG assets).
- Breaking the cal.com drop-in embed contract.
- Breaking Cloudflare Workers / OpenNext deployability.
- Adding SVGO/SVGR/font-converter tooling (none needed).

This is a **visual-only** redesign. If a restyle seems to require a logic change, STOP and flag it.

---

## Tool Stack

| Tool | Surface | Purpose |
|------|---------|---------|
| Bash / Read / Write / Edit | Files/Code | Edit TS/CSS/React, vendor fonts+SVGs, run build/lint/test |
| Playwright MCP | Browser | Drive local app, snapshot/screenshot surfaces both themes, axe injection |
| Peekaboo CLI 3.4.0 | Native | Screenshot fallback if browser tooling stalls |
| pnpm (10.33) / Node (24) | Code | `pnpm dev` / `build` / `lint` / `test` |
| npx lighthouse (11.6) | Browser | a11y/perf scoring |

---

## Skills Reference

All at `.claude/skills/`. Agents MUST read the relevant skill before starting a task.

| Skill | Use When |
|-------|----------|
| `pennie-design-system-in-slate` | Restyling ANY surface — tokens, fonts, assets, theming, color/shape/voice rules, pitfalls |
| `slate-ui-verification` | Verifying any surface — Playwright/axe/Lighthouse/contrast script, surface→URL matrix, auth blocker |
| `slate-embed-contract` | Editing widget.js or embed theming — the cal.com drop-in contract guardrails |

---

## Tools Reference

| Server/Tool | Surface | Use For | Key Operations |
|-------------|---------|---------|----------------|
| **Playwright MCP** | Browser | Drive app, verify | browser_navigate, browser_snapshot, browser_take_screenshot, browser_evaluate (axe), browser_resize, emulate reduced-motion |
| **Peekaboo CLI** | Native | Screenshot fallback | `peekaboo image`, `peekaboo see --app` |
| **Bash** | Code | build/lint/test, file ops | `pnpm dev/build/lint/test`, cp, node scripts |
| **npx lighthouse** | Browser | a11y/perf score | `npx lighthouse <url> --only-categories=accessibility` |

---

## Verification Methods

| Surface | Tool | Verification Method |
|---------|------|-------------------|
| Browser (Web) | Playwright | snapshot + screenshot per theme; axe via browser_evaluate; compare to DS `preview/*.html` |
| Code | Bash | `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (incl. `scripts/test-contrast.ts`) |
| Files | Read | read back vendored assets/fonts; grep for stray `neutral-/emerald-/red-/amber-/#hex` |
| Native (fallback) | Peekaboo | `peekaboo image` of the browser window |
| A11y | axe + Lighthouse + contrast script | AA rules clean; Lighthouse a11y ≥0.95; contrast pairings pass |

Canonical booking URL for verification: `/book?xbc=411&theme=light|dark`.

---

## Phase Overview

| Phase | Goal | Tasks | Primary Surfaces |
|-------|------|-------|-----------------|
| 1: Foundation | Tokens + fonts + assets + theming so every surface inherits Pennie | 6 | Code |
| 2: Booker (consumer) | Restyle the booking flow beige-first, sky CTA, delight finish | 5 | Code + Browser |
| 3: Internal pages | Login (marketing-rich), admin, me, landing — light + dark | 5 | Code + Browser |
| 4: Embed + a11y polish | widget.js chrome, AA+ pass, responsive, contrast guard | 5 | Code + Browser |
| 5: Comprehensive verification | All surfaces, both themes, embed, mobile, AA+, build/lint/test, booking E2E | 4 | All |
| **Total** | | **25** | |

---

## Phase 1: Foundation

**Goal**: Port the Pennie token system, fonts, and assets into Slate so all later restyles
inherit the system. No surface visually "finished" yet, but the plumbing is brand-correct.

### Task 1.1: Vendor fonts + assets
- **Objective**: Get the licensed fonts and brand assets into the repo at their final paths.
- **Surface(s)**: [file]
- **Dependencies**: None
- **Blocked by**: None
- **Actions to Perform**:
  - [file] Copy `PPMori-Regular.woff2` (400) + `PPMori-SemiBold.woff2` (600) from
    `~/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/` → `src/app/fonts/PPMori/`.
  - [file] Copy logo SVGs (`logo-pennie-charcoal.svg`, `-cream.svg`, `-lg-*`, `logo-mark.svg`)
    from the DS `assets/` → `public/brand/`.
  - [file] Copy the confirmation graphic (`pic-1` coins, default) → `public/brand/pic-1-coins.png`.
  - [file] Delete dead `public/slate-logo.png` (1.2 MB, unreferenced) and old `src/app/icon.png`.
- **Contracts**: Asset paths consumed by 1.3 (fonts), 1.4 (icons), Phase 2/3 (logos, graphic).
- **Acceptance Criteria**:
  - [ ] Two woff2 files present under `src/app/fonts/PPMori/`.
  - [ ] Logo SVGs + confirmation graphic present under `public/brand/`.
  - [ ] Dead assets removed; no references dangling (grep).
- **Verification**:
  - [ ] [file] Read back each path; grep repo for `slate-logo.png` / `icon.png` → no live refs.
- **Skills**: `pennie-design-system-in-slate`

### Task 1.2: Port token layer (colors_and_type.css → Slate)
- **Objective**: Bring all `--pennie-*` + semantic + radii + shadow + `--space-*` tokens and
  the `.pn-*` base classes into `globals.css`, with light/dark theming.
- **Surface(s)**: [code]
- **Dependencies**: None
- **Blocked by**: None
- **Actions to Perform**:
  - [code] Replace boilerplate `src/app/globals.css`: Layer A = raw `--pennie-*`/semantic/
    radii/shadow/`--space-*` in `:root` + `[data-theme="dark"]` flipping semantic vars only.
  - [code] Add the `.pn-*` base classes (btn variants, card, h1–h4, lead/body/small/eyebrow)
    from the DS CSS (omit its `@font-face` block).
  - [code] Layer B: `@theme inline` exposing the subset as Tailwind utilities
    (`--color-accent`, `--radius-*`, `--font-sans`, etc.); add `@custom-variant dark`.
  - [code] Remove the `body { font-family: Arial }` override and the `--font-geist-*` tokens.
- **Contracts**: Tokens consumed by every later task; `data-theme` attribute consumed by 1.5.
- **Acceptance Criteria**:
  - [ ] All DS tokens resolve as CSS vars; `.pn-*` classes match DS `preview/*.html`.
  - [ ] Both raw `var(--…)` and Tailwind utilities (e.g. `bg-accent`) work.
  - [ ] No Geist/Arial references remain.
- **Verification**:
  - [ ] [code] `pnpm build` exits 0; [browser] a token smoke check renders sky/beige/graphite.
- **Skills**: `pennie-design-system-in-slate`

### Task 1.3: Load PP Mori via next/font/local
- **Objective**: Self-host PP Mori (400+600, 700→600, `font-synthesis:none`) and wire it to
  the `--font-sans` token so `.pn-*`, the `font-sans` utility, and body all resolve to it.
- **Surface(s)**: [code]
- **Dependencies**: 1.1 (fonts vendored), 1.2 (token layer)
- **Blocked by**: 1.1, 1.2
- **Actions to Perform**:
  - [code] Create `src/app/fonts/pp-mori.ts` with `next/font/local` (Regular 400, SemiBold 600,
    + a 700 src aliased to SemiBold), `variable: '--font-pp-mori'`, `declarations:[{prop:'font-synthesis',value:'none'}]`, `display:'swap'`, fallback stack.
  - [code] Apply `ppMori.variable` to `<html>` in `layout.tsx`; remove Geist imports; update
    `metadata` (title/description) if needed.
  - [code] Point DS `--font-sans` (and `@theme --font-sans`) at `var(--font-pp-mori)`.
- **Contracts**: `--font-pp-mori` consumed by token layer.
- **Acceptance Criteria**:
  - [ ] App renders in PP Mori; headings 600, body 400; no synthesized bold; no Geist.
- **Verification**:
  - [ ] [code] `pnpm build` exits 0; [browser] computed `font-family` on body = PP Mori; weights correct.
- **Skills**: `pennie-design-system-in-slate`

### Task 1.4: Brand icon + app-icon set
- **Objective**: Create inline React icon components from the DS `currentColor` SVGs and set
  the Pennie favicon/app icons.
- **Surface(s)**: [code][file]
- **Dependencies**: 1.1
- **Blocked by**: 1.1
- **Actions to Perform**:
  - [code] Create `src/components/icons/` inline `<svg>` React components for the icons Slate
    uses (arrow, check, check-badge, smile, chevrons, plus/minus, clock, phone, globe, etc.),
    all `currentColor` (keep `check-badge` tick literal `#F9F6F0`).
  - [file] Add `src/app/icon.svg` (Pennie mark, baked concrete fill) + replace `apple-icon`
    (PNG or `apple-icon.tsx` ImageResponse) per Next 16 metadata conventions.
- **Contracts**: Icon components consumed by Booker (2.x), internal pages (3.x), embed (4.x).
- **Acceptance Criteria**:
  - [ ] Icons inline and tint via `color`/`currentColor`; favicon shows Pennie mark.
- **Verification**:
  - [ ] [browser] favicon + a sample icon render correct color in both themes.
- **Skills**: `pennie-design-system-in-slate`

### Task 1.5: Theme infrastructure (data-theme, no-flash, toggle)
- **Objective**: Establish the `data-theme` light/dark mechanism app-wide with no flash.
- **Surface(s)**: [code]
- **Dependencies**: 1.2
- **Blocked by**: 1.2
- **Actions to Perform**:
  - [code] Default `data-theme="light"` on `<html>`; add a no-flash inline `<head>` script +
    `suppressHydrationWarning` for internal pages that persist a choice (localStorage).
  - [code] Build a small client theme-toggle island (used by internal pages in Phase 3).
- **Contracts**: Consumed by Booker theme prop reconciliation (2.1) + internal toggle (3.x).
- **Acceptance Criteria**:
  - [ ] Toggling `data-theme` flips semantic vars; no FOUC; SSR-safe.
- **Verification**:
  - [ ] [browser] switch theme → colors flip; reload → persisted; no flash.
- **Skills**: `pennie-design-system-in-slate`

### Task 1.V: Phase 1 Verification Sweep
- **Objective**: Confirm the foundation is brand-correct and builds.
- **Dependencies**: 1.1–1.5 complete
- **Verification**:
  - [ ] [code] `pnpm build` + `pnpm lint` clean; `pnpm test` green.
  - [ ] [browser] token smoke page in both themes; PP Mori loaded; favicon correct.
  - [ ] [file] grep: no `font-geist`, no `slate-logo.png`, no Arial override.
  - [ ] Evidence (screenshots, build log) saved to `reports/`.

---

## Phase 2: Booker (consumer)

**Goal**: Restyle the booking flow to the Pennie system — beige/light default, sky CTA,
clean steps + one delight finish — preserving light/dark + embed brandColor. Highest-visibility surface.

### Task 2.1: Token-drive the Booker palette + flip default to light
- **Objective**: Replace `Booker.tsx`'s hardcoded `neutral-*` PALETTE with token-driven styling;
  default theme → light.
- **Surface(s)**: [code]
- **Dependencies**: Phase 1
- **Blocked by**: 1.V
- **Actions to Perform**:
  - [code] Rewrite the `PALETTE` object (Booker.tsx ~47–92) to use Pennie tokens / `.pn-*`
    semantics for light + dark; flip the `theme = "dark"` default (~124) to `"light"`.
  - [code] Reconcile with `data-theme` (1.5) and the embed `theme` param.
- **Contracts**: brandColor handling preserved for 2.4; theme contract with /book (2.x).
- **Acceptance Criteria**:
  - [ ] Booker renders beige/light by default; dark still correct; no `neutral-*` literals left.
- **Verification**:
  - [ ] [browser] `/book?xbc=411` (no theme) → beige; `&theme=dark` → navy; [file] grep no `neutral-`.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 2.2: Restyle calendar + time-slot selection
- **Objective**: Day grid, month nav, slot list to Pennie tokens; fix sub-44px targets.
- **Surface(s)**: [code]
- **Actions to Perform**:
  - [code] Day cells, selected-day, today-dot (replace emerald → sky/green token + non-color
    cue), slot buttons, month-nav (enlarge to ≥44px), skeletons → Pennie tokens.
  - [code] Surface timezone near the slot list.
- **Dependencies**: 2.1 — **Blocked by**: 2.1
- **Acceptance Criteria**:
  - [ ] Calendar/slots match DS `preview/` feel; selected state has non-color signal; ≥44px targets.
- **Verification**:
  - [ ] [browser] screenshot day/slot states both themes; tap targets measured.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 2.3: Restyle the attendee form + primary CTA
- **Objective**: Inputs (DS field style: shadow not border), the sky CTA (sky fill + graphite
  label, arrow), error states → muted rose.
- **Surface(s)**: [code]
- **Actions to Perform**:
  - [code] Form fields → `.pn-*`/tokens; CTA → `.pn-btn--big --primary` (fix white-on-sky →
    graphite label); `text-red-*` → rose `#C43D3D`.
- **Dependencies**: 2.1 — **Blocked by**: 2.1
- **Acceptance Criteria**:
  - [ ] CTA is sky+graphite (passes 7.36:1); errors muted rose; inputs on-brand.
- **Verification**:
  - [ ] [browser] axe clean on form; CTA contrast verified; [code] grep no `red-500`.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 2.4: Confirmation delight + brandColor default
- **Objective**: Add the one delight moment; make embed pass Pennie sky by default.
- **Surface(s)**: [code]
- **Actions to Perform**:
  - [code] Confirmation screen: standalone → `pic-1-coins.png` in sky-soft panel + warm copy;
    embed (`embedded` flag) → inline check-badge/smile SVG puck. Animate opacity/transform ONLY.
  - [code] Default brandColor → Pennie sky when no `brand` param (keep host override).
- **Dependencies**: 2.1, 1.4 — **Blocked by**: 2.1
- **Contracts**: Respects embed ResizeObserver (no height animation) — see `slate-embed-contract`.
- **Acceptance Criteria**:
  - [ ] Standalone shows graphic; embed shows lightweight SVG; default accent = sky; reduced-motion honored.
- **Verification**:
  - [ ] [browser] complete a booking in standalone + embed; confirm delight renders; no resize jump.
- **Skills**: `pennie-design-system-in-slate`, `slate-embed-contract`, `slate-ui-verification`

### Task 2.5: Restyle ManageBooking + reschedule/cancel pages
- **Objective**: `/booking/manage/[token]` and reschedule/cancel views to Pennie; muted rose.
- **Surface(s)**: [code]
- **Actions to Perform**:
  - [code] `ManageBooking.tsx` + manage/reschedule/cancel pages → tokens; `red-600/200` → rose.
- **Dependencies**: 2.1 — **Blocked by**: 2.1
- **Acceptance Criteria**:
  - [ ] Manage flow on-brand both themes; destructive actions use muted rose, not bright red.
- **Verification**:
  - [ ] [browser] screenshot manage/reschedule/cancel (needs a real token — see auth/seed note).
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 2.V: Phase 2 Verification Sweep
- **Verification**:
  - [ ] [browser] all Booker states, both themes, desktop + 390px mobile; axe clean; Lighthouse a11y ≥0.95.
  - [ ] [code] `pnpm build/lint/test` green; grep no stray `neutral-/emerald-/red-`.
  - [ ] Booking flow works E2E (standalone + embed). Evidence → `reports/`.

---

## Phase 3: Internal pages

**Goal**: Login (marketing-rich), admin, me, landing — fully branded, light + dark.

### Task 3.1: Shared app shell + theme toggle
- **Objective**: A branded header/shell (logo, nav tabs, email, theme toggle) for admin/me.
- **Surface(s)**: [code]
- **Dependencies**: Phase 1 — **Blocked by**: 1.V
- **Actions to Perform**:
  - [code] Build `AppHeader` (charcoal logo, Admin/Me tabs, theme toggle from 1.5, reconnect-Google);
    extract the duplicated admin/me style constants into a shared module.
- **Contracts**: Shell consumed by 3.2 (admin), 3.3 (me).
- **Acceptance Criteria**:
  - [ ] Shared header renders; toggle works; one source for the shared style constants.
- **Verification**: [ ] [browser] header in both themes (auth required — see blocker).
- **Skills**: `pennie-design-system-in-slate`

### Task 3.2: Restyle admin dashboard
- **Objective**: Beige dashboard; white `.pn-card` sections; role/status pills; shadow-led tables
  with tabular numerals; replace JSX-ternary status colors with Pennie tokens (keep conditions).
- **Surface(s)**: [code]
- **Dependencies**: 3.1 — **Blocked by**: 3.1
- **Actions to Perform**:
  - [code] Re-skin via the shared style constants; map push-health dot / bookable / webhook pill /
    `text-amber-600` (lines ~155/449/543/806/945) → Pennie tokens preserving non-color signals.
- **Acceptance Criteria**:
  - [ ] Admin on-brand both themes; no bright `amber-/green-/red-/neutral-` literals; data unchanged.
- **Verification**: [ ] [browser] admin screenshots both themes; [code] grep the two .tsx files for bright classes.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 3.3: Restyle me (agent self-view)
- **Objective**: Same shell, simpler; bookable pill; sky-soft notice replacing amber banner.
- **Surface(s)**: [code]
- **Dependencies**: 3.1 — **Blocked by**: 3.1
- **Acceptance Criteria**: [ ] me on-brand both themes; amber banner → calm sky-soft notice.
- **Verification**: [ ] [browser] me screenshots both themes.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 3.4: Marketing-rich login
- **Objective**: Split layout — navy brand panel (cream logo, optimistic copy, optional sticky-note)
  + white form card with the existing Google CTA reskinned to `.pn-btn--big --primary`.
- **Surface(s)**: [code]
- **Dependencies**: Phase 1 — **Blocked by**: 1.V
- **Actions to Perform**:
  - [code] `lg:grid-cols-2`, stacks <1024px, panel hidden <640px; cream logo on navy; keep `signIn()` untouched.
- **Acceptance Criteria**:
  - [ ] Login is split marketing layout; white-on-navy passes AA; auth mechanism unchanged.
- **Verification**: [ ] [browser] login screenshots desktop + mobile, both themes; axe clean.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 3.5: Restyle landing page
- **Objective**: `src/app/page.tsx` → single beige hero, one display heading, sky primary + outlined buttons.
- **Surface(s)**: [code]
- **Dependencies**: Phase 1 — **Blocked by**: 1.V
- **Acceptance Criteria**: [ ] Landing on-brand; buttons sky primary + outline secondary.
- **Verification**: [ ] [browser] landing screenshot both themes.
- **Skills**: `pennie-design-system-in-slate`, `slate-ui-verification`

### Task 3.V: Phase 3 Verification Sweep
- **Verification**:
  - [ ] [browser] login/admin/me/landing both themes (resolve admin/me auth path first).
  - [ ] [code] `pnpm build/lint/test` green; grep both admin/me .tsx for bright color classes.
  - [ ] Evidence → `reports/`.

---

## Phase 4: Embed + accessibility polish

**Goal**: Pennie-brand the injected modal chrome (literal values), add modal a11y + loading +
mobile, and lock accessibility with the contrast guard — without breaking the cal.com contract.

### Task 4.1: Restyle widget.js modal chrome (literals)
- **Objective**: Re-skin the injected host-page chrome with literal Pennie values (it can't read
  CSS vars); keep widget.js vanilla.
- **Surface(s)**: [code]
- **Dependencies**: Phase 2 — **Blocked by**: 2.V
- **Actions to Perform**:
  - [code] Modal → white, `border-radius:16px`, `--shadow-pop` literal, navy scrim
    `rgba(29,33,47,0.55)`, graphite close button. NO `--pennie-*` vars in widget.js.
- **Contracts**: Must NOT touch Cal() API, data-cal-*, URL params, postMessage contract.
- **Acceptance Criteria**: [ ] Chrome looks Pennie; widget.js still dependency-free; contract intact.
- **Verification**: [ ] [browser] open modal from `/embed-example.html`; chrome literals render.
- **Skills**: `slate-embed-contract`, `slate-ui-verification`

### Task 4.2: Modal a11y + loading + mobile
- **Objective**: role=dialog/aria-modal, focus trap + restore, Escape, scroll lock, ≥44px close,
  branded loading state, mobile full-screen (<640px, `100dvh`), reduced-motion.
- **Surface(s)**: [code]
- **Dependencies**: 4.1 — **Blocked by**: 4.1
- **Acceptance Criteria**: [ ] Modal is keyboard-accessible, traps focus, escapes, locks scroll, full-screen on mobile.
- **Verification**: [ ] [browser] keyboard-only open/close; mobile viewport; axe on host page.
- **Skills**: `slate-embed-contract`, `slate-ui-verification`

### Task 4.3: Commit the contrast guard
- **Objective**: Add `scripts/test-contrast.ts` (node-native, runs in `pnpm test`) asserting the
  D17 pairings + forbidden-as-text tripwires from the ported tokens.
- **Surface(s)**: [code]
- **Dependencies**: 1.2 — **Blocked by**: 1.2
- **Acceptance Criteria**: [ ] `pnpm test` runs the contrast script; passes on current tokens; fails if a pairing regresses.
- **Verification**: [ ] [code] `pnpm test` green; deliberately break a token → script fails.
- **Skills**: `slate-ui-verification`

### Task 4.4: Theme-aware focus + reduced-motion sweep
- **Objective**: Implement theme-aware focus (graphite outline on light, sky on navy; glow decorative),
  honor `prefers-reduced-motion` on all entry/float/hover/delight animations.
- **Surface(s)**: [code]
- **Dependencies**: Phase 2, 3 — **Blocked by**: 2.V, 3.V
- **Acceptance Criteria**: [ ] Focus visible & AA on both surfaces; motion fully gated by reduced-motion.
- **Verification**: [ ] [browser] Tab through each surface; emulate reduced-motion → no animation.
- **Skills**: `slate-ui-verification`, `pennie-design-system-in-slate`

### Task 4.5: Responsive sweep
- **Objective**: Verify/adjust mobile (640px stack) across Booker, internal pages, embed.
- **Surface(s)**: [code]
- **Dependencies**: 2.V, 3.V, 4.1 — **Blocked by**: 2.V, 3.V
- **Acceptance Criteria**: [ ] All surfaces usable at 390px; no overflow; targets ≥44px.
- **Verification**: [ ] [browser] 390×844 screenshots of each surface.
- **Skills**: `slate-ui-verification`

### Task 4.V: Phase 4 Verification Sweep
- **Verification**:
  - [ ] [browser] embed modal a11y + mobile; [code] `pnpm test` (contrast) green; reduced-motion verified.
  - [ ] cal.com contract intact (Cal() API, params, postMessage). Evidence → `reports/`.

---

## Phase 5: Comprehensive Verification

**Goal**: Multi-surface verification of every deliverable against DISCOVERY.md acceptance bars.

### Task 5.1: Full visual + theme sweep (all surfaces)
- Screenshot every surface (Booker all states, manage, login, admin, me, landing, embed) in
  BOTH themes at desktop + 390px mobile; compare to DS `preview/*.html`. Evidence → `reports/screens/`.

### Task 5.2: Accessibility audit (AA + extra care)
- axe clean (AA) on every public surface + embed host page; Lighthouse a11y ≥0.95; `pnpm test`
  contrast guard green; keyboard nav + focus + reduced-motion + SR labels manually verified;
  confirm color is never the sole signal (selected day, best-match, errors).

### Task 5.3: Functional regression + build/deploy safety
- `pnpm build` + `pnpm lint` + `pnpm test` green; booking flow works E2E (standalone + embed);
  confirm NO logic touched (git diff review: only CSS/markup/asset changes); cal.com contract intact;
  sanity-check OpenNext build compatibility (`pnpm build` is the proxy; full `cf:build` optional).

### Task 5.4: Final coherence + sign-off
- Cross-surface consistency (same tokens, type, shapes everywhere); grep whole repo for stray
  `neutral-/emerald-/amber-/red-/green-/#hex` outside tokens; confirm all DISCOVERY decisions
  (D1–D22) satisfied; write final report to `reports/final-verification.md`.

---

## Dependency Graph

```
Phase 1 (Foundation)
  1.1 fonts/assets ─┐
  1.2 tokens ───────┼─> 1.3 fonts-load
                    ├─> 1.4 icons
                    └─> 1.5 theme-infra
  (1.1..1.5) ─> 1.V ─────────────────────────────┐
                                                  │
        ┌─────────────────────┬───────────────────┤
        v                     v                   v
Phase 2 (Booker)       Phase 3 (Internal)   Phase 4 (Embed/a11y)
  2.1 ─> 2.2,2.3,2.4,2.5    3.1 ─> 3.2,3.3      4.1 ─> 4.2
  (2.x) ─> 2.V             3.4, 3.5            4.3 (needs 1.2)
        │                  (3.x) ─> 3.V        4.4 (needs 2.V,3.V)
        │                       │              4.5 (needs 2.V,3.V)
        │                       │              (4.x) ─> 4.V
        └──────────┬────────────┴──────────────────┘
                   v
        Phase 5 (Comprehensive Verification) 5.1 ─> 5.2 ─> 5.3 ─> 5.4
```

Note: 4.1/4.3 can start after Phase 2 / Task 1.2 respectively; 4.4/4.5 gate on 2.V + 3.V.

---

## Task Execution Protocol

### For each task:
1. **Orient**: Read the task file, the listed skills, and PROGRESS.md.
2. **Plan**: Explore current state of the target files; plan the minimal visual-only change.
3. **Execute**: Edit on [code]/[file]; never alter logic. Use tokens/`.pn-*`, never hex.
4. **Verify**: Run the verification loop (Execute → Verify on Browser/Code → retry ≤3 → escalate).
5. **Complete**: Update PROGRESS.md with status, evidence paths, notes.

### For verification sweep tasks (x.V):
1. Re-verify ALL deliverables from the phase on their surfaces (screenshots both themes).
2. Run `pnpm build/lint/test`; run axe/Lighthouse on changed surfaces.
3. Check cross-surface coherence; grep for stray non-token colors.
4. Fix failures, re-verify until green; record evidence in `reports/`.

### For the final phase (5):
1. Every surface checked on Browser in both themes + mobile.
2. Every accessibility criterion (D17/D18) validated.
3. Build/lint/test green; booking E2E; cal.com contract + CF deployability intact.
4. Iterate until all checks pass; write `reports/final-verification.md`.

### Auth note (admin/me)
`/admin` and `/me` are Google-OAuth-gated; a headless agent can't self-auth. Before 3.V and
5.1/5.2 for those surfaces, resolve via a logged-in Playwright profile / injected Supabase
session / user-supplied screenshots (see `reports/surface-verification.md`).

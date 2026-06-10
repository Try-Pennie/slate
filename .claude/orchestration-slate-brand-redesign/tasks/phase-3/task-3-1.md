# Task 3.1: Shared app shell + theme toggle

## Objective

Build a branded, presentation-only `AppHeader` (charcoal Pennie logo, Admin/My-availability nav
tabs, current user email, a persisted light/dark theme toggle, and the "Connect / reconnect
Google" action) for the internal `/admin` and `/me` pages, and extract the duplicated style
constants those two pages carry into one shared module. This is the chrome that tasks 3.2 (admin)
and 3.3 (me) consume. **Visual-only** — no auth, RBAC, server-action, form-`name=`, or data
changes.

## Context

`/admin` and `/me` are server components that today each declare their own copy of the same four
Tailwind style-constant strings (`labelCls`/`inputCls`/`cardCls`/`btnCls`) and each render their
own ad-hoc `<header className="flex items-center justify-between">`. This task creates the single
source of truth for both: a shared styles module and a shared `AppHeader`. Phase 1 (foundation) is
already complete — the Pennie tokens, `data-theme` + `@custom-variant dark`, the no-flash inline
`<head>` script, PP Mori via `next/font/local`, vendored logo SVGs, and inline icon components all
exist and just need to be consumed here.

This is the first task in Phase 3 and gates 3.2 and 3.3.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash / Read / Write / Edit | Create `AppHeader` + theme-toggle island + shared styles module; rewire admin/me to import them |
| Browser | Playwright MCP | Verify header renders + toggle flips theme in both themes (auth-gated — see blocker) |

## Dependencies

- Phase 1 (all of 1.1–1.5, gated by 1.V) — provides: Pennie tokens + `.pn-*` classes in
  `globals.css`; `data-theme` mechanism + no-flash script + `suppressHydrationWarning` on `<html>`;
  the client theme-toggle island scaffolding (1.5); PP Mori; vendored `logo-pennie-charcoal.svg`
  (+ `logo-mark.svg`) under `public/brand/`; inline icon components under `src/components/icons/`.

## Blocked By

- 1.V (Phase 1 verification sweep)

## Research Findings

Key findings from research files relevant to this task:

- From `internal-pages-execution.md`: admin (`src/app/admin/page.tsx` lines 76–81) and me
  (`src/app/me/page.tsx` lines 8–12) **duplicate** the style constants — they are separate copies
  and must both be edited, or extracted to a shared module. Extraction is the recommended, cleaner,
  still-visual-only path.
- From `internal-pages-execution.md`: the per-page `<header className="flex items-center
  justify-between">` (admin line 360, me line 47) should be replaced with a shared `AppHeader`
  (`components/AppHeader.tsx`, presentation-only, takes `email`/`role`/`active` props). Recommended
  shell: a **beige bar with a `--border` bottom hairline** (lighter than the navy nav band; lets
  the beige page dominate per the 80/15/5 rule). Left: `logo-pennie-charcoal.svg` (charcoal
  wordmark on beige) + mark, ~22px. Tabs: "Admin" → `/admin` and "My availability" → `/me` as
  `.pn-small-bold` links (active = `text-fg`, inactive = `text-fg-muted`). Right: user email as
  `.pn-small` muted, the theme toggle, and "Connect / reconnect Google" → `.pn-btn--small
  --additional`.
- From `internal-pages-execution.md` (target replacements for the shared constants):
  ```ts
  const labelCls = "block text-xs font-semibold text-fg-muted";              // was text-neutral-500
  const inputCls  = "mt-1 w-full rounded-sm bg-surface px-3 text-fg "         // rounded-sm = 8px
                  + "shadow-xs h-[44px] outline-none "                        //   no border, soft shadow
                  + "focus-visible:outline-3 focus-visible:outline-focus-ring "
                  + "focus-visible:outline-offset-2 placeholder:text-fg-muted";
  const cardCls  = "rounded-md bg-surface shadow-xs p-6";                     // .pn-card recipe
  const btnCls   = "pn-btn pn-btn--small pn-btn--primary";                   // sky fill + graphite label
  ```
  Use the `.pn-btn` classes directly. Primary Save/Create = `.pn-btn--small --primary` (40px,
  fits dense forms). Destructive/secondary (Cancel, clear, "Sync from Salesforce") =
  `.pn-btn--small --additional` (outlined). Do NOT use `--big` in the dense admin forms.
- From `internal-pages-execution.md` (theme toggle): a tiny `"use client"` island that toggles
  `document.documentElement` `data-theme` and persists to `localStorage.slate-theme` — **the same
  key the foundation no-flash script reads** (keep them in sync). Placement: header icon button
  (sun/moon). No DS moon icon exists — use a clean 2px inline SVG or a foundation icon. It adds NO
  server logic; admin/me stay server components and embed this client child. Default light;
  honors a stored preference.
- From `internal-pages-execution.md` (theming mechanism, D11/D19): internal pages use semantic
  utilities (`bg-bg`, `text-fg`, `bg-surface`, `border-[--border]`) and `dark:` one-offs. Because
  `@theme inline` re-resolves utilities through the live cascade, flipping `data-theme` reskins all
  pages with zero per-page dark code.
- From `wcag-accessibility.md` (D17/D18): theme-aware focus — 2px graphite outline on light, 2px
  sky on navy (foundation should set this globally; the header inherits it). 44px+ touch targets:
  the toggle button and the reconnect-Google button must be at least 44×44 / 44 tall. Nav tabs and
  the toggle must have accessible names; the toggle is icon-only so it needs an `aria-label`
  (e.g. `aria-label="Switch to dark theme"` / `"Switch to light theme"`).
- From `wcag-accessibility.md`: never `outline: none` without a replacement; color is never the
  sole signal — the active nav tab must differ from inactive by more than color (e.g.
  `font-semibold` + `aria-current="page"`, not color alone).

## Execution Plan

### Step 1: Orient

**Surface:** [code]

- [code] Read the current `src/app/admin/page.tsx` (lines 1–82 for the constants + imports; line
  360 for the header) and `src/app/me/page.tsx` (lines 1–55) to capture the EXACT current strings
  and header markup you are replacing.
- [code] Read `src/app/globals.css` to confirm the `.pn-btn`, `.pn-card`, `.pn-small`,
  `.pn-small-bold`, and semantic utilities (`bg-bg`/`text-fg`/`bg-surface`/`border-[--border]`)
  exist (Phase 1 deliverable). Confirm the no-flash script's `localStorage` key (should be
  `slate-theme`).
- [code] Confirm the vendored assets exist: `public/brand/logo-pennie-charcoal.svg` and the inline
  icon components in `src/components/icons/` (Phase 1.1/1.4). If the toggle needs a sun/moon icon
  and none exists, plan a small inline 2px-stroke SVG inside the toggle island.

**Verification:**
- [code] `grep -n "slate-theme" src/app/layout.tsx src/app/*.tsx` confirms the no-flash key. Read
  back confirms the `.pn-*` classes and assets are present.

### Step 2: Create the shared styles module

**Surface:** [code]

- [code] Create `src/components/ui/styles.ts` exporting `labelCls`, `inputCls`, `cardCls`, `btnCls`
  (and, optionally, `btnSecondaryCls = "pn-btn pn-btn--small pn-btn--additional"`) using the exact
  Pennie-equivalent strings from Research Findings above. These are plain string constants — no JSX,
  no logic.
- Keep the strings token-driven (semantic utilities + `.pn-*`), never hex. `rounded-sm` = 8px
  (`--radius-sm`); `rounded-md` = 10px (`--radius-md`).
- **S10: also create the shared `src/components/ui/Pill.tsx` here — 3.1 OWNS it; 3.2 (admin role/
  status pills) and 3.3 (me bookable pill) CONSUME it** (mirrors the S2 ThemeToggle single-owner
  rule, to avoid a duplicate `Pill` clobber). A presentation-only component:
  `Pill({ variant, children })` where `variant ∈ { "role-agent","role-manager","role-admin",
  "status-ok","status-error","status-pending","outline" }`, each mapping to Pennie token classes
  (`rounded-pill`, `13/700`, ~24px tall; status-error uses `bg-[var(--error-bg)] text-[var(--error)]`
  per S1; the ink `role-admin` pill needs a `dark:` variant since it's invisible on the dark navy
  page). No logic, no data.

**Verification:**
- [code] Read back `src/components/ui/styles.ts` and `src/components/ui/Pill.tsx`; confirm no
  `neutral-`/`green-`/`amber-`/`red-`/raw rose-`#hex` appears
  (`grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-|#[0-9a-fA-F]{3,6}" src/components/ui/styles.ts src/components/ui/Pill.tsx`
  → only intentional Pennie token refs incl. `var(--error)`/`var(--error-bg)`).

### Step 3: Consume the existing theme-toggle island (do NOT recreate it)

**Surface:** [code]

- **S2: Task 1.5 is the SOLE creator of `src/components/ThemeToggle.tsx`. This task does NOT create
  or overwrite it — it imports the existing component** (`import { ThemeToggle } from
  "@/components/ThemeToggle"`) and mounts it inside `AppHeader` (Step 4). Creating a second
  implementation here would clobber 1.5's.
- [code] Confirm `src/components/ThemeToggle.tsx` exists (Phase 1.5 deliverable) and already: is
  `"use client"`, flips `document.documentElement` `data-theme` light↔dark, persists to
  `localStorage.slate-theme` (the SAME key the no-flash script reads), initializes from the current
  `data-theme` in a `useEffect` (SSR-safe), and exposes an accessible `<button>` with an
  `aria-label`.
- [code] If the 1.5 toggle's appearance needs the header treatment (icon-only sun/moon, ≥44×44
  target, `.pn-btn--small --additional` styling), make that minimal presentational change INSIDE
  `src/components/ThemeToggle.tsx` (still 1.5's file, single source of truth) rather than forking a
  new component. Keep the `slate-theme` key and the flip/persist behavior byte-identical.

**Verification:**
- [code] `grep -rn "ThemeToggle" src/app/admin/page.tsx src/app/me/page.tsx src/components/AppHeader.tsx`
  shows IMPORTS/usages of `@/components/ThemeToggle`, and there is exactly ONE
  `src/components/ThemeToggle.tsx` file (created by 1.5, not duplicated here).
- [code] `pnpm build` exits 0 (confirms the `"use client"` island compiles and `layout.tsx`
  `suppressHydrationWarning` is honored).
- [browser] (after Step 5) clicking the toggle flips `document.documentElement` `data-theme` and
  the page colors flip; reload persists the choice (`localStorage.slate-theme`).

### Step 4: Build the AppHeader

**Surface:** [code]

- [code] Create `src/components/AppHeader.tsx`, a **presentation-only** component (it can be a
  server component since it renders the client `ThemeToggle` as a child). Props:
  `{ email: string; role?: string; active: "admin" | "me" }`.
  - Beige bar (`bg-bg`) with a bottom hairline (`border-b border-[--border]`), comfortable
    horizontal padding, items vertically centered.
  - Left: `next/image` (or `<img>`) of `/brand/logo-pennie-charcoal.svg` (+ optional
    `logo-mark.svg`) at ~22px tall, with `alt="Pennie"`.
  - Tabs: `next/link` "Admin" → `/admin` and "My availability" → `/me`, styled `.pn-small-bold`;
    active tab = `text-fg` + `aria-current="page"`, inactive = `text-fg-muted`. (Active state must
    not rely on color alone — `aria-current` + weight carry it.)
  - Right group: the user `email` as `.pn-small text-fg-muted`; the `ThemeToggle`; and the
    "Connect / reconnect Google" action — a plain `<a href="/login">` styled
    `.pn-btn .pn-btn--small .pn-btn--additional` (this preserves the existing admin behavior at
    admin line 365–367 — do not change the href or convert it to a form/action).
  - Ensure the toggle and reconnect button are ≥44px tall/square for touch (D18).
- Do NOT read auth/session or perform any data fetch in the header; the page passes `email`/`role`
  down as props (admin already has `me.email`/`me.role`; me has `me.email`/`me.name`/`me.bookable`).

**Verification:**
- [code] `pnpm build` exits 0. Read back confirms no logic/data-fetch and no stray non-token colors
  (`grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-|#[0-9a-fA-F]{3,6}" src/components/AppHeader.tsx` → empty).

### Step 5: Rewire admin + me to consume the shared module and header

**Surface:** [code]

- [code] In `src/app/admin/page.tsx`: delete the local `labelCls`/`inputCls`/`cardCls`/`btnCls`
  declarations (lines ~76–81) and `import { labelCls, inputCls, cardCls, btnCls } from
  "@/components/ui/styles"`. Replace the `<header>` block (lines ~360–368) with
  `<AppHeader email={me.email} role={me.role} active="admin" />`. **Do not** change any section
  body, form, action, RBAC gate, or `name=` here — task 3.2 does the section restyle; 3.1 only
  swaps the constants' definitions (via import) and the header. (Because the constants are now
  imported with the new Pennie values, the admin body will already pick up the new field/button
  look — that is expected and is the "change once, re-skin everywhere" win; 3.2 handles the
  remaining ad-hoc strings and the status ternaries.)
- [code] In `src/app/me/page.tsx`: delete the local `labelCls`/`inputCls`/`btnCls` (lines ~8–12),
  import them from the shared module, and replace the `<header>` (lines ~47–55) — but keep the
  bookable-status line content; 3.3 restyles it into a pill. For 3.1, at minimum wrap the page in
  `AppHeader email={me.email} active="me"` above the existing `<main>` content (or integrate the
  header per 3.3's plan). Keep `me`'s `currentUser()`/`redirect("/login")` and all forms/actions
  byte-for-byte.
- [code] Verify `tsconfig` path alias `@/` resolves `@/components/...` (it already does in this
  repo). Use `next/link` and `next/image` per Next 16 conventions (read
  `node_modules/next/dist/docs/` if unsure — see AGENTS.md).

**Verification:**
- [code] `pnpm build` exits 0; `pnpm lint` clean.
- [code] `grep -n "labelCls\|inputCls\|cardCls\|btnCls" src/app/admin/page.tsx src/app/me/page.tsx`
  shows only the import + usages, no local `const … =` redefinitions.
- [code] `git diff src/app/admin/actions.ts` is EMPTY (actions untouched); diff of admin/me shows
  only import + header + constant-definition removals (no form/`name=`/RBAC changes).

### Step 6: Browser verification (both themes)

**Surface:** [browser]

> **AUTH BLOCKER:** `/admin` and `/me` are Google-OAuth-gated; a headless agent cannot self-auth.
> Resolve via a logged-in Playwright profile / injected Supabase session / user-supplied
> screenshots (see `reports/surface-verification.md` and the Phase auth note). If a session cannot
> be obtained, capture evidence via the user-supplied-screenshot path and record the blocker in
> PROGRESS.md; do not block the whole task on it — the build/lint/grep code gates above are the
> hard gates for 3.1.

- [browser] With a session, navigate to `/admin` and `/me`. `browser_snapshot` confirms the shared
  header renders (logo, two tabs with the correct active tab, email, toggle, reconnect link).
- [browser] Click the theme toggle → confirm `data-theme` flips on `<html>`, page colors flip,
  header beige↔dark adapts. `browser_take_screenshot` light + dark for both pages.
- [browser] Reload → confirm the chosen theme persists (no flash to the other theme first).
- [browser] Run axe via `browser_evaluate` (`@axe-core/playwright`, tags wcag2a/wcag2aa/wcag21aa)
  on the header region; 0 serious/critical. Confirm the toggle has an accessible name and the
  active tab has `aria-current="page"`.

**Verification:**
- [browser] Paired light/dark screenshots saved to `reports/`; axe report 0 serious/critical;
  toggle flips + persists.

## Artifacts to Create

- `src/components/ui/styles.ts` - shared `labelCls`/`inputCls`/`cardCls`/`btnCls` (+ optional
  secondary btn) constants - [code]
- `src/components/ui/Pill.tsx` - presentation-only role/status pill (S10 — owned here, consumed by
  3.2 + 3.3) - [code]
- `src/components/AppHeader.tsx` - presentation-only branded header (logo, tabs, email, toggle,
  reconnect-Google) - [code]
- (S2: `src/components/ThemeToggle.tsx` is NOT created here — it is owned/created by Task 1.5 and
  only IMPORTED by this task. Any header-fit tweak is made inside 1.5's file.)

## Artifacts to Modify

- `src/app/admin/page.tsx` - remove local style constants (import them instead); replace the
  `<header>` with `<AppHeader … active="admin" />`. No body/form/action/RBAC change. - [code]
- `src/app/me/page.tsx` - remove local style constants (import them); add/replace header with
  `<AppHeader … active="me" />`. No form/action change. - [code]

## Contracts

### Provides (for downstream tasks)

- `@/components/ui/styles` exports (`labelCls`, `inputCls`, `cardCls`, `btnCls`[, secondary]) -
  consumed by Task 3.2 (admin sections) and 3.3 (me sections).
- `@/components/ui/Pill` (S10) - role/status pill consumed by 3.2 (admin) and 3.3 (me bookable pill).
- `@/components/AppHeader` (props `email`, `role?`, `active`) - consumed by 3.2 and 3.3.
  (AppHeader mounts the 1.5-owned `@/components/ThemeToggle`; S2 — this task does not create the toggle.)

### Consumes (from upstream tasks)

- Phase 1 tokens + `.pn-*` classes + semantic utilities (1.2/1.3) - the style strings and header
  resolve through them.
- Phase 1 `data-theme` mechanism + no-flash script reading `localStorage.slate-theme` (1.5) - the
  toggle writes the same key.
- Phase 1 `src/components/ThemeToggle.tsx` (1.5) - the toggle island this task imports/mounts (S2);
  not recreated here.
- Phase 1 vendored `public/brand/logo-pennie-charcoal.svg` (1.1) + inline icons (1.4).

## Acceptance Criteria

- [ ] One source of truth for the shared style constants (`src/components/ui/styles.ts`); admin and
      me both import it; no duplicated local definitions remain.
- [ ] One source of truth for the role/status pill (`src/components/ui/Pill.tsx`, S10); 3.2/3.3
      consume it rather than each defining their own.
- [ ] `AppHeader` renders the charcoal logo, Admin + My-availability tabs (correct active +
      `aria-current`), user email, theme toggle, and reconnect-Google link — presentation-only.
- [ ] The 1.5-owned `ThemeToggle` is IMPORTED (not recreated); exactly one
      `src/components/ThemeToggle.tsx` exists. It flips `data-theme` on `<html>`, persists to
      `localStorage.slate-theme`, and causes no flash on reload.
- [ ] Header + toggle render correctly in BOTH light and dark themes.
- [ ] No auth/RBAC/server-action/form-`name=`/data changes (git diff confirms; `actions.ts`
      untouched).
- [ ] No stray `neutral-`/`green-N`/`amber-`/`red-N`/`emerald-`/`#hex` in the new files.
- [ ] `pnpm build` + `pnpm lint` green.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` → exit 0; `pnpm lint` → clean.
- Run: `grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-|#[0-9a-fA-F]{3,6}" src/components/ui/styles.ts src/components/AppHeader.tsx src/components/ThemeToggle.tsx` → no matches.
- Run: `git diff --stat src/app/admin/actions.ts` → no changes. `git diff src/app/admin/page.tsx
  src/app/me/page.tsx` → only import/header/constant-removal lines; no `name=`/action/RBAC edits.

#### [browser] Web Verification
- Navigate to (with a session): `/admin` and `/me`.
- Snapshot: header present with logo, both tabs (active marked via `aria-current`), email, toggle,
  reconnect link.
- Flow: click toggle → `data-theme` flips, colors flip; reload → persisted, no flash.
- axe (via `browser_evaluate`, wcag2a/2aa/21aa): 0 serious/critical on the header.
- Screenshot: `/admin` + `/me` header, light and dark → `reports/`.

### Cross-Surface Coherence
- The toggle writes `localStorage.slate-theme`; confirm it is the SAME key the foundation no-flash
  `<head>` script reads (grep both) — a mismatch causes a flash.
- The same `AppHeader` instance renders identically on `/admin` and `/me` (only the active tab
  differs).

## Skills to Read

- `pennie-design-system-in-slate` - tokens, fonts, assets, `.pn-*` recipes, logo usage
  (charcoal-on-beige), theming pitfalls, and the color/shape/voice rules the header must follow.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/internal-pages-execution.md` - the primary
  per-page spec; shared-constant target strings, header recipe, theme-toggle island, theming
  mechanism.
- `.claude/orchestration-slate-brand-redesign/research/tailwind-v4-token-mapping.md` - how
  `data-theme` + `@custom-variant dark` + `@theme inline` make utilities re-resolve; the no-flash
  script pattern.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - theme-aware focus,
  44px targets, accessible name on the icon-only toggle, color-not-sole-signal for the active tab.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` - top authority (D11 both themes, D13
  branded task-efficient, D17/D18 a11y, D19 token/theming approach).

## Execution Surfaces Reference

Read execution surface definitions and verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

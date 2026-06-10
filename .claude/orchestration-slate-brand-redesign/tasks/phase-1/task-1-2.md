# Task 1.2: Port the Pennie token layer into globals.css

## Objective

Replace Slate's stock boilerplate `src/app/globals.css` with the full Pennie token system: a two-layer "import-then-map" structure — Layer A is the raw `--pennie-*` / semantic / radii / shadow / spacing / type tokens plus the `.pn-*` base classes (ported verbatim from the design system's `colors_and_type.css`), with a `[data-theme="dark"]` scope flipping only the semantic vars; Layer B is a `@theme inline` block exposing the subset that should become Tailwind utilities. This makes raw `var(--…)`, `.pn-*` classes, AND Tailwind utilities (`bg-accent`, `text-fg`, `rounded-xl`, `shadow-md`, `font-sans`) all resolve to the Pennie system and follow light/dark theming. **Code-only, visual foundation — no logic, no markup changes.**

## Context

This is the heart of Phase 1. Every later surface (Booker, internal pages, embed) styles against these tokens, so getting the structure right here is what lets all those restyles "just inherit" the brand. It runs in parallel with Task 1.1 (no dependency between them). Task 1.3 (fonts) points `--font-sans` at the `next/font/local` variable defined here; Task 1.5 (theming) relies on the `[data-theme="dark"]` rule and `@custom-variant dark` added here; Task 4.3 (contrast guard) reads the resolved token hex out of this file. **DISCOVERY D5: visual-only — do not alter booking logic, the cache, or any TS.**

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Read, Write/Edit, Bash (`pnpm build`) | Rewrite `globals.css` with the two-layer token system; verify it compiles |
| Browser | Playwright MCP (smoke only) | Render a token smoke check (sky / beige / graphite resolve) — light confirmation; full verification is Phase 1.V |

## Dependencies

- None (parallel with 1.1)

## Blocked By

- None

## Research Findings

Key findings from `research/tailwind-v4-token-mapping.md` (the authoritative mapping recipe) and the `pennie-design-system-in-slate` skill §2:

- **Slate runs Tailwind v4.3.0, CSS-configured — there is NO `tailwind.config.js`.** Everything is in `globals.css` via `@import "tailwindcss"`. The repo already uses `@theme inline` — keep that keyword.
- **Two-layer "import-then-map" (DISCOVERY D19):**
  - **Layer A** = raw tokens in plain `:root` (NOT `@theme`), copied verbatim from `colors_and_type.css`: all `--pennie-*`, the semantic vars, `--radius-*`, `--shadow-*`, `--space-1..15`, the type vars (`--font-sans`, `--font-display`, `--fw-*`, `--fs-*`, `--lh-*`, `--tracking-*`). Plus the `.pn-*` base classes. This makes raw `var(--…)` and `.pn-*` render identical to the DS previews.
  - **Layer B** = `@theme inline { … }` re-exposing the subset that should be utilities, pointing back at Layer A vars. The `inline` keyword is **load-bearing**: without it the utility freezes the build-time value and theming breaks.
- **`@theme` cannot be nested under `@media`/`[data-theme]`** (custom-properties only). So per-mode flips live in ordinary `[data-theme="dark"]` rules outside `@theme`; only the mapping goes inside `@theme inline`.
- **Dark = `data-theme` attribute + `@custom-variant dark`, NOT the OS media query.** Add: `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`. DISCOVERY rejects `prefers-color-scheme` (can't force light-default Booker, can't honor embed/per-widget theme, no user toggle). Dark flips **semantic vars only** (`--bg`→navy, `--surface`→ink-2, `--fg`→beige, `--border`→border-ink); accent/sky and focus-ring stay the same.
- **Name-collision pitfall:** Layer A defines `--radius-xl: 16px`; if `@theme inline` also writes `--radius-xl: var(--radius-xl)` the self-reference resolves fine in practice but is brittle. **Safer: give Layer A private names (`--pn-radius-*`, `--pn-shadow-*`) and map `@theme inline { --radius-xl: var(--pn-radius-xl); }`.** Colors are already cleanly separated (`--pennie-*`/semantic in A → `--color-*` in `@theme`), so colors don't need renaming. Apply the private-name treatment to radii and shadows. **However:** Task 4.3's contrast guard reads `--pennie-*` and semantic color tokens by their canonical names from this file — keep all COLOR token names exactly as in `colors_and_type.css` (only radii/shadow get private aliases).
- **Remove the boilerplate `body { font-family: Arial… }`** (it overrides the font var) and the `@media (prefers-color-scheme: dark)` block, and drop `--font-geist-sans`/`--font-geist-mono`. (The actual Geist import removal in `layout.tsx` is Task 1.3; here, just remove the `--font-geist-*` references in `globals.css`.)
- **Do NOT paste the DS `@font-face` block** — Task 1.3's `next/font/local` generates it; pasting it would break on unresolved `fonts/…` URLs and double-load.
- **CSS layer ordering:** `@import "tailwindcss"` establishes `@layer theme, base, components, utilities`. Keep the `@import "tailwindcss"` line first. The Pennie `:root`/`.pn-*` can be unlayered (they then win over preflight where needed). If you want utilities to be able to override `.pn-*`, wrap `.pn-*` in `@layer components` — optional; default to unlayered to match the DS previews exactly.
- **`--font-sans` (D6/D7):** set it to `var(--font-pp-mori), -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`. `--font-pp-mori` is defined by Task 1.3's `next/font/local`. Until 1.3 lands, the fallback stack still renders (graceful). Keep the global `font-synthesis: none` rule from the DS.

The current `globals.css` (to be replaced) is 27 lines of stock boilerplate (white/black, Geist tokens, Arial body override, OS-media dark). Read it first to confirm before overwriting.

## Execution Plan

### Step 1: Read the current state and the token source

**Surface:** [code]

- Read `src/app/globals.css` (confirm it is the boilerplate described above).
- Read `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` in full — this is the source of truth for every token value and every `.pn-*` class. You will copy its `:root` block (lines ~62–193), its `html, body` base rule (minus what conflicts), and all the `.pn-*` classes (lines ~208–292) verbatim. You will NOT copy its `@font-face` block (lines ~11–60).

**Verification:**
- Confirmed both files read; you have the exact token values and `.pn-*` recipes in hand.

### Step 2: Write the new globals.css — Layer A (raw tokens)

**Surface:** [code]

Write `src/app/globals.css` starting with `@import "tailwindcss";`. Then a `:root` block containing, copied from `colors_and_type.css`:
- All `--pennie-*` brand-core, legacy-alias, neutral, and accent colors (keep canonical names exactly — the contrast guard depends on them).
- **The error rose token (S1 — the DS has no rose/error token, but downstream error states + the contrast guard depend on one, so it MUST be defined here):**
  - `--pennie-rose: rgb(196, 61, 61);` (the `#C43D3D` error base — 4.77:1 on beige, 5.14:1 on white).
  - Semantic `--error: var(--pennie-rose);` (the name downstream consumers reference — Tasks 2.3, 2.5, 3.2, 3.3 use `var(--error)` / `--pennie-rose`; Task 4.3's contrast guard reads `--error`).
  - `--error-bg: rgba(196, 61, 61, 0.12);` (the 12% rose tint for soft error-wash pills / failed-webhook backgrounds — the one used in 2.3's 409 notice and 3.2's webhook-failed pill).
- All semantic tokens (`--bg`, `--bg-alt`, `--bg-ink`, `--surface`, `--surface-elevated`, `--fg`, `--fg-strong`, `--fg-muted`, `--fg-on-ink`, `--fg-on-sky`, `--border`, `--border-soft`, `--border-ink`, `--accent`, `--accent-hover`, `--accent-press`, `--focus-ring`). **Reconcile `--accent-hover` to `#6dc5f7` (sky-hover, graphite-on-it = 6.51:1 per D17) — the contrast guard reads exactly this value.**
- Radii under **private names** to avoid `@theme` collision: `--pn-radius-xs:4px; --pn-radius-sm:8px; --pn-radius-md:10px; --pn-radius-lg:12px; --pn-radius-xl:16px; --pn-radius-pill:999px;`.
- Shadows under private names: `--pn-shadow-xs/-sm/-md/-lg/-pop` with the exact multi-layer values from the DS.
- Spacing `--space-1..15` with the exact px values.
- Type tokens: `--font-sans: var(--font-pp-mori), -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;`, `--font-display: var(--font-sans);`, `--fw-*`, `--fs-*`, `--lh-*`, `--tracking-*`.

> Note: the `.pn-*` classes reference `--radius-xl`, `--shadow-xs`, etc. by their original names. Since Layer A now uses private `--pn-radius-*`/`--pn-shadow-*` names, EITHER (a) update the `.pn-*` class bodies to reference the private names, OR (b) keep both: define the private names AND alias the originals (`--radius-xl: var(--pn-radius-xl);` etc.) in `:root`, then map `@theme inline` from the private names. **Prefer (b)** — it keeps the `.pn-*` classes byte-identical to the DS (easiest to diff against `preview/*.html`) and only the `@theme` block reads the private names. Confirm there is no circular reference (`@theme` reads `--pn-radius-xl`, `.pn-*` reads `--radius-xl`, both ultimately the same literal).

Then the base rule (adapted from the DS `html, body`):
```css
html, body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
```
Do NOT re-add a `font-family: Arial` override. Do NOT add `font-size`/`line-height` on `body` if it would fight existing layout — port the DS values (`--fs-body`, `--lh-loose`) but if `pnpm build` or a later surface shows a regression, that is a Phase 2 concern; keep the DS base for fidelity.

**Verification:**
- File written; visually scan that every token from `colors_and_type.css` `:root` is present and no `--background`/`--foreground`/`--font-geist-*` boilerplate tokens remain.

### Step 3: Add the `.pn-*` base classes

**Surface:** [code]

Copy the `.pn-display`, `.pn-h1`–`.pn-h4`, `.pn-lead`, `.pn-body`, `.pn-body-bold`, `.pn-small`, `.pn-small-bold`, `.pn-eyebrow`, `.pn-btn` (+ `:active`/`:focus-visible`), `.pn-btn--big`, `.pn-btn--small`, `.pn-btn--primary` (+ `:hover`), `.pn-btn--additional` (+ `:hover`), `.pn-btn--link`, `.pn-card` — verbatim from `colors_and_type.css`. Do NOT translate these to Tailwind `@components`; they are the DS source of truth and map 1:1 to the previews.

**Theme-aware focus (S3 — Task 1.2 OWNS this; 4.4 only verifies/sweeps it, 2.V/3.V assert it).** Do NOT port the DS's bare sky `:focus-visible { outline-color: var(--focus-ring); }` rule — the sky ring is only 1.57:1 on beige / 1.69:1 on white (fails 1.4.11 3:1). Instead define a contrast-carrying focus line distinct from the decorative glow:
- Keep `--focus-ring: rgba(130,208,255,0.45)` (the decorative sky glow).
- Add `--focus-ring-line: var(--fg)` in `:root` (graphite outline, ~11.5:1 on light surfaces); override it to `var(--accent)` (sky, ~9.5:1 on navy) inside the `[data-theme="dark"]` block (Step 4).
- Ship the global focus recipe so every surface inherits AA-compliant focus from Foundation:
```css
:focus-visible {
  outline: 2px solid var(--focus-ring-line);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--focus-ring); /* sky glow, decorative only */
}
```
Apply the same recipe to `.pn-btn:focus-visible` (replacing the DS's sky-only ring). The outline carries the 3:1 contrast (graphite on light, sky on navy); the sky `box-shadow` is purely decorative. (Task 4.4 sweeps this across surfaces + fixes any `overflow-hidden` clipping; it does NOT re-author the token.)

**`sr-only` utility (S7).** Several a11y steps in Phases 2/3 (e.g. the Booker "today" visually-hidden marker, live-region text) assume an `sr-only` utility exists. Add the standard visually-hidden class to the ported CSS so it is available app-wide:
```css
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

**Verification:**
- All `.pn-*` selectors from the DS are present and reference only Pennie tokens.
- The theme-aware `:focus-visible` recipe (2px `--focus-ring-line` outline + decorative sky `box-shadow`) is present; `--focus-ring-line` is defined in `:root` (graphite) and flipped in `[data-theme="dark"]` (sky); the bare DS sky-only `:focus-visible` rule was NOT ported.
- `.sr-only` utility present.

### Step 4: Dark scope + dark variant

**Surface:** [code]

Add, OUTSIDE `@theme`:
```css
[data-theme="dark"] {
  --bg: var(--pennie-navy);
  --surface: var(--pennie-ink-2);
  --surface-elevated: var(--pennie-ink-2);
  --fg: var(--pennie-beige);
  --fg-muted: var(--pennie-line-3);
  --border: var(--border-ink);
  --focus-ring-line: var(--accent); /* S3: sky outline on navy (graphite stays light-only) */
  /* accent / accent-hover / focus-ring stay sky */
}

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

**Global reduced-motion guard (S9 — Task 1.2 OWNS this so it exists before any Phase 2 animation lands; 2.4 references this guard, 4.4 only verifies it).** Add the global guard AFTER the base/`.pn-*` styles (so it wins the cascade):
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

**Verification:**
- Dark rule flips only semantic vars (no `--pennie-*` raw colors redefined), including `--focus-ring-line` → sky. `@custom-variant dark` present.
- The global `@media (prefers-reduced-motion: reduce)` guard is present once, after the base styles.

### Step 5: Layer B — `@theme inline` mapping

**Surface:** [code]

Add a single `@theme inline { … }` block exposing the utility subset:
```css
@theme inline {
  --color-bg: var(--bg);
  --color-bg-alt: var(--bg-alt);
  --color-bg-ink: var(--bg-ink);
  --color-surface: var(--surface);
  --color-fg: var(--fg);
  --color-fg-strong: var(--fg-strong);
  --color-fg-muted: var(--fg-muted);
  --color-fg-on-ink: var(--fg-on-ink);
  --color-fg-on-sky: var(--fg-on-sky);
  --color-border: var(--border);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-focus-ring: var(--focus-ring);
  /* raw brand colors for illustration accents */
  --color-pennie-sky: var(--pennie-sky);
  --color-pennie-sky-soft: var(--pennie-sky-soft);
  --color-pennie-navy: var(--pennie-navy);
  --color-pennie-yellow: var(--pennie-yellow);
  --color-pennie-mint: var(--pennie-mint);
  --color-pennie-green: var(--pennie-green);
  --color-pennie-blue: var(--pennie-blue);

  --radius-xs: var(--pn-radius-xs);
  --radius-sm: var(--pn-radius-sm);
  --radius-md: var(--pn-radius-md);
  --radius-lg: var(--pn-radius-lg);
  --radius-xl: var(--pn-radius-xl);
  --radius-pill: var(--pn-radius-pill);

  --shadow-xs: var(--pn-shadow-xs);
  --shadow-sm: var(--pn-shadow-sm);
  --shadow-md: var(--pn-shadow-md);
  --shadow-lg: var(--pn-shadow-lg);
  --shadow-pop: var(--pn-shadow-pop);

  --font-sans: var(--font-sans);
  --font-display: var(--font-display);
}
```
Remove the old `@theme inline` block (`--color-background`, `--color-foreground`, `--font-sans: var(--font-geist-sans)`, `--font-mono`) entirely. Remove the old `:root { --background/--foreground }` and the `@media (prefers-color-scheme: dark)` block.

**Verification:**
- Exactly one `@theme inline` block; no `--font-geist-*`, no `--color-background`/`--color-foreground`, no `font-mono` token, no `prefers-color-scheme` media query in the file.

### Step 6: Build smoke test

**Surface:** [code]

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm build
```
Expect exit 0. Tailwind v4's `@custom-variant` syntax should compile; if it errors, that is the one item the research flagged to smoke-test — read the error, and if needed adjust the `@custom-variant` form (the documented v4 syntax) and rebuild. (`pnpm dev` is fine for the browser smoke in Step 7, but `pnpm build` is the real gate.)

**Verification:**
- `pnpm build` exits 0 with no CSS/PostCSS errors. Note: Task 1.3 hasn't defined `--font-pp-mori` yet, so the font falls back to `-apple-system` — that's expected and not a build error.

### Step 7: Browser token smoke check (light only — full sweep is 1.V)

**Surface:** [browser]

Start the dev server in the background, then verify a few tokens resolve. Quick approach via Playwright MCP `browser_evaluate` on any rendered page (e.g. `/` landing or `/book?xbc=411`):
```js
() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    bg: cs.getPropertyValue('--bg').trim(),
    fg: cs.getPropertyValue('--fg').trim(),
    accent: cs.getPropertyValue('--accent').trim(),
    radiusXl: cs.getPropertyValue('--pn-radius-xl').trim(),
  };
}
```
Expect `--bg` = `rgb(249, 246, 240)` (beige), `--fg` = `rgb(52, 52, 52)` (graphite), `--accent` resolving to sky `rgb(130, 208, 255)`, `--pn-radius-xl` = `16px`. Then set `document.documentElement.dataset.theme = 'dark'` and re-read: `--bg` should now resolve to navy `rgb(29, 33, 47)` and `--fg` to beige, while `--accent` stays sky.

**Verification:**
- Light values resolve to beige/graphite/sky/16px; toggling `data-theme="dark"` flips bg→navy, fg→beige, accent unchanged. (This is a smoke check; the full both-theme screenshot comparison is Task 1.V.)

## Artifacts to Create

- None (overwrites an existing file)

## Artifacts to Modify

- `src/app/globals.css` — replace the boilerplate with the two-layer Pennie token system (Layer A raw tokens + `.pn-*` classes + dark scope + `@custom-variant dark`; Layer B `@theme inline` mapping) - [code]

## Contracts

### Provides (for downstream tasks)

- All `--pennie-*` / semantic / `--radius-*` (+ private `--pn-radius-*`) / `--shadow-*` / `--space-*` / type tokens as CSS vars — consumed by every Phase 2/3/4 restyle.
- `--pennie-rose` / `--error` / `--error-bg` — the error/rose tokens consumed by Tasks 2.3, 2.5, 3.2, 3.3 (error states) and read by 4.3's contrast guard (S1).
- `--focus-ring-line` (theme-aware) + the `:focus-visible` recipe — consumed/verified by 2.V, 3.V, and 4.4 (S3).
- `.sr-only` utility (S7) and the global `prefers-reduced-motion` guard (S9) — consumed by Phase 2/3 a11y/animation steps.
- Tailwind utilities (`bg-bg`, `bg-surface`, `text-fg`, `text-fg-muted`, `bg-accent`, `border-border`, `rounded-xl`, `shadow-md`, `font-sans`, etc.) — consumed by all later restyles.
- `[data-theme="dark"]` semantic-flip rule + `@custom-variant dark` — consumed by Task 1.5 (theme infra) and every surface's dark styling.
- The resolved color-token hex/rgb (canonical `--pennie-*` + semantic names preserved) — read by Task 4.3's `scripts/test-contrast.ts`.
- `--font-sans` pointed at `var(--font-pp-mori), …` — the hook Task 1.3 fills in.

### Token-name contract (S4 — the exact names downstream tasks depend on)

These names MUST exist with these exact spellings; downstream tasks (especially 4.3's contrast guard, which reads them by name) hard-fail if they drift:

| Token | Value | Read by |
|-------|-------|---------|
| `--pennie-graphite` | `rgb(52,52,52)` | 4.3 (CTA/body/focus pairings) |
| `--pennie-sky` | `rgb(130,208,255)` (`#82D0FF`) | 4.3, 2.x CTA |
| `--pennie-sky-deep` | `#439FE1` | 4.3 (forbidden-as-CTA-text tripwire) |
| `--pennie-beige` | `rgb(249,246,240)` (`#F9F6F0`) | 4.3, surfaces |
| `--pennie-white` | white | 4.3 |
| `--pennie-navy` | `rgb(29,33,47)` (`#1D212F`) | 4.3, dark bg |
| `--pennie-muted` | `#6A6A70` | 4.3 (muted-on-beige thin pass) |
| `--pennie-blue` | `#486CCA` | 4.3, blue-text-on-light |
| `--pennie-rose` / `--error` | `rgb(196,61,61)` (`#C43D3D`) | 4.3, all error states (S1) |
| `--error-bg` | `rgba(196,61,61,0.12)` | 2.3/3.2 soft error wash |
| `--accent-hover` | `#6dc5f7` (6.51:1 under graphite, per D17) | 4.3 (`atLeast(graphite, accent-hover, 4.5)`) |
| `--accent` | sky | 2.x CTA, dark focus line |
| `--focus-ring` | `rgba(130,208,255,0.45)` | decorative focus glow |
| `--focus-ring-line` | `var(--fg)` light / `var(--accent)` dark | 4.4 focus recipe |

4.3 reads exactly these names: because Foundation tokenizes `--error` and reconciles `--accent-hover` to `#6dc5f7`, 4.3 must use `r("--error")` / `r("--accent-hover")` rather than the `HEX()` literal fallback.

### Consumes (from upstream tasks)

- None directly. (Task 1.1 runs in parallel; this task does not read the vendored fonts — it only references the `--font-pp-mori` var name that 1.3 will define.)

## Acceptance Criteria

- [ ] All DS tokens from `colors_and_type.css` resolve as CSS vars in `globals.css`; `.pn-*` classes present and byte-faithful to the DS.
- [ ] Both raw `var(--…)` and Tailwind utilities (`bg-accent`, `text-fg`, `rounded-xl`, `shadow-md`, `font-sans`) work.
- [ ] `[data-theme="dark"]` flips only semantic vars; `@custom-variant dark` present; no `prefers-color-scheme` block.
- [ ] No Geist (`--font-geist-*`, `font-mono`) or Arial-override references remain; no `--background`/`--foreground` boilerplate tokens.
- [ ] `--pennie-rose` (`rgb(196,61,61)`), `--error`, and `--error-bg` (12% tint) defined; `--accent-hover` reconciled to `#6dc5f7` (S1/S4).
- [ ] Theme-aware `:focus-visible` recipe present (graphite outline on light, sky on navy, sky glow as decorative box-shadow only); `--focus-ring-line` defined in both `:root` and the dark scope (S3).
- [ ] `.sr-only` utility present (S7); global `@media (prefers-reduced-motion: reduce)` guard present after base styles (S9).
- [ ] `pnpm build` exits 0.
- [ ] Browser smoke: light → beige/graphite/sky/16px; dark toggle flips bg/fg, accent stays sky.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run `cd /Users/danhankins-wright/Documents/Slate && pnpm build` → exit 0, no PostCSS/CSS errors.
- `grep -n "font-geist\|prefers-color-scheme\|font-family: Arial\|--background\|--foreground\|font-mono" src/app/globals.css` → no matches.
- `grep -c "@theme inline" src/app/globals.css` → exactly 1.
- `grep -n "@custom-variant dark" src/app/globals.css` → present.
- Read the file back: confirm Layer A `:root`, dark scope, and Layer B blocks are in the right order (`@import "tailwindcss"` first).

#### [browser] Web Verification
- Start `pnpm dev` (background); warm `http://localhost:3000/`.
- Navigate; `browser_evaluate` the token smoke snippet (Step 7). Expect beige/graphite/sky/16px in light; navy/beige with sky-stable accent after setting `data-theme="dark"`.
- Screenshot is optional here (full theme sweep is 1.V).

### Cross-Surface Coherence
- The CSS var names this file exposes must match what Task 4.3's contrast guard reads (`--pennie-graphite`, `--pennie-sky`, `--pennie-sky-deep`, `--pennie-beige`, `--pennie-white`, `--pennie-navy`, `--pennie-muted`, `--pennie-blue`, plus `--error` and `--accent-hover`). Confirm those exact names exist in the file (see the Token-name contract above).
- The `--font-pp-mori` reference in `--font-sans` is the handoff to Task 1.3 — confirm the var name is spelled exactly `--font-pp-mori`.

## Skills to Read

- `pennie-design-system-in-slate` — §1 (token inventory), §2 (the two-layer import-then-map, the `inline` keyword, the collision/`@custom-variant` gotchas), §5 (shape/radius), §8 (pitfalls: don't import `@font-face`, README-vs-CSS drift). This is the core reference for the whole task.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/tailwind-v4-token-mapping.md` — the authoritative two-layer recipe, `@theme inline` mechanics, name-collision fix, `@custom-variant` syntax (smoke-test on build), CSS layer ordering.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

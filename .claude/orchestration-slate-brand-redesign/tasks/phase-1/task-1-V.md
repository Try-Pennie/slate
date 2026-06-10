# Task 1.V: Phase 1 Verification Sweep

## Objective

Confirm the Foundation phase (Tasks 1.1–1.5) is brand-correct, builds clean, and is plumbed end to end: the Pennie tokens resolve in both themes, PP Mori is loaded (body 400 / headings 600, no Geist), the Pennie favicon renders, the icon components tint, and the dead Slate-era assets/refs are gone. Re-verify every Phase 1 deliverable on its surface, fix any regressions (retry ≤3 then escalate), and save evidence to `reports/`. **Verification-only and visual-only — observe and prove; do not introduce new styling or any logic change (DISCOVERY D5).**

## Context

This is the gate between Phase 1 and Phases 2/3/4 — all three downstream phases depend on `1.V` (per the dependency graph in PHASES.md). Nothing later should start until the foundation is proven solid, because every restyle inherits these tokens/fonts/theming. This task does not build new features; it exercises the outputs of 1.1–1.5 together and records proof. If a check fails, make the minimal fix on the owning surface (or hand back to the owning task), re-verify, and only then sign off.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash (`pnpm build`, `pnpm lint`, `pnpm test`) | Confirm build/lint/test green |
| Files | Bash (`grep`, `ls`), Read | Grep for stray Geist/Arial/dead-asset refs; confirm vendored assets present |
| Browser | Playwright MCP, npx lighthouse (optional) | Token smoke in both themes; PP Mori loaded; favicon correct; capture screenshots |

## Dependencies

- **Tasks 1.1, 1.2, 1.3, 1.4, 1.5 all complete.**

## Blocked By

- 1.1, 1.2, 1.3, 1.4, 1.5

## Research Findings

Drawn from all three research files + both skills (these are the acceptance bars this sweep enforces):

- **Token system (1.2):** two-layer `globals.css` — Layer A raw `--pennie-*`/semantic/`--pn-radius-*`/`--pn-shadow-*`/`--space-*`/type tokens + `.pn-*` classes + `[data-theme="dark"]` semantic flip; Layer B single `@theme inline` mapping; `@custom-variant dark` present. No `prefers-color-scheme`, no `--font-geist-*`, no Arial body override, no `--background`/`--foreground` boilerplate.
- **Fonts (1.1+1.3):** exactly two woff2 under `src/app/fonts/PPMori/`; `next/font/local` in `src/app/fonts/pp-mori.ts` (400+600+700-alias, `font-synthesis:none`); `layout.tsx` applies `ppMori.variable`, no Geist. Computed body font = PP Mori; headings 600, body 400.
- **Assets (1.1):** logo SVGs + `pic-1-coins.png` under `public/brand/`; `public/slate-logo.png` and `src/app/icon.png` deleted; no live refs.
- **Icons + app-icon (1.4):** inline `currentColor` SVG components in `src/components/icons/` (never `<img>`; `check-badge` keeps `#F9F6F0` tick); `src/app/icon.svg` is the Pennie mark with a baked fill; favicon link resolves to it; apple icon is the Pennie mark.
- **Theming (1.5):** default `data-theme="light"` + no-flash `<head>` script (`slate-theme` key) + `suppressHydrationWarning`; `ThemeToggle.tsx` island; flip works, persists, no FOUC, SSR-safe.
- **Verification toolchain (`slate-ui-verification`):** dev server in background; warm routes (Next 16 compiles on first hit); 1280×900 desktop viewport; `browser_evaluate` for computed-style/token reads; `pnpm build`/`lint`/`test` are the code gates. Note: `scripts/test-contrast.ts` is added in Phase 4 (Task 4.3), so `pnpm test` here runs whatever `scripts/test-*.ts` already exist — the contrast guard is NOT expected to exist yet; do not fail this sweep on its absence.
- **DISCOVERY D5 / scope:** no logic touched. A quick `git diff --stat` review should show only CSS/markup/asset/font changes across Phase 1.

## Execution Plan

### Step 1: Code gates — build, lint, test

**Surface:** [code]

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm build && echo "BUILD_OK"
cd /Users/danhankins-wright/Documents/Slate && pnpm lint && echo "LINT_OK"
cd /Users/danhankins-wright/Documents/Slate && pnpm test && echo "TEST_OK"
```
- `pnpm build` exit 0 (fonts emit to `.next/static/media`, icon routes resolve, no PostCSS/CSS errors, no hydration-mismatch warning).
- `pnpm lint` clean (no errors; respect existing ESLint/Prettier config).
- `pnpm test` green — runs the existing `scripts/test-*.ts`. (The contrast guard arrives in Phase 4; absence here is expected.)

**Verification:**
- All three print their OK marker / exit 0. Capture the build log tail to `reports/phase-1-build.log`.

### Step 2: File grep + asset presence

**Surface:** [file]

```bash
cd /Users/danhankins-wright/Documents/Slate
grep -rn "font-geist\|--font-geist\|font-mono\|prefers-color-scheme\|font-family: Arial\|--background\b\|--foreground\b" src/app/globals.css src/app/layout.tsx || echo "NO_STALE_TOKENS"
grep -rn "slate-logo.png\|src/app/icon.png\|\"/icon.png\"" src public || echo "NO_DEAD_ASSET_REFS"
grep -rn "Geist\|next/font/google" src/app || echo "NO_GEIST"
ls -1 src/app/fonts/PPMori                      # exactly 2 woff2
ls -1 public/brand                              # logos + pic-1-coins.png
ls src/app/icon.svg                             # favicon present
ls src/app/icon.png public/slate-logo.png 2>&1  # both: No such file
grep -rln "<img" src/components/icons || echo "ICONS_ARE_INLINE"
```

**Verification:**
- `NO_STALE_TOKENS`, `NO_DEAD_ASSET_REFS`, `NO_GEIST`, `ICONS_ARE_INLINE` all print.
- `src/app/fonts/PPMori` has exactly 2 files (Regular, SemiBold). `public/brand` has the 5 logos + `pic-1-coins.png` (+ `pic-3-ribbon.png`). `icon.svg` present; `icon.png`/`slate-logo.png` gone.

### Step 3: Start dev server + warm routes

**Surface:** [code][browser]

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm dev   # run_in_background: true
```
Then warm:
```bash
until curl -sf -o /dev/null http://localhost:3000/book?xbc=411; do sleep 1; done; echo up
for u in "/" "/book?xbc=411&theme=light" "/book?xbc=411&theme=dark" "/icon.svg"; do curl -sf -o /dev/null "http://localhost:3000$u"; done; echo warmed
mkdir -p reports/{screens,axe,lighthouse}   # S6: create all three evidence subdirs so any early capture (incl. the optional Lighthouse baseline below) can write
```
These are the canonical evidence dirs from `slate-ui-verification` §2/§3 — every capturing task `mkdir -p`s them first and writes to the same `reports/{screens,axe,lighthouse}/` tree with the `<surface>-<theme>-<viewport>` filename convention.

**Verification:**
- Server up; routes warmed; `reports/screens/` exists.

### Step 4: Token smoke in both themes

**Surface:** [browser]

Navigate `/` (or `/book?xbc=411`). `browser_evaluate`:
```js
() => {
  const set = (t) => document.documentElement.setAttribute('data-theme', t);
  const read = () => { const cs = getComputedStyle(document.documentElement); const b = getComputedStyle(document.body);
    return { theme: document.documentElement.dataset.theme, bg: cs.getPropertyValue('--bg').trim(), fg: cs.getPropertyValue('--fg').trim(), accent: cs.getPropertyValue('--accent').trim(), bodyBg: b.backgroundColor, radiusXl: cs.getPropertyValue('--pn-radius-xl').trim() }; };
  set('light'); const light = read();
  set('dark'); const dark = read();
  set('light');
  return { light, dark };
}
```
Expect: light → `--bg` beige `rgb(249, 246, 240)`, `--fg` graphite `rgb(52, 52, 52)`, `--accent` sky `rgb(130, 208, 255)`, `--pn-radius-xl` `16px`. dark → `--bg` navy `rgb(29, 33, 47)`, `--fg` beige, `--accent` still sky. Screenshot both: `reports/screens/foundation-light.png`, `foundation-dark.png`.

**Verification:**
- Light and dark token values match; accent stays sky across themes; 16px radius resolves. Both screenshots saved.

### Step 5: PP Mori loaded + weights

**Surface:** [browser]

On `/book?xbc=411&theme=light`, `browser_evaluate`:
```js
() => {
  const body = getComputedStyle(document.body).fontFamily;
  const els = [...document.querySelectorAll('h1,h2,.pn-h1,.pn-h2,.pn-display')].slice(0,1)
    .map(e => ({ w: getComputedStyle(e).fontWeight, f: getComputedStyle(e).fontFamily }));
  return { body, heading: els[0] || null };
}
```
Expect `body` to be the PP Mori (next/font hash) family, NOT Geist/Arial; heading weight `600`.

**Verification:**
- Body font = PP Mori; heading 600. No Geist/Arial in computed family.

### Step 6: Favicon correct

**Surface:** [browser]

`browser_evaluate` `() => [...document.querySelectorAll('link[rel*="icon"]')].map(l => l.getAttribute('href'))` → includes the generated `icon.svg`. Navigate `/icon.svg`, screenshot `reports/screens/favicon.png` → navy Pennie mark.

**Verification:**
- Favicon link resolves to the Pennie mark `icon.svg`; rendered mark is the navy "P".

### Step 7: Theme persistence / no-flash spot check

**Surface:** [browser]

`browser_evaluate` to set `localStorage.setItem('slate-theme','dark')`, reload `/`, confirm `document.documentElement.dataset.theme === 'dark'` and body bg = navy on first paint (no white flash). Then clear the key. (This re-confirms Task 1.5 in the integrated build.)

**Verification:**
- Reload honors persisted dark with no flash; key cleaned up; no hydration error in console.

### Step 8: Logic-untouched diff review + evidence

**Surface:** [code][file]

```bash
cd /Users/danhankins-wright/Documents/Slate && git diff --stat
```
Confirm changes are limited to: `src/app/globals.css`, `src/app/layout.tsx`, `src/app/fonts/*`, `src/app/icon.svg`, `src/app/apple-icon.*`, `src/components/icons/*`, `src/components/ThemeToggle.tsx`, and `public/brand/*` adds + the two deletes. No API routes, server actions, `src/lib/booking/*`, DB, or auth files touched. Then write a short `reports/phase-1-verification.md` summarizing pass/fail per deliverable with evidence paths.

**Verification:**
- `git diff --stat` shows only Phase-1-appropriate files. `reports/phase-1-verification.md` written with the checklist results and links to the build log + screenshots.

## Artifacts to Create

- `reports/phase-1-build.log` — captured build/lint/test output - [file]
- `reports/screens/foundation-light.png`, `foundation-dark.png`, `favicon.png` (+ theme spot-check screenshots) - [browser]
- `reports/phase-1-verification.md` — pass/fail summary per deliverable with evidence paths - [file]

## Artifacts to Modify

- None expected. (If a regression is found, fix the minimal owning-surface file — `globals.css`, `layout.tsx`, an icon component, etc. — then re-run the sweep. Record any such fix in the report.)

## Contracts

### Provides (for downstream tasks)

- A signed-off Foundation: tokens (both themes), PP Mori, favicon/icons, theming mechanism, clean build/lint/test — the green light that unblocks Phase 2 (Booker), Phase 3 (internal pages), and Phase 4 (embed/a11y).
- `reports/phase-1-verification.md` + evidence — the record those phases reference.

### Consumes (from upstream tasks)

- All outputs of Tasks 1.1–1.5 (vendored assets, token layer, font loading, icon/app-icon set, theme infra).

## Acceptance Criteria

- [ ] `pnpm build` + `pnpm lint` + `pnpm test` all green.
- [ ] Token smoke passes in BOTH themes (light beige/graphite/sky/16px; dark navy/beige, accent stays sky).
- [ ] PP Mori loaded (body PP Mori, headings 600); no Geist/Arial.
- [ ] Favicon shows the Pennie mark; apple icon is the Pennie mark.
- [ ] Grep finds no `font-geist`, no `slate-logo.png`/`icon.png` live refs, no Arial override, no `prefers-color-scheme`; icons are inline (no `<img>`).
- [ ] Theme flip persists with no flash; SSR-safe.
- [ ] `git diff --stat` confirms no logic files touched.
- [ ] Evidence (build log, screenshots, report) saved under `reports/`.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build`, `pnpm lint`, `pnpm test` → all exit 0 / OK markers. Capture to `reports/phase-1-build.log`.
- `git diff --stat` → only Phase-1 files.

#### [file] File Verification
- The greps in Step 2 all print their "clean" markers.
- `ls` confirms 2 woff2, the `public/brand` assets, `icon.svg` present, dead assets gone.

#### [browser] Web Verification
- Steps 4–7: token smoke (both themes), PP Mori computed font, favicon link + render, theme persistence/no-flash. Screenshots saved under `reports/screens/`.
- (Optional) `npx lighthouse "http://localhost:3000/book?xbc=411&theme=light" --only-categories=accessibility --output=json --output-path=reports/lighthouse/foundation-a11y --chrome-flags="--headless=new" --quiet` — informational baseline; the real a11y gate is per-surface in Phases 2–5, not required to pass here.

### Cross-Surface Coherence
- The `--font-pp-mori` chain (1.3 module → `globals.css` `--font-sans` → computed body font) resolves end to end (Step 5 proves it).
- The `slate-theme` key matches between `layout.tsx` and `ThemeToggle.tsx`, and the dark flip seen in the browser matches the `[data-theme="dark"]` rule in `globals.css` (Steps 4 + 7).
- The favicon `icon.svg` mark matches the vendored `public/brand/logo-mark.svg` geometry (Step 6).

## Skills to Read

- `slate-ui-verification` — §2 (start app + warm routes), §3 (Playwright procedure, viewports, evidence layout), §10 (acceptance gate). This is the verification playbook for the sweep.
- `pennie-design-system-in-slate` — §1/§2/§3/§6 as the checklist of what "brand-correct foundation" means (tokens, two-layer wiring, fonts, asset locations).

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/tailwind-v4-token-mapping.md` — what the token layer must contain (to verify completeness).
- `.claude/orchestration-slate-brand-redesign/research/pp-mori-font-loading.md` — the font acceptance points (PP Mori loaded, weights, no Geist).
- `.claude/orchestration-slate-brand-redesign/research/asset-pipeline-execution.md` — the asset/icon/favicon acceptance points and the "delete dead assets" cleanup.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

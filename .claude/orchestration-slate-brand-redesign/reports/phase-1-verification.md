# Phase 1 Verification Sweep (Task 1.V)

**Date:** 2026-06-10 · **Branch:** redesign/pennie-brand · **Result: PASS (all deliverables + gates green)**

Scope: visual-only re-verification of Foundation Tasks 1.1–1.5 on the integrated build.
No logic touched.

## Deliverable results

| # | Deliverable | Result | Evidence |
|---|-------------|--------|----------|
| 1.1 | Assets vendored / dead assets deleted | PASS | `src/app/fonts/PPMori/` has exactly 2 woff2 (Regular, SemiBold). `public/brand/` has the 5 logo SVGs (mark, charcoal, cream, lg-charcoal, lg-cream) + `pic-1-coins.png` + `pic-3-ribbon.png`. `src/app/icon.png` and `public/slate-logo.png` both gone (`ls` → No such file). No live refs (grep `NO_DEAD_ASSET_REFS`). |
| 1.2 | Token layer | PASS | `globals.css`: `@custom-variant dark` (1), single `@theme inline {` block (line 321), `[data-theme="dark"]` flip, `.sr-only`, `prefers-reduced-motion` guard, `--focus-ring-line` (theme-aware), `--error`/`--pennie-rose`/`--error-bg`, `--pn-radius-xl`. Grep: no `font-geist`/`--font-geist`/`font-mono`/`prefers-color-scheme`/`Arial`/`--background`/`--foreground` (`NO_STALE_TOKENS`). |
| 1.3 | PP Mori via next/font/local | PASS | `pp-mori.ts`: 400 Regular + 600 SemiBold + 700-alias→SemiBold, `variable: --font-pp-mori`, `display: swap`, `font-synthesis: none`. `layout.tsx` applies `ppMori.variable`. No Geist in `src/app` (`NO_GEIST`). Build emits `PPMori_Regular-s.p.*.woff2` + `PPMori_SemiBold-s.p.*.woff2` to `.next/static/media`. Computed body font = ppMori (not Geist/Arial). |
| 1.4 | Brand icon + app-icon set | PASS | `src/components/icons/` 8 inline `currentColor` SVG components + `index.ts` barrel; no `<img>` (`ICONS_ARE_INLINE`). `CheckBadgeIcon` keeps `#F9F6F0` tick + currentColor circle. `src/app/icon.svg` = navy baked fill `#1D212F`. `apple-icon.tsx` present; old `apple-icon.png` deleted. Build registers `/icon.svg` + `/apple-icon` routes; favicon `<link rel="icon" href="/icon.svg" type="image/svg+xml">` present in DOM. Rendered `/icon.svg` = navy Pennie "P". |
| 1.5 | Theme infra | PASS | `layout.tsx`: `data-theme="light"` + `suppressHydrationWarning` + inline no-flash `<head>` script reading `slate-theme` (no `prefers-color-scheme`). `ThemeToggle.tsx` exists. Persistence spot-check: `localStorage['slate-theme']='dark'` → reload `/` → `data-theme=dark`, body bg navy on first paint (no flash); key cleaned to null. |

## Code gates

- `pnpm build` → **exit 0**. Fonts emitted, `/icon.svg` + `/apple-icon` routes resolve, no PostCSS/CSS errors, no hydration warnings. Log: `reports/phase-1-build.log`.
- `pnpm lint` → **clean** ("ESLint: No issues found").
- `pnpm test` → **green** ("ALL PASSED" across all existing `scripts/test-*.ts` — routing, sync-core, webhook-retry). No reference to `scripts/test-contrast.ts` (correctly absent until Task 4.3).

## Browser token smoke (headless Chrome via CDP, 1280×900)

| Token | Light | Dark |
|-------|-------|------|
| `--bg` | `#f9f6f0` (beige) ✓ | `#1d212f` (navy) ✓ |
| `--fg` | `#343434` (graphite) ✓ | `#f9f6f0` (beige) ✓ |
| `--accent` | `#82d0ff` (sky) ✓ | `#82d0ff` (sky — stays) ✓ |
| body bg | rgb(249,246,240) ✓ | rgb(29,33,47) ✓ |
| `--pn-radius-xl` | 16px ✓ | 16px ✓ |

- Body font-family = `ppMori, "ppMori Fallback", …` (NOT Geist/Arial). Heading weight = **600**, ppMori.
- Favicon link resolves to `/icon.svg` (image/svg+xml) + apple-touch-icon.
- Screenshots: `reports/screens/foundation-light.png`, `foundation-dark.png`, `favicon.png`.

## Logic-untouched gate

`git status` / diff shows changed files limited to: `src/app/globals.css`, `src/app/layout.tsx` (markup), `src/app/fonts/*` (new), `src/app/icon.svg` (new), `src/app/apple-icon.tsx` (new), `src/components/icons/*` (new), `src/components/ThemeToggle.tsx` (new), `public/brand/*` (adds), deletes of `public/slate-logo.png` + `src/app/icon.png` + `src/app/apple-icon.png`, plus orchestration docs (`CLAUDE.md` design-context section, `.impeccable.md`, `.claude/orchestration-*`). **No `src/lib/**`, `src/middleware.ts`, API routes, server actions, or booking/auth/DB logic touched.** Visual-only confirmed.

## Notes

- The Booker chrome itself is still Slate-era neutral (expected — Phase 2 restyles it). Foundation = tokens/fonts/theming/assets layer, which is brand-correct and plumbed end to end.
- No regressions found; no fixes were required during the sweep.

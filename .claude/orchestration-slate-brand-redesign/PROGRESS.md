# Slate Brand Redesign - Execution Progress

**Target**: Self-paced (no hard deadline)
**Current Phase**: Phase 2 (Booker) — Task 2.1 next (Phase 1 Foundation complete + swept)

---

## Phase Overview

| Phase | Status | Tasks Done | Total | Notes |
|-------|--------|------------|-------|-------|
| 1: Foundation | done | 6 | 6 | tokens + fonts + assets + theming |
| 2: Booker | pending | 0 | 6 | beige-first, sky CTA, delight finish |
| 3: Internal pages | pending | 0 | 6 | login (marketing-rich), admin, me, landing; light+dark |
| 4: Embed + a11y polish | pending | 0 | 6 | widget.js chrome, modal a11y, contrast guard, focus/motion |
| 5: Comprehensive verification | pending | 0 | 4 | all surfaces×themes×mobile, AA+, regression, sign-off |
| **Total** | | **6** | **28** | |

---

## Task Progress

### Phase 1: Foundation

| Task | Title | Surface(s) | Status | Date | Verification | Notes |
|------|-------|-----------|--------|------|--------------|-------|
| 1.1 | Vendor fonts + assets | file | done | 2026-06-09 | PASS - all dest files landed (2 woff2 sizes match source; 5 SVGs + 2 PNGs); both dead assets deleted; grep finds no live refs; charcoal logo concrete fill #343434 (no currentColor) | Copied: PPMori-Regular/SemiBold.woff2 -> src/app/fonts/PPMori/; logo-pennie-{charcoal,cream,lg-charcoal,lg-cream}.svg + logo-mark.svg + pic-1-coins.png + pic-3-ribbon.png (S14 alternate) -> public/brand/. Deleted: public/slate-logo.png, src/app/icon.png. apple-icon.png preserved. No code/build-tooling touched. |
| 1.2 | Port token layer (incl. --error/rose, sr-only, reduced-motion, theme-aware focus) | code | done | 2026-06-09 | PASS - pnpm build exit 0 (clean, no PostCSS errors), pnpm lint exit 0. Grep: no font-geist/prefers-color-scheme/Arial/--background/--foreground/font-mono; exactly 1 @theme inline block; @custom-variant dark present; --pennie-rose/--error/--error-bg, .sr-only, --focus-ring-line, reduced-motion guard all present. Built CSS resolves --bg→#f9f6f0, --pennie-sky #82d0ff, --pennie-navy #1d212f, --pn-radius-xl 16px, --error→--pennie-rose, --focus-ring-line→--fg, data-theme=dark flip + sr-only + prefers-reduced-motion. /book?xbc=411 and / → 200. | Two-layer rewrite of globals.css: Layer A raw :root tokens (all --pennie-*, semantic, private --pn-radius-*/--pn-shadow-* + public aliases, --space-1..15, type tokens) + [data-theme=dark] semantic flip; ADDED --pennie-rose rgb(196,61,61), --error, --error-bg 12% tint; --accent-hover reconciled #6dc5f7; theme-aware --focus-ring-line (graphite light / sky dark) + :focus-visible & .pn-btn:focus-visible recipe (replaced DS sky-only ring); .pn-* classes byte-faithful; .sr-only; global reduced-motion guard. Layer B @theme inline maps colors/radii/shadows/fonts + brand colors; @custom-variant dark. --font-sans points at var(--font-pp-mori) (1.3 handoff). Removed Geist/Arial/OS-media boilerplate. DS @font-face NOT ported (1.3). |
| 1.3 | Load PP Mori via next/font/local | code | done | 2026-06-10 | PASS - pnpm build exit 0, pnpm lint exit 0. Both PP Mori woff2 emitted to .next/static/media (PPMori_Regular-s.p.*.woff2, PPMori_SemiBold-s.p.*.woff2). grep: no Geist/geist/next-font-google/--font-geist in src/app. Browser: /book?xbc=411 -> 200 (after expected redirect to /login in dev, no booking ctx); served <html> class = `ppmori_...__variable h-full antialiased` (no Geist class); HTML preloads both PPMori woff2 as font; served app CSS has 3 @font-face all `font-family: ppMori` (400->Regular, 600+700->SemiBold alias) each with `font-synthesis: none`; `--font-pp-mori: "ppMori","ppMori Fallback",...` defined; `--font-sans: var(--font-pp-mori), ...` chain resolves to PP Mori (not Geist/Arial); Geist count in served CSS = 0. (pnpm test contrast script still absent - expected.) | Created src/app/fonts/pp-mori.ts: next/font/local, src array = 400 Regular + 600 SemiBold + 700-alias->SemiBold, variable '--font-pp-mori', display swap, fallback apple-system stack, declarations font-synthesis:none. layout.tsx: removed Geist/Geist_Mono imports + geistSans/geistMono decls; import ppMori; <html> className now `${ppMori.variable} h-full antialiased`; metadata/body/lang unchanged (no data-theme/suppressHydrationWarning - that's 1.5). globals.css --font-sans already chained to var(--font-pp-mori) from 1.2 - now satisfied. Note: dev required `rm -rf .next` once to clear a stale Geist-compiled CSS chunk after the swap. |
| 1.4 | Brand icon + app-icon set | code, file | done | 2026-06-10 | PASS - pnpm build exit 0 (`/icon.svg` + `/apple-icon` routes registered), pnpm lint exit 0. Server-render of all 8 icons: every component emits `currentColor`, spreads `{...props}` (className->class, width override, chevron transform for left variant all honored), CheckBadgeIcon keeps `#F9F6F0` tick literal with `currentColor` circle, no `<img>` anywhere. Browser: `/icon.svg` -> 200 image/svg+xml 831B `fill="#1D212F"` (no currentColor); `/apple-icon` -> 200 image/png 180x180 RGBA. Next auto-injects `<link rel="icon" href="/icon.svg" type="image/svg+xml">` + `<link rel="apple-touch-icon" href="/apple-icon" sizes="180x180">` on / and /login (no hand-written link / metadata.icons). **S12 both-themes tint (real Chrome computed-style):** same `currentColor` SVG -> light `fill=rgb(52,52,52)` graphite (--fg->--pennie-graphite), dark `fill=rgb(249,246,240)` beige (--fg->--pennie-beige). Inherits --fg in BOTH themes. (contrast script still absent - expected.) | Created src/components/icons/ (8 inline `SVGProps<SVGSVGElement>` components from DS currentColor SVGs + index.ts barrel): ArrowRightIcon, ChevronRightIcon (stroke; rotate/transform for left), CheckIcon, CheckBadgeIcon (#F9F6F0 tick literal kept), SmileIcon, PlusIcon, MinusIcon, PhoneIcon (ported from DS bold/Phone.svg). All fill/stroke=currentColor, aria-hidden, focusable=false, JSX-cased attrs. Created src/app/icon.svg = Pennie mark (logo-mark.svg geometry, viewBox 0 0 20.091 22.331) with baked fill="#1D212F" navy (favicon has no inherited color). Created src/app/apple-icon.tsx = next/og ImageResponse, 180x180, navy mark on #F9F6F0 cream rounded tile (borderRadius 40), size+contentType exports; deleted stale src/app/apple-icon.png (was old Slate icon). No SVGR/SVGO added. layout.tsx NOT touched (Next file conventions auto-emit links; left clean for 1.5's no-flash script region). |
| 1.5 | Theme infra (data-theme, no-flash, ThemeToggle) | code | done | 2026-06-10 | PASS - pnpm build exit 0, pnpm lint exit 0, tsc --noEmit clean. Served `<html>` = `lang="en" data-theme="light" class="ppmori_...__variable h-full antialiased"` (PP Mori var preserved, light default). Inline `<head>` no-flash script present, references `slate-theme`, contains NO prefers-color-scheme (only OS media query in served HTML is Next's built-in not-found/global-error fallback CSS, out of scope). Served CSS has `[data-theme="dark"]` block + `--pennie-navy:#1d212f`. **Real Chrome (CDP) no-flash proof:** initial `dataset.theme=light`; after `localStorage['slate-theme']='dark'` + full reload -> `dataset.theme=dark`, body bg `rgb(29,33,47)` navy, body fg `rgb(249,246,240)` beige (Task 1.2 semantic flip applied on first paint, no FOUC); localStorage cleaned to null. ThemeToggle exports, `"use client"`. (contrast script absent - expected.) | layout.tsx: added `data-theme="light"` + `suppressHydrationWarning` to `<html>` (preserved `${ppMori.variable} h-full antialiased` + metadata/body); injected inline `<head>` `<script>` (dangerouslySetInnerHTML IIFE) reading `localStorage` key `slate-theme`, honoring only `light`/`dark`, else leaving SSR default; NO prefers-color-scheme. Created src/components/ThemeToggle.tsx: SOLE creator (3.1 consumes). `"use client"`; uses `useSyncExternalStore` (subscribe via MutationObserver on `<html>` data-theme attr, getSnapshot reads `dataset.theme`, getServerSnapshot returns "light") instead of useEffect+setState - the spec's example tripped the project's `react-hooks/set-state-in-effect` lint rule; useSyncExternalStore is SSR-safe (no document access during render), lint-clean, and stays in sync if other surfaces flip the attr. toggle() sets `document.documentElement.dataset.theme`, persists `localStorage.setItem('slate-theme', next)` (try/catch), key matches the no-flash script exactly. Accessible `<button>` with dynamic `aria-label` (Switch to light/dark theme), text label Light/Dark, styled `.pn-btn .pn-btn--small .pn-btn--additional` (no sun/moon icon in the 1.4 set, per task text label is fine). TS no any. |
| 1.V | Phase 1 Verification Sweep | all | done | 2026-06-10 | PASS - all of 1.1-1.5 re-verified green. build/lint/test exit 0 (ALL PASSED; no contrast-script ref). Greps: NO_STALE_TOKENS, NO_DEAD_ASSET_REFS, NO_GEIST, ICONS_ARE_INLINE. Browser (headless Chrome/CDP): light --bg #f9f6f0 / --fg #343434 / --accent #82d0ff / radius-xl 16px; dark --bg #1d212f / --fg #f9f6f0 / accent stays sky; body font ppMori (not Geist/Arial), heading 600; favicon link → /icon.svg (navy P mark); theme persists dark on reload, no flash. git diff: visual-only, no logic touched. | Evidence: reports/phase-1-verification.md, reports/phase-1-build.log, reports/screens/{foundation-light,foundation-dark,favicon}.png. No fixes needed. |

### Phase 2: Booker

| Task | Title | Surface(s) | Status | Date | Verification | Notes |
|------|-------|-----------|--------|------|--------------|-------|
| 2.1 | Token-drive PALETTE + flip default to light | code | pending | | | blocked-by: 1.V |
| 2.2 | Restyle calendar + time-slots | code | pending | | | blocked-by: 2.1; ≥44px targets |
| 2.3 | Attendee form + primary CTA | code | pending | | | white-on-sky fix; errors → var(--error) |
| 2.4 | Confirmation delight + brandColor default sky | code | pending | | | opacity/transform only (ResizeObserver) |
| 2.5 | ManageBooking + reschedule/cancel | code | pending | | | red → var(--error) |
| 2.V | Phase 2 Verification Sweep | all | pending | | | axe + Lighthouse + both themes + mobile |

### Phase 3: Internal pages

| Task | Title | Surface(s) | Status | Date | Verification | Notes |
|------|-------|-----------|--------|------|--------------|-------|
| 3.1 | Shared app shell + ThemeToggle consume + Pill | code | pending | | | blocked-by: 1.V |
| 3.2 | Restyle admin dashboard | code | pending | | | JSX-ternary status colors → tokens (manual grep) |
| 3.3 | Restyle me | code | pending | | | amber banner → sky-soft notice |
| 3.4 | Marketing-rich login | code | pending | | | split layout; keep signIn() |
| 3.5 | Restyle landing | code | pending | | | beige hero |
| 3.V | Phase 3 Verification Sweep | all | pending | | | resolve admin/me auth first |

### Phase 4: Embed + accessibility polish

| Task | Title | Surface(s) | Status | Date | Verification | Notes |
|------|-------|-----------|--------|------|--------------|-------|
| 4.1 | widget.js modal chrome (literals) | code | pending | | | blocked-by: 2.V; no default theme param |
| 4.2 | Modal a11y + loading + mobile | code | pending | | | blocked-by: 4.1 |
| 4.3 | scripts/test-contrast.ts guard | code | pending | | | blocked-by: 1.2; runs in pnpm test |
| 4.4 | Theme-aware focus + reduced-motion sweep (verify) | code | pending | | | blocked-by: 2.V, 3.V; verify-only |
| 4.5 | Responsive sweep | code, browser | pending | | | blocked-by: 2.V, 3.V |
| 4.V | Phase 4 Verification Sweep | all | pending | | | cal.com contract intact |

### Phase 5: Comprehensive Verification

| Task | Title | Surface(s) | Status | Date | Verification | Notes |
|------|-------|-----------|--------|------|--------------|-------|
| 5.1 | Full visual + theme sweep (all surfaces) | browser | pending | | | resolve admin/me auth up front |
| 5.2 | Accessibility audit (AA + extra care) | browser, code | pending | | | axe + Lighthouse + contrast script |
| 5.3 | Functional regression + build/deploy safety | code | pending | | | git-diff proves no logic change |
| 5.4 | Final coherence + sign-off | all | pending | | | writes reports/final-verification.md |

---

## Verification Sweep Results

### Phase 1 Verification Sweep
- Status: done / PASS (2026-06-10)
- All Foundation deliverables 1.1-1.5 re-verified on the integrated build; no regressions, no fixes required.
- Code gates: `pnpm build` exit 0 (PP Mori woff2 emitted, /icon.svg + /apple-icon routes resolve, no PostCSS/hydration errors), `pnpm lint` clean, `pnpm test` ALL PASSED across existing scripts/test-*.ts (contrast guard correctly absent until 4.3).
- Grep gates: no font-geist/--font-geist/font-mono/prefers-color-scheme/Arial/--background/--foreground; no slate-logo.png/icon.png refs; no Geist in src/app; icons inline (no `<img>`).
- Token smoke (both themes, headless Chrome/CDP): light beige/graphite/sky + 16px radius; dark navy/beige, accent stays sky. Body font = PP Mori, heading weight 600. Favicon = navy Pennie mark via /icon.svg. Theme persists + no-flash confirmed.
- Logic-untouched: git diff limited to css/tsx/ts/asset/doc files; no src/lib/**, middleware, API routes, server actions, or booking/auth/DB changes.
- Evidence: `reports/phase-1-verification.md`, `reports/phase-1-build.log`, `reports/screens/{foundation-light,foundation-dark,favicon}.png`.
### Phase 2 Verification Sweep
- Status: pending
### Phase 3 Verification Sweep
- Status: pending
### Phase 4 Verification Sweep
- Status: pending
### Phase 5 Final Verification
- Status: pending

---

## Surface Setup Status

| Tool/Surface | Type | Status | Notes |
|-------------|------|--------|-------|
| Playwright MCP | MCP | verified (configured) | user-scope, ✔ Connected; tools load at session start |
| Peekaboo CLI | CLI | verified | 3.4.0; screenshot fallback |
| Node / pnpm / npx | Runtime/CLI | verified | Node 24.12, pnpm 10.33, npx 11.6 (lighthouse) |
| Next dev server | Server | verified | `pnpm dev` Ready ~235ms, port 3000, .env.local |
| Public routes | Browser | verified | /, /book(light+dark), /embed-example.html, /login, /widget.js → 200 |

---

## Blockers

| Blocker | Type | Surfaces Affected | Status | Resolution |
|---------|------|-------------------|--------|------------|
| admin/me are Google-OAuth-gated | auth | /admin, /me (browser verify) | open | Resolve before 3.V & 5.1: logged-in Playwright profile / injected Supabase session / user screenshots (see reports/surface-verification.md) |

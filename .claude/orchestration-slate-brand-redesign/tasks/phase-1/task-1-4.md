# Task 1.4: Brand icon components + app-icon set

## Objective

Create inline React icon components from the design system's `currentColor` SVGs (so they tint via `color`/`currentColor`), barrel-export them, and set the Pennie favicon/app-icon (a mark `icon.svg` with a baked concrete fill, plus a Pennie apple-icon). This replaces Slate-era icons/app-icons with brand ones and gives Phases 2/3/4 a ready icon set. **Code/files only, visual foundation — no logic changes.**

## Context

Phase 1 foundation. Depends only on Task 1.1 (which vendored `public/brand/logo-mark.svg` and deleted the old `src/app/icon.png`). The icon components built here are consumed by the Booker restyle (Phase 2: arrow on the CTA, chevrons on the calendar, check-badge/smile on the embed confirmation puck) and internal pages (Phase 3: menu/search/edit/info/cross as needed). The favicon/app-icon make the browser tab and home-screen icon show the Pennie mark. **DISCOVERY D5: visual-only.**

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Write, Read | Author `src/components/icons/*.tsx` inline SVG components + `index.ts` barrel |
| Files | Bash, Read, Write | Create `src/app/icon.svg` (baked-fill mark); add `apple-icon` (PNG or `apple-icon.tsx` ImageResponse) |
| Browser | Playwright MCP | Confirm favicon shows the Pennie mark; a sample icon tints with `color` in both themes |

## Dependencies

- **Task 1.1** — vendored `public/brand/logo-mark.svg` (favicon source) and deleted `src/app/icon.png`.

## Blocked By

- 1.1

## Research Findings

Key findings from `research/asset-pipeline-execution.md` §4–5 and the `pennie-design-system-in-slate` skill §6:

- **UI icons MUST be inline `<svg>` React components, never `<img>`.** `<img>` renders the SVG as an opaque image and cannot inherit the surrounding `color`/`currentColor`, which breaks the entire DS tint model. Each component returns the DS `<svg>` markup with `fill`/`stroke="currentColor"` preserved and spreads `props: React.SVGProps<SVGSVGElement>` (so callers pass `className`, `aria-hidden`, `width`, `style`). No SVGR/SVGO installed and none to be added — hand-author from the DS SVGs (they're single-path, clean).
- **`check-badge.svg` exception:** its circle is `currentColor` but the tick is a **hardcoded `#F9F6F0`** (designed-in on-puck contrast color, NOT a token miss). KEEP the literal; color the circle via `currentColor`. For a fully tintable check on plain surfaces, use `check.svg` instead.
- **Icon scope (author on demand, not the whole DS set).** Build the ones Slate actually uses. Verified exact DS markup for the core set (from the DS `assets/icons/`):
  - `arrow-right.svg`: `viewBox 0 0 24 24`, `fill="currentColor"`, single path `M 20 12.76 L 13.401 19 L 12.195 18 L 17.758 12.76 L 2 12.76 L 2 11.24 L 17.758 11.24 L 12.195 6 L 13.401 5 L 20 11.24 L 20 12.76 Z`.
  - `chevron-right.svg`: `viewBox 0 0 24 24`, `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`, path `M9 6l6 6-6 6`. (Mirror with `transform="scale(-1,1)"` / `rotate` for a left chevron.)
  - `check.svg`: `viewBox 0 0 24 24`, stroke `currentColor` width 2.5, path `M4 12.5l5 5L20 6.5`.
  - `check-badge.svg`: `viewBox 0 0 20 20`, `<circle cx=10 cy=10 r=9 fill="currentColor"/>` + `<path d="M5.8 10.2l3 3L14.5 7.5" fill="none" stroke="#F9F6F0" stroke-width="2" .../>` (keep the `#F9F6F0` literal).
  - `smile.svg`: `viewBox 0 0 24 24`, stroke `currentColor` width 1.8: `<circle cx=12 cy=12 r=9/>`, `<path d="M8 14s1.5 2 4 2 4-2 4-2"/>`, two filled eye circles.
  - `plus.svg` / `minus.svg`: `viewBox 0 0 24 24`, `fill="currentColor"`, single paths (see DS).
  - Phone: use `assets/icons/bold/Phone.svg` (read its markup when authoring `PhoneIcon`).
  - Clock / Globe: the DS has no equivalent — **keep the existing inline Clock/Globe SVGs already in `Booker.tsx`** (do not move/rewrite them in this task; Phase 2 handles Booker). Author Clock/Phone/Globe components here only if the markup is readily available; otherwise leave Booker's inline ones for Phase 2.
- **App icons (Next 16.2.7 file conventions, verified):** `favicon` → `.ico` only; `icon` → includes **`.svg`**; `apple-icon` → PNG/JPG only (**NO svg**). Next auto-emits `<link rel>` from these files — do NOT hand-write `<link>` in `<head>` or add `metadata.icons`.
  - **`src/app/icon.svg`** ← the Pennie mark (`logo-mark.svg`, `viewBox 0 0 20.091 22.331`). A favicon has NO inherited `color`, so **bake a concrete fill** — set `fill="#1D212F"` (navy) on the path instead of `currentColor`, on a transparent ground so it reads on light browser chrome.
  - **`src/app/apple-icon`** ← SVG not allowed. Two options: (a) keep the existing `src/app/apple-icon.png` only if it's already the Pennie mark (it is NOT — it's the old Slate icon), so replace it; (b) **preferred: add `src/app/apple-icon.tsx` using `next/og` `ImageResponse`** to render the mark on a 180×180 rounded brand tile (cream or navy ground) in-repo, zero binary export, dependency-free (ships with Next 16). If you add `apple-icon.tsx`, delete the stale `apple-icon.png` so Next doesn't serve both.
- **Destination:** `src/components/icons/*.tsx` + `src/components/icons/index.ts` barrel.

## Execution Plan

### Step 1: Author the core inline icon components

**Surface:** [code]

Create `src/components/icons/` and one `.tsx` per needed icon. Pattern (TypeScript, no `any`, 2-space indent, no comments unless non-obvious):
```tsx
import type { SVGProps } from "react";

export function ArrowRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden focusable={false} {...props}>
      <path d="M 20 12.76 L 13.401 19 L 12.195 18 L 17.758 12.76 L 2 12.76 L 2 11.24 L 17.758 11.24 L 12.195 6 L 13.401 5 L 20 11.24 L 20 12.76 Z" />
    </svg>
  );
}
```
Author at least: `ArrowRightIcon`, `ChevronRightIcon` (stroke variant; accept props so callers can rotate for a left chevron), `CheckIcon`, `CheckBadgeIcon` (KEEP the `#F9F6F0` tick literal; circle `currentColor`), `SmileIcon`, `PlusIcon`, `MinusIcon`. Use the exact DS path data from the Research Findings above. For `PhoneIcon`, read `~/Documents/Pennie Branding/Pennie Design System/assets/icons/bold/Phone.svg` and port it. Convert SVG attributes to JSX (`stroke-width` → `strokeWidth`, `stroke-linecap` → `strokeLinecap`, `fill-rule` → `fillRule`). The `xmlns` attr is harmless to drop on inline JSX SVG.

For stroke-based icons (chevron, check, smile) the `<svg>` should carry `fill="none" stroke="currentColor"` and the stroke geometry attrs.

**Verification:**
- Each component file compiles (checked at build, Step 4). Each preserves `currentColor` (except the `check-badge` tick `#F9F6F0`). Each spreads `{...props}`.

### Step 2: Barrel-export

**Surface:** [code]

Create `src/components/icons/index.ts` re-exporting every component:
```ts
export { ArrowRightIcon } from "./ArrowRightIcon";
export { ChevronRightIcon } from "./ChevronRightIcon";
export { CheckIcon } from "./CheckIcon";
export { CheckBadgeIcon } from "./CheckBadgeIcon";
export { SmileIcon } from "./SmileIcon";
export { PlusIcon } from "./PlusIcon";
export { MinusIcon } from "./MinusIcon";
export { PhoneIcon } from "./PhoneIcon";
```
(Keep it in sync with whatever you authored.)

**Verification:**
- `index.ts` exports match the files present in the dir.

### Step 3: Favicon — `src/app/icon.svg` (baked concrete fill)

**Surface:** [file]

Read `public/brand/logo-mark.svg` (vendored by Task 1.1). Create `src/app/icon.svg` with the same `viewBox 0 0 20.091 22.331` and path, but change the path `fill` from `currentColor` to a concrete navy `#1D212F` (so it renders on light browser chrome). Keep the ground transparent. Example:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="20.091" height="22.331" viewBox="0 0 20.091 22.331" fill="none">
  <path d="M 11.481 0 C … Z" fill="#1D212F" fill-rule="evenodd"/>
</svg>
```
(Copy the full path `d` verbatim from `logo-mark.svg`.)

**Verification:**
- `src/app/icon.svg` exists, valid SVG, path `fill="#1D212F"` (NOT currentColor). `src/app/icon.png` is gone (deleted in Task 1.1) so Next won't serve two `icon` files.

### Step 4: Apple icon

**Surface:** [file][code]

Preferred: create `src/app/apple-icon.tsx` using `next/og` `ImageResponse` (per the Next 16 app-icons "Generate icons using code" doc) to draw the Pennie mark centered on a 180×180 rounded brand tile (cream `#F9F6F0` ground, navy mark — good contrast and on-brand). Set the required `size = { width: 180, height: 180 }` and `contentType = "image/png"` exports. Then delete the stale `src/app/apple-icon.png` (old Slate icon) so Next serves only the generated one.

If `ImageResponse` proves fiddly within the retry budget, fallback: keep a single PNG `apple-icon.png` but it MUST be the Pennie mark — if you cannot produce a Pennie-mark PNG in-repo, leave the existing PNG, note it in PROGRESS as a follow-up, and do NOT ship a non-Pennie apple icon as "done."

**Verification:**
- Either `apple-icon.tsx` exists (with `size`/`contentType` exports) and `apple-icon.png` removed, OR a Pennie-mark `apple-icon.png` is in place. `pnpm build` resolves the route (Step 5).

### Step 5: Build

**Surface:** [code]

```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm build
```
Expect exit 0. If `apple-icon.tsx` is used, the build registers the metadata route.

**Verification:**
- `pnpm build` exits 0; no TS errors in `src/components/icons/*` or the icon routes.

### Step 6: Browser verification (favicon + sample icon tint)

**Surface:** [browser]

Start `pnpm dev` (background). Navigate to any page (e.g. `/book?xbc=411&theme=light`). For the favicon, screenshot the browser tab / confirm via the `<link rel="icon">` Next injects:
```js
() => Array.from(document.querySelectorAll('link[rel*="icon"]')).map(l => l.getAttribute('href'))
```
Expect an href pointing at the generated `icon.svg` (e.g. `/icon.svg?…`). Capture: `/icon.svg` screenshot (navy mark) as favicon evidence.

**S12 — both-themes icon-tint check (owned here, not deferred).** Because no surface imports the icons yet in Phase 1, prove tint directly with a throwaway `browser_evaluate` mount: render one icon (e.g. `ArrowRightIcon`) into a container whose `color` is the light `--fg` (graphite) and read back the SVG's computed `fill`/`color`; then set `document.documentElement.dataset.theme = 'dark'`, put the icon on a navy surface where `color` is the dark `--fg` (beige), and confirm the same icon now renders beige — proving `currentColor` inheritance works in BOTH themes. Example:
```js
() => {
  const el = document.createElement('span');
  el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--fg');
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 12h20"/></svg>';
  document.body.appendChild(el);
  const fill = getComputedStyle(el.querySelector('svg')).color;
  el.remove();
  return fill; // light: graphite; after setting data-theme=dark and re-running: beige
}
```
This is the owning verification for 1.4's icon-tint acceptance criterion; full in-context tint is re-confirmed in Phase 2 when the Booker imports the icons.

**Verification:**
- `<link rel="icon">` resolves to the Pennie mark `icon.svg`; the rendered mark is the navy Pennie "P".
- The both-themes tint check confirms an icon inherits `--fg` via `currentColor`: graphite on light, beige on navy (S12).

## Artifacts to Create

- `src/components/icons/ArrowRightIcon.tsx` (and `ChevronRightIcon`, `CheckIcon`, `CheckBadgeIcon`, `SmileIcon`, `PlusIcon`, `MinusIcon`, `PhoneIcon`) — inline `currentColor` SVG components - [code]
- `src/components/icons/index.ts` — barrel export - [code]
- `src/app/icon.svg` — Pennie mark favicon, baked navy fill - [file]
- `src/app/apple-icon.tsx` — `ImageResponse` 180×180 Pennie-mark apple icon (preferred) - [file][code]

## Artifacts to Modify

- (If using `apple-icon.tsx`) delete `src/app/apple-icon.png` so Next serves one apple icon - [file]

## Contracts

### Provides (for downstream tasks)

- `src/components/icons/*` (+ barrel): the inline icon set — consumed by Phase 2 (Booker CTA arrow, calendar chevrons, confirmation `CheckBadgeIcon`/`SmileIcon` puck) and Phase 3 (admin/login chrome icons).
- `src/app/icon.svg` + apple icon: the Pennie favicon/app-icon for every page.

### Consumes (from upstream tasks)

- Task 1.1: `public/brand/logo-mark.svg` (favicon source markup) and the deletion of `src/app/icon.png`.

## Acceptance Criteria

- [ ] Icon components are inline `<svg>` (not `<img>`) and tint via `currentColor`/`color`; `check-badge` keeps the `#F9F6F0` tick literal.
- [ ] Both-themes tint verified here (S12): an icon inherits `--fg` via `currentColor` — graphite on light, beige on navy.
- [ ] Barrel `index.ts` exports all authored icons.
- [ ] `src/app/icon.svg` is the Pennie mark with a baked concrete fill; favicon link resolves to it.
- [ ] An apple-icon shows the Pennie mark (via `apple-icon.tsx` ImageResponse, with the stale PNG removed) — or is explicitly flagged as a follow-up if not achievable.
- [ ] `pnpm build` exits 0; no SVGR/SVGO added.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `cd /Users/danhankins-wright/Documents/Slate && pnpm build` → exit 0.
- `grep -rn "currentColor" src/components/icons` → present in each stroke/fill icon. `grep -rn "<img" src/components/icons` → no matches.
- `grep -rn "#F9F6F0" src/components/icons/CheckBadgeIcon.tsx` → the tick literal preserved.
- Read `src/components/icons/index.ts` → exports match files present.

#### [file] File Verification
- Read `src/app/icon.svg` → valid SVG, path `fill="#1D212F"`, not `currentColor`.
- `ls src/app/icon.png` → "No such file" (deleted in 1.1). If `apple-icon.tsx` used: `ls src/app/apple-icon.png` → gone; read `apple-icon.tsx` for `size`/`contentType` exports.

#### [browser] Web Verification
- `browser_evaluate` the `link[rel*="icon"]` href list → includes the generated `icon.svg`.
- Navigate `/icon.svg`, screenshot → navy Pennie mark on transparent/white. Save to `reports/screens/favicon.png`.
- S12 both-themes tint: run the throwaway-mount `browser_evaluate` (Step 6) in light then dark → the icon's computed `color`/`fill` resolves to graphite (light `--fg`) then beige (dark `--fg`).

### Cross-Surface Coherence
- The icon component names exported here must be the names Phase 2/3 tasks import (e.g. `ArrowRightIcon`, `CheckBadgeIcon`). Keep names stable; the barrel is the contract surface.

## Skills to Read

- `pennie-design-system-in-slate` — §6 (icons MUST be inline `<svg>` components, never `<img>`; the `check-badge` `#F9F6F0` caveat; favicon needs a baked fill; app-icon SVG-not-allowed rule).

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/asset-pipeline-execution.md` — §4 (icon component pattern, the `currentColor` requirement, `check-badge` caveat), §5 (Next app-icon conventions + `ImageResponse` codegen), and the copy-map rows for each icon.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

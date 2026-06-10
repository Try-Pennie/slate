# Asset Pipeline & Inventory - Research

**Wave**: Second
**Researcher**: Asset pipeline & inventory (Slate brand redesign)
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code/Files

---

## Summary

This file is the concrete asset manifest and pipeline for porting the Pennie Design
System into Slate's repo. It says exactly which design-system files Slate needs, where
each lands in the repo, and how each is consumed, justified against Next 16.2.7 (App
Router) + Tailwind v4 + `next/font/local` + OpenNext/Cloudflare Workers. The headline
decisions: (1) ship only the **licensed woff2 kit, weights 400 + 600** into
`src/app/fonts/PPMori/` (already settled in DISCOVERY D6/D7 and the font-loading research);
(2) the DS UI icons are **all `currentColor`** so they must be **inline `<svg>` React
components** (hand-authored, no SVGR/SVGO installed) gathered in `src/components/icons/` so
`color` inherits — `<img>` cannot tint them; (3) **app icons**: keep PNG for `apple-icon`
(Next forbids SVG there) but the favicon/`icon` can move to the Pennie **mark SVG**; (4)
delight assets split by surface per D16: the **iridescent `pic-1.png` (coins)** goes to
`public/` for the standalone confirmation page, while the embed iframe uses a tiny inline
**`check-badge` / `smile`** SVG component (no image weight). No conversion/optimization
tooling is needed or installed — the woff2 kit is already woff2 and the SVGs are already
clean and small (<1 KB each); do not add SVGO/SVGR for this pass.

## Key Findings

### 1. What the design system actually contains (inventoried)

Root: `~/Documents/Pennie Branding/Pennie Design System/`

- **Logos** (`assets/`, all SVG, ~0.8–4.2 KB each):
  - Wordmark, concrete-fill (for `<img>`): `logo-pennie-charcoal.svg` (graphite `#343434`
    fill, verified), `logo-pennie-cream.svg` (cream fill, for ink/navy surfaces),
    `logo-pennie-lg-charcoal.svg` / `logo-pennie-lg-cream.svg` (larger footer proportions).
  - Wordmark, `currentColor` source (for inline use): `logo-pennie.svg`, `logo-pennie-dark.svg`.
  - **Mark only** (the "P" glyph): `logo-mark.svg` (verified `fill="currentColor"`,
    `viewBox 0 0 20.091 22.331`), `logo-mark-dark.svg`.
- **UI icons** (`assets/icons/*.svg`, 24×24 or 20×20, **all `currentColor`**): `arrow-right`,
  `arrow-down`, `arrow-up-right`, `chevron-right`, `check`, `check-badge`, `cross`, `close`
  (in `bold/`), `info`, `search`, `smile`, `star`, `plus`, `minus`, `menu`, `edit`, `home`,
  `coin`, `card`, `safe`, `chart-up`, plus product icons (`debt-consolidation`, `heloc`,
  `personal-loans`, `large-purchases`). Verified `arrow-right.svg` = single path,
  `fill="currentColor"`. Three style sub-sets exist: top-level (mixed), `bold/`,
  `linear/` (stroked), `twotone/` (speedometer only).
  - **Exception caught:** `check-badge.svg` is a `currentColor` *circle* but the checkmark
    stroke is **hardcoded `#F9F6F0`** (beige) so the tick reads on a colored puck. `smile.svg`
    is fully `currentColor` (stroke). This matters when tinting (see §4).
- **Brand graphics** (`assets/brand/graphics/*.png`): `pic-1.png` (floating iridescent
  coins), `pic-2.png`, `pic-3.png` (iridescent ribbon) + 34 `pic-3-N.png` frames. These are
  the iridescent 3D objects for the delight moment (D16).
- **Illustrations** (`assets/brand/illustrations/1.png`..`8.png`, `about-us-image.png`,
  `CTA image.png`) — people/scene art; heavier, for marketing panels (login per D12).
- **People photography** (`assets/people/person-1.png`, `blog-laptop.png`).
- **Partner press logos** (`assets/brand/partners logo/{dark,light}/*.png`) — not needed by Slate.
- **Misc raster** at `assets/` root: `icon-smile-yellow.png` (a plain peach circle, NOT a
  face — confirmed by booker-ux research), `product-coins.png`, `phone-mockup.png`, etc.
- **Fonts**: `fonts/*.otf` (personal-use, DO NOT SHIP — D6). Licensed woff2 kit lives
  separately at `~/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/`:
  `PPMori-Regular.woff2` (400, 35.5 KB), `PPMori-Medium.woff2` (500, 36.9 KB — skip),
  `PPMori-SemiBold.woff2` (600, 37.9 KB), `PPMori-Bold.woff2` (700, 39.9 KB — skip, alias
  700→600 instead). README confirms these are the trypennie production fonts, web-licensed.

### 2. Slate's current asset state (what we're replacing)

- `public/` holds: `slate-logo.png` (1.2 MB — **unused anywhere in code**, confirmed by grep;
  it is dead weight and should be deleted/replaced, not just left), `widget.js`,
  `embed-example.html`.
- `src/app/icon.png` (290 KB) and `src/app/apple-icon.png` (37.5 KB) — Next metadata file
  conventions; these are the current (Slate, not Pennie) app icons. No code references them
  directly; Next auto-wires `<link rel>` tags from the file names.
- `src/app/layout.tsx` imports `Geist` + `Geist_Mono` from `next/font/google`, sets
  `--font-geist-sans`/`--font-geist-mono`. To be replaced by `ppMori` (`next/font/local`).
- `src/app/globals.css` is the stock Next starter (white/black, Geist tokens) — to be
  replaced with the ported Pennie tokens (Foundation task, not this file's scope, but the
  font + asset wiring lands here).
- **Icons in code today are hand-rolled inline SVGs** inside `Booker.tsx` (Clock/Phone/Globe,
  ~lines 94–116) — already the inline pattern, just not the Pennie set. Good: the migration
  is swapping inline SVGs for inline Pennie SVGs, same technique.
- **No SVGR, no SVGO, no `@svgr/webpack`, no font conversion tools installed** (verified:
  `node_modules/@svgr` absent, `node_modules/svgo` absent, no svg-related `.bin`). Homebrew is
  available but not needed.

### 3. Font assets — destination & justification (settled by D6/D7 + pp-mori research)

Copy the licensed woff2 kit into the repo next to the font-definition module so
`next/font/local`'s relative `src` paths resolve at build time:

- **Dest:** `src/app/fonts/PPMori/PPMori-Regular.woff2` + `PPMori-SemiBold.woff2` (two files only).
- **Definition module:** `src/app/fonts/pp-mori.ts` (the pattern in §Recommended Approach of
  the font-loading research — `localFont({ src: [...], variable: '--font-pp-mori', ... })`
  with the 700→600 alias and `font-synthesis: none`).
- **Why `src/app/fonts/` (not `public/fonts/`):** `next/font/local` resolves `src` relative to
  the module that calls it and **self-hosts** the files — at build time Next emits the
  `@font-face` CSS and copies hashed copies to `_next/static/media/…`. The source woff2 must
  live **inside the build graph (under `src/`)**, not in `public/`. Putting them in `public/`
  and hand-writing `@font-face` would lose Next's preload + CLS-reducing fallback metrics and
  contradict D7 ("Load via `next/font/local`… Don't paste the DS `@font-face` block"). This is
  CF/OpenNext-safe because it's purely build-time; the hashed files land in the static asset
  manifest OpenNext uploads (same mechanism trypennie uses in prod).
- **Do NOT ship:** `PPMori-Medium.woff2` (no Medium 500 per D6), `PPMori-Bold.woff2` (alias
  700→600 by pointing a second `src` entry at the SemiBold file), the `.otf` files
  (personal-use license), Extralight, italics.

### 4. UI icon strategy — inline React SVG components (the `currentColor` requirement)

The DS SKILL.md is explicit: icons "are all drawn with `currentColor`. Inline them (or embed
as `<svg>`) so `color` inherits — `<img src>` won't tint." An `<img>` renders the SVG as an
opaque image and **cannot** pick up the surrounding `color`/`var(--fg-muted)`; tinting would
require CSS masks (fragile) or per-color file copies. So `<img>` is rejected for UI icons.

**Recommended pattern: hand-authored inline React components in `src/components/icons/`.**

- One small `.tsx` per icon, each a function returning the DS `<svg>` markup with
  `fill="currentColor"` / `stroke="currentColor"` preserved and spreading
  `props: React.SVGProps<SVGSVGElement>` so callers pass `className`, `aria-hidden`, `width`,
  `style`, etc. Example shape:
  ```tsx
  export function ArrowRightIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor"
           aria-hidden focusable={false} {...props}>
        <path d="M 20 12.76 L 13.401 19 ..." />
      </svg>
    );
  }
  ```
  Color then inherits from the parent's `color` (set via Tailwind `text-*` util or a Pennie
  token like `color: var(--fg-muted)`).
- **Why hand-authored over SVGR:** SVGR is **not installed**, and adding a webpack/SWC loader
  in Next 16 + OpenNext is extra build surface for ~8 tiny icons. The DS SVGs are already
  single-path/clean; copying the markup into a `.tsx` is faster and zero-dependency. The
  scope is small (booker needs roughly: `arrow-right`, `chevron-right`, `phone`, `check`/
  `check-badge`, `smile`, plus keep clock/globe as the existing inline SVGs since the DS has
  no equivalents — per booker-ux §3). Admin/login may add a few more (`menu`, `search`,
  `edit`, `info`, `cross`/`close`). Build them on demand, not the whole set.
- **Why not an SVG `<symbol>` sprite:** a sprite (`<use href="#id">`) also inherits
  `currentColor`, but it adds a fetch/inline-blob step and indirection for no benefit at this
  count; inline components are simpler and tree-shakeable. Reject sprite for this scale.
- **`check-badge.svg` caveat:** its tick is hardcoded `#F9F6F0` (beige), designed to sit on a
  colored puck — the circle is `currentColor`, the check is always beige. When porting,
  **keep the `#F9F6F0` literal** (it's a designed-in contrast color, not a token miss); set the
  puck/circle color via `currentColor` (e.g. `text-[color:var(--pennie-sky)]` or
  `--pennie-green`). For a fully tintable check on light surfaces, prefer `check.svg`
  (plain `currentColor`) instead.
- **No SVGO pass needed:** files are already minimal (`arrow-right` is one path, ~250 bytes).
  Optionally strip the `xmlns` attr when inlining in JSX (React doesn't need it on nested
  inline SVG, but it's harmless to keep). Do not install SVGO for this.

**Destination:** `src/components/icons/*.tsx` + a barrel `src/components/icons/index.ts`.

### 5. App icons / favicon (Next metadata file convention — verified against installed docs)

Doc: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md`
(Next 16.2.7). Supported types per convention:

| Convention | Supported types | Location |
|---|---|---|
| `favicon` | `.ico` only | `app/` root only |
| `icon` | `.ico`, `.jpg`, `.jpeg`, `.png`, **`.svg`** | `app/**` |
| `apple-icon` | `.jpg`, `.jpeg`, **`.png` (NO svg)** | `app/**` |

Next auto-emits the `<link rel>` tags from these files — no `metadata.icons` config needed
(and don't hand-write `<link>` in `<head>`). Plan:

- **`src/app/icon.svg`** ← Pennie **mark** (`logo-mark.svg`, the "P"). SVG is allowed for
  `icon` and is crisp at every size, ~0.8 KB. Use `logo-mark.svg` (currentColor) but **bake a
  concrete fill** for the favicon since a tab favicon has no inherited `color` — set
  `fill="#1D212F"` (navy) or `#343434` (graphite) on a transparent/cream ground so it reads on
  light browser chrome. (Inline-currentColor inheritance does not apply to a standalone
  favicon file; give it an explicit fill.)
- **`src/app/apple-icon.png`** ← replace the current Slate PNG with a Pennie-mark PNG on a
  brand ground (180×180 recommended for apple-touch-icon). SVG is **not** permitted here, so a
  PNG export of the mark on a cream or navy rounded tile is required. This is the one place a
  raster export is needed (see Human Actions — needs a one-time PNG export, or generate via
  the `icon.tsx`/`ImageResponse` code route if we want it in-repo and dependency-free).
- **Delete** `src/app/icon.png` (290 KB) once `icon.svg` is in place (Next would otherwise
  serve both; keep one). Replacing `icon.png` with `icon.svg` removes ~290 KB.
- **Optional `favicon.ico`:** not required (the `icon.svg` covers modern browsers); skip unless
  legacy `.ico` is wanted.

### 6. Logo placement per surface & background (per SKILL.md §"Assets to pull from")

The SKILL.md rule: concrete-fill variants for `<img>` (no `currentColor` across an `<img>`
boundary); `currentColor` source for inline.

- **Charcoal/graphite wordmark on light** (cream/white/sky surfaces): `logo-pennie-charcoal.svg`.
  Used on: Booker shell header (beige/light default per D10), `/book`, manage page, admin/me
  light theme, login form panel.
- **Cream wordmark on navy** (ink surfaces): `logo-pennie-cream.svg`. Used on: navy hero/footer
  bands, login marketing panel if navy (D12), dark-theme headers.
- **Large proportions** (footers): `logo-pennie-lg-charcoal.svg` / `-lg-cream.svg`.
- **Mark only** (`logo-mark.svg`): favicon/app icon, compact embed header, avatar-adjacent
  contexts where the full wordmark is too wide.
- **Delivery choice:** for static surfaces use the concrete-fill SVG via Next `<Image>` or a
  plain `<img>` from `public/` (no tint needed). For a logo that must flip color with the
  theme in one element, inline `logo-pennie.svg` (currentColor) as a React component and let
  `color` switch via `data-theme`. **Recommendation:** ship both — concrete-fill SVGs in
  `public/brand/` for `<img>`, and (only if a theme-flipping inline logo is wanted) a
  `Wordmark` inline component in `src/components/icons/`. Default to the concrete-fill `<img>`
  approach (simpler, matches SKILL.md guidance); pick charcoal vs cream per surface background.

### 7. Delight assets — split by surface (D16)

D16 locks: **iridescent Pennie 3D graphic on the STANDALONE confirmation page; lightweight
SVG icon (check-badge/smile in a sky-soft puck) inside the EMBED iframe** (performance).

- **Standalone page** (`/booking/[id]` confirmation, non-embedded Booker confirmed state):
  use **`assets/brand/graphics/pic-1.png`** (floating iridescent coins — verified soft sky+gold
  on transparent bg, finance-appropriate, calm). `pic-3.png` (iridescent ribbon) is the listed
  alternative (slightly more celebratory). Per the open item in DISCOVERY ("coins vs ribbon —
  pick during task"), **recommend `pic-1.png` (coins)** as the default for a finance booking
  confirmation; keep `pic-3.png` available as the alternate. Lands in `public/brand/`.
  - These PNGs can be large; check the file size and, if >~150 KB, that's acceptable for a
    standalone page load (not the embed). It is loaded only on the success screen, so it does
    not affect initial booker paint. No conversion needed; serve as-is.
- **Embed iframe** (`/book` confirmed state when `embed=1`): use the **inline `check-badge` or
  `smile` SVG component** inside a sky-soft (`--pennie-sky-soft`) puck — **zero image weight**,
  crisp, and avoids adding network cost to the latency-sensitive iframe. This reuses the
  `src/components/icons/` component from §4, so no separate asset file is copied for the embed.
  Per embed-css-isolation research, animate opacity/transform only (ResizeObserver posts
  scrollHeight; height animation breaks resize).
- **Decision rule for the Booker:** branch on the `embedded` flag already read in
  `/book/page.tsx` — embedded → inline SVG puck; standalone → `pic-1.png`. Both get the warm
  copy ("You're booked! ...") and a single calm fade/rise honoring `prefers-reduced-motion`.

### 8. Conversion / optimization steps (keep minimal — essentially none)

- **Fonts:** no conversion — the licensed kit is already woff2 (D7). Just copy 2 files.
- **SVGs:** no SVGO — files are already small and clean; inlining into `.tsx` is the only
  "transform," done by hand. (If a future bulk import is wanted, `npx svgo` is a one-shot, but
  do not add it as a dependency for this pass.)
- **App icon PNG:** the one raster step — a 180×180 `apple-icon.png` of the Pennie mark.
  Either export once from the SVG (user/designer, or `rsvg-convert`/`sharp` one-off) or
  generate in-repo via a Next `apple-icon.tsx` + `ImageResponse` route (zero external dep,
  documented in the same app-icons doc §"Generate icons using code"). Prefer the
  `ImageResponse` route to keep it in the build and avoid a binary export step.
- **Large brand PNGs** (`pic-1.png`): serve as-is from `public/`; Next `<Image>` will optimize
  on demand if used (note: OpenNext image optimization config — if `next/image` optimization is
  disabled on CF, the PNG is served raw, which is fine for a single confirmation graphic).

## Recommended Approach

1. **Fonts** — copy `PPMori-Regular.woff2` + `PPMori-SemiBold.woff2` to
   `src/app/fonts/PPMori/`; add `src/app/fonts/pp-mori.ts`; wire `ppMori.variable` in
   `layout.tsx`; drop Geist. (Per font-loading research + D6/D7.)
2. **UI icons** — hand-author the needed `currentColor` SVGs as inline React components in
   `src/components/icons/` (`ArrowRightIcon`, `ChevronRightIcon`, `PhoneIcon`, `CheckIcon`/
   `CheckBadgeIcon`, `SmileIcon`, + admin set as needed). Barrel-export via `index.ts`. Keep
   the existing inline Clock/Globe SVGs in Booker (no DS equivalent). No `<img>` for icons.
3. **App icons** — add `src/app/icon.svg` (Pennie mark, concrete navy/graphite fill); replace
   `src/app/apple-icon.png` with a Pennie-mark PNG (or an `apple-icon.tsx` `ImageResponse`
   route); delete `src/app/icon.png`.
4. **Logos** — copy `logo-pennie-charcoal.svg`, `logo-pennie-cream.svg`,
   `logo-pennie-lg-charcoal.svg`, `logo-pennie-lg-cream.svg`, `logo-mark.svg` to
   `public/brand/`; use via `<img>`, charcoal-on-light / cream-on-navy per surface. Add an
   inline `Wordmark` component only if a theme-flipping logo is needed.
5. **Delight** — copy `pic-1.png` (and optionally `pic-3.png`) to `public/brand/` for the
   standalone confirmation; use the inline `CheckBadgeIcon`/`SmileIcon` in a sky-soft puck for
   the embed. Branch on `embedded`.
6. **Cleanup** — delete the unused `public/slate-logo.png` (1.2 MB dead weight) and the old
   `src/app/icon.png`.
7. **No new build tooling** — no SVGR, no SVGO, no font converters. The only optional codegen
   is the `apple-icon.tsx` `ImageResponse` route (uses `next/og`, already available in Next 16).

### Copy-map table (source path → dest path → usage)

| Source (under `~/Documents/Pennie Branding/`) | Dest (under `~/Documents/Slate/`) | Usage / how consumed |
|---|---|---|
| `PP Mori Font/woff2 (licensed web kit)/PPMori-Regular.woff2` | `src/app/fonts/PPMori/PPMori-Regular.woff2` | `next/font/local` weight 400; build-time self-host → `_next/static/media` |
| `PP Mori Font/woff2 (licensed web kit)/PPMori-SemiBold.woff2` | `src/app/fonts/PPMori/PPMori-SemiBold.woff2` | `next/font/local` weight 600 + 700-alias |
| `PP Mori Font/woff2 (licensed web kit)/PPMori-Medium.woff2` | — (DO NOT COPY) | No Medium 500 per D6 |
| `PP Mori Font/woff2 (licensed web kit)/PPMori-Bold.woff2` | — (DO NOT COPY) | Alias 700→600 instead |
| `Pennie Design System/fonts/*.otf` | — (DO NOT COPY) | Personal-use license; forbidden on web (D6) |
| `Pennie Design System/assets/logo-mark.svg` | `src/app/icon.svg` (concrete fill) **and** `public/brand/logo-mark.svg` | Favicon (`icon` convention, baked fill) + compact mark in UI (`<img>`) |
| `Pennie Design System/assets/logo-pennie-charcoal.svg` | `public/brand/logo-pennie-charcoal.svg` | Wordmark on light surfaces via `<img>` |
| `Pennie Design System/assets/logo-pennie-cream.svg` | `public/brand/logo-pennie-cream.svg` | Wordmark on navy/ink surfaces via `<img>` |
| `Pennie Design System/assets/logo-pennie-lg-charcoal.svg` | `public/brand/logo-pennie-lg-charcoal.svg` | Large footer wordmark on light |
| `Pennie Design System/assets/logo-pennie-lg-cream.svg` | `public/brand/logo-pennie-lg-cream.svg` | Large footer wordmark on navy |
| `Pennie Design System/assets/logo-pennie.svg` (currentColor) | `src/components/icons/Wordmark.tsx` (optional, inline) | Only if a theme-flipping inline logo is needed |
| `Pennie Design System/assets/icons/arrow-right.svg` | `src/components/icons/ArrowRightIcon.tsx` | Inline `<svg currentColor>` on primary CTA (translateX on hover) |
| `Pennie Design System/assets/icons/chevron-right.svg` | `src/components/icons/ChevronRightIcon.tsx` | Calendar prev/next nav (mirror for prev) |
| `Pennie Design System/assets/icons/bold/Phone.svg` | `src/components/icons/PhoneIcon.tsx` | Event-panel phone meta row |
| `Pennie Design System/assets/icons/check-badge.svg` | `src/components/icons/CheckBadgeIcon.tsx` | Embed confirmation puck (keep `#F9F6F0` tick literal; circle = currentColor) |
| `Pennie Design System/assets/icons/smile.svg` | `src/components/icons/SmileIcon.tsx` | Alt embed confirmation puck (fully currentColor) |
| `Pennie Design System/assets/icons/check.svg` | `src/components/icons/CheckIcon.tsx` | List ticks / inline confirmations (fully tintable) |
| `Pennie Design System/assets/icons/{search,menu,edit,info,cross}.svg` (as needed) | `src/components/icons/*.tsx` | Admin/me/login chrome — author on demand |
| `Pennie Design System/assets/brand/graphics/pic-1.png` | `public/brand/pic-1-coins.png` | Standalone confirmation delight graphic (D16) |
| `Pennie Design System/assets/brand/graphics/pic-3.png` | `public/brand/pic-3-ribbon.png` (optional alt) | Alternate confirmation graphic |
| `Pennie Design System/assets/brand/illustrations/*.png` (1 chosen) | `public/brand/login-art.png` (only if login uses illustrated panel per D12) | Login marketing panel art |
| — (export of `logo-mark`) | `src/app/apple-icon.png` (or `src/app/apple-icon.tsx` ImageResponse) | Apple touch icon (SVG not allowed; PNG/codegen required) |
| `public/slate-logo.png` (existing, 1.2 MB) | DELETE | Unused dead weight |
| `src/app/icon.png` (existing, 290 KB) | DELETE | Superseded by `icon.svg` |

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Icons as hand-authored inline React `<svg>` components | `currentColor` inherits; zero deps; tree-shakeable; matches existing Booker inline pattern; small icon count | Manual copy of markup per icon | **Recommended** |
| Icons via SVGR loader (`@svgr/webpack`) | Auto-imports `.svg` as components | Not installed; adds build/loader config in Next 16 + OpenNext for ~8 icons; overkill | Rejected |
| Icons as `<img src="…svg">` | Simplest copy step | **Cannot tint** `currentColor` (the whole DS icon model breaks); fixed color only | Rejected (violates SKILL.md) |
| Icons as SVG `<symbol>` sprite + `<use>` | `currentColor` works; one file | Extra indirection/fetch; no benefit at this count | Rejected |
| Fonts in `src/app/fonts/PPMori/` via `next/font/local` | Build-time self-host, preload, CLS metrics, CF-safe | — | **Recommended** |
| Fonts in `public/fonts/` + hand `@font-face` | Familiar | No preload/CLS metrics; contradicts D7; loses Next optimization | Rejected |
| Favicon as `icon.svg` (mark) | Crisp all sizes; tiny; one file | Needs a baked fill (no inherited color on a favicon) | **Recommended** |
| Keep PNG `icon.png` | No change | 290 KB; not the Pennie mark | Rejected (replace) |
| `apple-icon.png` raster export | Required (SVG unsupported) | One manual export step | Recommended (or use `apple-icon.tsx` ImageResponse to keep in-repo) |
| Delight: `pic-1.png` everywhere incl. embed | One asset | Adds image weight to latency-sensitive iframe | Rejected for embed (D16 splits surfaces) |
| Delight: inline SVG everywhere incl. standalone | Tiny | Loses the "wow" iridescent moment on the standalone page | Rejected for standalone (D16 wants the graphic there) |
| Add SVGO/font-converter tooling | "Optimized" | Files already small/woff2; new deps + build surface for no gain | Rejected |

## Pitfalls and Edge Cases

- **`<img>` cannot tint `currentColor` icons** — the single biggest trap; all UI icons must be
  inline `<svg>` (React components), not `<img>`. Logos (concrete-fill) are the only SVGs safe
  to load via `<img>`.
- **`apple-icon` does not accept SVG** (Next file convention) — must be PNG or a `.tsx`
  `ImageResponse` route. `favicon` accepts only `.ico`; `icon` accepts `.svg`. Don't try to
  ship an `apple-icon.svg`.
- **Favicon has no inherited color** — bake a concrete fill (`#1D212F`/`#343434`) into
  `icon.svg`; don't leave it `currentColor` (it would render black/transparent unpredictably in
  browser chrome).
- **`check-badge.svg` tick is hardcoded `#F9F6F0`** (not a token miss — it's the on-puck
  contrast color). Keep the literal; color the circle via `currentColor`. For a tintable check
  on plain light surfaces, use `check.svg` instead.
- **Font source files must live under `src/` (not `public/`)** so `next/font/local`'s relative
  `src` resolves and self-hosting works. Copy to `src/app/fonts/PPMori/`.
- **Don't ship the `.otf` fonts or the woff2 Medium/Bold** — license (OTF) and brand-rule
  (Medium 500 banned, 700 aliased) constraints from D6.
- **Delete `public/slate-logo.png` (1.2 MB)** — unused; leaving it bloats the CF asset upload.
- **`pic-1.png` only on the standalone page**, never inside the embed iframe (D16, perf).
  Gate on the `embedded` flag in `/book/page.tsx`.
- **Embed delight must animate opacity/transform only** (not height) — height changes trip the
  ResizeObserver `slate:resize` and jitter the iframe (embed-css-isolation research).
- **No SVGR/SVGO installed** — do not assume an `import Icon from './x.svg'` works; it won't
  without a loader. Author components by hand.
- **OpenNext + `next/image`**: if image optimization is disabled on CF Workers, `pic-1.png`
  is served raw from `public/` — acceptable for one confirmation graphic; don't rely on
  runtime optimization for it.

## References

- `~/Documents/Pennie Branding/Pennie Design System/SKILL.md` (icon/logo `currentColor` rules,
  "inline them, `<img>` won't tint"; logo concrete-fill variants per surface)
- `~/Documents/Pennie Branding/Pennie Design System/assets/` (logos, `icons/` all currentColor,
  `brand/graphics/pic-1.png`+`pic-3.png`, `brand/illustrations/`)
- `~/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/` (Regular/Medium/SemiBold/
  Bold woff2 + README confirming web license)
- DISCOVERY.md D6/D7 (fonts: licensed woff2, 400+600, 700→600 alias), D8 (color), D12 (login
  marketing panel), D15 (embed constraints), D16 (delight split: graphic standalone / SVG embed)
- First-wave research: `pp-mori-font-loading.md` (font dest + `next/font/local` wiring),
  `booker-ux-patterns.md` (icon swaps §3, delight §5 — `pic-1`/`pic-3`, `check-badge`/`smile`),
  `embed-css-isolation.md` (embed perf, opacity/transform-only animation)
- Next 16.2.7 installed docs:
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md`
  (favicon/icon/apple-icon supported types + `ImageResponse` codegen),
  `node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md` (`next/font/local`)
- Slate current state: `src/app/layout.tsx` (Geist), `src/app/globals.css`,
  `src/app/icon.png`/`apple-icon.png`, `public/slate-logo.png` (unused), `public/widget.js`,
  `src/components/Booker.tsx` (existing inline-SVG icon pattern)
- Tooling check: no `@svgr`, no `svgo`, no font converters in `node_modules` (verified)

---

## Second Wave Additions

### Execution Details (filtered by DISCOVERY.md)

- **D6/D7 (fonts):** only `PPMori-Regular.woff2` + `PPMori-SemiBold.woff2` → `src/app/fonts/PPMori/`;
  2 files, alias 700→600, skip Medium/Bold/OTF/italics. No conversion.
- **D8 (color):** icon tint via `currentColor` + Pennie tokens (`--fg-muted`, `--pennie-sky`,
  `--pennie-green`); never hardcode hex when inlining (except the designed-in `#F9F6F0` tick in
  `check-badge`).
- **D12 (login):** if the marketing panel uses illustrated art, copy ONE
  `brand/illustrations/*.png` → `public/brand/login-art.png`; if it uses a flat navy panel, no
  image asset needed (just the cream wordmark `logo-pennie-cream.svg`).
- **D15 (embed):** no Pennie image assets in the iframe confirmation — inline SVG only; widget.js
  stays vanilla (no asset imports). Logos/icons used by `/book` load inside the iframe document
  (fine — full design system there), not on the host page.
- **D16 (delight):** standalone → `public/brand/pic-1-coins.png`; embed → inline
  `CheckBadgeIcon`/`SmileIcon` in a `--pennie-sky-soft` puck. Branch on `embedded`.

### Tool and Surface Configuration

| Tool/Service | Surface | Purpose | Setup Required | Agent Can Self-Configure? |
|-------------|---------|---------|----------------|---------------------------|
| Bash (`cp`) | Files | Copy woff2 (×2), logo SVGs, `pic-1.png`, login art into the repo per the copy-map | None | Yes |
| Read/Write/Edit | Files | Author `src/components/icons/*.tsx` from DS SVG markup; `pp-mori.ts`; `icon.svg`; edit `layout.tsx` | None | Yes |
| `next/og` `ImageResponse` (built-in) | Files | Optional `src/app/apple-icon.tsx` to generate the 180×180 apple icon in-repo (no binary export) | None (ships with Next 16) | Yes |
| `pnpm build` | Files | Confirm fonts emit to `_next/static/media`, no edge-runtime warning, icons resolve | Deps installed | Yes |
| Playwright MCP | Browser | Verify favicon/app icon, logo per surface/theme, confirmation graphic (standalone) vs SVG puck (embed) render correctly | Slate dev server | Yes |

### Verification Strategy

- **Method:** After the copy + component authoring, run `pnpm build` (green = fonts/icons
  resolved, no missing-asset errors). Then Playwright: load `/book` standalone (confirm
  `pic-1` coins on success) and `/book?embed=1` (confirm inline SVG puck, no extra image
  request in the network panel). Check the browser tab favicon = Pennie mark. Grep the repo to
  confirm no `<img>` is used for a `currentColor` icon and no `.otf`/Medium/Bold woff2 was copied.
- **Evidence:** `pnpm build` log (font media emitted, no warnings); Playwright screenshots of
  (1) tab favicon, (2) Booker header logo on light + on navy, (3) standalone confirmation with
  `pic-1`, (4) embed confirmation with inline SVG puck + network tab showing no PNG fetch in the
  iframe, (5) `ls src/app/fonts/PPMori/` showing exactly 2 files.
- **Acceptance threshold:** exactly 2 woff2 files shipped; all UI icons inline + tint with theme
  color; favicon/apple-icon are the Pennie mark; standalone confirmation shows `pic-1`, embed
  shows inline SVG (no image weight); `public/slate-logo.png` and old `icon.png` deleted; build
  green on `pnpm build` (and ideally `pnpm cf:build`).

### Human Actions Required

| Action | Who | How | Status |
|--------|-----|-----|--------|
| Confirm `pic-1` (coins) vs `pic-3` (ribbon) for standalone confirmation | User (or task default) | DISCOVERY open item; default = `pic-1` coins | Pending (non-blocking; agent can default) |
| Confirm login panel is navy-flat vs illustrated (affects whether to copy an illustration) | User / login-surface task | Per D12 layout decision | Pending (non-blocking) |
| Provide/approve the 180×180 `apple-icon.png` OR approve the `apple-icon.tsx` ImageResponse codegen | User | Either supply a PNG export of the mark, or accept the in-repo codegen route | Pending (agent can self-do via ImageResponse) |
| Confirm licensed woff2 web embedding is permitted (already stated, README confirms) | User | Already confirmed in D6 ("We have a license") + kit README | Done |

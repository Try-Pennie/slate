# PP Mori Font Loading in Next.js - Research

**Wave**: First
**Researcher**: PP Mori font loading domain (Slate brand redesign)
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code/Files

---

## Summary

Slate (Next.js 16.2.7, App Router, Tailwind v4, OpenNext/Cloudflare Workers) currently
loads Geist via `next/font/google`. We need to swap to PP Mori loaded with
`next/font/local`, wired into the design system's `--font-sans` token so both `.pn-*`
classes and Tailwind utilities resolve to PP Mori, with `font-synthesis: none`, a
700→600 alias, and italics where licensing allows.

**The single most important finding is a licensing conflict that overrides the task brief.**
The task says to prefer the design-system OTFs (200/400/600 + italics) "for brand fidelity."
But those OTFs are the **Free-For-Personal-Use desktop cut** (Pangram Pangram EULA,
`EULA-PangramPangram-FreeForPersonalUse-MAY2021.pdf`) and the licensed-kit README
**explicitly forbids using them for web/commercial work**. Slate is a commercial Pennie
product. The licensed woff2 web kit (`Regular 400 / Medium 500 / SemiBold 600 / Bold 700`,
no Extralight, no italics) is the only license-clean source for web embedding. The two
sources do not overlap cleanly: the licensed kit lacks 200 Extralight and italics; the OTFs
lack a license to embed on the web. This must be surfaced as a decision in DISCOVERY (see
Pitfalls and Open Decision below) before any code is written.

## Key Findings

### 1. Next.js 16 `next/font/local` API (verified against installed docs)

Docs read: `node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md`
and `.../01-getting-started/13-fonts.md`. Next version: **16.2.7**. The `next/font/local`
API in this version matches the familiar API (no breaking change here despite the AGENTS.md
warning) — confirmed from the installed docs, not training data.

- Import is a **default export**: `import localFont from 'next/font/local'` (note: trypennie's
  `fonts.ts` uses `import localFonts from ...` — the name is arbitrary since it's a default
  import; both work).
- `src` accepts a string or an **array of `{ path, weight, style }` objects** for multiple
  files in one family. `path` is resolved **relative to the file where `localFont` is called**.
- Relevant options for `next/font/local` (from the API reference table):
  | Option | Type | Notes |
  |---|---|---|
  | `src` | string \| `Array<{path,weight?,style?}>` | **Required** |
  | `weight` | string | Per-file in the array, or top-level for single file |
  | `style` | string | `'normal'` / `'italic'`; per-file in array |
  | `display` | string | default `'swap'`; design system wants `swap` ✓ |
  | `preload` | boolean | default `true` |
  | `fallback` | string[] | fallback font stack, **no default** |
  | `adjustFontFallback` | `'Arial'` \| `'Times New Roman'` \| `false` | default `'Arial'`; auto size-adjust metrics to reduce CLS |
  | `variable` | string | **the CSS variable name**, e.g. `'--font-pp-mori'` — this is the Tailwind/`--font-*` hook |
  | `declarations` | `Array<{prop,value}>` | **local-only**; injects extra `@font-face` descriptors, e.g. `{ prop: 'font-synthesis', value: 'none' }` |
- `subsets`/`axes` are **`next/font/google` only** — not available for local fonts (no warning needed).
- `.otf` files are accepted by `next/font/local` (docs example uses `.ttf`; the loader accepts
  `.woff2`/`.woff`/`.ttf`/`.otf`). woff2 is strongly preferred for size/perf.
- The loader returns `{ className, style, variable }`. With `variable` set, you apply
  `font.variable` to `<html>`/`<body>` className and the CSS var becomes available to all CSS.

### 2. The two font sources and their licensing (the crux)

| Source | Path | Weights | Italics | License | Web/commercial use |
|---|---|---|---|---|---|
| Design-system OTFs | `Pennie Design System/fonts/*.otf` AND `PP Mori Font/*.otf` | 200, 400, 600 | yes | **Free-For-Personal-Use** (`EULA-PangramPangram-FreeForPersonalUse-MAY2021.pdf`) | **NO — forbidden** |
| Licensed web kit (woff2) | `PP Mori Font/woff2 (licensed web kit)/*.woff2` | 400, 500, 600, 700 | **no** | Licensed (used in trypennie.com prod) | **YES** |
| trypennie in-repo | `~/trypennie/src/assets/fonts/PPMori/*.woff2` | 400, 500, 600, 700 | no | same licensed kit | YES (this is where the kit was copied from) |

The licensed-kit `README.txt` is explicit:
> "Use THESE for any web/commercial Pennie product (e.g. Slate). Do NOT use the .otf files in
> the parent folder for web/commercial work — those are the 'Free For Personal Use' desktop cut
> (see the EULA PDF) and are missing Medium 500."

So the task-brief instruction ("prefer the design-system weights for brand fidelity") and the
license are in direct conflict. **License wins for a shipping product.** The practical effect:
- We **cannot** ship 200 Extralight on the web (only exists in the personal-use OTFs).
- We **cannot** ship italics on the web (only exist in the OTFs).
- The licensed kit has Medium 500, which the canonical Pennie brand spec says we do *not* use.

### 3. Brand weight spec (from `colors_and_type.css`)

Canonical weights and how the CSS uses them:
- `--fw-extralight: 200`, `--fw-regular: 400`, `--fw-semibold: 600`, `--fw-bold: 600` (bold is
  aliased to semibold). **No Medium 500.** The CSS aliases 700→600 via a `@font-face` so any
  `font-weight: 700` renders as SemiBold.
- Body = 400 (`.pn-body`, `.pn-lead`), headings/bold = 600 (`.pn-h1..h4`, `.pn-display`,
  `.pn-btn`, `.pn-body-bold`).
- `font-synthesis: none` on `html, body` — never fake bold/italic.
- 200 Extralight is declared but **not referenced by any `.pn-*` class** in the file — it's
  available for opt-in display use, not part of the core body/heading recipe.

Reconciling brand spec vs licensed kit: the **load-bearing weights for `.pn-*` are 400 and 600**
— both present in the licensed kit. So the licensed kit fully covers the actual UI recipe.
200 Extralight and italics are nice-to-have, not used by any base class. We can ship a
brand-faithful Slate with **just 400 + 600 from the licensed kit** and lose nothing the
`.pn-*` system actually renders.

### 4. Wiring into Tailwind v4 `@theme` + the design-system `--font-sans`

Slate's `globals.css` already uses Tailwind v4's `@theme inline` with
`--font-sans: var(--font-geist-sans)`. The design system's `colors_and_type.css` defines
`--font-sans: 'PP Mori', -apple-system, …` and `--font-display: var(--font-sans)`, and all
`.pn-*` classes resolve `font-family: var(--font-sans)`.

The clean wiring (verified against the "With Tailwind CSS" section of the installed font docs):
1. `next/font/local` with `variable: '--font-pp-mori'` produces a CSS var holding the
   hashed font-family + the Next fallback metrics.
2. Apply `font.variable` to `<html className>`.
3. In CSS, set the design system's token to point at it:
   `--font-sans: var(--font-pp-mori), -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;`
4. In Tailwind `@theme inline`, set `--font-sans: var(--font-sans)` (or directly
   `var(--font-pp-mori), …`) so the `font-sans` utility and the `.pn-*` `var(--font-sans)`
   both resolve to PP Mori. One token, both systems.

This means we do **not** need the design system's `@font-face` block at all — `next/font/local`
generates the `@font-face` rules itself (self-hosted, hashed, preloaded). We only keep the
`--font-sans`/`--font-display` **token** lines and point them at the Next-generated variable.

### 5. `font-synthesis: none` and the 700→600 alias

- **`font-synthesis: none`**: best applied globally in CSS (`html, body { font-synthesis: none; }`)
  exactly as the design system already does — keep that line when porting `colors_and_type.css`.
  It can *also* be injected per-`@font-face` via the local font `declarations` option
  (`declarations: [{ prop: 'font-synthesis', value: 'none' }]`), but the global CSS rule is
  simpler and matches the design system. Recommend the global rule; `declarations` is optional
  belt-and-suspenders.
- **700→600 alias**: with `next/font/local` you reproduce the design system's alias by adding a
  second `src` entry that points the 600 file at weight `'700'`:
  ```ts
  { path: './PPMori-SemiBold.woff2', weight: '600', style: 'normal' },
  { path: './PPMori-SemiBold.woff2', weight: '700', style: 'normal' }, // alias 700 → SemiBold file
  ```
  This makes any `font-weight: 700` (including Tailwind `font-bold`) render the SemiBold cut.
  Combined with `font-synthesis: none`, nothing is faked. Note Next will emit two `@font-face`
  blocks referencing the same hashed file — harmless, no double download (same asset URL).

### 6. OTF → woff2 conversion (only relevant IF the OTFs are licensed for web)

If a future licensed web cut of 200/italics is obtained, or if the decision is made to convert,
the OTFs can be converted to woff2. **No conversion tooling is currently installed**
(`woff2_compress`, `fonttools`, `pyftsubset` all absent; Homebrew is available at
`/opt/homebrew/bin/brew`). Conversion options:
- **Homebrew woff2** (Google's reference compressor):
  ```bash
  brew install woff2
  woff2_compress "PPMori-Regular.otf"   # → PPMori-Regular.woff2 alongside the input
  ```
  Run once per file. woff2 typically yields ~40-50% smaller files than OTF.
- **fonttools (Python)** — also lets you subset to latin to shrink further:
  ```bash
  pip install fonttools brotli
  fonttools ttLib.woff2 compress PPMori-Regular.otf   # → PPMori-Regular.woff2
  # optional latin subset:
  pyftsubset PPMori-Regular.otf --flavor=woff2 --output-file=PPMori-Regular.woff2 \
    --unicodes="U+0000-00FF,U+2000-206F,U+2070-209F,U+20A0-20CF"
  ```
- **DO NOT convert the personal-use OTFs for the shipping product** — converting does not change
  the license; the output woff2 would still be unlicensed for web. Conversion is only a path if
  someone obtains the licensed web cut as OTF, which is not the case today (the licensed cut is
  already woff2).

For the actual redesign, **no conversion is needed**: the licensed kit is already woff2.

### 7. Cloudflare Workers / OpenNext compatibility

Slate ships via OpenNext (`open-next.config.ts`, `wrangler.jsonc`, `.open-next/`, scripts
`cf:build`/`cf:preview`/`cf:deploy` using `opennextjs-cloudflare`). `next/font/local` is
**fully compatible**: font optimization happens at **build time** — Next emits the `@font-face`
CSS and copies hashed font files into the static output (`/_next/static/media/…`). There is no
runtime Node API or filesystem read on the request path (unlike `next/font/google`, which fetches
at build but is also fine). OpenNext serves these as static assets from the Worker/R2 asset
binding. This is the same mechanism trypennie uses in production on its host. No edge-runtime
gotcha here because nothing font-related executes at runtime.

One thing to confirm during implementation: the font files must end up in the static asset
manifest OpenNext uploads. They will, because they're standard `_next/static` build outputs — no
special config. Keep `display: 'swap'` so first paint uses the fallback and avoids invisible text.

## Recommended Approach

1. **Use the licensed woff2 web kit, not the OTFs.** Copy
   `PP Mori Font/woff2 (licensed web kit)/*.woff2` into the repo (e.g.
   `src/app/fonts/` or `src/assets/fonts/PPMori/`). This is license-clean for a commercial product.
2. **Load only the brand-canonical weights 400 and 600** from the kit (skip Medium 500 to honor the
   "no Medium" brand rule; skip Bold 700 as a file and instead **alias 700→600** to match the
   design system). Do not attempt Extralight 200 or italics — not available license-clean.
3. **Create a font definitions file** `src/app/fonts/pp-mori.ts` (per the docs' "font definitions
   file" pattern) so the single font instance is reused:
   ```ts
   import localFont from 'next/font/local';

   export const ppMori = localFont({
     src: [
       { path: './PPMori-Regular.woff2', weight: '400', style: 'normal' },
       { path: './PPMori-SemiBold.woff2', weight: '600', style: 'normal' },
       // Alias 700 → SemiBold so font-bold / font-weight:700 render SemiBold (matches design system)
       { path: './PPMori-SemiBold.woff2', weight: '700', style: 'normal' },
     ],
     display: 'swap',
     variable: '--font-pp-mori',
     fallback: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
     // optional belt-and-suspenders; global CSS rule also sets this:
     declarations: [{ prop: 'font-synthesis', value: 'none' }],
   });
   ```
4. **Update `src/app/layout.tsx`**: remove Geist imports, apply `ppMori.variable`:
   ```tsx
   import type { Metadata } from "next";
   import { ppMori } from "./fonts/pp-mori";
   import "./globals.css";

   export const metadata: Metadata = {
     title: "Slate",
     description: "Scheduling and booking for Pennie.",
   };

   export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
     return (
       <html lang="en" className={`${ppMori.variable} h-full antialiased`}>
         <body className="min-h-full flex flex-col">{children}</body>
       </html>
     );
   }
   ```
5. **In `globals.css`** (after porting the design system tokens), set the design-system token to
   the Next variable and keep the global font rules:
   ```css
   :root {
     --font-sans: var(--font-pp-mori), -apple-system, BlinkMacSystemFont,
                  'Segoe UI', system-ui, sans-serif;
     --font-display: var(--font-sans);
   }
   html, body { font-family: var(--font-sans); font-synthesis: none;
                -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }

   @theme inline {
     --font-sans: var(--font-sans);   /* Tailwind font-sans utility → PP Mori */
     --font-display: var(--font-display);
   }
   ```
   This makes `.pn-*` classes (`var(--font-sans)`), the Tailwind `font-sans` utility, and the
   `html/body` default all resolve to PP Mori from one source.
6. **Do NOT paste the design system's `@font-face` block** — `next/font/local` generates it.
   Only port the *token* lines (`--font-sans`, `--font-display`, `--fw-*`, `--fs-*`, etc.) and the
   `font-synthesis: none` rule from `colors_and_type.css`.
7. **Drop `--font-geist-sans`/`--font-geist-mono` and the `Geist`/`Geist_Mono` imports** entirely.
   Check for any remaining `font-mono` usage before removing the mono token (grep
   `--font-geist-mono` / `font-mono`).

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Licensed woff2 kit, weights 400+600, alias 700→600 (no Medium, no Extralight, no italics) | License-clean for commercial use; covers every weight the `.pn-*` system actually renders; smallest payload (2 files); matches trypennie prod source | Loses 200 Extralight + italics vs the OTFs (but neither is used by any base class) | **Recommended** |
| Licensed woff2 kit, all 4 weights (400/500/600/700) like trypennie | Matches trypennie's exact setup | Ships Medium 500 which violates the canonical "no Medium" brand rule; 700 should alias to 600 not be its own cut; extra download | Rejected (brand-rule conflict; trypennie's kit predates the canonical spec) |
| Design-system OTFs (200/400/600 + italics) via `next/font/local` | Full brand weight range incl. Extralight + italics; matches `colors_and_type.css` `@font-face` exactly | **Personal-use-only license — forbidden for a shipping commercial product**; larger OTF files; no Medium anyway | Rejected (licensing) |
| Convert OTFs → woff2 then ship | Smaller files than raw OTF | Conversion doesn't change the license; output still unlicensed for web | Rejected (licensing) |
| Keep design system's `@font-face` block + plain `<link>`/CSS (no next/font) | Mirrors `colors_and_type.css` verbatim | Loses Next's build-time self-hosting, preload, and CLS-reducing fallback metrics; more manual; weaker perf | Rejected |

## Pitfalls and Edge Cases

- **OPEN DECISION for DISCOVERY (blocking):** The task brief's "prefer design-system OTF weights
  for brand fidelity" conflicts with the licensed-kit README, which forbids the OTFs for
  web/commercial use. **Recommendation: use the licensed woff2 kit (400+600).** Confirm with the
  user that losing 200 Extralight + italics on the web is acceptable (they aren't used by any
  `.pn-*` class, so visually nothing in the current system changes). If the user wants Extralight
  or italics on the web, they must obtain a **licensed web cut** of those — do not ship the
  personal-use OTFs.
- **Brand rule vs trypennie reality:** trypennie ships Medium 500; the canonical spec says no
  Medium and aliases 700→600. Follow the canonical spec for Slate, not trypennie's exact `fonts.ts`.
  Do not copy trypennie's 4-weight array.
- **Default-import name:** `next/font/local` is a default export — trypennie names it `localFonts`
  (plural) which can mislead; the import name is irrelevant.
- **`subsets` is google-only:** don't add `subsets` to the local loader (it's ignored / not in the
  local API); preloading still works for local fonts via `preload: true` (default).
- **`adjustFontFallback` default is `'Arial'` for local:** Next auto-generates a size-adjusted
  Arial fallback to cut CLS. Keep the default unless the metrics look off; the explicit `fallback`
  array (apple-system, etc.) is the *fallback font stack*, separate from the CLS-metric fallback.
- **`@theme inline` self-reference:** writing `--font-sans: var(--font-sans)` inside `@theme inline`
  while also defining `--font-sans` in `:root` works because `inline` resolves the var at use-site,
  but verify it compiles. If Tailwind balks, point the theme token directly at the source:
  `--font-sans: var(--font-pp-mori), -apple-system, …;` and keep `:root --font-sans` for the
  `.pn-*` classes. Two definitions of the same value is acceptable; just keep them in sync.
- **No mono font:** Slate's current layout declares `--font-geist-mono`. Confirm nothing relies on
  `font-mono` before deleting; PP Mori has no mono cut, and the design system defines no mono token.
- **OpenNext static assets:** fonts land in `_next/static/media` at build; no runtime config needed,
  but run `pnpm build` (and ideally `pnpm cf:build`) after the swap to confirm the assets are
  emitted and no edge-runtime warning appears.
- **`pnpm test`** uses `node --experimental-strip-types scripts/test-*.ts` — font changes are
  CSS/layout only and won't be covered by those tests; verification is visual (Playwright) + a
  green `pnpm build`/`lint`.

## References

- Installed Next.js font docs (source of truth for this version 16.2.7):
  - `/Users/danhankins-wright/Documents/Slate/node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md`
  - `/Users/danhankins-wright/Documents/Slate/node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md`
- Design system font setup: `/Users/danhankins-wright/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` (`@font-face` block + `--font-sans`/`--fw-*` tokens + `font-synthesis: none`)
- Design system OTFs: `/Users/danhankins-wright/Documents/Pennie Branding/Pennie Design System/fonts/` (200/400/600 + italics, personal-use)
- Licensed web kit + README: `/Users/danhankins-wright/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/` (400/500/600/700 woff2; README states web/commercial usage rule)
- EULA: `/Users/danhankins-wright/Documents/Pennie Branding/PP Mori Font/EULA-PangramPangram-FreeForPersonalUse-MAY2021.pdf`
- trypennie reference impl: `/Users/danhankins-wright/trypennie/src/assets/fonts/PPMori/fonts.ts` + `/Users/danhankins-wright/trypennie/src/app/layout.tsx`
- Slate current state: `/Users/danhankins-wright/Documents/Slate/src/app/layout.tsx`, `/Users/danhankins-wright/Documents/Slate/src/app/globals.css`
- OpenNext config: `/Users/danhankins-wright/Documents/Slate/open-next.config.ts`, `/Users/danhankins-wright/Documents/Slate/wrangler.jsonc`

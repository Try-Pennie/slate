# Tailwind v4 + Design-Token Mapping - Research

**Wave**: First
**Researcher**: Tailwind v4 + design-token mapping researcher (Slate brand redesign)
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code

---

## Summary

Slate runs **Tailwind v4.3.0** (via `@tailwindcss/postcss ^4`) on **Next.js 16.2.7** (App Router, Turbopack root pinned), hosted on Cloudflare Workers via OpenNext. Tailwind v4 is configured entirely in CSS (`@import "tailwindcss"` in `globals.css`); there is no `tailwind.config.js`. The clean path to bring the Pennie tokens in is a **two-layer approach**: (1) declare the raw `--pennie-*` / semantic / radii / shadow / spacing tokens in plain `:root` (and a dark scope) so raw `var(--…)` and the `.pn-*` classes keep working verbatim, then (2) re-expose the subset that should become utilities through a `@theme inline { … }` block that points back at those vars. This satisfies the design system's "use CSS variables, never hex" rule, keeps the `.pn-*` recipes intact, and gives Tailwind utilities (`bg-accent`, `text-fg`, `rounded-xl`, `shadow-md`, `font-sans`, etc.) for free. Everything compiles at build time through PostCSS with no runtime cost, so it is fully Cloudflare/OpenNext-compatible.

## Key Findings

### Installed versions and config (verified)

- `tailwindcss` **4.3.0**; `@tailwindcss/postcss ^4` (the only PostCSS plugin). Source of truth: `node_modules/tailwindcss/package.json`, `postcss.config.mjs`.
- `next` **16.2.7**, App Router. `next.config.ts` pins `turbopack.root = import.meta.dirname`. No `useLightningcss`, no `inlineCss`, no custom `cssChunking` set.
- `@opennextjs/cloudflare ^1.19.11`, `wrangler ^4.97.0`; `open-next.config.ts` uses default (in-memory) cache.
- Current `globals.css` is stock boilerplate: `@import "tailwindcss"` + a `@theme inline` block mapping `--color-background`, `--color-foreground`, `--font-sans: var(--font-geist-sans)`, `--font-mono`. Dark handling is a bare `@media (prefers-color-scheme: dark)` flipping two vars. `body` hardcodes `font-family: Arial, Helvetica, sans-serif` (overrides the var — a bug to drop in the redesign).
- `layout.tsx` loads `Geist` + `Geist_Mono` from `next/font/google` and sets `geistSans.variable geistMono.variable` on `<html>`. Both must be removed and replaced with PP Mori via `next/font/local`.

### How Tailwind v4 `@theme` works (verified from `node_modules/tailwindcss/index.css` + `theme.css`)

- `@import "tailwindcss"` expands to `@layer theme, base, components, utilities;` then pulls in `theme.css` (the default token set) inside `@layer theme`, plus preflight (base) and the utilities engine. The default tokens live in a `@theme default { … }` block.
- **`@theme` is the bridge from CSS custom properties to utilities.** Any custom property you declare inside `@theme` is (a) emitted as a real CSS variable on `:root` AND (b) registered with the utility engine so a corresponding utility/variant is generated. This is namespaced by prefix:
  - `--color-*` → color utilities (`bg-*`, `text-*`, `border-*`, `ring-*`, `fill-*`, `stroke-*`, `from-*`, etc.). E.g. `--color-accent` → `bg-accent`, `text-accent`, `border-accent`, `ring-accent`.
  - `--font-*` → `font-*` family utilities. `--font-sans` is also what preflight uses for the default body font.
  - `--radius-*` → `rounded-*` (`--radius-xl` → `rounded-xl`).
  - `--shadow-*` → `shadow-*` (`--shadow-md` → `shadow-md`).
  - `--spacing-*` → spacing-based utilities (`p-*`, `m-*`, `gap-*`, `w-*`, `h-*`, etc.). NOTE v4's default is a single `--spacing: 0.25rem` multiplier; named `--spacing-<key>` entries add named steps usable as `p-<key>`.
  - `--text-*` → `text-<size>` font-size utilities (with optional `--text-*--line-height` companions). `--tracking-*` → `tracking-*`. `--leading-*` → `leading-*`.
- **`@theme` vs `@theme inline` (the load-bearing distinction):**
  - Plain `@theme { --color-accent: var(--pennie-sky); }` emits the variable *and* the utility, but the generated utility resolves to the literal value captured at build time. When the theme value is itself a `var()` that you intend to **reassign in a nested/conditional scope** (light/dark, `[data-theme]`), plain `@theme` can "freeze" the indirection incorrectly.
  - `@theme inline { --color-accent: var(--pennie-sky); }` tells Tailwind to **inline the variable reference into the generated utility** (i.e. `.bg-accent { background-color: var(--pennie-sky) }`), so the utility re-resolves through whatever `--pennie-sky` / the chain points to *at the element's scope at runtime*. This is exactly what we want for theming: utilities follow the live cascade.
  - The repo already uses `@theme inline` — keep that keyword.
- **`@theme` must contain only custom-property declarations**, not selectors. It cannot be nested under `@media`/`[data-theme]`. Theme *values* that change per mode are therefore declared with `@theme inline` once (pointing at a plumbing var) and the plumbing var is flipped in ordinary `:root` / `[data-theme]` rules outside `@theme`.
- Tokens you DON'T put in `@theme` (e.g. `--pennie-cream-3`, `--space-13`, every legacy alias) still work as raw `var(--…)` because they're just CSS custom properties — they simply don't get an auto-generated utility. That's fine; the `.pn-*` classes and any `style={{}}` consume them directly.

### Next.js 16 font + CSS facts (verified from installed docs)

- `next/font/local` accepts `src` as an array of `{ path, weight, style }`, plus `variable` (CSS var name), `display`, `preload`, `fallback`, `adjustFontFallback`, and `declarations` (raw `@font-face` descriptors, e.g. `{ prop: 'font-synthesis', value: 'none' }`). Source: `01-app/03-api-reference/02-components/font.md`.
- Recommended CSS practice (from `01-app/01-getting-started/11-css.md`): keep Tailwind/global imports at the app root, single entry file, use Tailwind for most styling + CSS Modules / global CSS for the rest. Confirms our `globals.css` single-entry approach.
- **Theme-without-flash** (from `01-app/02-guides/preventing-flash-before-hydration.md`): the documented Next.js 16 pattern for persisted theme is an inline `<script>` in `<head>` that sets `data-theme` on `<html>` before first paint, with `suppressHydrationWarning` on `<html>`, and CSS keyed on `[data-theme='light']` / `[data-theme='dark']`. This is the canonical pattern to adopt for internal pages.

### Available font files (verified by listing)

- Design system export `fonts/` ships **OTFs only**, canonical set: `PPMori-Extralight.otf` (200), `Regular` (400), `SemiBold` (600), plus the three matching `*Italic.otf`. This matches the brand rule (200/400/600, no Medium, 700→600, `font-synthesis: none`).
- A separate `~/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/` exists but is a different/older cut: it has `Bold`, `Medium`, `Regular`, `SemiBold` woff2 — i.e. it is **missing Extralight and includes Medium**, which contradicts the design system's weight policy. Do NOT use that webkit's weight set as the source of truth; if woff2 is wanted, convert the canonical OTFs (see Pitfalls).

## Recommended Approach

Adopt the **two-layer "import-then-map" model** in `src/app/globals.css`:

1. **Layer A — raw token plumbing (plain `:root`, not `@theme`).** Port the `:root` block from `colors_and_type.css` verbatim into `globals.css` (or `@import` a vendored copy — see Alternatives): all `--pennie-*`, the semantic `--bg/--surface/--fg*/--border*/--accent*/--focus-ring`, `--radius-*`, `--shadow-*`, `--space-*`, and the type vars. Keep the `.pn-*` component classes and `.pn-h1`..`.pn-eyebrow`, `.pn-btn*`, `.pn-card` as-is. This guarantees raw `var(--…)` usage and the `.pn-*` recipes render identically to the design system previews. **Do not import the `@font-face` block from `colors_and_type.css`** — its `src: url('fonts/…')` paths won't resolve and would double-load fonts; fonts come from `next/font/local` instead.

2. **Layer B — `@theme inline` mapping (utilities).** Re-expose the semantic + scale tokens as Tailwind tokens, pointing back at Layer A vars, so utilities follow the live cascade:

```css
@import "tailwindcss";

/* Layer A: raw tokens (light defaults) */
:root {
  --pennie-beige: rgb(249,246,240);
  --pennie-graphite: rgb(52,52,52);
  --pennie-navy: rgb(29,33,47);
  --pennie-sky: rgb(130,208,255);
  /* …all the rest, copied from colors_and_type.css… */

  --bg: var(--pennie-beige);
  --surface: var(--pennie-white);
  --fg: var(--pennie-graphite);
  --fg-muted: var(--pennie-muted);
  --border: rgba(52,52,52,0.16);
  --accent: var(--pennie-sky);
  --accent-hover: #6dc5f7;
  --focus-ring: rgba(130,208,255,0.45);

  --radius-xs:4px; --radius-sm:8px; --radius-md:10px;
  --radius-lg:12px; --radius-xl:16px; --radius-pill:999px;
  --shadow-xs: 0 0 .858px rgba(0,0,0,.04), 0 1.7px 5.1px rgba(0,0,0,.04), 0 8.6px 17.2px rgba(0,0,0,.04);
  /* …sm/md/lg/pop… */
  --space-1:4px; /* …through --space-15:148px… */
}

/* Layer A (dark scope): flip only the semantic vars. */
[data-theme="dark"] {
  --bg: var(--pennie-navy);
  --surface: var(--pennie-ink-2);
  --fg: var(--pennie-beige);
  --fg-muted: var(--pennie-line-3);
  --border: var(--border-ink);
  /* accent/sky stay the same; focus ring stays sky */
}

/* Dark variant for utilities: drive `dark:` off the data attribute, not the OS. */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

/* Layer B: expose tokens as utilities. `inline` => utilities re-resolve at runtime. */
@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-fg: var(--fg);
  --color-fg-muted: var(--fg-muted);
  --color-border: var(--border);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-focus-ring: var(--focus-ring);
  /* raw brand colors too, for illustration accents */
  --color-pennie-sky: var(--pennie-sky);
  --color-pennie-yellow: var(--pennie-yellow);
  --color-pennie-mint: var(--pennie-mint);
  --color-pennie-navy: var(--pennie-navy);

  --radius-xs: var(--radius-xs); --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md); --radius-lg: var(--radius-lg);
  --radius-xl: var(--radius-xl); --radius-pill: var(--radius-pill);

  --shadow-xs: var(--shadow-xs); --shadow-sm: var(--shadow-sm);
  --shadow-md: var(--shadow-md); --shadow-lg: var(--shadow-lg);

  --font-sans: var(--font-pp-mori);   /* set by next/font/local variable */
}
```

> Note the `--radius-*`/`--shadow-*` "self-referential" lines: inside `@theme inline` the right-hand `var(--radius-xl)` resolves to the Layer A `:root` value, and the left-hand registers the `rounded-xl`/`shadow-xl` utility. (If a name in Layer A and the `@theme` key collide, prefer giving the Layer-A var a distinct private name like `--pn-radius-xl` to avoid ambiguity — see Pitfalls.)

3. **Fonts via `next/font/local` in `layout.tsx`** (replaces Geist):

```tsx
import localFont from "next/font/local";
const ppMori = localFont({
  src: [
    { path: "../fonts/PPMori-Extralight.otf", weight: "200", style: "normal" },
    { path: "../fonts/PPMori-ExtralightItalic.otf", weight: "200", style: "italic" },
    { path: "../fonts/PPMori-Regular.otf", weight: "400", style: "normal" },
    { path: "../fonts/PPMori-RegularItalic.otf", weight: "400", style: "italic" },
    { path: "../fonts/PPMori-SemiBold.otf", weight: "600", style: "normal" },
    { path: "../fonts/PPMori-SemiBoldItalic.otf", weight: "600", style: "italic" },
    // alias 700 -> SemiBold so `font-bold` renders correctly
    { path: "../fonts/PPMori-SemiBold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-pp-mori",
  display: "swap",
  declarations: [{ prop: "font-synthesis", value: "none" }],
});
// <html className={`${ppMori.variable} …`} data-theme="light" suppressHydrationWarning>
```

4. **Theming strategy: `data-theme` attribute (class-like), not OS media query.** The Booker must default to beige/light and honor an explicit theme prop and embed override; OS `prefers-color-scheme` cannot express "default light regardless of OS." Use `data-theme` on a scope element + `@custom-variant dark`. Internal pages add the documented inline-script-in-`<head>` to set `data-theme` from `localStorage` before paint (no flash). The Booker already takes a `theme: "light" | "dark"` prop — set `data-theme` on the Booker's root wrapper from that prop so the scope is local to the widget (critical for the embed, which may differ from the host page).

5. **`.pn-*` classes: keep as-is, do NOT translate to Tailwind `@components`.** They're the design-system source of truth, already reference tokens, and map 1:1 to the previews the redesign verifies against. Use them for typography (`.pn-h1`, `.pn-body`) and the canonical CTA/card recipes; use Tailwind utilities for layout/spacing/one-off styling. Optionally wrap a couple in `@layer components` only if a name needs to be overridable by utilities — not required.

6. **Booker brandColor override stays inline.** The `brandColor` hex is dynamic per host, so it cannot be a build-time token; keep the existing inline `style={{ backgroundColor: brandColor }}` pattern. Layer B is for the static Pennie defaults; brandColor overrides them at the element level.

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Two-layer: raw `:root` tokens + `@theme inline` mapping** (recommended) | Raw `var()`, `.pn-*`, AND utilities all work; theming via live cascade; honors "vars never hex"; previews render identically | Slightly more verbose; must avoid name collisions between Layer A and `@theme` keys | **Recommended** |
| Re-declare every token *inside* `@theme` only (no separate `:root`) | One block | `@theme` can't be nested under `[data-theme]`/`@media`, so per-mode flips are awkward; tokens not meant to be utilities (e.g. `--space-13`, legacy aliases) pollute the utility namespace; harder to keep 1:1 with `colors_and_type.css` | Rejected |
| `@import "./pennie-tokens.css"` (vendored copy of the `:root` block) then `@theme inline` on top | Keeps design-system file pristine/diffable; easy re-sync when DS updates | Must strip the `@font-face` block from the import; one extra file; import-order must be after `@import "tailwindcss"` so cascade/layers are right | **Recommended variant** — vendor the `:root`+`.pn-*` portion as `src/app/pennie.css`, import it, layer `@theme inline` in `globals.css` |
| Import `colors_and_type.css` wholesale (incl. `@font-face`) | Zero edits to DS file | Broken `fonts/` URL paths; double font loading vs `next/font`; pulls `html,body` base rules that may fight Tailwind preflight/Next | Rejected |
| OS `prefers-color-scheme` for dark (current boilerplate) | Simplest | Can't force light-default Booker; can't honor embed/per-widget theme; no user toggle | Rejected for the app; keep only as a fallback default if no `data-theme` is set |

## Pitfalls and Edge Cases

- **`@theme` name collisions.** If Layer A `:root` defines `--radius-xl: 16px` and `@theme inline` also defines `--radius-xl: var(--radius-xl)`, the RHS self-reference resolves to the `:root` value (fine in practice) but is confusing and brittle. Safer: name Layer A privately (`--pn-radius-xl: 16px`) and map `@theme inline { --radius-xl: var(--pn-radius-xl); }`. Same for shadows. (Colors are already cleanly separated: `--pennie-*`/semantic in Layer A → `--color-*` in `@theme`.)
- **`@media (prefers-color-scheme: dark)` cannot live inside `@theme`.** Mode flips go in ordinary `[data-theme]` rules; only the `inline` mapping goes in `@theme`. Confirmed by the directive's "custom-properties-only" constraint.
- **`body { font-family: Arial… }` in current `globals.css` overrides the font var** — must be removed/replaced with `font-family: var(--font-pp-mori), var(--font-sans)` (or just rely on preflight `--font-sans` = `var(--font-pp-mori)`).
- **`font-synthesis: none` is global in the DS.** Apply it (via `declarations` on the font and/or a base rule) or the browser will fake-bold the 400 when `font-bold`/700 is requested on a weight that isn't loaded. We alias 700→SemiBold to cover `font-bold`.
- **OTF vs woff2.** OTFs work with `next/font/local` and are self-hosted/subset by Next at build, but woff2 is ~30-40% smaller. The shipped woff2 webkit is the WRONG cut (Medium present, Extralight absent). If woff2 is desired, convert the canonical OTFs (e.g. `fonttools`/`woff2_compress`) — don't mix in the webkit's Medium. Decision deferred to DISCOVERY (Open Question in brief); OTF-as-shipped is a safe default.
- **Booker uses hardcoded `neutral-*` Tailwind utilities** (`PALETTE` object in `src/components/Booker.tsx`, lines 47-92) — these are NOT token-driven and must be rewritten to Pennie tokens during the per-surface restyle. The palette switch is keyed on the `theme` prop, not `data-theme`; the restyle should reconcile these (e.g. set `data-theme` from the prop and use `bg-bg`/`text-fg`/`bg-accent`/`dark:` utilities).
- **`embedded` Booker theming must be scoped.** Put `data-theme` on the Booker root, not `<html>`, so the iframe/host theme and embed `ui.theme` don't conflict. The embed passes `theme` + `brand` query params (`public/widget.js` line 137).
- **Cloudflare/OpenNext.** All Tailwind work is build-time PostCSS → static CSS; nothing in this approach runs at the edge, so it's fully compatible. `next/font/local` self-hosts fonts as static assets (served by the Worker's asset handler) — no external font fetch at runtime, good for Workers. Avoid the experimental `inlineCss` unless first-load perf demands it (trade-off: kills stylesheet caching for return visitors). Keep `@tailwindcss/postcss` as the only PostCSS plugin; Turbopack reads `postcss.config.mjs` (root already pinned in `next.config.ts`).
- **CSS layer ordering.** `@import "tailwindcss"` establishes `@layer theme, base, components, utilities`. Put the Pennie `:root`/`.pn-*` either unlayered (wins over `base`/preflight as needed) or, if you want utilities to override `.pn-*`, place `.pn-*` in `@layer components`. Keep `@import` of any vendored `pennie.css` immediately after `@import "tailwindcss"`.

## References

- `node_modules/tailwindcss/package.json` — version 4.3.0 (verified)
- `node_modules/tailwindcss/index.css`, `theme.css`, `preflight.css` — `@layer` structure, `@theme default`, default `--color-*/--radius-*/--shadow-*/--text-*/--spacing` namespaces (verified)
- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md` — Tailwind v4 setup, CSS ordering, dev vs prod chunking (verified)
- `node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md` + `…/03-api-reference/02-components/font.md` — `next/font/local`, `src` array, `variable`, `declarations`, `display`, `adjustFontFallback` (verified)
- `node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md` — inline-script `data-theme` set in `<head>` + `suppressHydrationWarning` (verified)
- `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/inlineCss.md` — experimental inline CSS trade-offs (verified)
- `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` — token source of truth (verified, read in full)
- `~/Documents/Pennie Branding/Pennie Design System/README.md` + `SKILL.md` — vars-never-hex rule, weight policy, `.pn-*` inventory (verified)
- Tailwind v4 `@theme` / `@theme inline` / `@custom-variant` mechanics: behavior of the `inline` keyword (utilities re-resolve through live `var()` cascade) and `@custom-variant dark` for data-attribute theming are **recommendations grounded in the directive semantics confirmed against the installed engine**, but the exact `@custom-variant` syntax for the dark variant should be smoke-tested with `pnpm build` during implementation (label: recommendation, verify on first build).

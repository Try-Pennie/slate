---
name: pennie-design-system-in-slate
description: How to apply the Pennie Design System inside the Slate codebase (tokens, fonts, assets, theming). Use when restyling any Slate surface.
---

# Pennie Design System in Slate

How the Pennie Design System maps into Slate's code. Read this before restyling any
surface (Booker, `/book`, manage/reschedule/cancel, admin, me, login, embed). This is
the **project-architecture** layer; the generic `pennie-brand` skill is brand theory.

## Source of truth

The **exported design system** at `~/Documents/Pennie Branding/Pennie Design System/` is
authoritative: `colors_and_type.css` (tokens + `.pn-*` classes), `README.md`, `SKILL.md`,
`assets/`, `preview/*.html`. **It supersedes the markdown `pennie-brand` skill on any
conflict.** On further conflict, `colors_and_type.css` (the CSS) wins over the README prose
(see Pitfalls — the README is stale on pills and field borders).

DISCOVERY.md (`.claude/orchestration-slate-brand-redesign/DISCOVERY.md`) is the top authority
for *this redesign* and overrides everything below where they differ.

**Golden rule: use CSS variables, never hex.** `background: var(--accent)`, not `#82D0FF`.
The only allowed literal exceptions are documented below (embed host-page chrome; the
`check-badge` tick; the favicon fill) — places where the cascade can't reach.

Verified stack: **Tailwind 4.3.0** (CSS-config, no `tailwind.config.js`), **Next 16.2.7**
(App Router), OpenNext 1.19.11 on Cloudflare Workers. All token work is build-time PostCSS,
fully CF-compatible.

---

## 1. The token system

All of these come from `colors_and_type.css`. Port them; don't reinvent them.

### Raw brand colors (`--pennie-*`) — canonical
| Token | Value | Role |
|---|---|---|
| `--pennie-white` | `rgb(255,255,255)` | Surface; text on dark |
| `--pennie-beige` | `rgb(249,246,240)` | Main background |
| `--pennie-graphite` | `rgb(52,52,52)` | Primary text |
| `--pennie-navy` | `rgb(29,33,47)` | Hero/footer bands |
| `--pennie-sky` | `rgb(130,208,255)` | **The only action color** |
| `--pennie-sky-soft` | `rgb(236,248,255)` | Sky wash / puck fill |
| `--pennie-sky-deep` | `rgb(67,159,225)` | Deep sky (NOT for press fill — see a11y) |
| `--pennie-blue` | `rgb(72,108,202)` | `#486CCA` — blue TEXT on light |
| `--pennie-yellow` / `--pennie-yellow-2` | `rgb(255,208,115)` / `rgb(255,150,111)` | Illustration only |
| `--pennie-mint` / `--pennie-green` / `--pennie-green-deep` | mint / `rgb(85,207,144)` / `rgb(0,182,122)` | Illustration / success |
| `--pennie-muted` | `rgb(106,106,112)` | Secondary text (don't lighten — AA edge) |
| `--pennie-mercury` | `rgb(227,227,229)` | Strokes / outlines |

Legacy aliases (`--pennie-cream`→beige, `--pennie-ink`→navy, `--pennie-charcoal`→graphite,
`--pennie-cream-2/3`, `--pennie-ink-2`, `--pennie-line/-2/-3`) resolve to the same colors so
older markup renders. Prefer canonical names in new work.

### Semantic tokens (these are what you actually style with)
`--bg` `--bg-alt` `--bg-ink` · `--surface` `--surface-elevated` · `--fg` `--fg-strong`
`--fg-muted` `--fg-on-ink` `--fg-on-sky` · `--border` (`rgba(52,52,52,0.16)`) `--border-soft`
`--border-ink` · `--accent` (sky) `--accent-hover` (`#6dc5f7`) `--accent-press` (sky-deep) ·
`--focus-ring` (`rgba(130,208,255,0.45)`).

Light defaults: `--bg`=beige, `--surface`=white, `--fg`=graphite. Dark flips the **semantic**
vars only (`--bg`→navy, `--surface`→ink-2, `--fg`→beige, `--border`→border-ink); accent and
focus ring stay sky.

### Radii — `--radius-*`
`xs 4px` · `sm 8px` · `md 10px` · `lg 12px` · `xl 16px` · `pill 999px`.

### Shadows — `--shadow-*` (always soft; never hard black)
`xs` (default card) · `sm` · `md` (menu/popover) · `lg` · `pop` (`0 12px 32px rgba(29,33,47,0.18)`, modals).

### Spacing — `--space-1..15`
`4, 8, 10, 12, 16, 20, 24, 32, 40, 56, 64, 80, 104, 120, 148` px. Snap to these.

### Type tokens
`--font-sans` (PP Mori stack) · `--font-display` (=sans). Weights `--fw-regular 400`,
`--fw-semibold 600`, `--fw-bold 600` (bold aliases to semibold), `--fw-extralight 200`
(declared, unused — skip). Sizes `--fs-display 50` `--fs-h1 40` `--fs-h2 32` `--fs-h3 26`
`--fs-h4 22` `--fs-lead 20` `--fs-body 16` `--fs-small 14` `--fs-xs 12`. Line-heights
`--lh-tight..loose`, tracking `--tracking-tight -0.02em`.

### Base classes — `.pn-*` (compose these, don't translate to Tailwind)
- **Buttons:** `.pn-btn` + size (`.pn-btn--big` 56px/16px-radius, `.pn-btn--small` 40px/12px-radius)
  + variant (`.pn-btn--primary` sky fill + graphite label, `.pn-btn--additional` outlined,
  `.pn-btn--link` text-only). Primary CTAs advancing a flow get an arrow icon.
- **Card:** `.pn-card` (white surface, `--radius-md`, `--shadow-xs`, `--space-5` padding).
- **Type:** `.pn-display` `.pn-h1` `.pn-h2` `.pn-h3` `.pn-h4` `.pn-lead` `.pn-body`
  `.pn-body-bold` `.pn-small` `.pn-small-bold` `.pn-eyebrow`. One display per screen.

Keep `.pn-*` as-is (they reference tokens and map 1:1 to the previews verification compares
against). Use Tailwind utilities for layout/spacing/one-offs.

---

## 2. Wiring tokens into Slate — the two-layer "import-then-map"

`globals.css` only. Tailwind v4 is CSS-configured; there is no config file.

**Layer A — raw token plumbing (plain `:root`, NOT `@theme`).** Port the `:root` block from
`colors_and_type.css` (or vendor it as `src/app/pennie.css` and `@import` it right after
`@import "tailwindcss"`): all `--pennie-*`, semantic, `--radius-*`, `--shadow-*`, `--space-*`,
type vars, plus the `.pn-*` classes. This makes raw `var(--…)` and `.pn-*` render identically
to the DS previews. Then flip **semantic vars only** in a `[data-theme="dark"]` rule.

**Layer B — `@theme inline` mapping (utilities).** Re-expose the semantic + scale tokens as
Tailwind tokens pointing back at Layer A, so utilities re-resolve through the live cascade:
`--color-bg: var(--bg)`, `--color-fg: var(--fg)`, `--color-accent: var(--accent)`,
`--radius-xl: var(--radius-xl)`, `--shadow-md: var(--shadow-md)`, `--font-sans: var(--font-sans)`,
etc. The `inline` keyword is **load-bearing** — without it, utilities freeze the build-time
value and theming breaks. Keep `inline`.

**Theming = `data-theme` attribute + `@custom-variant dark`, NOT the OS media query.**
```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```
OS `prefers-color-scheme` can't express "Booker defaults to light regardless of OS," can't
honor an embed/per-widget theme, and gives no user toggle. Booker sets `data-theme` on its own
root wrapper from its `theme` prop (scopes the embed independently of the host). Internal pages
use the documented Next 16 inline-`<head>`-script pattern to set `data-theme` from
`localStorage` before paint (`suppressHydrationWarning` on `<html>`).

Notes / gotchas:
- `@theme` can't be nested under `@media`/`[data-theme]` (custom-properties only). Mode flips
  live in ordinary `[data-theme]` rules; only the mapping goes in `@theme inline`.
- Self-referential `--radius-xl: var(--radius-xl)` resolves fine but is brittle; if it confuses
  the build, give Layer A a private name (`--pn-radius-xl`) and map from that.
- Remove the boilerplate `body { font-family: Arial… }` (it overrides the font var) and the
  `@media (prefers-color-scheme: dark)` block. Drop Geist + `--font-geist-*`.
- Tokens not in `@theme` (legacy aliases, `--space-13`) still work as raw `var()`; they just
  get no utility. That's intended.

---

## 3. Fonts — PP Mori via `next/font/local`

- **Ship the LICENSED woff2 web kit only**, weights **400 + 600**, with **700 aliased to 600**
  (point a third `src` entry at the SemiBold file), `font-synthesis: none`. This is the same kit
  trypennie ships in production. The `.pn-*` system only uses 400/600, so nothing is lost.
- **Do NOT ship the design-system OTFs** (`Pennie Design System/fonts/*.otf`) — they are the
  Free-For-Personal-Use desktop cut; the EULA forbids commercial web use. **Do NOT ship Medium
  500 or Bold 700** from the kit (no Medium per brand rule; 700 aliases to 600). No Extralight,
  no italics on web (only exist in the unlicensed OTFs).
- **Do NOT paste the DS `@font-face` block** — `next/font/local` generates it. Only port the
  *token* lines (`--font-sans`, `--font-display`, `--fw-*`, `--fs-*`) and the global
  `font-synthesis: none` rule.
- Wiring: `src/app/fonts/pp-mori.ts` calls `localFont({ variable: "--font-pp-mori", ... })`;
  `layout.tsx` puts `ppMori.variable` on `<html>`; `globals.css` sets
  `--font-sans: var(--font-pp-mori), -apple-system, …` so `.pn-*`, the Tailwind `font-sans`
  utility, and the body default all resolve to PP Mori from one source. Keep `display: "swap"`.
  Self-hosts at build time → fully CF/OpenNext-safe.

---

## 4. Color usage rules

- **80/15/5.** Beige/white surfaces dominate (~80%); navy for occasional hero/stat/footer bands;
  graphite text (~15%); sky accents only where action lives (~5%).
- **Sky is the ONLY action color.** Primary CTA = **sky fill + graphite label** (`--fg-on-sky`).
  Secondary = beige/white outline. Never a second colored fill on one screen.
- **Yellow / mint / peach = illustration, sticky-notes, testimonials only — never CTAs.**
- **No hard black** (`#000`). Use navy or graphite. **No hard black drop shadows** — `--shadow-*`.
- **Errors** = muted rose `#C43D3D` on a 12% tint, never bright pure red.
- **Blue TEXT/icons on light** must be `--pennie-blue` (`#486CCA`) — sky/sky-deep fail contrast
  as text on light. Sky is for *fills* (CTA), not text.

### Contrast must-knows (from DISCOVERY D17, verified math)
- Graphite on sky = 7.36:1 PASS — no darker sky needed for the CTA.
- **White-on-sky CTA FAILS AA** — label must be graphite, not white.
- Pressed CTA: cap fill at `--accent-hover` `#6dc5f7` (6.51:1); signal press via `translateY`,
  not a darker fill (sky-deep `#439FE1` = 4.32:1 FAIL).
- **Focus ring is theme-aware**: 2px graphite outline on light, 2px sky outline on navy. The sky
  glow stays decorative box-shadow only (sky ring on light = 1.57:1 FAIL).
- Selected day / best-match: pair color with a non-color cue (text/icon/shape) — emerald dots
  alone fail (2.54:1 + color-only).

---

## 5. Shape rules

- **Buttons & cards = 16px** (`--radius-xl` / `--radius-md` per shipped CSS). **NOT pills** —
  the README's "pill button" wording is **stale; the CSS wins.**
- **Pills (999px) for badges only.** Chips/tags = 4px (`--radius-xs`). Large bands = 24px.
- Shadows always `--shadow-*` (soft); never a hard black drop shadow.

---

## 6. Asset locations (once vendored into the repo)

| Asset | Repo destination | Consumption |
|---|---|---|
| Fonts (`PPMori-Regular.woff2`, `PPMori-SemiBold.woff2`) | `src/app/fonts/PPMori/` | `next/font/local` (must be under `src/`, not `public/`) |
| Wordmark logos (charcoal, cream, `-lg-` variants, mark) | `public/brand/` | concrete-fill SVG via `<img>` |
| UI icons | `src/components/icons/*.tsx` (+ `index.ts` barrel) | **inline React `<svg>`** (currentColor) |
| Confirmation graphic `pic-1` (coins) | `public/brand/` | standalone confirmation page only |
| Login marketing art (1 illustration, if used) | `public/brand/login-art.png` | login panel (D12) |
| Favicon | `src/app/icon.svg` (Pennie mark, baked concrete fill) | Next `icon` convention |
| Apple icon | `src/app/apple-icon.png` or `apple-icon.tsx` ImageResponse | SVG not allowed here |

**Icons MUST be inline `<svg>` React components, never `<img>`** — `<img>` can't inherit
`currentColor`, which breaks the entire DS icon tint model. Each component spreads
`React.SVGProps<SVGSVGElement>` and keeps `fill/stroke="currentColor"`; color comes from the
parent (`text-*` util or `var(--fg-muted)`). Hand-author them (no SVGR/SVGO installed); the DS
SVGs are single-path and clean. Logos (concrete-fill) are the only SVGs safe to load via `<img>`.

**Logo variant per background:** `logo-pennie-charcoal.svg` on light (cream/white/sky);
`logo-pennie-cream.svg` on navy/ink; `-lg-` variants in footers; `logo-mark.svg` for compact/
favicon. For a single element that flips with the theme, inline `logo-pennie.svg` (currentColor)
as a `Wordmark` component.

**Delight split (D16):** standalone confirmation page → `pic-1` iridescent coins PNG; **embed
iframe → inline `CheckBadgeIcon`/`SmileIcon` in a sky-soft puck** (zero image weight; the iframe
is latency-sensitive). Branch on the `embedded` flag. Animate **opacity/transform only** —
height animation trips the embed's ResizeObserver `slate:resize`. Honor `prefers-reduced-motion`.

Cleanup: delete the unused `public/slate-logo.png` (1.2 MB) and old `src/app/icon.png` (290 KB).
The `check-badge.svg` tick is a hardcoded `#F9F6F0` (designed-in on-puck contrast, not a token
miss) — keep the literal; color the circle via `currentColor`.

---

## 7. Voice rules (user-facing copy)

- **Button copy is a verb phrase**: "View my offers", "Get loan offer", "Continue". Never
  "Submit" / "Click here".
- **Optimistic, warm, plain English.** Lead with the outcome. Numbers over adjectives.
- **Always disclose rates** (APR + term; "As of <month>"). **Never guarantee** ("guaranteed
  approval"). No fear-based or crypto-bro hype copy. No jargon (say "monthly payment", not
  "amortized principal").
- Slate-specific: no dashes/em-dashes in user-facing copy; never name the secret platform
  "Cadence" in UI. Confirmation copy is warm and concrete ("You're booked! Sarah will call you
  Thursday at 2:00.").

---

## 8. Common pitfalls

- **README-vs-CSS drift — CSS always wins.** README says pill buttons (CSS = 16px); README says
  form fields have a border (the shipped recipe leans on shadow). When prose and
  `colors_and_type.css` disagree, follow the CSS.
- **`Booker.tsx` hardcodes a `PALETTE` of `neutral-*` Tailwind classes** (~lines 47–92), keyed on
  the `theme` prop, NOT token-driven. Rewrite it token-driven (`bg-bg`/`text-fg`/`bg-accent` +
  `data-theme` set from the prop). It also defaults to `theme="dark"` (~line 124) — **flip to
  light** (Booker is beige-first).
- **Status colors live in JSX ternaries** in admin/me (and similar) components — `grep` for them.
  They will NOT be caught by a globals.css token swap; convert each to semantic/Pennie tokens.
- **White-on-sky CTA fails AA** — label graphite, not white. (See §4.)
- **Don't import the DS `@font-face` block** or the DS `html,body` base rules wholesale (broken
  font paths, double-load, fights Tailwind preflight).
- **Embed host-page chrome can't read `--pennie-*` vars** (different document/no stylesheet) — in
  `widget.js` use LITERAL values: white modal, 16px radius, `--shadow-pop` navy shadow, navy scrim
  `rgba(29,33,47,0.55)`, sky focus ring. Keep `widget.js` vanilla/dependency-free and the cal.com
  contract intact.

---

## 9. Verification

Per surface: screenshot both themes (Playwright MCP) and compare to DS `preview/*.html`; run
axe-core + Lighthouse; emulate `prefers-reduced-motion`; `pnpm build` + `pnpm lint` + `pnpm test`
green; booking flow works E2E; embed drop-in contract intact. No stray hex (grep). See
`.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` for the
full toolchain and the contrast script (`scripts/test-contrast.ts`, recommended to commit as a
permanent guard) that asserts the D17 contrast pairings.

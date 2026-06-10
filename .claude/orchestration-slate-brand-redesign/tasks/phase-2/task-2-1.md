# Task 2.1: Token-drive the Booker palette + flip default to light

## Objective

Replace `Booker.tsx`'s hardcoded `neutral-*` Tailwind `PALETTE` object with token-driven
styling that reads the Pennie semantic tokens (`--bg`, `--surface`, `--fg`, `--fg-muted`,
`--border`, `--accent`, `--focus-ring`) ported in Phase 1, and flip the component's default
theme from `dark` to `light` so the Booker renders beige-first per DISCOVERY D10. This is the
foundational Booker restyle that 2.2/2.3/2.4/2.5 build on. **Visual-only: no props, state,
fetch, or embed-contract logic changes.**

## Context

The Booker is the highest-visibility consumer surface (a borrower booking a call). Today it
defaults to a neutral-gray dark theme that reads nothing like trypennie.com. Phase 1 landed the
full Pennie token system in `src/app/globals.css` (raw `--pennie-*` + semantic vars + `.pn-*`
classes + `@theme inline` Tailwind utilities + `data-theme` theming + PP Mori). This task wires
the Booker to that system at the palette level and establishes beige-as-default. Tasks 2.2
(calendar/slots), 2.3 (form/CTA), 2.4 (confirmation delight), and 2.5 (manage) all assume this
token-driven `PALETTE` shape and the light default are already in place.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| `src/components/Booker.tsx` | [code] | Rewrite `PALETTE` object to token-driven classes; flip `theme` default to `light`; reconcile `data-theme` with the `theme` prop |
| `src/app/book/page.tsx` | [code] | Flip the embed entry theme default from `dark` to `light` |
| `/book?xbc=411` (both themes) | [browser] | Verify beige default + dark still correct |

## Dependencies

- Phase 1 (all of 1.1–1.5, gated by 1.V) — provides the ported token layer in `globals.css`
  (semantic vars, `.pn-*` classes, `@theme inline` utilities like `bg-bg`/`text-fg`/`bg-accent`),
  PP Mori, the `data-theme` light/dark mechanism, and `@custom-variant dark`.

## Blocked By

- Task 1.V (Phase 1 Verification Sweep)

## Research Findings

Key findings relevant to this task:

- From `booker-ux-patterns.md`: The **recommended approach is to keep the `PALETTE` two-key
  (`light`/`dark`) object shape and swap only the VALUES to Pennie tokens** — this is zero
  logic/prop change, keeps the embed `theme` prop and `brandColor` override working untouched,
  and is the smallest diff. (Ripping out `PALETTE` for pure `data-theme`/CSS-vars was explicitly
  *rejected* this pass as touching too many lines.)
- From `booker-ux-patterns.md`: The shell should become a `.pn-card`-style surface — `background:
  var(--surface)`, soft `--shadow-*` (not a hard border), beige page behind it. Dark theme maps to
  `--bg-ink`/navy, text `--fg-on-ink`/beige, panels `--pennie-ink-2`. Panel dividers: `--border`
  on light, `--border-ink` on dark (replace `border-neutral-800/200`).
- From `wcag-accessibility.md`: Light defaults are `--bg`=beige, `--surface`=white, `--fg`=graphite;
  dark flips the **semantic** vars only; accent + focus ring stay sky. Muted-on-beige passes only
  at 4.98:1 — never lighten `--fg-muted`.
- From `pennie-design-system-in-slate` SKILL §8 Pitfalls: `Booker.tsx` hardcodes a `PALETTE` of
  `neutral-*` classes (~47–92), keyed on `theme`, NOT token-driven; rewrite token-driven and flip
  the `theme="dark"` default (~124) to light. **80/15/5 discipline** — reserve solid sky for the
  CTA (2.3); use `--pennie-sky-soft` washes elsewhere; don't sky-tint everything here.
- From `slate-embed-contract` SKILL (D10): trypennie sends **no `ui.theme`**, so whatever the
  default is renders for the real integration. Flip the default to light in BOTH `/book/page.tsx`
  and the `Booker` prop default. The host can still override via the `theme` param; param plumbing
  is untouched.

## Current State (exact references — read before editing)

`src/components/Booker.tsx`:
- **`PALETTE` object: lines 47–92.** Two keys `dark` (48–69) and `light` (70–91), each a flat map
  of `neutral-*` Tailwind class strings: `shell`, `border`, `title`, `muted`, `faint`, `body`,
  `avatar`, `dayOn`, `dayOff`, `daySelected`, `ring`, `slot`, `input`, `toggleBorder`, `toggleOn`,
  `toggleOff`, `navHover`, `skeleton`, `confirm`, `backHover`.
- **`theme = "dark"` default: line 124** (in the `Booker({ ... })` destructure). Also documented in
  the prop JSDoc at line 19 ("Defaults to dark.").
- **`const c = PALETTE[theme];` line 129** — the selected palette object used throughout.
- **brandColor inline overrides: lines 132–134** — `dotStyle` (2.2 dots), `ringStyle` (2.2
  selected-day ring), `confirmStyle` (avatar fill + CTA). `confirmStyle` forces `color: "#fff"`
  (line 134) — **this white-on-sky bug is fixed in 2.3, not here**; leave the brandColor inline
  mechanism intact so downstream tasks keep working.
- **`shell` string: line 261** — `mx-auto max-w-4xl overflow-hidden rounded-2xl border ${c.shell}`.
  Note the `overflow-hidden` (clips focus outlines — flagged for 2.2/4.4) and `rounded-2xl border`
  (should become shadow-led, not border-led).
- **`data-theme` is NOT currently set on the Booker root.** The root `<div ref={rootRef}>` is at
  line 265 (confirmed view) and line 283 (main view). To make the ported tokens resolve correctly
  per theme inside the Booker subtree (independent of the host page), set `data-theme={theme}` on
  the Booker root wrapper so the `[data-theme="dark"]` semantic flips apply inside the component.

`src/app/book/page.tsx`:
- **Line 55:** `theme={first(sp, "theme") === "light" ? "light" : "dark"}` — this forces dark
  unless `theme=light` is explicitly passed. **Flip to light-default**: light unless `theme=dark`
  is explicitly passed (e.g. `theme={first(sp, "theme") === "dark" ? "dark" : "light"}`).
- `src/app/booking/[id]/page.tsx` does NOT pass a `theme` prop (it relies on the Booker default),
  so flipping the `Booker` prop default to `"light"` covers that entry automatically — verify, do
  not add a prop unless needed.

## Execution Plan

### Step 1: Read the ported token layer

**Surface:** [code]

- Read `src/app/globals.css` to confirm which semantic vars and `.pn-*` classes + `@theme inline`
  Tailwind utilities Phase 1 actually shipped. Confirm the utility names available (expected from
  the SKILL: `bg-bg`, `bg-surface`, `text-fg`, `text-fg-muted`, `bg-accent`, `border-border`,
  `rounded-xl`/`rounded-md`, `shadow-xs`, etc., plus `data-theme` flipping the semantic vars and
  `@custom-variant dark`). If a utility you need is missing, prefer raw `var(--…)` via inline
  style or an arbitrary Tailwind value (`bg-[var(--surface)]`) rather than re-adding `neutral-*`.
- Read `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` for the canonical
  semantic token names and the `.pn-card` recipe to mirror.

**Verification:**
- Confirm (Read) that `--bg`, `--surface`, `--fg`, `--fg-muted`, `--border`, `--border-ink`,
  `--accent`, `--accent-hover`, `--focus-ring`, `--pennie-sky-soft`, `--pennie-ink-2` all resolve
  in `globals.css`, and that `[data-theme="dark"]` flips the semantic ones.

### Step 2: Rewrite the `PALETTE` object (lines 47–92) to token-driven classes

**Surface:** [code]

- Keep the EXACT two-key shape (`dark` / `light`) and the EXACT same key names so nothing
  downstream breaks. Only change the values from `neutral-*` strings to Pennie-token classes.
- Recommended mappings (use Tailwind `@theme` utilities where they exist; fall back to
  `bg-[var(--token)]` arbitrary values otherwise). Because Phase 1 sets `data-theme` to flip the
  semantic vars, **you can drive most keys from the same semantic-token class in both themes** and
  let `[data-theme]` do the flipping — but keep both keys populated for clarity and for the few
  values that differ (e.g. ring color, skeleton wash). Suggested values:

  | Key | light | dark | Notes |
  |---|---|---|---|
  | `shell` | `bg-surface text-fg` | `bg-surface text-fg` | semantic vars flip via `data-theme`; shadow added in Step 4 |
  | `border` | `border-border` | `border-border` | `--border` flips to `--border-ink` under dark |
  | `title` | `text-fg` | `text-fg` | graphite light / beige dark |
  | `muted` | `text-fg-muted` | `text-fg-muted` | never lighten muted (4.98:1 guard) |
  | `faint` | `text-fg-muted` | `text-fg-muted` | reuse muted; do NOT introduce a lighter-than-muted text token (AA) |
  | `body` | `text-fg` | `text-fg` | |
  | `avatar` | `bg-[var(--pennie-sky-soft)] text-fg` | `bg-[var(--pennie-ink-2)] text-fg` | sky-soft wash, graphite initials (NOT solid sky — 80/15/5) |
  | `dayOn` | `text-fg hover:bg-[var(--pennie-sky-soft)]` | `text-fg hover:bg-[var(--pennie-ink-2)]` | calendar polished in 2.2 |
  | `dayOff` | `cursor-default text-fg-muted opacity-50` | `cursor-default text-fg-muted opacity-50` | 2.2 refines |
  | `daySelected` | `bg-[var(--pennie-sky-soft)]` | `bg-[var(--pennie-ink-2)]` | 2.2 adds non-color cue |
  | `ring` | `ring-[var(--accent)]` | `ring-[var(--accent)]` | default ring = sky (2.2 finalizes) |
  | `slot` | `bg-surface border-border text-fg` | `bg-surface border-border text-fg` | 2.2 finalizes hover |
  | `input` | `bg-surface text-fg` | `bg-surface text-fg` | 2.3 finalizes field recipe |
  | `toggleBorder` | `border-border` | `border-border` | 2.2 finalizes |
  | `toggleOn` | `bg-[var(--pennie-sky-soft)] text-fg` | `bg-[var(--pennie-ink-2)] text-fg` | 2.2 finalizes |
  | `toggleOff` | `text-fg-muted` | `text-fg-muted` | |
  | `navHover` | `hover:bg-[rgba(52,52,52,0.04)]` | `hover:bg-[var(--pennie-ink-2)]` | 2.2 enlarges targets |
  | `skeleton` | `bg-[var(--pennie-wild-sand)]` | `bg-[var(--pennie-ink-2)]` | beige shimmer; if `--pennie-wild-sand` not ported, use `bg-[var(--pennie-cream-3)]` or `bg-[var(--bg-alt)]` |
  | `confirm` | `bg-accent text-fg` | `bg-accent text-fg` | sky fill + graphite label; 2.3 finalizes the `.pn-btn` recipe + arrow |
  | `backHover` | `hover:text-fg` | `hover:text-fg` | |

- IMPORTANT: do NOT introduce raw hex. Use token vars only. The one allowed literal is the
  `rgba(52,52,52,0.04)` light nav hover IF an equivalent token wash is not present; prefer a token.
- Leave the `confirm` label as graphite (`text-fg`) — the white-on-sky fix is formally completed in
  2.3, but set graphite here so you never reintroduce white-on-sky.

**Verification:**
- [code] `pnpm build` exits 0. [file] `grep -n "neutral-" src/components/Booker.tsx` returns no
  matches inside the `PALETTE` object (some may remain elsewhere until 2.2/2.3 — note them, but the
  PALETTE itself must be neutral-free).

### Step 3: Flip the default theme to light + set `data-theme` on the Booker root

**Surface:** [code]

- `Booker.tsx` line 124: change `theme = "dark"` to `theme = "light"`. Update the JSDoc at line 19
  from "Defaults to dark." to "Defaults to light." (visual/comment only).
- Set `data-theme={theme}` on the Booker root wrapper(s) so the `[data-theme="dark"]` semantic
  flips apply inside the component subtree regardless of the host/page `data-theme`. Apply to BOTH
  the confirmed-view root (line 265) and the main-view root (line 283). Do not remove `ref={rootRef}`
  (load-bearing for the embed ResizeObserver).
- `src/app/book/page.tsx` line 55: flip to light-default —
  `theme={first(sp, "theme") === "dark" ? "dark" : "light"}`.

**Verification:**
- [code] `pnpm build` exits 0; `pnpm lint` clean.
- [browser] After the dev server is up, `/book?xbc=411` (no theme param) renders beige/light;
  `/book?xbc=411&theme=dark` renders navy/dark.

### Step 4: Shadow-led shell (replace border-led look)

**Surface:** [code]

- Line 261 `shell` string: keep `mx-auto max-w-4xl rounded-2xl` but replace the hard `border
  ${c.shell}` border-led look with a soft shadow per `.pn-card`. Suggested:
  `mx-auto max-w-4xl rounded-xl bg-surface text-fg shadow-[var(--shadow-xs)]` (or the `shadow-md`
  Tailwind token if Phase 1 exposed `--shadow-*` as utilities). Keep `overflow-hidden` for now if
  removing it would change layout — BUT note in PROGRESS.md that `overflow-hidden` clips focus
  outlines on edge-adjacent controls (month nav, last calendar column); 4.4 resolves it (use
  `box-shadow` rings there or relax the clip). Do not break the rounded corners or max-width.
- Place the shell on a beige page surface where the page wrapper allows (the page background is set
  by `globals.css` body/`--bg`; do not force a second background here unless needed).

**Verification:**
- [browser] Screenshot `/book?xbc=411&theme=light` and confirm a white card on a beige page with a
  soft shadow (no hard 1px gray border). Dark theme shows navy surfaces.

## Artifacts to Modify

- `src/components/Booker.tsx` — rewrite `PALETTE` (47–92) to token-driven; flip default `theme`
  (124) + JSDoc (19); set `data-theme={theme}` on roots (265, 283); shadow-led `shell` (261) — [code]
- `src/app/book/page.tsx` — flip theme default (line 55) — [code]

## Contracts

### Provides (for downstream tasks)

- Token-driven `PALETTE` object (same two-key `light`/`dark` shape, same key names) — consumed by
  2.2 (calendar/slot keys), 2.3 (input/confirm keys), 2.4 (shell/confirm view), 2.5 follows the
  same token conventions.
- `data-theme={theme}` on the Booker root — downstream tasks rely on `[data-theme]` flipping
  semantic vars inside the subtree.
- Beige/light default established — 2.4 brandColor default + 2.V verification assume it.
- brandColor inline override mechanism (`dotStyle`/`ringStyle`/`confirmStyle`) left intact for 2.2
  (dots/ring) and 2.4 (default-sky brandColor); the white-on-sky `confirmStyle` color fix is
  delegated to 2.3.

### Consumes (from upstream tasks)

- Phase 1 `globals.css`: semantic tokens, `.pn-*`, `@theme inline` utilities, `data-theme`
  mechanism, `@custom-variant dark`, PP Mori — this task styles entirely against them.

## Acceptance Criteria

- [ ] Booker renders beige/light by DEFAULT (`/book?xbc=411` with no theme param).
- [ ] `&theme=dark` still renders a correct navy/dark Booker (semantic vars flipped via `data-theme`).
- [ ] The `PALETTE` object contains NO `neutral-*` literals and NO raw hex (token vars only).
- [ ] Component default `theme` is `light` (line 124) and `/book/page.tsx` defaults to light (55).
- [ ] No prop, state, fetch, ResizeObserver, or embed-param logic changed (visual-only).
- [ ] `pnpm build` exits 0, `pnpm lint` clean.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` → expect exit 0.
- Run: `pnpm lint` → expect clean.
- Run: `grep -n "neutral-" src/components/Booker.tsx` → no matches within the `PALETTE` block
  (lines ~47–92). Record any remaining `neutral-`/`emerald-`/`red-` elsewhere as deferred to
  2.2/2.3.

#### [browser] Web Verification
Start dev server in the background and warm routes per `slate-ui-verification` §2:
```bash
cd /Users/danhankins-wright/Documents/Slate && pnpm dev   # run_in_background: true
until curl -sf -o /dev/null http://localhost:3000/book?xbc=411; do sleep 1; done; echo up
```
- Navigate `http://localhost:3000/book?xbc=411` (NO theme param). Snapshot + screenshot →
  `reports/screens/book-light-desktop.png`. Confirm: beige/white surfaces, graphite text, white
  card on beige with soft shadow, PP Mori loaded.
- Navigate `http://localhost:3000/book?xbc=411&theme=dark`. Screenshot →
  `reports/screens/book-dark-desktop.png`. Confirm: navy surfaces, beige/white text, no
  `neutral-gray` look.
- Navigate `http://localhost:3000/booking/seed-test?xbc=411` (path entry, no theme prop passed) →
  confirm it ALSO defaults to beige/light (proves the prop default flip covers this entry).

### Cross-Surface Coherence
- The same token-driven palette must render identically whether reached via `/book` (embed entry)
  or `/booking/[id]` (path entry); both default to light.

## Skills to Read

- `pennie-design-system-in-slate` — token names, semantic vars, `.pn-card` recipe, 80/15/5, the
  exact `PALETTE`/`theme="dark"` pitfall callout, two-layer token wiring.
- `slate-ui-verification` — surface→URL matrix (`xbc=411`), dev-server warmup, screenshot naming,
  acceptance gate.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/booker-ux-patterns.md` — Booker anatomy,
  per-state token mapping, the "keep PALETTE two-key shape, swap values" recommended approach.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — semantic defaults,
  muted-on-beige guard, theme-aware contrast.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
`~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md`

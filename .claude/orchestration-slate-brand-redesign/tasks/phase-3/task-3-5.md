# Task 3.5: Restyle the landing page

## Objective

Restyle `src/app/page.tsx` (the `/` landing stub) to the Pennie system: a single beige hero with
the charcoal Pennie logo, one display heading, a warm `.pn-lead` description, and two buttons — sky
primary ("Admin", with arrow) + outlined secondary ("Embed demo"). Visual-only; both themes via the
inherited `data-theme`.

## Context

`/` is a 27-line internal/dev-facing stub: centered `<h1>Slate</h1>`, one muted paragraph, and two
links — "Admin" (`bg-neutral-900`) and "Embed demo" (outlined → `/embed-example.html`). It is a
public, auth-free page. Keep it minimal but on-brand — a single beige hero, not a full marketing
page. The two `href`s are functional and stay (`/admin`, `/embed-example.html`).

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash / Read / Write / Edit | Reskin the hero + two buttons to Pennie tokens |
| Browser | Playwright MCP | Screenshot both themes; axe (public page — no auth blocker) |

## Dependencies

- Phase 1 (gated by 1.V) - tokens, `.pn-*`, `data-theme` + no-flash script, PP Mori, vendored
  `public/brand/logo-pennie-charcoal.svg` (+ `logo-mark.svg`), `arrow-right` inline icon.

## Blocked By

- 1.V

## Research Findings

- From `internal-pages-execution.md` (LANDING — clean branded version):
  - `bg-bg` (beige) centered column, `max-w-2xl`.
  - Logo (`logo-pennie-charcoal.svg`, charcoal-on-beige) + optional mark at top, `alt="Pennie"`.
  - `.pn-h1`/`.pn-display` "Slate" (**one display per screen** — README §2.2) + `.pn-lead
    text-fg-muted` keeping the current product description (lines ~7–10), warmed to Pennie voice
    (it already reads on-brand: "Availability aware booking for Pennie…").
  - Two actions: "Admin" → `.pn-btn .pn-btn--big .pn-btn--primary` (sky + arrow, `href="/admin"`);
    "Embed demo" → `.pn-btn .pn-btn--big .pn-btn--additional` (outlined,
    `href="/embed-example.html"`). Replace the `bg-neutral-900` / `border-neutral-300` buttons.
  - Optional: one small iridescent graphic or sticky-note for warmth (one, calm) — optional, skip
    by default to stay calm.
  - Light + dark via `data-theme` (inherits); no per-page dark code.
- From `wcag-accessibility.md`: graphite-on-sky 7.36:1 PASS (primary), graphite-on-beige 11.54:1
  PASS; logo `<img>` needs `alt`; arrow icon `aria-hidden`; 44px+ targets (`--big` = 56px);
  theme-aware focus inherited. Keep one logical `<h1>`.
- From `DISCOVERY.md` / `slate-copy-rules`: no em/en dashes in copy; never name "Cadence". The
  current copy mentions "webhooks for Regal" — that is acceptable (Regal is named in the brief);
  do not introduce "Cadence". Keep copy minimal and on-brand.
- This is a `Link`/`<a>` page; use `next/link` for internal `/admin`, plain `<a>` for the static
  `/embed-example.html` (it already does — keep that distinction).

## Execution Plan

### Step 1: Orient

**Surface:** [code]

- [code] Read `src/app/page.tsx` (27 lines). Note the two `href`s (`/admin` via `Link`,
  `/embed-example.html` via `<a>`) — keep both exactly.
- [code] Confirm `public/brand/logo-pennie-charcoal.svg` and the `arrow-right` icon component exist
  (Phase 1.1/1.4).

**Verification:**
- [code] Assets present; hrefs identified.

### Step 2: Reskin the hero + buttons

**Surface:** [code]

- [code] Wrap the content in a beige centered column (`bg-bg`, `max-w-2xl`, centered, comfortable
  vertical padding / `min-h-[100dvh]`). Add the charcoal logo at top (`/brand/logo-pennie-charcoal.svg`,
  `alt="Pennie"`). Heading → `.pn-h1`/`.pn-display` "Slate" (one display only). Description →
  `.pn-lead text-fg-muted`, keep the current sentence (no dashes; no "Cadence").
- [code] Buttons: "Admin" → `<Link href="/admin" className="pn-btn pn-btn--big pn-btn--primary">`
  with the `arrow-right` icon (`aria-hidden`). "Embed demo" →
  `<a href="/embed-example.html" className="pn-btn pn-btn--big pn-btn--additional">`. Remove the
  `bg-neutral-900` and `border-neutral-300` classes.

**Verification:**
- [code] `pnpm build` + `pnpm lint` green. `grep -nE "neutral-[0-9]|bg-neutral-900|green-[0-9]|amber-|red-[0-9]|emerald-"
  src/app/page.tsx` → empty. `git diff src/app/page.tsx` shows the two `href` values unchanged.

### Step 3: Browser verification (both themes)

**Surface:** [browser]

> `/` is a public page — no auth blocker.

- [browser] Navigate to `/`. `browser_snapshot` confirms: charcoal logo, one display "Slate",
  `.pn-lead` description, sky primary "Admin" (with arrow) + outlined "Embed demo".
  `browser_take_screenshot` light.
- [browser] Toggle `data-theme=dark` (via `browser_evaluate`) → confirm beige→navy page, text →
  beige, buttons still correct (sky primary, outlined secondary). Screenshot dark.
- [browser] `browser_resize` to 390×844 → confirm the hero is usable, buttons stack/wrap cleanly,
  ≥44px targets.
- [browser] axe via `browser_evaluate` (wcag2a/2aa/21aa) → 0 serious/critical, both themes. Confirm
  one `<h1>`, logo `alt`, theme-aware focus ring on the buttons (Tab).

**Verification:**
- [browser] Light + dark (+ mobile) screenshots → `reports/`; axe 0 serious/critical.

## Artifacts to Modify

- `src/app/page.tsx` - beige hero, logo, one display heading, `.pn-lead`, sky primary + outlined
  buttons; both `href`s unchanged - [code]

## Contracts

### Provides (for downstream tasks)

- A branded landing for the 3.V sweep + Phase 5.

### Consumes (from upstream tasks)

- Phase 1: tokens, `.pn-*`, `data-theme`, PP Mori, `logo-pennie-charcoal.svg`, `arrow-right` icon.

## Acceptance Criteria

- [ ] Landing is a single beige hero: charcoal logo, one display heading, warm `.pn-lead`
      description.
- [ ] Buttons are sky primary ("Admin", with arrow) + outlined secondary ("Embed demo"); no
      `bg-neutral-900`/`border-neutral-300`.
- [ ] Both themes correct via inherited `data-theme`.
- [ ] Both `href`s (`/admin`, `/embed-example.html`) unchanged.
- [ ] No stray `neutral-N`/bright literals remain.
- [ ] `pnpm build` + `pnpm lint` green; axe clean both themes.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` → exit 0; `pnpm lint` → clean.
- Run: `grep -nE "neutral-[0-9]|bg-neutral-900|green-[0-9]|amber-|red-[0-9]|emerald-" src/app/page.tsx`
  → no matches.
- Inspect `git diff src/app/page.tsx` → only styling/markup; `href="/admin"` and
  `href="/embed-example.html"` intact.

#### [browser] Web Verification
- Navigate to: `/` (public).
- Snapshot: charcoal logo, one display "Slate", `.pn-lead`, sky primary + outlined buttons.
- Toggle `data-theme=dark`: beige→navy, text→beige, buttons correct.
- Resize 390×844: usable, ≥44px targets.
- axe (wcag2a/2aa/21aa) → 0 serious/critical, both themes; one `<h1>`, logo `alt`, focus ring.
- Screenshot: light + dark (+ mobile) → `reports/`.

### Cross-Surface Coherence
- The sky primary + outlined button pair matches the same recipe on login (3.4) and the Booker
  (Phase 2). Charcoal-logo-on-beige matches `/admin` `AppHeader` (3.1) + DS `logo.html`.

## Skills to Read

- `pennie-design-system-in-slate` - tokens, `.pn-*`, logo usage (charcoal-on-beige), button recipes,
  one-display-per-screen rule, voice.
- `slate-ui-verification` - Playwright/axe loop; landing is public (no auth blocker).

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/internal-pages-execution.md` - primary
  landing spec.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - pairings, 44px,
  one `<h1>`.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` - top authority (D8, D11, D17/D18).
  Memory `slate-copy-rules` (no dashes; never "Cadence").

## Execution Surfaces Reference

Read execution surface definitions and verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

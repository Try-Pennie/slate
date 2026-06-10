# Task 3.4: Marketing-rich login

## Objective

Rebuild `src/app/login/page.tsx` as a marketing-rich split layout (D12): a navy brand panel with
the cream Pennie logo + optimistic copy (and an optional sticky-note) beside a white form card whose
existing "Continue with Google" button is reskinned to the sky primary `.pn-btn--big --primary`
with the right-arrow icon. **The `signIn()` mechanism (lines ~14–30) is load-bearing and must NOT
be touched** — only the returned JSX (lines ~32–49) is restyled/restructured. Visual-only.

## Context

`/login` is the one internal page that needs net-new markup (the split layout). Today it is a
single centered `max-w-sm` card: `<h1>Slate</h1>`, one muted `<p>`, one `bg-neutral-900` button
calling `signIn()` → `supabase.auth.signInWithOAuth` with the calendar scopes. It is a `"use client"`
component and renders unauthenticated (public page; the OAuth click is the only auth surface). It
gates Tasks 3.4 only on Phase 1.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash / Read / Write / Edit | Rebuild the JSX into a split layout; reskin the Google CTA; keep `signIn()` untouched |
| Browser | Playwright MCP | Screenshot desktop + mobile, both themes; axe; confirm `signIn` still fires (public page) |

## Dependencies

- Phase 1 (gated by 1.V) - tokens, `.pn-*`, `data-theme` + no-flash script, PP Mori, vendored
  `public/brand/logo-pennie-cream.svg` (+ `logo-mark.svg`), inline `arrow-right` icon, optional
  `pic-3.png` graphic.

## Blocked By

- 1.V

## Research Findings

### Untouchable auth (pitfall)

- From `internal-pages-execution.md`: `signIn()` (login lines ~14–30: provider, `CALENDAR_SCOPES`,
  `redirectTo: ${window.location.origin}/api/auth/callback`, `access_type: "offline"`,
  `prompt: "consent"`, optional `hd`) is functional — **do NOT touch it**. Only restyle the JSX
  returned at lines ~32–49. Keep the `useState` `loading` flag and the
  `{loading ? "Redirecting…" : "Continue with Google"}` label behavior; keep `disabled={loading}`.

### Split layout & responsive (D12, mirrors DS `cta-block.html` `.cta-grid` lines 31–50)

- From `internal-pages-execution.md`:
  - Desktop ≥1024px: `grid lg:grid-cols-2 min-h-screen` (or `min-h-[100dvh]`). Recommended:
    **left = navy brand panel, right = white form card** (left-panel reads more "product").
  - Stack to one column <1024px: brand panel becomes a short top band (logo + one line), form card
    below. **Below 640px the panel hides** (except possibly the logo) so the form is above the fold.
    Honor 44px targets and `100dvh`.

### Left brand panel — navy hero (D8 navy hero; white-on-navy 16.02:1 AA-pass per D17)

- `bg-[--pennie-navy]` full-bleed; `--radius-lg` (24px) on the inner card edge if floated, or full
  to the viewport edge.
- Logo: `public/brand/logo-pennie-cream.svg` (cream wordmark on ink — matches `navigation.html`
  line 223) + optional `logo-mark.svg`, top-left, ~22px tall, `alt="Pennie"`.
- Brand copy: `.pn-h2`/`.pn-h1` cream + `.pn-lead` beige-muted. On-brand, verb-phrase, optimistic,
  **discloses nothing sensitive** (no agent counts, no "buckets", no Salesforce). Default copy
  (per the Human Actions recommendation, use unless the user picks another):
  - Headline: "Welcome back."
  - Sub: "Manage your availability and let the right calls find you."
  - NO em/en dashes; never "Cadence" (memory `slate-copy-rules`).
- Optional sticky-note (DS signature device, README §3.2; one max): a small `~-3°` rotated yellow
  note (`--pennie-yellow`, `--radius-sm` 8px, `--shadow-sm`) with a warm line e.g. "Leads always
  see times in their own timezone." Decorative; **skip on mobile**. (Recommended default: include
  one sticky-note on login, no iridescent graphic, to stay calm — confirm with user if desired.)
- Optional low-opacity `pic-3.png` ribbon in a bottom corner — only if it stays calm.

### Right form card

- Surface `bg-surface` (white) on the beige page, `.pn-card` style (`--radius-md`/`--radius-lg`,
  `--shadow-xs`), `p-8`, `max-w-sm`, vertically centered.
- Heading `.pn-h3` "Sign in to Slate" + `.pn-small text-fg-muted` helper (keep the existing intent:
  "Sign in with your Pennie Google account…", warmed up; no internal disclosure).
- CTA = sky primary: `.pn-btn .pn-btn--big .pn-btn--primary` full-width, **graphite label**
  (D17 7.36:1 PASS — never white-on-sky) + the **right-arrow icon** (`arrow-right`, primary CTAs
  that advance a flow get the arrow). A Google "G" glyph before the label is fine/conventional.
  Keep label a verb phrase: `{loading ? "Redirecting…" : "Continue with Google"}`. Keep
  `onClick={signIn}` and `disabled={loading}`.
- Focus ring: theme-aware (D17) — graphite outline on light, sky on navy. The foundation sets this
  globally; login inherits it. Keep the sky glow as decorative box-shadow only (never the sole 3:1
  indicator on light).

### Theming (D11)

- Login **defaults to light** (it is marketing-rich/beige) but still honors a stored preference via
  the foundation no-flash `data-theme` script. In dark, the page `--bg` flips navy, the form card
  `--surface` flips `--pennie-ink-2`, text → beige — automatic via `data-theme`. No per-page dark
  code needed beyond semantic utilities. (Login may omit the in-page toggle since it has no header;
  it still respects the stored theme.)

### A11y (wcag-accessibility.md)

- White-on-navy 16.02:1 PASS; cream-on-navy 14.85:1 PASS; graphite-on-sky 7.36:1 PASS — verify via
  axe. Logo `<img>` needs `alt`; decorative graphic/sticky-note `aria-hidden`. Button keeps its
  accessible name; 44px+ target (`--big` is 56px). No `outline:none` without replacement.

## Execution Plan

### Step 1: Orient

**Surface:** [code]

- [code] Read `src/app/login/page.tsx` in full. Mark lines ~14–30 (`signIn`) as untouchable; the
  restyle scope is the returned JSX (~32–49) plus possibly extracting a small presentational
  sub-component for the panel (still client, no logic).
- [code] Confirm vendored assets: `public/brand/logo-pennie-cream.svg`, `logo-mark.svg`, the
  `arrow-right` inline icon component (Phase 1.1/1.4), and optional `pic-3.png`.

**Verification:**
- [code] You can identify exactly which lines are auth (keep) vs JSX (restyle), and the assets
  exist.

### Step 2: Build the split layout shell

**Surface:** [code]

- [code] Replace the returned `<main className="flex min-h-full flex-1 items-center justify-center
  p-8">…` with a `grid lg:grid-cols-2 min-h-screen` (or `min-h-[100dvh]`) container. Left cell =
  navy brand panel; right cell = white form card centered. Below `lg`, stack to one column; below
  `640px`, hide the brand panel body (keep at most the logo). Use Tailwind responsive prefixes
  (`hidden lg:flex`, etc.). Keep everything inside the existing `LoginPage` client component.

**Verification:**
- [code] `pnpm build` exits 0. The component still exports default `LoginPage` and still imports
  `supabaseBrowser` and `useState`.

### Step 3: Navy brand panel

**Surface:** [code]

- [code] Brand panel: `bg-[--pennie-navy]`, cream logo top-left (`/brand/logo-pennie-cream.svg`,
  ~22px, `alt="Pennie"`), headline `.pn-h2`/`.pn-h1` cream + sub `.pn-lead` beige-muted (default
  copy from Research Findings unless the user picked another). Optional single sticky-note
  (`-3°` rotate, `--pennie-yellow`, `--radius-sm`, `--shadow-sm`, `aria-hidden`, hidden on mobile).
  No em/en dashes; no internal disclosure.

**Verification:**
- [code] Read back: white/cream text on navy only (no white-on-sky); logo has `alt`; copy has no
  dashes and names no internals.

### Step 4: Form card + reskinned Google CTA

**Surface:** [code]

- [code] Form card: `bg-surface` `.pn-card`, `p-8`, `max-w-sm`, vertically centered. Heading
  `.pn-h3` "Sign in to Slate" + `.pn-small text-fg-muted` helper. Replace the
  `bg-neutral-900 … text-white` button with `<button onClick={signIn} disabled={loading}
  className="pn-btn pn-btn--big pn-btn--primary w-full">` containing an optional Google "G" glyph,
  the label `{loading ? "Redirecting…" : "Continue with Google"}`, and the `arrow-right` icon
  (`aria-hidden`). Keep `onClick`, `disabled`, and the label logic exactly.

**Verification:**
- [code] `grep -n "bg-neutral-900\|text-white" src/app/login/page.tsx` → empty (CTA reskinned).
  `pnpm build` + `pnpm lint` green. `git diff src/app/login/page.tsx` shows lines ~14–30
  (`signIn`) UNCHANGED.

### Step 5: Browser verification (desktop + mobile, both themes)

**Surface:** [browser]

> `/login` is a public page — no auth blocker for rendering. Do NOT complete the Google OAuth flow
> (it leaves the app); only confirm the button styles and that clicking `signIn` fires without a
> console error (it will navigate toward Google — intercept/abort or just verify no thrown error
> before redirect).

- [browser] Navigate to `/login`. Desktop (~1280px): `browser_snapshot` confirms the split — navy
  panel (cream logo + copy) left, white form card right. `browser_take_screenshot` light + dark.
- [browser] `browser_resize` to 390×844 (mobile): confirm it stacks to one column, the panel body
  hides (logo may remain), the form card is above the fold, targets ≥44px. Screenshot light + dark.
- [browser] Toggle `data-theme` (via `browser_evaluate`) → dark: page navy, form card ink, text
  beige. Screenshot.
- [browser] axe via `browser_evaluate` (wcag2a/2aa/21aa) → 0 serious/critical, both themes. Confirm
  white/cream-on-navy and graphite-on-sky pass; the CTA has an accessible name and a visible
  theme-aware focus ring (Tab to it).
- [browser] Click the CTA → confirm `signIn` fires (navigation toward Google / no console error);
  do not finish OAuth.

**Verification:**
- [browser] Desktop + mobile, light + dark screenshots → `reports/`; axe 0 serious/critical; CTA
  fires `signIn` with no error.

## Artifacts to Modify

- `src/app/login/page.tsx` - rebuild the returned JSX into a navy-panel + white-form split; reskin
  the Google CTA to `.pn-btn--big --primary` + arrow; `signIn()` (lines ~14–30) untouched - [code]

## Contracts

### Provides (for downstream tasks)

- A branded login for the 3.V sweep + Phase 5; the reconnect-Google link in `AppHeader` (3.1)
  points here.

### Consumes (from upstream tasks)

- Phase 1: tokens, `.pn-*`, `data-theme` + no-flash script, PP Mori, `logo-pennie-cream.svg`,
  `arrow-right` icon, optional `pic-3.png`.

## Acceptance Criteria

- [ ] Login is a split marketing layout: navy brand panel (cream logo + optimistic, internal-free
      copy, optional one sticky-note) + white form card.
- [ ] Google CTA is sky primary + graphite label + arrow (never white-on-sky); `.pn-btn--big`.
- [ ] Responsive: two columns ≥1024px, stacks <1024px, panel body hidden <640px; 44px targets;
      `100dvh`.
- [ ] White/cream-on-navy and graphite-on-sky pass AA (axe clean both themes).
- [ ] Defaults to light, honors stored theme; dark variant correct.
- [ ] `signIn()` (lines ~14–30) byte-for-byte unchanged; auth still fires.
- [ ] No `bg-neutral-900`/`text-white`/stray bright literals remain.
- [ ] `pnpm build` + `pnpm lint` green.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` → exit 0; `pnpm lint` → clean.
- Run: `grep -nE "neutral-[0-9]|text-white|green-[0-9]|amber-|red-[0-9]|emerald-" src/app/login/page.tsx`
  → no matches (cream/navy use `--pennie-*` tokens, not Tailwind grayscale).
- Inspect `git diff src/app/login/page.tsx` → lines ~14–30 (`signIn`, scopes, redirect, queryParams)
  unchanged; only JSX restyled.

#### [browser] Web Verification
- Navigate to: `/login` (public).
- Snapshot (desktop): split layout — navy panel + cream logo + copy left, white form card right.
- Resize 390×844: stacks, panel body hidden, form above fold, ≥44px targets.
- Toggle `data-theme=dark`: navy page, ink form card, beige text.
- axe (wcag2a/2aa/21aa) → 0 serious/critical, both themes; CTA has accessible name + theme-aware
  focus ring.
- Flow: click CTA → `signIn` fires (no console error); do NOT complete OAuth.
- Screenshot: desktop + mobile, light + dark → `reports/`.

### Cross-Surface Coherence
- Cream-logo-on-navy usage matches DS `navigation.html` (line 223) and `logo.html`.
- The sky CTA matches the Booker primary CTA (Phase 2) and `buttons.html` (sky fill + graphite +
  arrow). Compare the split to DS `cta-block.html`.

## Skills to Read

- `pennie-design-system-in-slate` - tokens, `.pn-*`, logo usage (cream-on-navy), button/CTA recipe,
  sticky-note device, voice rules.
- `slate-ui-verification` - Playwright/axe loop; login is public (no auth blocker); the
  "don't complete OAuth" note.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/internal-pages-execution.md` - primary login
  spec (split layout, brand panel, form card, copy options, untouchable `signIn`).
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - white/cream-on-navy
  + graphite-on-sky pairings, theme-aware focus, 44px.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` - top authority (D12 marketing-rich
  login, D8 color, D11 both themes, D17/D18). Memory `slate-copy-rules` (no dashes; never "Cadence").

## Execution Surfaces Reference

Read execution surface definitions and verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

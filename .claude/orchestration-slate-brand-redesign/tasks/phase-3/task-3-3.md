# Task 3.3: Restyle the `/me` agent self-view

## Objective

Restyle `src/app/me/page.tsx` to the Pennie system using the shared `AppHeader` + style constants
from Task 3.1: a beige page with one or two white `.pn-card` sections, the bookable status shown as
a **pill** instead of bare green text, and the amber "no working hours" banner replaced with a calm
sky-soft **notice card**. **Strictly visual-only** — `currentUser()`/`redirect("/login")`, the
`setMyWorkingHours`/`useMyDefaultHours` actions, and every form `name=` stay byte-for-byte.

## Context

`/me` is a 138-line `force-dynamic` server component — the simpler sibling of `/admin`. It shares
the same form primitives (weekday checkboxes + time inputs) and, after Task 3.1, the same imported
style constants and `AppHeader`. The two `/me`-specific colored bits to fix are the bookable status
text (line ~51) and the amber no-hours banner (line ~58). The working-hours form just inherits the
new `inputCls`/`labelCls`/`btnCls`. Reuse the shared `Pill` helper from Task 3.1 (S10).

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash / Read / Write / Edit | Re-skin header block, bookable pill, no-hours notice, working-hours card |
| Browser | Playwright MCP | Screenshot both themes; verify pill + calm notice (auth-gated — see blocker) |

## Dependencies

- Task 3.1 - shared `@/components/ui/styles` + `@/components/ui/Pill` (S10 — the bookable status
  pill, owned by 3.1) + `AppHeader` (already wired into `/me`).
- Phase 1 - tokens, `.pn-*`, semantic utilities, `data-theme`, vendored icons (incl. `info`).

## Blocked By

- 3.1 (hard). 3.1 owns `@/components/ui/Pill` (S10) — import it. (If for some reason 3.1's Pill is
  not yet available, create the bookable pill inline with the same green-wash/outline tokens and
  reconcile to the 3.1-owned shared helper in 3.V.)

## Research Findings

- From `internal-pages-execution.md` (ME — same shell, simpler):
  - Reuse `AppHeader` with `active="me"`. Page is `bg-bg`; keep `max-w-xl` (line ~46) and the
    section spacing.
  - Header block (lines ~47–55): `.pn-h2`/`.pn-h3` "Your availability" + a `.pn-small` line with
    name and the **bookable status pill** (not bare green text).
  - No-hours banner (line ~58): a calm **notice card** — `bg-[--pennie-sky-soft]` (or
    `--pennie-cream-3`) surface, `text-fg`, with an `info.svg` icon — NOT amber. Keep the "Use
    default hours" `.pn-btn--small --primary` button inside it and its `<form action={useMyDefaultHours}>`.
  - Working-hours card: `cardCls` + the shared form swap. "Reset to company default hours" link
    (line ~127) → `.pn-btn--link text-[--pennie-blue]`.
  - Closing helper `<p>` (line ~133): `.pn-small text-fg-muted`.
- From `internal-pages-execution.md` (status mapping table): `/me` bookable status (line ~51)
  `text-green-600` / `text-neutral-400` → render as a pill: bookable =
  `bg-[--pennie-green-wash] text-[--pennie-green-deep]`; not-bookable = mercury outline +
  `text-fg-muted`. Keep the `me.bookable ? "Bookable" : "Not bookable yet"` condition and text.
- From `internal-pages-execution.md` (pitfalls): yellow-as-text fails AA on light — that's why the
  amber banner becomes a sky-soft/cream notice, calm not alarmist (Pennie voice). The weekday
  checkboxes (lines ~91–104) are `text-[10px]` — bump to `.pn-small text-fg-muted` and set
  `accent-[--pennie-sky]`; do not rebuild them. `type="time"` inputs use `inputCls`.
- From `wcag-accessibility.md`: color never the sole signal — the bookable pill carries text, the
  notice card carries the info icon + the existing sentence. 44px targets on the inputs/buttons
  (the new `inputCls` is `h-[44px]`).
- From `DISCOVERY.md` / `slate-copy-rules` (memory): no em/en dashes in user-facing copy; never name
  the secret platform "Cadence". Keep the existing copy intent; do not add disclosure of internals.
- The auth note: `/me` is auth-gated (`redirect("/login")` if no session).

## Execution Plan

### Step 1: Orient

**Surface:** [code]

- [code] Read `src/app/me/page.tsx` in full. Confirm 3.1 already imports the shared style constants
  and renders `AppHeader active="me"`. Note the exact `name=` on every input
  (`timezone`, `day_1..day_7`, `start`, `end`) and the two `action=` forms — these stay.
- [code] Confirm `@/components/ui/Pill` exists (3.1, S10). Confirm an `info` icon component exists in
  `src/components/icons/` (Phase 1.4); if not, plan a small inline `currentColor` info SVG.

**Verification:**
- [code] You have the full `name=`/action contract list and the available Pill variants + icon.

### Step 2: Header block + bookable pill

**Surface:** [code]

- [code] Restyle the header block under `AppHeader`: title → `.pn-h2`/`.pn-h3` "Your availability";
  the name + status line → `.pn-small text-fg-muted` with the status rendered as
  `<Pill variant={me.bookable ? "status-ok" : "outline"}>{me.bookable ? "Bookable" : "Not bookable yet"}</Pill>`.
  Keep `me.name ?? me.email` exactly. Do not change the condition.

**Verification:**
- [code] `pnpm build` exits 0. `grep -n "text-green-600\|text-neutral-400" src/app/me/page.tsx` →
  empty.

### Step 3: No-hours notice card

**Surface:** [code]

- [code] Replace the amber banner (line ~58) with a calm notice card: `bg-[--pennie-sky-soft]`
  surface, `rounded-md`, `text-fg`, an `info` icon at the left, the existing sentence ("You have no
  working hours set, so you won't get bookings."), and the unchanged
  `<form action={useMyDefaultHours}><button className={btnCls}>Use default hours</button></form>`.
  Keep the `rules.length === 0 &&` guard and the apostrophe-escaped copy. No amber, no bright red.

**Verification:**
- [code] `grep -n "amber-" src/app/me/page.tsx` → empty. `pnpm build` exits 0.

### Step 4: Working-hours card + links + closing copy

**Surface:** [code]

- [code] The working-hours `<section>` already uses `cardCls`/`labelCls`/`inputCls`/`btnCls` (now
  Pennie via 3.1). Restyle the remaining ad-hoc bits: weekday checkbox labels (lines ~91–104) →
  `.pn-small text-fg-muted` + `accent-[--pennie-sky]` on the checkbox; the "Reset to company
  default hours" link (line ~127, currently `text-xs text-neutral-500 underline`) →
  `.pn-btn--link text-[--pennie-blue]`; closing `<p>` (line ~133, `text-xs text-neutral-400`) →
  `.pn-small text-fg-muted`. Keep every `name=`, `defaultValue=`, `type=`, and both forms.

**Verification:**
- [code] `pnpm build` + `pnpm lint` green. `grep -nE "neutral-[0-9]|green-[0-9]|amber-|red-[0-9]|emerald-"
  src/app/me/page.tsx` → empty.

### Step 5: Browser verification (both themes)

**Surface:** [browser]

> **AUTH BLOCKER:** `/me` is Google-OAuth-gated (`redirect("/login")` without a session). Resolve
> via a logged-in (agent) Playwright profile / injected Supabase session / user-supplied
> screenshots (see `reports/surface-verification.md`). To exercise the no-hours notice, use an agent
> with empty availability rules (or seed that state). If a session is unavailable, record the
> blocker in PROGRESS.md; the code gates are the hard gates.

- [browser] With an agent session, navigate to `/me`. `browser_snapshot` confirms: `AppHeader`,
  the bookable pill (not bare text), the working-hours card. `browser_take_screenshot` light + dark
  (toggle via the 3.1 ThemeToggle or `data-theme` via `browser_evaluate`).
- [browser] Force the empty-rules state to confirm the calm sky-soft notice card (info icon + copy
  + "Use default hours") renders, not an amber banner. Screenshot both themes.
- [browser] Confirm input focus shows the theme-aware ring (graphite on light, sky on navy) and
  inputs are ≥44px tall. axe via `browser_evaluate` (wcag2a/2aa/21aa) → 0 serious/critical.

**Verification:**
- [browser] Paired light/dark screenshots (with-hours + no-hours states) → `reports/`; axe 0
  serious/critical; bookable pill + calm notice confirmed.

## Artifacts to Modify

- `src/app/me/page.tsx` - header block + bookable pill, no-hours notice card, working-hours card
  bits, links, closing copy → Pennie tokens; no form/action/`name=` change - [code]

## Contracts

### Provides (for downstream tasks)

- A branded `/me` for the 3.V sweep + Phase 5; demonstrates the shared shell/pill reuse.

### Consumes (from upstream tasks)

- 3.1: shared `styles` constants + `AppHeader`.
- 3.1: `@/components/ui/Pill` (S10).
- Phase 1: tokens, `.pn-*`, semantic utilities, `data-theme`, `info` icon.

## Acceptance Criteria

- [ ] `/me` renders on-brand in BOTH themes: beige page, white `.pn-card` section(s), shared header.
- [ ] Bookable status is a pill (text + color), not bare green/neutral text.
- [ ] The amber no-hours banner is replaced by a calm sky-soft notice card (info icon + copy +
      "Use default hours"), not alarmist.
- [ ] No `amber-`/`green-N`/`red-N`/`neutral-N`/`emerald-` literals remain in `me/page.tsx`.
- [ ] Auth flow, both forms, and all `name=` unchanged (git diff confirms).
- [ ] `pnpm build` + `pnpm lint` green.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` → exit 0; `pnpm lint` → clean.
- Run: `grep -nE "neutral-[0-9]|green-[0-9]|amber-|red-[0-9]|emerald-" src/app/me/page.tsx` → no
  matches.
- Inspect `git diff src/app/me/page.tsx` → only styling/markup changes; `currentUser()`/`redirect`,
  `setMyWorkingHours`/`useMyDefaultHours`, and all `name=`/`defaultValue=` intact.

#### [browser] Web Verification
- Navigate to (agent session): `/me`; and an empty-rules agent for the no-hours state.
- Snapshot: header, bookable pill, working-hours card, notice card (when no hours).
- Flow: toggle theme → page flips; confirm input focus ring + 44px inputs.
- axe (wcag2a/2aa/21aa) → 0 serious/critical, both themes.
- Screenshot: with-hours + no-hours, light + dark → `reports/`.

### Cross-Surface Coherence
- The bookable pill matches `/admin`'s bookable pill (same `Pill` helper/tokens).
- Field/button styling matches `/admin` (same shared constants).
- Compare to DS `preview/forms.html` + `cards.html`.

## Skills to Read

- `pennie-design-system-in-slate` - tokens, `.pn-*`, card/notice/pill recipes, voice rules.
- `slate-ui-verification` - Playwright/axe loop, the `/me` auth blocker, evidence capture.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/internal-pages-execution.md` - primary `/me`
  spec (header, bookable pill, calm notice, working-hours card).
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - color-not-sole-signal,
  44px, AA pairings.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` - top authority (D8 color, D11 both
  themes, D13, D17/D18). Memory `slate-copy-rules` (no dashes; never "Cadence").

## Execution Surfaces Reference

Read execution surface definitions and verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

# Task 3.2: Restyle the admin dashboard

## Objective

Restyle `src/app/admin/page.tsx` to the Pennie system: a beige page with white `.pn-card`
sections, role/status pills, shadow-led tables with tabular numerals, and the bright JSX-ternary
status colors (push-health dot, bookable button, webhook delivery pill, eligible-agent warning,
routing-trace reassignment) remapped to Pennie status tokens **while preserving each ternary
condition and every non-color signal**. **Strictly visual-only** — no `actions.ts` change, no
changed `name=`/`value=`/`searchParams`, no RBAC gate change, no data-fetch change.

## Context

`/admin` is a 1065-line `force-dynamic` server component. ~80% of its surface re-skins the moment
the shared style constants (now imported from `@/components/ui/styles` per Task 3.1) carry the
Pennie values. What remains for this task: (a) the section chrome (headings, descriptive copy,
page background, ad-hoc outlined buttons), (b) role/status **pills**, (c) the three `<table>`s, and
(d) the handful of **status colors computed inside JSX ternaries** — the one place where styling
couples to markup logic. The branch conditions stay; only the color values change.

**S8 — shared-file coordination:** 3.2 (admin) and 3.3 (me) edit separate page files, but both
consume the shared `@/components/ui/Pill` (this task owns/creates it) and `@/components/ui/styles`
(3.1 owns). 3.2 creates `Pill.tsx`; 3.3 imports it — run 3.2 before 3.3 (or have 3.3 create the
bookable pill inline and reconcile to the shared helper). Do not edit each other's page file.

RBAC gates remain untouched: `canManageAgents` (line ~250) gates manager+ sections;
`canEditOrgSettings`/`isAdmin` (line ~258) gates admin-only sections. Their visual presence must be
unchanged.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Code | Bash / Read / Write / Edit | Re-skin sections, pills, tables; remap status ternaries to Pennie tokens |
| Browser | Playwright MCP | Screenshot every section both themes; verify pills/tables/status; axe (auth-gated — see blocker) |

## Dependencies

- Task 3.1 - provides the shared `@/components/ui/styles` constants, the `@/components/ui/Pill`
  helper (S10), and `AppHeader` already wired into admin.
- Phase 1 - tokens, `.pn-*`, semantic utilities, `data-theme`, vendored icons.

## Blocked By

- 3.1

## Research Findings

### The one tricky spot — status colors live in JSX ternaries (D8 mapping)

A "no stray hex in globals.css" check will MISS these — they are color values embedded in
conditional expressions in `admin/page.tsx`. Remap bright → Pennie status tokens, keep the branch
logic and every text/`title=`/label signal:

| Location (admin/page.tsx) | Current | Pennie replacement |
|---|---|---|
| Push-health dot (~449–455) | `bg-green-500` / `bg-amber-500` / `bg-neutral-300` | `bg-[--pennie-green]` / `bg-[--pennie-yellow]` / `bg-[--pennie-mercury]`. **Keep** the existing `title=` text (line ~446) and the "push {watchedCount}/{bookableAgents.length} watched" label (line ~457) so color is never the sole signal (D18). |
| Bookable button (~543–547) | `border-green-300 text-green-700` / `border-neutral-300 text-neutral-500` | a pill badge: bookable = `bg-[--pennie-green-wash] text-[--pennie-green-deep]` with the `✓` (already in the label, line ~549); not-bookable = `--pennie-mercury` outline + muted text. Keep the surrounding `<form action={setBookable}>` + hidden inputs untouched. |
| Eligible-agent warning (~155) | `text-amber-600` (else `text-neutral-400`) | yellow-as-text fails AA on light — do NOT map amber→`--pennie-yellow` text. Treat the "no fallback set, bookings will fail" branch as an **error** → `text-[var(--error)]` (S1 — the 1.2 rose token = `--pennie-rose` = `#C43D3D`, 4.77:1 on beige; reference by name, no raw hex). Treat the "using fallback agent" branch as a **notice** → muted (`text-fg-muted`) or graphite + a yellow dot. The `eligibleCount === 0` vs else condition and the exact copy stay. |
| Webhook delivery status pill (~945–951) | `bg-green-100 text-green-700` / `bg-red-100 text-red-700` / `bg-amber-100 text-amber-700` | success `bg-[--pennie-green-wash] text-[--pennie-green-deep]`; failed `bg-[var(--error-bg)] text-[var(--error)]` (S1 — the 1.2 12% rose tint + rose token, by name, not raw `rgba(196,61,61,.12)`/`#C43D3D`); pending `bg-[--pennie-sky-soft] text-[--pennie-blue]`. Keep `title={d.last_response}` and the `{d.status}` text. Make it `rounded-pill`. |
| Routing-trace reassignment (~806) | `text-amber-600` | `text-[--pennie-blue]` (`#486CCA`, informational, AA-safe blue-text-on-light per D8/D17). Keep the "reassigned X → Y" content. |

These are the ONLY places structure couples to styling. Everywhere else is a pure class swap. They
will NOT be caught by a globals.css hex scan — **manually grep the file** for
`green-|amber-|red-|neutral-|emerald-`.

### Shared levers & section chrome (from internal-pages-execution.md)

- Page background: beige. Keep `mx-auto max-w-4xl space-y-8 p-8` (line ~359) spacing/width; ensure
  the page sits on `bg-bg` (inherited) with comfortable top padding under the new `AppHeader`
  (from 3.1).
- Sections are `cardCls` (`.pn-card` recipe: `rounded-md bg-surface shadow-xs p-6`) — shadow-led,
  not border-led (D9). Drop any `border-neutral-200` on cards.
- Section headers: `<h2 className="text-sm font-semibold">` → `.pn-h4` or `.pn-small-bold` (+
  optional `.pn-eyebrow` category). Descriptive `<p className="text-xs text-neutral-500">` →
  `.pn-small text-fg-muted`. The muted-count `<span className="font-normal text-neutral-400">`
  (line ~440) → `text-fg-muted`.
- Outlined buttons (admin lines ~462, 484, 524, 531, 542, 960 etc. — `border border-neutral-300
  hover:border-neutral-500`) → `.pn-btn .pn-btn--small .pn-btn--additional`. "Sync from Salesforce"
  (line ~462) is secondary → `--additional`. Primary Save/Create stay `.pn-btn--small --primary`
  (via `btnCls`).
- Search bar (lines ~468–495): input → the forms.html search recipe (rounded soft surface, search
  icon, sky focus); "Search" button → `--additional`; "clear" link → `.pn-btn--link`
  (`text-[--pennie-blue]`). Keep `method="get"` and every `name=`.
- `<code>` chips (criteria keys line ~108; reassign API key block line ~835) → `bg-[--pennie-wild-sand]`,
  chips `--radius-xs` (4px) / the key block `--radius-sm`, monospace stays. The reassign block is a
  read-only secret display — reskin only, keep it boxed.
- Weekday checkbox grids (lines ~388–410 and ~569–591): `text-[10px]` labels → `.pn-small`
  `text-fg-muted`; set native `accent-[--pennie-sky]` on the checkboxes. Do NOT rebuild them as
  custom widgets (scope creep). `<select>` / `type="time"` inputs use `inputCls`.

### Badges & pills (DS §3) and tables

- Use the shared presentation-only `Pill` helper (`src/components/ui/Pill.tsx`, owned by 3.1 per S10
  — import it, don't recreate) — `rounded-pill` (999px, the only 999px use, D9), `13/700` type,
  `~24px` tall, `6px/12px` (or `0 8px`) padding.
  - **Role pills** (agent/manager/admin): agent = neutral outlined (`border-[--border] text-fg`);
    manager = `--pennie-sky-soft` fill; admin = `--pennie-navy` fill + cream text (trust/ink). The
    ink role pill is invisible on the dark navy page — give it a `dark:` variant (sky-soft fill or
    beige outline).
  - **Status pills** (bookable, webhook status): green-wash / `var(--error-bg)`+`var(--error)` (S1,
    by name) / sky-soft per the table above.
- Three tables (recent routing ~770, webhook deliveries ~913, audit log ~986) + the agents roster
  (`space-y-5` list, ~496) read as quiet rows on a white card (D9): `thead` `.pn-small` muted
  `font-semibold` no fill; row dividers `border-t border-[--border]` (replaces `border-neutral-100`);
  optional row hover `hover:bg-[--pennie-wild-sand]` (light) / `hover:bg-[--pennie-ink-2]` (dark);
  add `tabular-nums` to When/Tries/count columns; cell text `text-fg` primary / `text-fg-muted`
  secondary (replaces `text-neutral-600/500/400`). Keep `overflow-x-auto`.
- Agent roster rows: name `.pn-body-bold`, meta `.pn-small text-fg-muted`, role → role pill,
  bookable → status pill.

### A11y / theming

- From `wcag-accessibility.md`: color never the sole signal — the push dot keeps its `title=` +
  label; the bookable pill keeps the `✓`/text; the webhook pill keeps the `{d.status}` text. Add a
  leading icon to the rose/error states where practical. `tabular-nums` on timestamps aids scanning.
- All light/dark is automatic via semantic utilities — verify the navy-on-navy edge cases in dark
  (admin role pill, sky-soft text on ink).

## Execution Plan

### Step 1: Orient

**Surface:** [code]

- [code] Read `src/app/admin/page.tsx` in full (it is long but the patterns repeat). Map each
  section to its line range. Confirm 3.1 already imports the shared constants and renders
  `AppHeader`.
- [code] Read `src/app/admin/actions.ts` to learn every `name=` the actions read — these are a
  hard contract; do not change any. Read `@/lib/auth/roles` to see `canManageAgents` /
  `canEditOrgSettings` / `ROLES` (do not touch the gates).
- [code] `grep -nE "green-|amber-|red-|neutral-|emerald-" src/app/admin/page.tsx` to enumerate
  EVERY color literal (including the ternaries) so none are missed.

**Verification:**
- [code] You have a complete list of color literals + their line numbers, and the full set of
  `name=`/action/RBAC references that must NOT change.

### Step 2: Consume the shared Pill helper (S10 — owned by 3.1, do NOT recreate)

**Surface:** [code]

- **S10: `src/components/ui/Pill.tsx` is created/owned by Task 3.1. This task IMPORTS it**
  (`import { Pill } from "@/components/ui/Pill"`) — do not create a second copy (it would clobber
  3.1's). Confirm it exists and exposes the variants this task needs:
  `variant ∈ { "role-agent","role-manager","role-admin","status-ok","status-error",
  "status-pending","outline" }` (`rounded-pill`, `13/700`, ~24px, `dark:` variant for the ink role
  pill; `status-error` = `bg-[var(--error-bg)] text-[var(--error)]` per S1).
- If a variant the admin needs is missing from the 3.1 component, add it INSIDE
  `src/components/ui/Pill.tsx` (still the single shared file) rather than forking a new component.

**Verification:**
- [code] `grep -rn "from \"@/components/ui/Pill\"" src/app/admin/page.tsx` → admin imports the shared
  Pill; there is exactly ONE `src/components/ui/Pill.tsx` (owned by 3.1, not duplicated here). If any
  variant edit was needed, `grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-|#[0-9a-fA-F]{3,6}"
  src/components/ui/Pill.tsx` → only intentional Pennie token refs incl. `var(--error)`/`var(--error-bg)`,
  no raw rose hex/rgba (S1).

### Step 3: Re-skin section chrome (headings, copy, page bg, outlined buttons, chips)

**Surface:** [code]

- [code] Apply the section-chrome swaps from Research Findings across all sections: headings →
  `.pn-h4`/`.pn-small-bold`; descriptions → `.pn-small text-fg-muted`; muted counts →
  `text-fg-muted`; all `border border-neutral-300 hover:border-neutral-500` outlined buttons →
  `.pn-btn .pn-btn--small .pn-btn--additional`; the search input → soft search recipe; clear link →
  `.pn-btn--link`; `<code>` chips/key block → `--pennie-wild-sand` + chip/sm radius; weekday
  checkbox labels → `.pn-small text-fg-muted` + `accent-[--pennie-sky]`.
- Do NOT change form `action=`, `method=`, input `name=`/`value=`, hidden inputs, or the
  `isAdmin`/`canManageAgents` conditional wrappers.

**Verification:**
- [code] `pnpm build` exits 0. After this step, `grep -nE "neutral-[0-9]" src/app/admin/page.tsx`
  should be sharply reduced (remaining hits are the status ternaries handled in Step 5).

### Step 4: Restyle the three tables + agent roster

**Surface:** [code]

- [code] Apply the table recipe (Research Findings) to recent-routing (~770), webhook-deliveries
  (~913), audit-log (~986): `thead` `.pn-small` muted `font-semibold`; dividers
  `border-t border-[--border]`; `tabular-nums` on When/Tries/count columns; cell text
  `text-fg`/`text-fg-muted`. Keep `overflow-x-auto`.
- [code] Agent roster (~496–675): name `.pn-body-bold`, meta `.pn-small text-fg-muted`, role →
  `<Pill variant="role-…">`, bookable → status pill (see Step 5 for the bookable ternary).

**Verification:**
- [code] `pnpm build` exits 0. `grep -n "border-neutral-100" src/app/admin/page.tsx` → empty.

### Step 5: Remap the status-color ternaries (preserve conditions + non-color signals)

**Surface:** [code]

- [code] Edit each of the five ternary sites per the mapping table in Research Findings, changing
  ONLY the className/color expressions, never the `condition ? … : …` structure, the surrounding
  JSX, the `title=`, or the visible text/`✓`:
  1. Push-health dot (~449–455): green/yellow/mercury tokens; keep `title=` + watched label.
  2. Bookable button (~543–547): green-wash/`green-deep` pill vs mercury outline + muted; keep
     `✓`/text and the `<form action={setBookable}>` + hidden inputs.
  3. Eligible-agent warning (~155): `text-[var(--error)]` for the "bookings will fail" branch, muted
     for the "using fallback" branch; keep the count + copy.
  4. Webhook delivery pill (~945–951): green-wash / `var(--error-bg)`+`var(--error)` / sky-soft per
     status; `rounded-pill`; keep `title={d.last_response}` + `{d.status}`.
  5. Routing-trace reassignment (~806): `text-[--pennie-blue]`; keep the content.
- Prefer routing these through the `Pill` helper where they are pills (bookable, webhook status);
  keep the dot and the two text states inline.

**Verification:**
- [code] `grep -nE "green-[0-9]|amber-[0-9]?|red-[0-9]|neutral-[0-9]|emerald-" src/app/admin/page.tsx`
  → EMPTY (every bright literal remapped). `pnpm build` + `pnpm lint` green.
- [code] `git diff src/app/admin/page.tsx` shows the ternary conditions unchanged (only color
  expressions differ); `git diff --stat src/app/admin/actions.ts` → no changes.

### Step 6: Browser verification (every section, both themes)

**Surface:** [browser]

> **AUTH BLOCKER:** `/admin` is Google-OAuth-gated AND needs a manager/admin role + seeded data
> (agents, a bucket, a webhook endpoint, bookings/deliveries/audit rows) to render every section
> and every status branch. Resolve via a logged-in Playwright profile / injected Supabase session /
> user-supplied screenshots + seed data (see `reports/surface-verification.md` and the Human
> Actions table in `internal-pages-execution.md`). If full data cannot be seeded, verify the
> sections that do render and record the gap in PROGRESS.md; the code gates (build/lint/grep/diff)
> are the hard gates.

- [browser] With a manager/admin session + seed data, navigate to `/admin`. `browser_snapshot` +
  `browser_take_screenshot` each section in BOTH themes (toggle via the 3.1 ThemeToggle or by
  setting `data-theme` via `browser_evaluate`).
- [browser] Exercise each status branch where seedable: push healthy/partial/none dot; bookable vs
  not pill; webhook success/failed/pending pill; eligible-count zero (fallback vs no-fallback);
  reassignment trace. Confirm each shows the Pennie color AND its non-color signal.
- [browser] Verify beige-page/white-card rhythm, role pills (incl. the ink admin pill's dark
  variant), tabular numerals on timestamps.
- [browser] axe via `browser_evaluate` (wcag2a/2aa/21aa) → 0 serious/critical, both themes.

**Verification:**
- [browser] Paired light/dark screenshots of each section → `reports/`; axe 0 serious/critical;
  every status branch shows correct token + non-color cue.

## Artifacts to Create

- None. (S10: `src/components/ui/Pill.tsx` is created/owned by Task 3.1; this task imports it. If a
  needed variant is missing, extend 3.1's file rather than creating a new component.)

## Artifacts to Modify

- `src/app/admin/page.tsx` - section chrome, tables, roster, pills, and the five status ternaries
  → Pennie tokens; no logic/form/RBAC/`name=` change - [code]
- (If a variant must be added: `src/components/ui/Pill.tsx` — extend the 3.1-owned shared component) - [code]

## Contracts

### Provides (for downstream tasks)

- A fully branded admin reference for the 3.V sweep + Phase 5. (The `@/components/ui/Pill` helper is
  owned by 3.1 per S10 — 3.2 consumes it, not provides it.)

### Consumes (from upstream tasks)

- 3.1: `@/components/ui/styles` constants + `@/components/ui/Pill` (S10) + `AppHeader` (already wired).
- Phase 1: tokens, `.pn-*`, semantic utilities, `data-theme`, vendored icons.

## Acceptance Criteria

- [ ] Admin renders on-brand in BOTH themes: beige page, white `.pn-card` sections, role/status
      pills, shadow-led tables with `tabular-nums`.
- [ ] All five status ternaries remapped to Pennie tokens with conditions + non-color signals
      preserved.
- [ ] No bright `amber-`/`green-N`/`red-N`/`neutral-N`/`emerald-` literals remain in
      `admin/page.tsx`.
- [ ] Data, forms, `name=`, RBAC gates, and `actions.ts` unchanged (git diff confirms).
- [ ] `pnpm build` + `pnpm lint` green.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- Run: `pnpm build` → exit 0; `pnpm lint` → clean.
- Run: `grep -nE "green-[0-9]|amber-[0-9]?|red-[0-9]|neutral-[0-9]|emerald-" src/app/admin/page.tsx`
  → no matches.
- Run: `git diff --stat src/app/admin/actions.ts` → no changes. Inspect `git diff
  src/app/admin/page.tsx` → only styling/className/markup changes; no `name=`/`value=`/`action=`/
  RBAC-gate edits, ternary conditions intact.

#### [browser] Web Verification
- Navigate to (manager/admin session + seed): `/admin`.
- Snapshot: every section renders; pills, tables, status states present.
- Flow: toggle theme → all sections flip; exercise each status branch (push/ bookable/ webhook/
  eligible/ reassignment) → correct token + non-color cue.
- axe (wcag2a/2aa/21aa) → 0 serious/critical, both themes.
- Screenshot: each section light + dark → `reports/`.

### Cross-Surface Coherence
- Pills, tables, and field styling match the look produced by the shared constants on `/me`
  (3.3) — same tokens, same shapes.
- Compare to DS `preview/badges.html`, `forms.html`, `cards.html`, `navigation.html`.

## Skills to Read

- `pennie-design-system-in-slate` - tokens, `.pn-*`, badge/pill/table/card recipes, color/shape
  rules, the D8 status-color mapping.
- `slate-ui-verification` - Playwright/axe/Lighthouse loop, the admin auth blocker, surface→URL
  matrix, evidence capture.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/internal-pages-execution.md` - primary admin
  spec; the status-ternary mapping table, pills, tables, section chrome.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - color-not-sole-signal,
  AA pairings (rose/blue/green tokens), tabular numerals.
- `.claude/orchestration-slate-brand-redesign/research/tailwind-v4-token-mapping.md` - semantic
  utilities re-resolving via `data-theme`.
- `.claude/orchestration-slate-brand-redesign/DISCOVERY.md` - top authority (D8 color, D9 shape,
  D13 branded admin, D17/D18 a11y).

## Execution Surfaces Reference

Read execution surface definitions and verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

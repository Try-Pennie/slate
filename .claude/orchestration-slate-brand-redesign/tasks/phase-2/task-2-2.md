# Task 2.2: Restyle the calendar + time-slot selection

## Objective

Restyle the Booker's month calendar (day grid, weekday header, month nav, selected/today states)
and the timeslot column (slot rows, 12h/24h toggle, skeletons, empty state) to Pennie tokens.
Replace the emerald dots (D17 contrast + color-only failures) with a sky/green token PLUS a
non-color cue, enlarge sub-44px touch targets (month nav ~24px, slots ~40px), and surface the
active timezone as a labeled chip near the slot list. **Visual-only: no availability, slot, or
date logic changes.**

## Context

**S8 — shared-file coordination:** Tasks 2.2, 2.3, and 2.4 all edit `src/components/Booker.tsx`
(2.2 = calendar/times ~324–489, 2.3 = form ~406–438, 2.4 = confirmed view ~263–278 + brandColor
~130–134). They run sequentially (or with coordinated, non-overlapping line regions) to avoid edit
collisions — re-read the file immediately before editing and confine changes to this task's region.

This sits between 2.1 (palette token-driven, light default — done) and 2.3 (form + CTA). The
calendar and slot list are the core interaction of the Booker. Today they carry the two most
visible stray colors (`bg-emerald-500` today-dot at line 394 and slot dot at line 479) and the
worst touch-target offenders (the `‹`/`›` month nav at `p-1` ≈ 24px). The `PALETTE` keys for
`dayOn/dayOff/daySelected/ring/slot/toggle*/navHover/skeleton/faint` were set token-driven in 2.1;
this task finalizes their visual recipes and the per-cell markup.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| `src/components/Booker.tsx` (calendar section ~324–402, times section ~439–489) | [code] | Day cells, month nav, weekday header, selected/today states, slot rows, 12h/24h toggle, skeletons, empty state, timezone chip |
| `/book?xbc=411&theme=light` / `&theme=dark` | [browser] | Verify calendar + slot states both themes; measure tap targets |

## Dependencies

- Task 2.1 — token-driven `PALETTE`, light default, `data-theme` on the Booker root.

## Blocked By

- Task 2.1

## Research Findings

- From `booker-ux-patterns.md` (§3 Calendar / day grid):
  - Weekday header (line 360) → `.pn-small` muted, `--fg-muted`.
  - Available day (`dayOn`): text `--fg`, hover `background: --pennie-sky-soft` (light) / subtle
    navy-elevated (dark), radius `--radius-sm` (8px).
  - Unavailable day (`dayOff`): `--fg-muted` at low emphasis (~40%), `cursor-default`.
  - Selected day: fill `--pennie-sky-soft`, ring `--pennie-sky` via the `ringStyle` pattern
    (1.5px inset). When no `brandColor`, default the ring to `var(--pennie-sky)` instead of
    `ring-white`/`ring-neutral-900`.
  - **"Today" dot (line 394): emerald → `--pennie-sky` (or `--pennie-green` for "available today").
    This is the single most visible stray color.** The `dotStyle` brandColor override still applies.
  - Prev/next nav (332–356): hover `background: rgba(52,52,52,0.04)` per `.pn-btn--additional:hover`.
- From `booker-ux-patterns.md` (§3 Slot list):
  - Each slot row → outlined button: `background: var(--surface)`, `border: 1px solid var(--border)`,
    `border-radius: var(--radius-md)` (10px), hover `border-color: rgba(52,52,52,0.45)`. Slot dot
    → `--pennie-sky`/`--pennie-green` (not emerald).
  - 12h/24h toggle (line 452) → segmented control: container `border: 1px solid var(--border)`
    radius `--radius-md`; active segment `background: --pennie-sky-soft`, `--fg`; inactive `--fg-muted`.
  - Skeletons (line 467): `animate-pulse` fill → beige/`--pennie-wild-sand` shimmer light,
    `--pennie-ink-2` dark; keep same heights so layout doesn't jump.
  - Surface the active timezone as a labeled chip atop the slot column (it's currently only buried
    in the left meta at line 319). **Visual only — do NOT add a timezone selector (that's logic).**
- From `wcag-accessibility.md`:
  - **Emerald dot on white = 2.54:1 FAIL (3:1 non-text) AND color-only.** Replace color-only dot
    with a non-color cue: append "today" to the cell's accessible name (visually-hidden or as a
    small text marker), and recolor to a token that passes if kept visible.
  - **Selected day:** add `aria-selected`/`aria-current="date"` plus a non-color visual (filled
    pill / bold day number) — not a colored ring alone.
  - **Touch targets:** day cells `aspect-square` (~32–40px on mobile) → enforce `min-height/min-width:
    44px`. Slot buttons `px-3 py-2.5` (~40px) → `py-3`/`min-height:44px`. Month nav `‹ ›` `p-1`
    (~24px) → pad to 44×44 (`p-2.5`+). 12h/24h toggle `px-2 py-1` (~26px) → 44px tall (or accept
    24px+spacing for this dense secondary control, but target 44).
  - **Tabular numerals** on times/dates aids low-vision scanning — apply `font-variant-numeric:
    tabular-nums` (Tailwind `tabular-nums`).
  - Sky/green as a small dot/indicator: a sky dot on white is 1.69:1 (fails 3:1 as a sole UI
    signal) — which is exactly why color must NOT be the only cue. Pairing the dot with text
    ("today" / the available-count in the label) satisfies "color never the sole signal."
- From `pennie-design-system-in-slate`: radii `sm 8px`, `md 10px`; **buttons/cells are NOT pills**;
  `.pn-btn--additional:hover` light wash; no hard borders where a token/shadow reads better.

## Current State (exact references — read before editing)

`src/components/Booker.tsx`:
- **Month header + nav: lines 326–358.** Header `<h2>` (327–330). Prev button (332–344): `disabled`
  when at/before current month, `className="rounded p-1 ${c.muted} ${c.navHover} disabled:opacity-30"`,
  glyph `‹`. Next button (345–356): `className="rounded p-1 ${c.muted} ${c.navHover}"`, glyph `›`.
  Both already have `aria-label="Previous/Next month"` — KEEP those labels.
- **Weekday header row: lines 360–366** — `grid grid-cols-7 ... text-[11px] uppercase tracking-wide
  ${c.faint}`, maps `WEEKDAYS` (`["Sun".."Sat"]`, line 37).
- **Day grid: lines 367–401.** Each cell: `<button>` (375), `disabled={!has}` (377),
  `style={isSelected ? ringStyle : undefined}` (382), className combines (383–389)
  `"relative aspect-square rounded-md text-sm"` + `has ? c.dayOn : c.dayOff` + selected branch
  `${c.daySelected} ${brandColor ? "" : `ring-1 ${c.ring}`}`. Renders `{cell.day}` (391) and the
  **today dot at 392–397**: `<span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2
  rounded-full bg-emerald-500" style={dotStyle} />`.
- **Times pane header + toggle (no slot selected): lines 441–463.** Day label (442–451). 12h/24h
  toggle (452–462): container `flex rounded-md border text-xs ${c.toggleBorder}`, two buttons
  `px-2 py-1 ${hour12 === is12 ? c.toggleOn : c.toggleOff}`.
- **Slot list: lines 464–486.** Loading skeletons (465–468): 6× `<div className="h-10 animate-pulse
  rounded-lg ${c.skeleton}" />`. Empty (469–470): `<p className="text-sm ${c.faint}">No times
  available.</p>`. Slot rows (472–484): `<button ... className="flex w-full items-center gap-2
  rounded-lg border px-3 py-2.5 text-left text-sm ${c.slot}">` with **slot dot at 478–481**:
  `<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" style={dotStyle} />` + `{fmtTime(iso)}`.
- **Timezone:** currently only in the left event panel meta (line 319: `{zone.replace(/_/g, " ")}`).
- The `c.dayOn/dayOff/daySelected/ring/slot/toggleBorder/toggleOn/toggleOff/navHover/skeleton/faint`
  values were already token-driven in 2.1 — refine the markup AND tune those values here if needed.

## Execution Plan

### Step 1: Recolor the two emerald dots + add non-color cues

**Surface:** [code]

- Today dot (lines 392–397): change `bg-emerald-500` → `bg-[var(--pennie-sky)]` (or
  `bg-[var(--pennie-green)]` for the "available today" read — pick green for the positive
  signal and note the choice). KEEP `style={dotStyle}` (brandColor override).
- **Add the non-color cue for "today":** add a visually-hidden text marker to the day button so
  SR users hear it and it's not color-only, e.g. append to the existing day content a
  `<span className="sr-only"> (today)</span>` when `isToday`. (S7: Task 1.2 ships the `.sr-only`
  utility, so use it directly.) This does NOT change logic — `isToday` already exists (line 373).
- Slot dot (lines 478–481): `bg-emerald-500` → `bg-[var(--pennie-sky)]`/`bg-[var(--pennie-green)]`
  (match the today-dot choice). KEEP `style={dotStyle}`.
- Do not introduce raw hex; use token vars.

**Verification:**
- [code] `grep -n "emerald" src/components/Booker.tsx` → 0 matches.
- [browser] Screenshot the calendar with today visible (both themes) → today cell shows a
  sky/green dot, and the a11y snapshot shows "today" in the cell's name.

### Step 2: Selected-day non-color cue + default sky ring

**Surface:** [code]

- Selected-day branch (lines 382–389): keep `c.daySelected` (sky-soft fill from 2.1). Ensure the
  default (no brandColor) ring is `--accent`/sky (the `c.ring` value from 2.1) — the current code
  already only rings when `!brandColor` via `ring-1 ${c.ring}`; confirm `c.ring` is sky-based.
- Add a non-color selected cue: make the selected day number bold/semibold (e.g. add
  `font-semibold` to the className when `isSelected`) so selection is not conveyed by
  fill/ring color alone. Add `aria-selected={isSelected}` and `aria-current={isToday ? "date" :
  undefined}` to the day `<button>` (attributes only — no logic change; `isSelected`/`isToday`
  already computed at 372–373).
- Compose a richer accessible name on the day button: `aria-label` like
  `"<weekday>, <Month> <day><, today if today>"` using the already-available `cell` DateTime.
  Adding the available-slot count is a nice-to-have but optional (avoid recomputing if it risks
  logic creep — the slot count per day is `slotsByDay.get(key)?.length`, already in scope at 371).

**Verification:**
- [browser] Snapshot shows `aria-selected`/`aria-current` on the active day; the selected day reads
  bold + sky-soft (not color-only). Both themes.

### Step 3: Enlarge month-nav + weekday header to Pennie

**Surface:** [code]

- Prev/next buttons (332–356): bump `p-1` → a 44×44 hit area. Suggested:
  `inline-flex h-11 w-11 items-center justify-center rounded-md ${c.muted} ${c.navHover}
  disabled:opacity-30`. KEEP the existing `aria-label`s, the `disabled` condition, and the
  `onClick` handlers (logic untouched). Optionally swap the `‹`/`›` glyphs for the inline chevron
  icon components from Task 1.4 (`src/components/icons/`) if present — otherwise keep the glyphs
  but center them in the larger target.
- Weekday header (360): set `${c.faint}` → muted token (already token-driven from 2.1); keep
  `text-[11px] uppercase tracking-wide` or align to `.pn-small`/`.pn-eyebrow` sizing.

**Verification:**
- [browser] Measure the month-nav button `boundingBox()` → ≥44×44px in both desktop and 390px
  mobile. Snapshot keeps the `Previous month`/`Next month` accessible names.

### Step 4: Day-cell touch target ≥44px

**Surface:** [code]

- Day grid cells (383–389): `aspect-square` can fall below 44px on narrow phones. Add
  `min-h-[44px] min-w-[44px]` (or a responsive size) to the cell button className so each tap target
  is ≥44px at 390px width, while keeping the grid layout. Keep `rounded-md` (8–10px) — NOT a pill.
- Add `tabular-nums` to the day number (and to slot times in Step 5) for low-vision scanning.

**Verification:**
- [browser] Resize to 390×844, screenshot the calendar, measure a day cell `boundingBox()` ≥44px.

### Step 5: Restyle slot rows, toggle, skeletons, empty state + timezone chip

**Surface:** [code]

- Slot rows (472–484): keep the outlined-button look from `c.slot` (2.1: `bg-surface border-border
  text-fg`); bump `py-2.5` → `py-3` (or `min-h-[44px]`) for the 44px target; set hover to
  `hover:border-[rgba(52,52,52,0.45)]` (light) — prefer a token if one exists. Radius `rounded-lg`
  → `rounded-md` (10px) to match the DS slot recipe. Add `tabular-nums` to the time. Keep
  `onClick={() => setSelectedSlot(iso)}` and the dot (recolored in Step 1).
- 12h/24h toggle (452–462): make it a proper segmented control — container `inline-flex rounded-md
  border ${c.toggleBorder}`; each button `px-3 min-h-[36px]` (target ≥24px with spacing; aim
  larger), active `${c.toggleOn}` (sky-soft fill + graphite), inactive `${c.toggleOff}` (muted). Add
  `aria-pressed={hour12 === is12}` to each toggle button (state cue, not color-only; attribute only,
  no logic change).
- Skeletons (465–468): keep `animate-pulse` + heights; the `${c.skeleton}` value (2.1) already
  drives a beige/ink wash. Confirm the wash reads as a calm shimmer in both themes; tune the 2.1
  `skeleton` token if it's too stark.
- Empty state (469–470): keep the `c.faint`→muted text; optionally warm the copy to "No times left
  that day, pick another." (Pennie voice; no dashes per `slate-copy-rules`). Keep it quiet (no big
  illustration — that's reserved for confirmation in 2.4).
- **Timezone chip:** add a small labeled chip atop the slot column (near the day label at 441–451),
  e.g. a `.pn-small` muted line or a 4px-radius chip showing `{zone.replace(/_/g, " ")}` with a
  globe icon. Use the existing `zone` value (line 127). This is display-only; do NOT add a picker.

**Verification:**
- [browser] Screenshot the slot list (a day with slots) both themes: outlined rows on surface, sky
  dot, tabular times, ≥44px rows; segmented 12h/24h toggle with sky-soft active; timezone chip
  visible near the slots. Snapshot shows `aria-pressed` on the toggle.
- [code] `grep -n "emerald\|neutral-" src/components/Booker.tsx` in the calendar/times sections →
  0 matches (any remaining `neutral-`/`red-` belongs to 2.3's form region — note, don't fix here).

## Artifacts to Modify

- `src/components/Booker.tsx` — calendar (month nav 332–356, weekday header 360, day grid 367–401,
  today/slot dots, selected-day cue), times pane (toggle 452–462, skeletons 465–468, empty 469–470,
  slot rows 472–484), add timezone chip near slot list — [code]

## Contracts

### Provides (for downstream tasks)

- Finalized calendar + slot visual recipes and the recolored (sky/green + non-color) indicators —
  2.V verification checks these; 4.4 (focus sweep) and 4.5 (responsive) build on the ≥44px targets.

### Consumes (from upstream tasks)

- 2.1 token-driven `PALETTE` (`dayOn/dayOff/daySelected/ring/slot/toggle*/navHover/skeleton/faint`),
  `data-theme` on the Booker root, light default.
- Task 1.4 icon components (chevron, globe/clock) if present — optional for nav/timezone chip.

## Acceptance Criteria

- [ ] No `emerald-*` anywhere in `Booker.tsx`; today/slot indicators use a sky/green token + a
      non-color cue ("today" text marker; bold + `aria-selected`/`aria-current` on the selected day).
- [ ] Month-nav buttons are ≥44×44px (desktop + 390px); day cells ≥44px at 390px; slot rows ≥44px.
- [ ] 12h/24h is a segmented control with `aria-pressed`; active = sky-soft + graphite.
- [ ] Active timezone surfaced as a labeled chip near the slot list (display-only).
- [ ] Times/dates use `tabular-nums`.
- [ ] Calendar + slots match the DS `preview/` feel in both themes; selected state has a non-color
      signal.
- [ ] No availability/slot/date logic changed (handlers, `disabled` conditions, `slotsByDay`,
      `activeDay`, ResizeObserver untouched). Visual-only.
- [ ] `pnpm build` exits 0; `pnpm lint` clean. All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build` → exit 0; `pnpm lint` → clean.
- `grep -n "emerald" src/components/Booker.tsx` → 0 matches.
- `grep -n "neutral-" src/components/Booker.tsx` → only within the form region (2.3 scope); none in
  the calendar/times sections.

#### [browser] Web Verification
Dev server + warm per `slate-ui-verification` §2 (`xbc=411`, port 3000).
- `/book?xbc=411&theme=light` and `&theme=dark`, desktop 1280×900:
  - Screenshot the calendar (today + a selected day visible) → `reports/screens/book-calendar-light-desktop.png`,
    `…-dark-desktop.png`. Confirm sky/green today dot, sky-soft selected fill + bold day, no emerald.
  - Click a day → click into the day's slots; screenshot the slot list →
    `reports/screens/book-slots-light-desktop.png`. Confirm outlined rows, sky dot, tabular times,
    timezone chip, segmented toggle.
- Resize 390×844: screenshot calendar + slots; measure `boundingBox()` of a day cell, the month-nav
  button, and a slot row → all ≥44px.
- `browser_snapshot` on the calendar: confirm `aria-selected`/`aria-current` on the active/today
  day, `aria-pressed` on the toggle, and the "today" text marker in the today cell's name.

### Cross-Surface Coherence
- Same calendar/slot styling renders via `/book` and `/booking/[id]` entries, both themes.

## Skills to Read

- `pennie-design-system-in-slate` — calendar/slot token recipes, radii (sm/md, NOT pills),
  sky/green vs emerald, 80/15/5, hover washes.
- `slate-ui-verification` — surface→URL matrix, viewport sizes (1280×900 / 390×844), tap-target
  measurement, screenshot naming, color-never-sole-signal checks.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/booker-ux-patterns.md` — §3 calendar/slot
  mapping, §3 toggle/skeleton, timezone-chip recommendation.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — emerald-dot fail,
  selected-day non-color cue, touch-target audit table, tabular-nums.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
`~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md`

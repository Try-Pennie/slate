# Task 2.5: Restyle ManageBooking + reschedule/cancel pages

## Objective

Restyle `ManageBooking.tsx` (the manage / reschedule / cancel flow) and its surrounding route
shells to the Pennie token system in BOTH light and dark, moving every bright `red-600`/`red-200`
to muted rose `#C43D3D`, rebuilding the reschedule slot grid with the same outlined-slot recipe as
the Booker, restyling the Reschedule / Cancel buttons (`.pn-btn--additional` / rose destructive),
and branding the `/book`, `/booking/[id]`, and manage route not-found/missing-config states.
**Visual + a11y-attribute only: the native `confirm()` and all fetch/state logic stay untouched.**

## Context

**S8 — shared-file coordination:** this task edits `src/app/book/page.tsx` (the missing-`xbc` error
~27–32) which Task 2.4 also touches (brandColor passthrough, line 56). Run sequentially with 2.4 (or
coordinate the regions: 2.4 owns line 56, 2.5 owns 27–32) and re-read the file right before editing
so the two edits to `book/page.tsx` don't collide. `ManageBooking.tsx` is this task's own file.

`ManageBooking.tsx` is the post-booking surface a borrower reaches via the manage link. It is the
most neglected: light-only, `text-neutral-600`, and **red-heavy** — a bright `text-red-600`
cancelled-status line (97), a red-bordered red-text Cancel button (114–120), and red error text
(124). The reschedule grid (126–145) is a flat 2/3-col grid of `neutral-200`-bordered time buttons.
The three route files also have bare `text-neutral-500` error states. This task brings all of it
on-brand, reusing 2.3's rose error pattern and 2.2's outlined-slot recipe. The native `confirm()`
dialog (line 85) is logic — leave it; only brand the surrounding chrome.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| `src/components/ManageBooking.tsx` | [code] | Tokenize all `neutral-*`; rose for cancelled/error/Cancel button; reschedule grid → outlined slots; dark theme support; a11y attrs |
| `src/app/booking/manage/[token]/page.tsx` | [code] | Brand the not-found state (line 14–20); pass theme if needed |
| `src/app/book/page.tsx` + `src/app/booking/[id]/page.tsx` | [code] | Brand the missing-`xbc` error states |
| `/booking/manage/<token>` (light + dark) | [browser] | Verify manage/reschedule/cancel both themes (needs a real token) |

## Dependencies

- Task 2.1 — token-driven conventions, `data-theme` theming, light default.
- Task 2.3 — the rose error pattern (`#C43D3D`/`--error` + `role="alert"` + icon) to reuse.
- Task 2.2 — the outlined-slot recipe to reuse for the reschedule grid.

## Blocked By

- Task 2.1

## Research Findings

- From `booker-ux-patterns.md` (§1 + §3 Manage / reschedule): `ManageBooking.tsx` is light-only,
  `text-neutral-600`, with **bright `text-red-600` errors and a red-bordered Cancel button** (lines
  117, 124) — must move to muted rose `#C43D3D`/`--pennie-rose`. Reschedule renders a flat 2/3-col
  grid of time buttons (129–143). Uses a native `confirm()` (line 85) — out of scope to change the
  logic, but the surrounding chrome should be branded. Reschedule slot grid → same outlined-slot
  recipe as the Booker; Reschedule button → `.pn-btn--additional`; **Cancel button + error → muted
  rose** (not `red-600`/`red-200`); status line `.pn-small` muted; cancelled state uses the rose
  token. `/book` missing-config error (page line 27) is bare `text-neutral-500` — brand it.
- From `wcag-accessibility.md`:
  - rose `#C43D3D` on beige = 4.77:1, on white = 5.14:1, white-on-rose (filled) = 5.14:1 — all PASS.
  - Errors must not be color-only or silent: add a leading icon + `role="alert"`.
  - Destructive Cancel: don't rely on red alone; the verb-phrase label ("Cancel booking") + rose +
    an icon carry the meaning. Targets ≥44px on the action buttons + reschedule slot buttons.
  - Cancelled status: pair the rose with text (it already says "This booking is cancelled.") — keep
    the text, recolor to rose; that satisfies color-never-sole-signal.
- From `pennie-design-system-in-slate`: `.pn-btn--additional` (outlined, transparent, 1px `--border`)
  for Reschedule; errors = muted rose on 12% tint; buttons 16px (`--radius-xl`)/`.pn-btn--small`
  (40px, 12px) — NOT pills; both themes via `data-theme`; status pills = `--radius-pill` (badges
  only). Status colors in JSX ternaries (e.g. line 96 `status === "cancelled" ?`) are NOT caught by
  a globals.css swap — convert each explicitly while preserving the conditions.
- From `slate-copy-rules` (memory, via the SKILL §7): no dashes/em-dashes in user-facing copy; never
  name "Cadence". "Reschedule" / "Cancel booking" are fine verb phrases.

## Current State (exact references — read before editing)

`src/components/ManageBooking.tsx` (light-only, no theme prop today):
- **Container (93):** `<div className="mx-auto max-w-xl p-6">`. Heading `<h1 className="text-lg
  font-semibold tracking-tight">{eventName}</h1>` (94).
- **Status line (95–104):** `<p className="mt-1 text-sm text-neutral-600">`; cancelled branch
  `<span className="text-red-600">This booking is cancelled.</span>` (97); otherwise `{fmt(...)}`
  + `<span className="text-neutral-400">({timeZone})</span>` (100–101).
- **Action buttons (106–122):** Reschedule `<button … className="rounded-md border border-neutral-300
  px-4 py-2 text-sm hover:border-neutral-500">` (108–113); **Cancel `<button onClick={cancel}
  disabled={busy} className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-600
  hover:border-red-400 disabled:opacity-60">Cancel booking</button>`** (114–120).
- **Error (124):** `{error && <p className="mt-4 text-sm text-red-600">{error}</p>}`.
- **Reschedule grid (126–145):** wrapper `border-t border-neutral-200 pt-6` (127); label
  `text-sm font-medium` (128); grid `grid grid-cols-2 gap-2 sm:grid-cols-3` (129); each slot
  `<button … className="rounded-md border border-neutral-200 px-2 py-2 text-xs hover:border-neutral-500
  disabled:opacity-60">{timeLabel(...)}</button>` (131–139); empty `<p className="text-sm
  text-neutral-400">No times available.</p>` (140–141).
- **Logic to NOT touch:** `cancel()` with `confirm("Cancel this booking?")` (84–90), `reschedule()`
  (64–82), the availability fetch effect (53–60), all state. `done` (62) gates the action row.
- **No `theme` prop / no `data-theme`** — this component is light-only today; add dark support.

`src/app/booking/manage/[token]/page.tsx`:
- **Not-found state (14–20):** `<main className="p-8 text-sm text-neutral-500">We couldn't find that
  booking.</main>`. Renders `<ManageBooking token bucketCode startsAt status eventName />` (22–30) —
  does NOT pass a theme.

`src/app/book/page.tsx` (line 27–32) and `src/app/booking/[id]/page.tsx` (line 28–34): identical
missing-`xbc` error `<main className="p-8 text-sm text-neutral-500">This booking link is missing its
configuration (no <code>xbc</code>).</main>`.

## Execution Plan

### Step 1: Add dark-theme support + tokenize the container/heading/status

**Surface:** [code]

- `ManageBooking.tsx` is light-only. Add `data-theme` support so it honors both themes. Simplest
  approach consistent with 2.1: wrap the root in `data-theme={theme}` where `theme` comes from a new
  optional prop defaulting to `"light"` (e.g. `theme = "light"` in the props) so the route can pass
  it, OR rely on the page/`<html>` `data-theme` if Phase 1/3 sets it app-wide. Prefer a `theme` prop
  defaulting to light to mirror the Booker and keep the surface self-contained. **Adding an optional
  presentational prop with a default is not a contract change to existing callers** (the route call
  at page line 22–30 keeps working). Confirm with the route file.
- Container (93): `bg-bg text-fg` (beige/graphite light, navy/beige dark via semantic vars). Heading
  (94): `.pn-h3`/`.pn-h4` or `text-fg font-semibold`. Status line (95–104): `text-fg-muted`
  (`.pn-small` muted), timezone span (100–101) `text-fg-muted`.

**Verification:**
- [browser] Manage page renders beige/light by default and navy/dark when themed; no `neutral-*` in
  the container/heading/status.

### Step 2: Rose for cancelled status + error

**Surface:** [code]

- Cancelled status span (97): `text-red-600` → rose. **S1: reference the 1.2 token by name —
  `text-[var(--error)]` (= `--pennie-rose` = `#C43D3D`); do NOT inline a raw `#C43D3D` literal.**
  KEEP the text "This booking is cancelled." (text + rose = color-never-sole-signal). Preserve the
  `status === "cancelled"` condition.
- Error line (124): `text-red-600` → rose; reuse 2.3's pattern — add `role="alert"` + a leading error
  icon (`aria-hidden`). KEEP the `{error}` conditional.

**Verification:**
- [code] `grep -n "red-600\|red-200\|red-400\|border-red" src/components/ManageBooking.tsx` → 0.
- [browser] A cancelled booking shows rose status; an error shows rose `role="alert"` with icon.

### Step 3: Restyle the action buttons

**Surface:** [code]

- Reschedule button (108–113): `.pn-btn--additional` (outlined, transparent, 1px `--border`,
  graphite label, hover wash) at a ≥44px target (`min-h-[44px]`, `rounded-md`/`rounded-xl` per DS —
  NOT a pill). KEEP `onClick={() => setRescheduling((v) => !v)}` and the "Reschedule"/"Close" label.
- Cancel button (114–120): destructive but calm — outlined with the **rose** token border + rose
  label (`border-[var(--error)] text-[var(--error)] hover:bg-[rgba(196,61,61,0.06)]`), ≥44px,
  `disabled:opacity-60`. Add a leading icon (optional) so it's not rose-only. KEEP `onClick={cancel}`,
  `disabled={busy}`, and the verb-phrase label "Cancel booking". The native `confirm()` inside
  `cancel()` is untouched.

**Verification:**
- [browser] Reschedule = on-brand outlined button; Cancel = muted-rose destructive button (not bright
  red); both ≥44px; both themes.

### Step 4: Reschedule slot grid → outlined-slot recipe

**Surface:** [code]

- Wrapper (127): `border-t border-neutral-200` → `border-t border-border`. Label (128): `text-fg`.
- Slot buttons (131–139): reuse the Booker's outlined-slot recipe (2.2) — `bg-surface border-border
  text-fg rounded-md`, hover `border-[rgba(52,52,52,0.45)]`, `min-h-[44px]`, `tabular-nums` on the
  time, `disabled:opacity-60`. KEEP `onClick={() => reschedule(iso)}`, `disabled={busy}`, the
  `slots.slice(0, 30)` map, and the `timeLabel` output.
- Empty state (140–141): `text-neutral-400` → `text-fg-muted`; optionally warm to "No times left,
  pick another." (no dashes). Keep the `slots.length === 0` condition.

**Verification:**
- [browser] Open Reschedule → the slot grid reads like the Booker's slots (outlined, surface,
  tabular times, ≥44px); both themes; no `neutral-*`.

### Step 5: Brand the route not-found / missing-config states

**Surface:** [code]

- `src/app/booking/manage/[token]/page.tsx` not-found (14–20): `text-neutral-500` → on-brand —
  `bg-bg text-fg-muted` centered with a `.pn-small`/`.pn-body` message; optionally a calm Pennie
  touch (no big illustration). Keep the copy meaning; no dashes. If you added a `theme` prop to
  `ManageBooking`, pass it (or leave default light) at 22–30.
- `src/app/book/page.tsx` (27–32) + `src/app/booking/[id]/page.tsx` (28–34) missing-`xbc` error:
  `text-neutral-500` → `text-fg-muted` on `bg-bg`, on-brand `.pn-small`/`.pn-body`. Keep the `<code>
  xbc</code>` reference and the conditional. These are server components; do not add client logic.

**Verification:**
- [browser] `/booking/manage/bogus-token` → branded not-found; `/book` (no `xbc`) → branded
  missing-config; both on beige with muted graphite text, PP Mori.

## Artifacts to Modify

- `src/components/ManageBooking.tsx` — dark support + tokenize container/heading/status (93–104);
  rose cancelled + error + `role="alert"` (97, 124); action buttons (108–120); reschedule grid
  (127–145) — [code]
- `src/app/booking/manage/[token]/page.tsx` — branded not-found (14–20); pass theme if added (22–30) — [code]
- `src/app/book/page.tsx` — branded missing-`xbc` (27–32) — [code]
- `src/app/booking/[id]/page.tsx` — branded missing-`xbc` (28–34) — [code]

## Contracts

### Provides (for downstream tasks)

- A fully on-brand manage/reschedule/cancel surface (both themes) + branded route error states —
  2.V, 5.1/5.2 verify; consistent rose/slot conventions complete the consumer-surface set.

### Consumes (from upstream tasks)

- 2.1 token conventions + `data-theme`; 2.3 rose error pattern; 2.2 outlined-slot recipe; Task 1.4
  icons (error icon) if present.

## Acceptance Criteria

- [ ] Manage / reschedule / cancel render on-brand in BOTH light and dark (no `neutral-*` left).
- [ ] Every `red-600`/`red-200`/`red-400`/`border-red-*` replaced with the 1.2 rose token referenced
      by name (`var(--error)` / `--pennie-rose`; no raw `#C43D3D` literal); cancelled status + error
      keep their text (color-never-sole-signal); error is a `role="alert"`.
- [ ] Reschedule = `.pn-btn--additional` outlined; Cancel = muted-rose destructive; both ≥44px.
- [ ] Reschedule slot grid uses the Booker's outlined-slot recipe with `tabular-nums`, ≥44px slots.
- [ ] Route not-found / missing-`xbc` states are branded (beige, muted graphite, PP Mori).
- [ ] No fetch/state/`confirm()`/reschedule/cancel logic changed (visual + a11y attrs + an optional
      presentational `theme` prop only).
- [ ] `pnpm build` exits 0; `pnpm lint` clean. All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build` → exit 0; `pnpm lint` → clean.
- `grep -n "neutral-\|red-600\|red-200\|red-400\|border-red" src/components/ManageBooking.tsx` → 0.
- `grep -n "neutral-500" src/app/book/page.tsx src/app/booking/[id]/page.tsx src/app/booking/manage/[token]/page.tsx` → 0.

#### [browser] Web Verification
Dev server + warm per `slate-ui-verification` §2. **Manage needs a real `manage_token`** (§8): first
complete a booking via `/book?xbc=411` and reuse its token, or get one from the user. Without a valid
token the page renders the (now-branded) not-found state — screenshot that as the edge case.
- `/booking/manage/<token>?…` (or however the page reads the token) at 1280×900, light + dark:
  screenshot the manage view → `reports/screens/manage-light-desktop.png` (+ `dark`). Confirm
  on-brand heading/status, rose-aware cancelled state.
- Click Reschedule → screenshot the slot grid (`reports/screens/manage-reschedule-light-desktop.png`):
  outlined slots, tabular times, ≥44px, both themes.
- Cancel button: screenshot showing the muted-rose destructive style (do not actually cancel a needed
  booking unless using a throwaway token).
- Error path: trigger a reschedule/cancel failure if feasible → rose `role="alert"`.
- Branded error states: `/booking/manage/bogus`, `/book` (no `xbc`) → screenshots.
- axe on the manage view → `reports/axe/manage-light.axe.json`, 0 violations (`color-contrast`,
  `button-name`, `region`).

### Cross-Surface Coherence
- The rose error pattern matches 2.3 (Booker); the reschedule slot recipe matches 2.2 (Booker slots).

## Skills to Read

- `pennie-design-system-in-slate` — `.pn-btn--additional`, rose errors, both-theme `data-theme`,
  status-color-in-JSX-ternary pitfall, no pills, voice rules.
- `slate-ui-verification` — surface→URL matrix (#4 manage + the real-token note in §8), screenshot
  naming, axe injection, acceptance gate.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/booker-ux-patterns.md` — §1 + §3 Manage /
  reschedule details, §4 errors, §6 copy.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — rose contrast,
  destructive-action non-color cue, targets.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
`~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md`

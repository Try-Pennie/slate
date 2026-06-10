# Task 2.4: Confirmation delight + brandColor default

## Objective

Turn the plain `confirmed` screen into the one calm delight moment of the booking flow: the
standalone confirmation gets the iridescent Pennie `pic-1-coins.png` graphic in a sky-soft/green-wash
panel with warm concrete copy and the timezone in the recap; the **embedded** confirmation (the
`embedded` flag) gets a lightweight inline check-badge/smile SVG puck instead (performance + iframe
latency). Animate opacity/transform ONLY (never height — protects the embed ResizeObserver), honor
`prefers-reduced-motion`, and make the embed pass **Pennie sky as the default brandColor** when the
host sends no `brand` param (host override preserved). **Visual-only: no booking, postMessage, or
embed-contract logic changes.**

## Context

**S8 — shared-file coordination:** Tasks 2.2, 2.3, 2.4 all edit `src/components/Booker.tsx`. This
task owns the `confirmed` view (~263–278) + the brandColor defaults (~130–134) and also edits
`src/app/book/page.tsx`. Run sequentially after 2.2/2.3 (or with coordinated, non-overlapping
regions); re-read the file right before editing and keep changes within the confirmed-view region so
the calendar (2.2) and form (2.3) edits don't collide.

After 2.1–2.3, the booking flow is on-brand up to submit. The `confirmed` screen (lines 263–278) is
still completely plain ("You're booked" + date/time + invite line). DISCOVERY D16 specifies exactly
ONE delight moment, calm, split by surface: heavy iridescent graphic standalone, lightweight SVG in
the embed. This task also lands D14's "embed explicitly passes Pennie sky as the default brandColor"
behavior. This is the warmest, highest-emotion screen and the riskiest for the embed (height
animation would jitter the iframe), so the ResizeObserver and reduced-motion guards are load-bearing.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| `src/components/Booker.tsx` (confirmed view ~263–278; brandColor defaults ~130–134) | [code] | Standalone graphic + embed SVG puck (branch on `embedded`); warm copy + timezone recap; calm opacity/transform entrance; reduced-motion; default brandColor → sky |
| `/book?xbc=411` standalone (light + dark) | [browser] | Complete a booking → confirm graphic + animation + reduced-motion |
| `/embed-example.html` modal | [browser] | Complete a booking in the embed → confirm SVG puck, no iframe resize jump |

## Dependencies

- Task 2.1 — token-driven palette, light default, `data-theme` root, brandColor inline mechanism.
- Task 1.4 — inline icon components (`CheckBadgeIcon` / `SmileIcon`) for the embed puck.
- Task 1.1 — `pic-1-coins.png` vendored to `public/brand/pic-1-coins.png`.

## Blocked By

- Task 2.1

## Research Findings

- From `booker-ux-patterns.md` (§5 the ONE delight moment): delight lives ONLY on `confirmed`,
  motion stays calm. Recommended illustration: **`pic-1.png` (floating coins)** — soft iridescent
  sky+gold, reads as "value/done," finance-appropriate (`pic-3` ribbon is the celebratory
  alternative). Avoid people-photo illustrations here. A small sky-washed puck with
  `check-badge.svg`/`smile.svg` in graphite is the tasteful lightweight alternative (esp. embed).
  Note: `icon-smile-yellow.png` is just a peach circle, NOT a face — use the SVG.
- From `booker-ux-patterns.md` recipe: panel surface `--pennie-green-wash` (`#F0F9F1`) or
  `--pennie-sky-soft`; graphic ~96–160px on top; heading `.pn-h3`/`.pn-h4` SemiBold ("You're booked"
  / "You're all set" / "See you then"); recap line date · time · **timezone** in `.pn-body`/`.pn-small`
  muted, `tabular-nums` on the time; sub-line keeps the calendar-invite reassurance, warm in
  `--fg-muted`. Motion: single gentle entrance, graphic fades+rises ~8–12px over ~300–400ms, easing
  `cubic-bezier(.2,.8,.2,1)`; NO confetti/loops/bounce; respect `prefers-reduced-motion`; **animate
  opacity/transform only (not height)** for embed safety.
- From `wcag-accessibility.md` (§4 reduced-motion + §5 SR): under reduced-motion render the final
  composed frame statically (opacity only, no transform) — use a `useReducedMotion()` JS branch if
  JS drives the animation, not CSS alone. The confirmed `<h2>` should receive focus (`tabindex="-1"`
  + `.focus()`) and the success be announced via a live region ("Booked. Sarah will call you …").
  Success green as TEXT fails on light (green-deep 2.44:1) — use graphite/charcoal text + a green
  check ICON (color reinforcing, not carrying meaning). Promote a single logical heading.
- From `slate-embed-contract` SKILL (D16 + ResizeObserver): branch on the `embedded` flag —
  standalone = heavy iridescent graphic; embed = lightweight inline SVG ONLY (do NOT ship the heavy
  graphic in the iframe). **The confirmation delight must animate `opacity`/`transform` ONLY, never
  `height`** — a height animation continuously fires the ResizeObserver and posts a moving
  `scrollHeight`, jittering the iframe. (D14) The embed explicitly passes **Pennie's sky as the
  default `brandColor`**; a host may still override via `ui.brandColor` — it is NOT sky-only-ignore.
- From `pennie-design-system-in-slate` (§6 delight split): standalone → `pic-1` coins PNG; embed →
  inline `CheckBadgeIcon`/`SmileIcon` in a sky-soft puck (zero image weight). The `check-badge.svg`
  tick is a hardcoded `#F9F6F0` literal (designed-in on-puck contrast) — keep the literal, color the
  circle via `currentColor`. Honor `prefers-reduced-motion`.

## Current State (exact references — read before editing)

`src/components/Booker.tsx`:
- **brandColor defaults: lines 130–134.** `dotStyle`/`ringStyle`/`confirmStyle` are all `brandColor
  ? {…} : undefined`. **There is no default sky brandColor today** — when `brandColor` is undefined,
  the dots/ring fall back to the palette (now sky/green after 2.2) and the CTA to `c.confirm` (sky
  after 2.1/2.3). For D14, the **embed entry should pass sky as the default `brand` param** (see
  Step 4 — this is best done in `/book/page.tsx`, not by faking a brandColor in the component, to
  keep the standalone non-embed surfaces clean and the override semantics intact).
- **`embedded` prop: line 123** (`embedded = false`) — the branch key for graphic-vs-SVG.
- **ResizeObserver: lines 188–199** — posts `slate:resize` `scrollHeight`; deps include `confirmed`
  (line 199). DO NOT modify; just ensure the confirmation animation never changes layout height.
- **`confirmed` view: lines 263–278.** Root `<div ref={rootRef} className={shell}>` (265) — keep
  `ref={rootRef}` and the `data-theme` from 2.1. Inner `<div className="p-10 text-center">` (266)
  with `<h2 className="text-lg font-semibold ${c.title}">You&apos;re booked</h2>` (267), date/time
  `<p className="mt-2 text-sm ${c.muted}">` (268–271) using `DateTime.fromISO(confirmed.start)
  .setZone(zone).toFormat("cccc, LLL d")` + `fmtTime(confirmed.start)`, and the invite line
  `<p className="mt-1 text-xs ${c.faint}">A calendar invite is on its way to {attendee.email || "your
  email"}.</p>` (272–274).
- `zone` (127), `fmtTime` (213–218), `attendee` (142) all in scope for the recap.
- `setConfirmed(...)` + the `slate:bookingSuccessful` postMessage: lines 241–249 — LOGIC, do not touch.

`src/app/book/page.tsx`:
- **brandColor passthrough: line 56** — `brandColor={first(sp, "brand") || undefined}`. For D14
  default-sky: when the embed sends no `brand`, default to Pennie sky here (host override preserved).
- `src/app/booking/[id]/page.tsx` does NOT pass `brandColor` (path entry, standalone) — leave it so
  the standalone path surface keeps the palette default (no forced sky tint beyond the CTA).

## Execution Plan

### Step 1: Branch the confirmed view on `embedded`

**Surface:** [code]

- In the `confirmed` view (263–278), keep the root `<div ref={rootRef} className={shell}
  data-theme={theme}>`. Inside the centered panel, branch on `embedded`:
  - **Standalone (`!embedded`):** render `pic-1-coins.png` via `<img src="/brand/pic-1-coins.png"
    alt="" aria-hidden="true" width={160} height={160} />` at ~96–160px, on a sky-soft or green-wash
    rounded panel (`rounded-xl bg-[var(--pennie-sky-soft)]` or `--pennie-green-wash`).
  - **Embedded (`embedded`):** render a lightweight sky-soft puck containing an inline
    `CheckBadgeIcon`/`SmileIcon` (from Task 1.4) — `<span className="inline-flex h-16 w-16
    items-center justify-center rounded-full bg-[var(--pennie-sky-soft)] text-[var(--accent)]">
    <CheckBadgeIcon …/></span>`. The `check-badge` tick stays its `#F9F6F0` literal; the circle
    inherits `currentColor`. **No heavy PNG in the embed.**
- Keep the surface a positive calm wash; do NOT use a solid sky fill (80/15/5).

**Verification:**
- [browser] Standalone shows the coins graphic; embed shows the SVG puck (see Step 5 walk).

### Step 2: Warm copy + timezone recap + a11y heading/announce

**Surface:** [code]

- Heading (267): keep/warm to a `.pn-h3`/`.pn-h4` SemiBold "You're booked" (or "You're all set").
  Make it the focus target: `tabIndex={-1}` + a ref that `.focus()`es on mount (a small `useEffect`
  keyed on `confirmed` — this is an a11y affordance, not booking logic; keep it minimal). Ensure one
  logical heading per the confirmed screen.
- Recap (268–271): keep the date/time; **add the timezone** to the line (e.g. append `({zone.replace
  (/_/g, " ")})`), `tabular-nums` on the time, `.pn-body`/`.pn-small` muted. Use graphite/muted text
  + the green/sky icon for the positive read (NOT green text — green-deep fails 2.44:1 on light).
- Sub-line (272–274): keep the calendar-invite reassurance; warm it, e.g. "A calendar invite is on
  its way to {email}." Concrete Pennie voice; **no dashes** (`slate-copy-rules`); never name
  "Cadence". (The brief's example "Sarah will call you Thursday at 2:00" is illustrative — only use a
  name if it's actually in scope/data; otherwise keep the email reassurance.)
- Add a visually-hidden `aria-live="polite"` (or `role="status"`) announcement of the success, e.g.
  "Booked. <day>, <date> at <time> <tz>. A calendar invite is on its way." Mount it within the
  confirmed render.

**Verification:**
- [browser] Snapshot shows the confirmed `<h2>` receives focus and a live region announces success;
  recap includes the timezone with tabular numerals.

### Step 3: Calm entrance animation (opacity/transform only) + reduced-motion

**Surface:** [code]

- Animate a single gentle entrance: the graphic/puck + copy fade in (opacity 0→1) and rise
  (transform `translateY(8–12px)`→0) over ~300–400ms, easing `cubic-bezier(.2,.8,.2,1)`. **Never
  animate `height`/`max-height`/`margin`/anything that changes layout height** — the embed
  ResizeObserver (188–199) posts `scrollHeight` and a height animation jitters the iframe.
- Implement via CSS keyframes/transition or Framer Motion if available. If JS-driven, branch on
  `useReducedMotion()` and render the final static frame under reduce. **S9: rely on the global
  `@media (prefers-reduced-motion: reduce)` guard authored in Task 1.2's `globals.css` (it already
  exists before this task lands) which zeroes animation/transition durations — do NOT add a second
  guard here.** Critically (S11): set the delight's RESTING state to the final visible frame and
  animate FROM a start state, so when the 1.2 guard disables the animation the content is fully
  visible (never `opacity:0` waiting on a disabled animation). NO confetti, NO loops, NO bounce; one
  reveal then still. (Task 4.4 verifies this; it does not re-edit this component.)

**Verification:**
- [browser] Normal: the entrance plays once (opacity/transform). With `browser_emulate_media
  reducedMotion=reduce`: the final frame renders instantly (no transform animation) →
  `reports/screens/confirm-light-reducedmotion.png`. `browser_evaluate` getComputedStyle on the
  delight element: `animationName === 'none'` or `animationDuration ~ '0s'` under reduce.

### Step 4: Default the embed brandColor to Pennie sky (D14)

**Surface:** [code]

- In `src/app/book/page.tsx` line 56: when the host sends no `brand` param, default to Pennie sky so
  the embed explicitly passes sky through; keep the host override. E.g.
  `brandColor={first(sp, "brand") || "#82D0FF"}` — OR, to avoid a raw hex in app code, default only
  when `embed=1` and prefer a shared constant; the SKILL allows sky as the embed default. (`#82D0FF`
  is the canonical sky value; if a shared constant exists, use it.) Do NOT add a default brandColor
  to `/booking/[id]/page.tsx` (standalone path entry keeps the palette default — the CTA is already
  sky via 2.1/2.3; forcing a brandColor tint on dots/ring everywhere would over-sky the standalone
  surface and break 80/15/5).
- Confirm the override still works: passing `&brand=<hex>` still tints dots/ring/avatar/CTA as before
  (the inline `dotStyle`/`ringStyle`/`confirmStyle` mechanism from 2.1 is untouched).

**Verification:**
- [browser] `/book?xbc=411&embed=1` (no brand) → indicators read Pennie sky (the explicit default);
  `/book?xbc=411&embed=1&brand=%23FF8800` → indicators tint orange (override preserved).

### Step 5: Embed end-to-end (ResizeObserver safety)

**Surface:** [browser]

- Via the embed (`/embed-example.html` modal, or `/book?xbc=411&embed=1`), complete a booking to
  reach the embedded confirmation. Confirm the lightweight SVG puck renders (NOT the coins PNG) and
  the iframe height does NOT jump/jitter during the entrance animation (the `slate:resize` posts a
  stable `scrollHeight` because only opacity/transform animate).

**Verification:**
- [browser] Screenshot the embedded confirmation puck; watch the console for `slate:resize` +
  `slate:bookingSuccessful` still firing; confirm no resize jitter mid-animation.

## Artifacts to Modify

- `src/components/Booker.tsx` — confirmed view: branch graphic/puck on `embedded`, warm copy +
  timezone recap, focus + live-region announce, calm opacity/transform entrance + reduced-motion
  (263–278); add a small focus `useEffect` keyed on `confirmed` — [code]
- `src/app/book/page.tsx` — default `brandColor` to Pennie sky when no `brand` (line 56) — [code]

## Artifacts Consumed (must exist)

- `public/brand/pic-1-coins.png` (Task 1.1)
- `CheckBadgeIcon`/`SmileIcon` in `src/components/icons/` (Task 1.4)

## Contracts

### Provides (for downstream tasks)

- The completed confirmation delight (both surfaces) + reduced-motion behavior — 2.V, 4.4, 5.1/5.2
  verify it; 4.1/4.2 (embed chrome) assume the embedded confirmation is the lightweight SVG.
- The embed default-sky brandColor — 4.1 (chrome stays fixed Pennie regardless), 4.x verification.

### Consumes (from upstream tasks)

- 2.1 palette/`data-theme`/brandColor mechanism; 1.1 `pic-1-coins.png`; 1.4 icon components; Phase 1
  global reduced-motion guard.

## Acceptance Criteria

- [ ] Standalone confirmation shows the `pic-1-coins.png` graphic in a sky-soft/green-wash panel;
      embed confirmation shows the lightweight inline SVG puck (NO heavy PNG in the iframe).
- [ ] Warm concrete copy; recap includes the timezone with `tabular-nums`; success announced via a
      live region; the confirmed heading receives focus.
- [ ] Entrance animates opacity/transform ONLY (never height); single calm reveal; honored under
      `prefers-reduced-motion` (static final frame).
- [ ] Embed iframe does NOT resize/jitter during the confirmation animation (ResizeObserver intact).
- [ ] Default brandColor = Pennie sky when no `brand` param on the embed entry; host override still
      works; standalone path entry unchanged.
- [ ] No booking/postMessage/embed-contract logic changed (visual-only; `setConfirmed`,
      `slate:resize`, `slate:bookingSuccessful`, `rootRef` untouched).
- [ ] `pnpm build` exits 0; `pnpm lint` clean. All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build` → exit 0; `pnpm lint` → clean.
- `grep -n "rootRef\|slate:resize\|slate:bookingSuccessful" src/components/Booker.tsx` → confirm the
  ResizeObserver/postMessage blocks are unchanged (same lines/behavior).
- Confirm no `height`/`max-height` animation in the confirmed view (grep the new animation code).

#### [browser] Web Verification
Dev server + warm per `slate-ui-verification` §2.
- **Standalone:** `/book?xbc=411&theme=light` → complete a booking (day → slot → fill form →
  Confirm) → confirmation. Screenshot → `reports/screens/confirm-light-desktop.png` (+ `dark`).
  Confirm coins graphic, warm copy, timezone, focus on heading.
- **Reduced-motion:** `browser_emulate_media reducedMotion=reduce`, repeat → static frame →
  `reports/screens/confirm-light-reducedmotion.png`; `browser_evaluate` confirms no transform
  animation.
- **Embed:** `/embed-example.html` → open modal → complete booking → confirm SVG puck, no iframe
  resize jitter; console shows `slate:resize` + `slate:bookingSuccessful`.
  Screenshot → `reports/screens/embed-confirm-desktop.png`.
- **brandColor default:** `/book?xbc=411&embed=1` (no brand) shows sky indicators; `&brand=%23FF8800`
  overrides to orange.
- axe on the confirmation view → `reports/axe/book-confirm-light.axe.json`, 0 violations.

### Cross-Surface Coherence
- Standalone vs embed confirmations carry the SAME warm copy/recap; only the graphic differs
  (heavy PNG standalone, light SVG embed). Animation behavior identical (opacity/transform, reduced-
  motion).

## Skills to Read

- `pennie-design-system-in-slate` — §6 delight split (pic-1 standalone / SVG puck embed), green/sky
  wash, check-badge literal tick, reduced-motion.
- `slate-embed-contract` — D16 embed delight split, D14 default-sky brandColor, the ResizeObserver
  opacity/transform-only rule, `embedded` flag branch.
- `slate-ui-verification` — booking-flow walk, reduced-motion emulation, embed verification, axe,
  screenshot naming.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/booker-ux-patterns.md` — §5 the ONE delight
  moment, the confirmation recipe + motion spec, §6 copy.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — §4 reduced-motion
  (JS branch), §5 focus-to-heading + live-region announce, green-as-text fail.
- `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md` — ResizeObserver +
  iframe height behavior (context for the opacity/transform-only rule).

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
`~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md`

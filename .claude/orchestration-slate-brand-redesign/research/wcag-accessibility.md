# WCAG 2.1 AA + Extra Care Accessibility - Research

**Wave**: First
**Researcher**: Accessibility (WCAG 2.1 AA + extra care) domain agent
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code + Browser (verification)

---

## Summary

The Pennie palette is mostly safe by a wide margin (graphite/navy text pairings clear 4.5:1 easily, and the marquee question — **graphite text on the sky CTA — passes at 7.36:1**). But there are four concrete failures that the redesign must engineer around: (1) **sky/sky-deep cannot be used as text or as a hairline UI indicator on beige/white** (1.57:1 / 2.67:1), so the sky focus glow alone does **not** meet the 3:1 non-text-contrast rule on light surfaces and needs a darker companion outline; (2) the current `bg-emerald-500` slot/today dots fail on light (2.54:1) and rely on color as the sole signal; (3) `--accent-press` (sky-deep) under graphite text drops to 4.32:1 — a borderline normal-text fail on the pressed CTA; (4) `--pennie-muted` on beige is a pass but only by 0.48 (4.98:1), so it must never get lighter. The current `Booker.tsx` is the bigger liability: it has no calendar/listbox semantics, no live regions, an unlabeled form (placeholder-only inputs), sub-44px targets, and animations that ignore `prefers-reduced-motion`.

## Key Findings

### 1. Contrast — exact ratios (WCAG 2.x relative-luminance, sRGB)

Computed with the official formula (`(L1+0.05)/(L2+0.05)`, linearized sRGB channels). Thresholds: **4.5:1** normal text, **3:1** large text (>=24px, or >=18.66px bold) and non-text UI/graphics (1.4.11).

#### Critical pairings — PASS

| Pairing | Hex | Ratio | Normal 4.5 | Large/UI 3.0 |
|---|---|---|---|---|
| Graphite text on beige (body) | `#343434` on `#F9F6F0` | **11.54:1** | PASS | PASS |
| Charcoal-2 strong text on beige | `#1F1F1F` on `#F9F6F0` | **15.28:1** | PASS | PASS |
| **PRIMARY CTA: graphite on sky** | `#343434` on `#82D0FF` | **7.36:1** | **PASS** | PASS |
| CTA label on hover sky (`--accent-hover #6dc5f7`) | `#343434` on `#6DC5F7` | **6.51:1** | PASS | PASS |
| White text on navy band | `#FFFFFF` on `#1D212F` | **16.02:1** | PASS | PASS |
| Beige text on navy (`--fg-on-ink`) | `#F9F6F0` on `#1D212F` | **14.85:1** | PASS | PASS |
| Graphite on white card | `#343434` on `#FFFFFF` | **12.45:1** | PASS | PASS |
| Muted text on white surface | `#6A6A70` on `#FFFFFF` | **5.37:1** | PASS | PASS |
| **Muted text on beige** | `#6A6A70` on `#F9F6F0` | **4.98:1** | **PASS (tight)** | PASS |
| Error rose on beige | `#C43D3D` on `#F9F6F0` | **4.77:1** | PASS (tight) | PASS |
| Error rose on white | `#C43D3D` on `#FFFFFF` | **5.14:1** | PASS | PASS |
| White on error rose (filled) | `#FFFFFF` on `#C43D3D` | **5.14:1** | PASS | PASS |
| Graphite on yellow / mint (decor) | on `#FFD073` / `#86E7B3` | 8.61 / 8.36:1 | PASS | PASS |

**Headline answer to the brief's core question:** graphite `#343434` on sky `#82D0FF` = **7.36:1 — passes AA for normal text with comfortable headroom.** No darker sky is required for the resting CTA. Keep `--fg-on-sky: graphite`.

#### Critical pairings — FAIL (must fix)

| Pairing | Hex | Ratio | Verdict |
|---|---|---|---|
| **Pressed CTA: graphite on sky-deep** (`--accent-press`) | `#343434` on `#439FE1` | **4.32:1** | **FAIL for normal text** (passes large 3:1 only). The 16px button label is normal text. |
| **White label on sky** (if ever used as alt CTA) | `#FFFFFF` on `#82D0FF` | **1.69:1** | FAIL hard. Never put white text/icons on sky. |
| **Sky as text/icon on beige** | `#82D0FF` on `#F9F6F0` | **1.57:1** | FAIL. Sky is decorative-only on light. |
| **Sky as text/icon on white** | `#82D0FF` on `#FFFFFF` | **1.69:1** | FAIL. |
| **Sky-deep as text on beige / white** | `#439FE1` | 2.67 / 2.88:1 | FAIL for body text. |
| **Sky focus ring vs beige** (1.4.11 non-text) | `#82D0FF` on `#F9F6F0` | **1.57:1** | **FAIL 3:1.** The sky glow alone is not a sufficient focus indicator on light surfaces. |
| **Sky focus ring vs white** | `#82D0FF` on `#FFFFFF` | **1.69:1** | FAIL 3:1. |
| Green-deep on beige | `#00B67A` on `#F9F6F0` | 2.44:1 | FAIL (success-text color needs a darker tone or paired icon). |
| **Current emerald dot on white** (`bg-emerald-500` in Booker) | `#10B981` on `#FFFFFF` | **2.54:1** | FAIL 3:1 — and it is a color-only signal (see Finding 6). |
| Mercury border on white / beige | `#E3E3E5` | 1.28 / 1.19:1 | "FAIL 3:1" but this is fine: decorative card hairlines are exempt; only borders that are the *sole* means of identifying a control/state need 3:1. |

#### Proposed compliant adjustments

- **Pressed/active CTA (4.32:1 fail):** do not darken the fill to `--accent-press` under graphite. Two clean options — (a) keep the fill at sky/`--accent-hover` and signal press with the existing `transform: translateY(1px)` + shadow only (no color change); or (b) if a darker press fill is wanted, cap it at `--accent-hover #6dc5f7` (6.51:1) which still reads as "pressed" via the translate. Reserve `sky-deep` for large/decorative use only.
- **Sky as a focus ring on light (1.57:1 fail):** the sky glow stays as the *aesthetic* layer, but pair it with a **dark outline** that carries the 3:1 burden. Recommended focus token for light surfaces: `outline: 2px solid #343434` (graphite-on-beige = 11.54:1) **plus** the existing `0 0 0 3px var(--focus-ring)` sky glow as `box-shadow`. On navy surfaces the sky ring alone is fine (sky-on-navy = 9.47:1) — keep sky there. See Finding 2.
- **Sky/sky-deep as text or standalone icons on light:** forbid. If a blue text/link/icon is needed on beige/white, the palette's `--pennie-blue #486CCA` is the only blue that passes: **4.56:1 on beige, 4.91:1 on white.** Use it for icon-as-information and links; keep sky for fills only.
- **Computed "minimum darkening" if a sky-derived text tone is ever required:** interpolating sky->navy, you need ~50–55% toward navy to clear 4.5:1 (e.g. `#4A708D`/`#507897` ≈ 4.7–4.9:1). Simpler to just use `--pennie-blue`.
- **Success/green:** `--pennie-green-deep #00B67A` fails as text on light (2.44:1). For the confirmation "booked" state use graphite/charcoal text + a green check *icon* (color reinforcing, not carrying meaning), or darken to a green that clears 4.5:1 on beige if green text is required.
- **Muted text guardrail:** `--pennie-muted` passes at 4.98:1 on beige / 5.37:1 on white but the beige margin is thin. Never set muted secondary text below 16px-on-a-lighter-bg without re-checking, and never use muted for anything load-bearing (errors, required-field hints).

### 2. Focus indicators

- **System default** (`colors_and_type.css`): `.pn-btn:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }` where `--focus-ring: rgba(130,208,255,0.45)`, plus global `:focus-visible { outline-color: var(--focus-ring); }`.
- **Against navy:** sky-on-navy = 9.47:1 — excellent, exceeds 3:1 (WCAG 2.4.11/2.4.13). Keep as-is on dark surfaces.
- **Against beige/white:** the sky ring is 1.57:1 / 1.69:1 — **below the 3:1 SC 2.4.11 "Focus Appearance" / 1.4.11 requirement.** A borrower tabbing through the booker on the default beige theme could lose track of focus. This is the single most important focus fix.
- **Recommendation — theme-aware focus token.** Define `--focus-ring-line` (the contrast-carrying outline) separately from `--focus-ring` (the soft glow):
  - Light theme: `outline: 2px solid var(--fg) /* graphite, 11.5:1 */; outline-offset: 2px; box-shadow: 0 0 0 4px var(--focus-ring);`
  - Dark/navy theme: `outline: 2px solid var(--accent) /* sky, 9.5:1 */; box-shadow: 0 0 0 4px var(--focus-ring);`
- **Extra care:** meet SC 2.4.13 "Focus Appearance" (AAA, but the brief asks for extra care) — the indicator should be at least a 2px-thick perimeter and have >=3:1 against adjacent colors. The 2px graphite/sky outline satisfies this. Ensure `outline-offset` does not get clipped by `overflow: hidden` on the booker shell (`overflow-hidden rounded-2xl` currently clips child outlines at the edge — use `box-shadow` rings for edge-adjacent controls, or remove the clip).
- Never `outline: none` without a replacement. The Booker's day/slot/nav buttons currently inherit only Tailwind's default ring (or nothing) — wire them all to the `.pn-*` focus recipe.

### 3. Keyboard navigation — calendar, timeslots, multi-step form

Current `Booker.tsx` renders the month as a 7-col grid of `<button>`s and times as a vertical `<button>` list. They are focusable but lack roving-tabindex/grid semantics, so a keyboard/SR user tabs through every day individually with no arrow-key movement and no announced structure.

- **Date grid — APG "Date Picker Dialog" / grid pattern.** Wrap cells in `role="grid"` with `role="row"`/`role="gridcell"`; put a single button per cell. Implement **roving tabindex**: only the active day is `tabindex="0"`, the rest `tabindex="-1"`. Arrow keys move day-by-day (Left/Right), Up/Down move by week, Home/End to week start/end, PageUp/PageDown change month, and the month nav buttons (`‹ ›`) stay in the tab order with `aria-label` (they already have `aria-label="Previous/Next month"` — good). Disabled days: keep them focusable-skippable via `aria-disabled` rather than the native `disabled` so SR users still hear "unavailable" rather than the control vanishing — but for a booking grid, `disabled` (current approach) is acceptable if the empty state is announced.
- **Time slots — APG Listbox or radiogroup.** Model the slot list as `role="listbox"` (single-select) with `role="option"` + `aria-selected`, or a radiogroup. Arrow Up/Down to move, Enter/Space to choose. This also gives the SR a count ("listbox, 6 options").
- **Multi-step form (slot -> name/email/phone -> confirm):** when a slot is chosen and the form panel swaps in, **move focus** to the panel heading (or first input) and announce the step. The "‹ Back" control must be a real `<button>` (it is) with an accessible name ("Back to time selection"). On the 409 "time taken" path, focus should move to the error and the slot list be re-announced. Trap nothing — this is inline, not a modal — but in the **embed `widget.js` modal**, implement a focus trap, restore focus to the trigger on close, and close on `Esc`.
- **12h/24h toggle:** model as a `role="radiogroup"` or `aria-pressed` toggle buttons (currently plain buttons with no pressed state).
- **Tab order sanity:** event panel -> month nav -> date grid -> time list -> form. Verify no positive `tabindex`.

### 4. prefers-reduced-motion

The redesign introduces entry/float/hover animations and a confirmation "delight moment." Honor SC 2.3.3 (AAA, in scope for extra care).

- Global guard in `globals.css`:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
      scroll-behavior: auto !important;
    }
  }
  ```
- **Per-effect intent:** entry/float animations -> replace with an instant fade-to-final-state (opacity only, no transform) under reduced-motion. Hover `transform`/scale -> drop the transform, keep color change. The `.pn-btn:active { transform: translateY(1px) }` micro-motion is fine (sub-perceptual) but include it in the guard for consistency.
- **Confirmation delight moment:** this is the highest risk (looping/float illustration, confetti, etc.). Under reduced-motion, render the **final composed frame statically** — show the illustration + "Nice. Sarah will call you Thursday at 2:00." copy with no looping/parallax/confetti. Never auto-play looping motion >5s without a pause control (2.2.2). Use Framer Motion's `useReducedMotion()` hook (or CSS) to branch — do not rely solely on disabling via CSS if JS drives the animation.
- The Booker's loading skeleton uses Tailwind `animate-pulse`; the global guard above neutralizes it (pulse is a gentle opacity loop — acceptable, but reduced-motion users get a static placeholder, which is correct).

### 5. Screen reader — labeling & live regions

Current `Booker.tsx` gaps: inputs are **placeholder-only** (no `<label>`, no `aria-label`) which fails SC 1.3.1/3.3.2 and disappears on focus; the calendar has no role/structure; loading and confirmation states are silent to SR users; the confirmed state swaps the whole subtree with no announcement.

- **Form fields:** give each input a real `<label>` (visually-hidden if the design wants placeholder-style) or `aria-label`, plus `autocomplete` tokens for a stressed borrower on mobile: name -> `autocomplete="name"`, email -> `type="email" autocomplete="email" inputmode="email"`, phone -> `type="tel" autocomplete="tel" inputmode="tel"`. Mark required fields with `aria-required` and, on error, `aria-invalid` + `aria-describedby` pointing at the message.
- **Date grid:** each day button `aria-label="Thursday, June 12 — 4 times available"` (compose from the slot count); the grid container `aria-label="Choose a day"`. Mark the selected day with `aria-selected`/`aria-current="date"` (not color alone — see Finding 6). The "today" dot needs a textual equivalent: append "today" to that cell's label.
- **Time list:** `role="listbox" aria-label="Available times for Thursday, June 12"`; each option `aria-label` = the formatted time. Announce the count.
- **Live regions (the missing piece):**
  - Availability loading -> a visually-hidden `aria-live="polite"` region announces "Loading available times…" then "6 times available for Thursday, June 12" / "No times available this month."
  - Month change -> announce the new month and availability.
  - Booking submit -> "Booking your call…" (polite), then **confirmation** moved to focus + announced: "Booked. Sarah will call you Thursday, June 12 at 2:00 PM. A calendar invite is on its way." The confirmed `<h2>` should receive focus (`tabindex="-1"` + `.focus()`).
  - Errors (409 / generic) -> `role="alert"` (assertive) so the "That time was just taken" message interrupts. Currently it is a plain `<p class="text-red-500">` — silent and color-only.
- **Headings:** keep one logical `<h1>` (event name) per booker; calendar/times use `<h2>`. The confirmation screen currently uses `<h2>` with no `<h1>` — promote or ensure page-level `<h1>` exists.
- **Icons:** decorative SVGs already use `aria-hidden="true"` (good). Any icon that conveys state (success check, error) needs a text equivalent.

### 6. Color is never the sole signal

Spots where Slate currently/likely encodes meaning in color only, with fixes:

- **Selected day:** today indicated by a colored ring + `c.daySelected` background only. Add `aria-selected`/`aria-current` and a non-color visual: a filled pill, a checkmark, or bold + underline on the day number.
- **"Today" dot:** `bg-emerald-500` 1×1 dot (also a contrast fail at 2.54:1). Replace color-only dot with the word "today" (visually-hidden for SR + a small text marker or ring), and recolor to a token that passes if kept visible.
- **Available vs unavailable days:** currently available = darker text + hover, unavailable = faint + `cursor-default`. Lightness difference alone is weak. Add the availability count to the label and/or a small "•" that also appears in the accessible name; disabled days get `aria-disabled`/`disabled` so state is programmatic, not just visual.
- **Best-match / round-robin "recommended" agent (if surfaced in redesign):** never indicate "best match" with a colored highlight alone — add a text badge ("Soonest" / "Recommended") with an icon.
- **Errors:** muted-rose text is the only error cue today. Add a leading error icon + `role="alert"` + put the message adjacent to the field via `aria-describedby`. Do not rely on red.
- **Selected time slot:** when chosen, reinforce with a checkmark/`aria-selected`, not just a border/background change.

### 7. Touch targets (44×44 CSS px, SC 2.5.5 / extra care)

Audit of current `Booker.tsx` sizing vs the 44px target:

| Control | Current size | 44px? | Fix |
|---|---|---|---|
| Day cell | `aspect-square` in a 7-col grid (~32–40px on mobile) | Likely **NO** on small/narrow embeds | Enforce `min-height/min-width: 44px` per cell, or pad the grid; the date picker is the densest hit area. |
| Time slot button | `px-3 py-2.5 text-sm` -> ~40px tall | **Marginal/NO** | Bump to `py-3` / `min-height: 44px`. |
| Confirm button | `py-2.5` -> ~40px | Marginal | Use `.pn-btn--big` (56px) per brand spec — comfortably passes. |
| Month nav `‹ ›` | `p-1` -> ~24px | **NO** | These are the worst offenders. Pad to 44×44 (`p-2.5`+) with the glyph centered. |
| 12h/24h toggle | `px-2 py-1` -> ~26px | **NO** | Pad to 44px tall, or accept as a low-frequency control with adequate spacing (SC 2.5.5 AAA wants 44; 2.5.8 AA wants 24px minimum with spacing — meet 24 at minimum, target 44). |
| Inputs | `py-2` -> ~38px | Marginal | `py-3` -> 44px. |

The brand's `.pn-btn--big` (56px) and `.pn-btn--small` (40px) bracket the target — primary actions should use `--big`. Note WCAG 2.1 AA's actual SC is **2.5.5 (AAA, 44px)**; the AA-level **2.5.8 Target Size (Minimum)** is 24px-with-spacing. The brief asks for 44px+ "extra care," so target 44 for all primary/calendar controls and accept 24+spacing only for dense secondary toggles.

## Recommended Approach

1. **Lock the contrast rules into tokens, not vibes.** Keep `--fg-on-sky: graphite` (7.36:1 confirmed). Add a forbid-list comment: no white/sky/sky-deep text on light; no graphite on sky-deep for normal text; blue text/icons on light must use `--pennie-blue #486CCA`. Cap the pressed-CTA fill at `--accent-hover`, not `--accent-press`.
2. **Theme-aware focus token.** Split the soft glow (`--focus-ring`) from a contrast-carrying line: graphite 2px outline on light, sky 2px outline on navy, both with the sky glow as `box-shadow`. Fix the `overflow-hidden` clipping on the booker shell so edge controls' outlines are visible.
3. **Rebuild Booker semantics:** date grid as APG date-picker grid (roving tabindex + arrow keys + composed `aria-label`s incl. availability count and "today"); time list as listbox/radiogroup; labeled+autocompleted form; focus management between steps; `role="alert"` errors; `aria-live="polite"` region for loading/availability/confirmation.
4. **Reduced-motion guard** global + a `useReducedMotion()` branch for the confirmation delight (static final frame).
5. **Color-never-alone:** add text/icon to selected day, today, availability, slot selection, and errors; recolor the emerald dots to a passing token or replace with shape/text.
6. **Touch targets:** min 44px on day cells, slots, month nav, inputs; primary CTA uses `.pn-btn--big` (56px).
7. **Verify in-browser, not just by eye** (Finding: Tooling below).

## Tooling to verify later (current, specific)

| Tool | What it catches | How to run |
|---|---|---|
| **axe-core 4.x** (`@axe-core/playwright`) | DOM-level WCAG (labels, roles, contrast, aria) | Add to Playwright (already in stack per brief): `import AxeBuilder from '@axe-core/playwright'; const r = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(r.violations).toEqual([]);` Run per booker step + both themes + embed. |
| **Playwright** (already connected via MCP) | keyboard nav, focus order, focus-visible, target size | Scripted `page.keyboard.press('Tab'/'ArrowRight')` walks; assert `:focus-visible` element; measure `boundingBox()` >= 44. Snapshot focus rings on beige & navy. |
| **Lighthouse** (in Chrome DevTools / `lighthouse` CLI / CI via LHCI) | accessibility score, contrast, names, ARIA, tap targets | `npx lighthouse http://localhost:3000/book --only-categories=accessibility --view`. Note: Lighthouse a11y is a subset — pair with axe. |
| **axe DevTools** browser extension | manual exploratory, "needs review" items | Run interactively on each surface; covers things automation misses. |
| **WebAIM Contrast Checker / APCA-aware tools** | spot-check pairings, large-text thresholds | webaim.org/resources/contrastchecker. For future-proofing, APCA (WCAG 3 draft) via apcacontrast.com — informational only; AA compliance is still WCAG 2.x ratios above. |
| **Pa11y / pa11y-ci** | CI gate alternative to LHCI | `pa11y http://localhost:3000/book` in the pipeline. |
| **VoiceOver (macOS) + NVDA (Windows)** | real SR behavior: announcements, live regions, grid nav | Manual: tab through booker, confirm loading/confirmation/error are spoken; verify date grid announces availability. Automation can't fully replace this. |
| **prefers-reduced-motion emulation** | motion guard | Playwright `await page.emulateMedia({ reducedMotion: 'reduce' })` then assert no transform animation on entry/confirmation. DevTools Rendering panel for manual. |
| **Repro contrast script** | exact ratios in CI | The Python script used here lives at `/tmp/contrast.py`; consider committing a `scripts/test-contrast.ts` (per the project's `scripts/test-*.ts` convention) that asserts the token pairings programmatically so a future token edit can't silently regress contrast. |

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Keep sky-only focus ring everywhere | matches brand "sky = action", simplest | fails 3:1 (1.4.11/2.4.11) on beige/white — borrowers lose focus | Rejected (light surfaces) |
| Graphite/sky theme-aware outline + sky glow | passes 3:1 on both themes, keeps the brand glow as decoration | one extra token, branch by theme | **Recommended** |
| Darken the sky CTA fill for "safety" | intuitive | unnecessary — graphite-on-sky already 7.36:1; darkening to sky-deep *breaks* normal-text AA (4.32) | Rejected |
| Use `--pennie-blue` for sky text on light | only blue that passes (4.56/4.91) | not the "action" hue | Recommended for text/icons; keep sky for fills |
| Native `disabled` on unavailable days | simplest, removes from tab order | SR users don't hear "unavailable" | Acceptable for booking if empty/availability state is announced via live region |
| APCA (WCAG 3) instead of WCAG 2 ratios | better perceptual model | not normative; brief targets WCAG 2.1 AA | Use WCAG 2.x for compliance, APCA informational only |

## Pitfalls and Edge Cases

- **`overflow-hidden` on the booker shell clips focus outlines** of edge-adjacent controls (month nav, last column). Use `box-shadow` rings there or relax the clip.
- **Embed `brandColor` host override** can produce *any* contrast against graphite/white. The current `confirmStyle` forces `color:#fff` on the brand fill — if the host passes a light brand color, white text fails. Mitigation: compute luminance of the incoming `brandColor` at runtime and pick graphite-vs-white label automatically; clamp/warn if the chosen color can't reach 4.5:1 with either.
- **Dark theme is the embed default** today (`theme = "dark"`), but the brand default is beige/light — verify focus/contrast in BOTH; sky ring is fine on navy, not on beige.
- **Placeholder-as-label** (current inputs) fails for SR and low-vision (placeholder grays out, vanishes on input). Always pair with a real/visually-hidden label.
- **`text-red-500` error** is a Tailwind default, not the brand `#C43D3D`, and it's color-only + silent. Switch to the rose token + `role="alert"` + icon.
- **Tabular numerals** (brand spec) on times/dates also aids low-vision scanning — apply `font-variant-numeric: tabular-nums`.
- **Confirmation delight loop** must not exceed 5s of auto motion without control (SC 2.2.2) and must collapse to a static frame under reduced-motion.
- **Muted-on-beige is a thin pass (4.98:1)** — any future lightening of beige or muted breaks it. Guard with the committed contrast test.
- **`aria-live` regions must exist in the DOM before the text changes** — inserting the region and its text in the same render often isn't announced. Mount the empty live region on initial render.

## References

- WCAG 2.1 SC 1.4.3 Contrast (Minimum, AA 4.5:1/3:1): https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
- WCAG 2.1 SC 1.4.11 Non-text Contrast (3:1 for UI/focus/graphics): https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html
- WCAG 2.2 SC 2.4.11/2.4.13 Focus Appearance: https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html
- WCAG SC 2.5.5 Target Size (44px, AAA) & 2.5.8 Target Size Minimum (24px, AA): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- WCAG SC 2.3.3 Animation from Interactions / prefers-reduced-motion: https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions.html
- ARIA Authoring Practices — Date Picker Dialog & Grid: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/
- ARIA Authoring Practices — Listbox / Radiogroup: https://www.w3.org/WAI/ARIA/apg/patterns/listbox/
- axe-core Playwright: https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- Source files: `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css`, `~/Documents/Slate/src/components/Booker.tsx`, `~/Documents/Slate/.impeccable.md`
</content>
</invoke>

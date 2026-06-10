# Booking Widget UX Patterns - Research

**Wave**: First
**Researcher**: First-wave research agent — booking widget UX patterns (Slate brand redesign)
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code + Browser (verification)

---

## Summary

Slate's `Booker.tsx` is already a competent three-pane Cal.com-style booker (event panel · month calendar · timeslot/form), with cache-first availability, embed `postMessage` resize, light/dark palettes, and a `brandColor` override. Its UX bones are good; what's missing is Pennie's warmth — it reads as neutral grayscale (neutral-950 dark default, emerald dots, white/black CTAs). This research maps each Booker state to concrete Pennie tokens and `.pn-*` recipes from the exported design system, anchors the flow against Cal.com/Calendly best practice, and specifies ONE calm delight moment for the confirmation screen. The redesign is visual-only: no state machine, props, or fetch logic changes.

The single most important correction up front: **the locked "16px buttons (NOT pills)" decision matches the *actual exported CSS*, not the README prose.** `colors_and_type.css` defines `--radius-xl: 16px` and `.pn-btn--big { border-radius: var(--radius-xl) }` — i.e. the shipped button radius is already 16px. The README's "buttons are pill-shaped (radius 40 or 999)" text is stale; the CSS supersedes the markdown per the PROJECT-BRIEF ("design system files supersede the markdown skill on conflicts"). Build against the CSS values below.

## Key Findings

### 1. Current Booker anatomy (what we're restyling)

File: `src/components/Booker.tsx`. Confirmed structure:

- **Shell** (`Booker.tsx:261`): `mx-auto max-w-4xl rounded-2xl border` + per-theme `shell`. Dark default (`theme = "dark"`, line 124) — this is the #1 brand mismatch; Pennie default is beige/light.
- **Three-column grid** (line 284): `md:grid-cols-[260px_1fr_240px]` — event panel · calendar · times/form. Stacks to one column on mobile (`grid-cols-1`).
- **Event panel** (lines 286–322): avatar puck with org initials (line 287), bucket name eyebrow, event title (`h1`, line 294), description, then a meta stack — `ClockIcon` duration, `PhoneIcon` phone, `GlobeIcon` timezone (lines 302–321). Icons are hand-rolled inline SVGs (lines 94–116).
- **Calendar** (lines 325–402): month header + prev/next nav (`‹`/`›` glyph buttons, lines 332–356; prev disabled at current month), Sun-first weekday row (line 360), 7-col day grid (line 367). Days: `dayOn`/`dayOff`/`daySelected`, a `ring` on the active day, and an emerald "today" dot (line 394). `brandColor` overrides dot/ring via inline `dotStyle`/`ringStyle` (lines 132–133).
- **Times / form pane** (lines 405–489): when no slot selected → day label + 12h/24h toggle (lines 452–462) + scrollable slot list (each slot = bordered row with emerald dot + time, lines 472–484); when a slot is selected → Back link, slot summary, three text inputs (name/email/phone, lines 417–428), error line, Confirm button (lines 430–437).
- **States**: `loading` → 6 skeleton bars (`animate-pulse`, line 467); empty day → "No times available." (line 470); `error` → `text-red-500` line (line 429), including the 409 "just taken" race message (line 251); `submitting` → "Booking…" + disabled (line 436); `confirmed` → success card (lines 263–278).
- **Confirmed screen** (lines 263–278): centered, "You're booked", date/time line, "A calendar invite is on its way to {email}." This is the delight target — currently completely plain.
- **Embed coupling**: a `ResizeObserver` posts `slate:resize` height to the host (lines 188–199) and `slate:bookingSuccessful` on confirm (lines 244–249). **Any restyle must not change `scrollHeight` behavior or remove `rootRef`** — height drives the iframe. Avoid layout that animates height unpredictably (see Pitfalls).

The two other surfaces are far plainer and need full Pennie treatment:
- `/book` page (`src/app/book/page.tsx`): the missing-config error (line 27) is bare `text-neutral-500`.
- `ManageBooking.tsx`: light-only, `text-neutral-600`, **bright `text-red-600` errors and red-bordered Cancel button** (lines 117, 124) — must move to muted rose `#C43D3D`/`--pennie-rose` (see §4). Reschedule renders a flat 2/3-col grid of time buttons (lines 129–143). Uses a native `confirm()` dialog (line 85) — out of scope to change logic, but the surrounding chrome should be branded.

### 2. Strong booking-flow UX (Cal.com / Calendly) — what works and why

Referenced against Cal.com (open source; the user keeps it as a *reference, not to copy* — memory `calcom-reference`) and Calendly conventions:

- **Three-pane "event → calendar → times" layout** (Cal.com's `Booker`): keeps the *what/who* persistently visible (left rail) while the user navigates *when* (calendar) and *which* (slots). Slate already mirrors this — keep it. Why it works: the context column reduces second-guessing ("am I booking the right thing?") and anchors trust.
- **Progressive disclosure of the form**: Cal.com and Slate both defer the name/email form until *after* a slot is picked. This is correct — asking for PII before showing value (an available time) hurts completion. Keep the slot→form transition.
- **Calendar + timeslot column, not a giant week grid**: for a single duration/round-robin pool, a month picker + day's slot list (Calendly's default) is lower cognitive load than Google-Calendar-style week views. Slate's choice is right.
- **Timezone made explicit and changeable**: Calendly/Cal.com always show the active timezone near the slots and let the user change it. Slate *shows* the zone (event panel, line 319) and auto-detects via `Intl` (line 32) but offers **no picker**. Best practice = show it prominently next to the time list, not just buried in the left meta. Low-risk visual win: surface the zone as a labeled chip atop the slot column. (Adding an actual zone *selector* is logic — defer; the brief is visual-only.)
- **12h/24h toggle** (Slate line 452): good, matches Cal.com. Keep, restyle as a `.pn`-style segmented control.
- **"Today" affordance + disabled past nav** (Slate lines 334, 393): correct. Cal.com disables past months and dots/marks today.
- **First-available auto-select**: Slate auto-derives the first available day (`firstAvailable`, line 180) so the slot column is never empty on load — better than Calendly's "pick a day first" blank. Keep.
- **Loading = skeletons, not spinners** (Slate line 466): matches modern Cal.com. Skeletons preserve layout and reduce perceived wait. Keep; restyle skeleton fill to a beige shimmer.
- **Confirmation = clear recap + next step**: Calendly's confirmation restates date/time/timezone and says "a calendar invite has been sent." Slate does this (lines 268–274). Best practice adds a single celebratory but calm visual + a clear "what happens next." This is our delight slot (§5).
- **Mobile**: Cal.com collapses to a single column, calendar first then slots; tap targets ≥44px. Slate stacks at `md` (768px). Pennie guidance is **stack at 640px** (README §5) — consider aligning the stack breakpoint and ensure day cells + slots meet 44px (today's `aspect-square` day cells in a 7-col grid can fall below 44px on small phones — see Pitfalls).

### 3. Mapping each Booker state → Pennie tokens & `.pn-*` recipes

All values from `colors_and_type.css` (canonical source). Use CSS vars / Tailwind `@theme` tokens, never raw hex (brief §8). Tokens below are the literal var names.

**Surfaces & shell**
- Default surface: `--bg` = `--pennie-beige` (`#F9F6F0`). Card surface: `--surface` = `--pennie-white`. The booker shell becomes a `.pn-card`-style surface: `background: var(--surface)`, `border-radius: var(--radius-md)` (10px) or `--radius-lg` (12px) for the large outer shell, `box-shadow: var(--shadow-xs)`. Drop the `border-neutral-*`; Pennie cards lean on soft shadow, not hard borders. Outer shell can sit on a beige page.
- Dark theme: map to `--bg-ink` = `--pennie-navy` (`#1D212F`), text `--fg-on-ink` = beige, elevated panels `--pennie-ink-2`. **Beige is the default**; dark is the embed `theme="dark"` path only.
- Panel dividers: replace `border-neutral-800/200` with `--border` (`rgba(52,52,52,0.16)`) on light, `--border-ink` (`rgba(246,246,246,0.2)`) on dark.

**Type** (event panel)
- Event title (`h1`, line 294) → `.pn-h3` (26/600) or `.pn-h4` (22/600) at booker scale; it's a card title. Use SemiBold 600, never 700.
- Bucket name eyebrow (line 293) → `.pn-eyebrow` (14/600, `--fg-muted`).
- Description (line 298) → `.pn-small` or `.pn-body` in `--fg-muted`.
- Meta rows → `.pn-small`, icon in `--fg-muted`.
- "One display per screen" rule: the booker has no display; the largest type is the event title. Fine.

**Avatar puck** (line 287)
- Replace `bg-neutral-*` with a color-washed puck per the product-icon convention (README §3.1): `--pennie-sky-soft` fill, `--pennie-graphite` initials. Do NOT fill it with `confirmStyle`/brandColor solid (current line 289 does) on the *avatar* — keep the wash subtle; reserve solid sky for the CTA only (80/15/5 rule).

**Icons**
- Swap the three hand-rolled inline SVGs (Clock/Phone/Globe) for the vendored set where available: `assets/icons/Phone.svg` (bold set) exists. There's no clock/globe in the export's UI set, so keep clean 2px-stroke `currentColor` inline SVGs matching the system's stroke style (the smile/search/check examples use ~1.6–2px stroke). Tint with `--fg-muted`.

**Calendar / day grid**
- Weekday header (line 360): `.pn-small` muted, `--fg-muted`.
- Available day (`dayOn`): text `--fg`, hover `background: --pennie-sky-soft` (light) / a subtle navy-elevated on dark. Radius `--radius-sm` (8px).
- Unavailable day (`dayOff`): `--fg-muted` at low emphasis (≈40%), `cursor-default`.
- Selected day (`daySelected` + ring): selected fill `--pennie-sky-soft`, ring → `--pennie-sky` via the existing `ringStyle` pattern (1.5px inset). When no `brandColor`, default the ring to `var(--pennie-sky)` instead of today's `ring-white`/`ring-neutral-900`.
- "Today" dot (line 394): change emerald (`bg-emerald-500`) → `--pennie-sky` (or `--pennie-green` for a positive "available today" read). This is the single most visible stray color. The existing `dotStyle` brandColor override still applies.
- Prev/next nav buttons (lines 332–356): use `assets/icons/chevron-right.svg` / `arrow-right.svg` (mirror for prev) instead of `‹`/`›` glyphs; hover `background: rgba(52,52,52,0.04)` per `.pn-btn--additional:hover`.

**Slot list** (lines 472–484)
- Each slot row → outlined button: `background: var(--surface)`, `border: 1px solid var(--border)`, `border-radius: var(--radius-md)` (10px), hover `border-color: rgba(52,52,52,0.45)` (matches the form-field hover in `forms.html`). Slot dot → `--pennie-sky`/`--pennie-green` (not emerald).
- 12h/24h toggle (line 452): segmented control — container `border: 1px solid var(--border)` radius `--radius-md`; active segment `background: --pennie-sky-soft`, `--fg`; inactive `--fg-muted`.

**Form fields** (inputs, lines 417–428)
- Per `forms.html`: height ~52px (currently `py-2` ≈ 40px — bump to meet the 48–52px system spec and the 44px target rule), `border-radius: --radius-sm` (8px), `background: var(--surface)`, placeholder `rgba(52,52,52,0.45)`, text `--fg`. **Focus = sky ring**: `outline: 3px solid var(--focus-ring)` (`rgba(130,208,255,0.45)`), `outline-offset: 2px` — this is the system's global focus treatment (`:focus-visible`, CSS line 291). Add visible `field__label`s (12–14/600) above inputs rather than placeholder-only, for SR + the system's labeled-field convention.

**Primary CTA — the "Confirm" button** (lines 430–437)
- This is the one place sky lives. Recipe = `.pn-btn .pn-btn--big .pn-btn--primary`:
  - `background: var(--accent)` = `--pennie-sky` (`#82D0FF`); **label color `--fg` = graphite** (`#343434`) — graphite-on-sky is the locked pairing, confirmed by `.pn-btn--primary { color: var(--fg) }` and `--fg-on-sky: --pennie-graphite`. (Current code uses white text on the brand fill, line 134 — change to graphite.)
  - `height: 56px`, `padding: 0 24px`, `border-radius: var(--radius-xl)` = **16px** (the locked spec).
  - Hover: `background: var(--accent-hover)` (= `--pennie-sky-deep`, `#439FE1`). Active: `transform: translateY(1px)`.
  - **Include the arrow icon** — every primary CTA that advances a flow gets the right-arrow (`assets/icons/arrow-right.svg`; the exact path is in `buttons.html:190`), and it nudges `translateX(4px)` on hover (`buttons.html:45`). Copy stays a verb phrase: "Confirm booking" / "Book my call" (see §6).
  - `embed brandColor` override: keep `confirmStyle` but set `color` to graphite by default (only invert to white if the chosen brandColor is dark — out of scope to auto-contrast; safest is to keep graphite and let hosts pass light brand colors).
- Secondary/Back actions → `.pn-btn--additional` (transparent, 1px `--border`) or `.pn-btn--link` (text-only, with a left arrow for "Back").

**Skeletons** (line 467)
- `animate-pulse` fill → `--pennie-cream-3`/`--pennie-wild-sand` shimmer on light, `--pennie-ink-2` on dark. Same heights so layout doesn't jump.

**Manage / reschedule** (`ManageBooking.tsx`)
- Reschedule slot grid → same outlined-slot recipe as the booker. Reschedule button → `.pn-btn--additional`. **Cancel button + error text → muted rose** (see §4), not `red-600`/`red-200`. Status line uses `.pn-small` muted; cancelled state uses the rose token.

### 4. Error / empty states in the Pennie system

- **Error color is muted rose, never bright red.** Token to add/use: rose `#C43D3D` (per brief §7 + SKILL.md "Bright pure-red error states — muted rose (#C43D3D) with 12% tint"). The `forms.html` error swatch uses `#E25C3F`; prefer the brief's canonical `#C43D3D` for text/borders with a 12% tint fill for error containers. Replace every `text-red-500`/`text-red-600`/`border-red-*` in `Booker.tsx` (line 429) and `ManageBooking.tsx` (lines 100, 117, 124, 141 area).
- **Error field state** (from `forms.html`): label + input border + hint all shift to the rose; hint is 12px below the field. Apply to the booking form if a field is invalid (visual only).
- **Empty "No times available."** (lines 470, 141): warm it up — `.pn-small` in `--fg-muted`, optionally a small calm graphic (e.g. a single muted brand object) + an optimistic nudge: "No times left this day — try another." Keep it quiet (no big illustration; that's reserved for confirmation).
- **The 409 "just taken" race** (line 251): keep the message; style it as an inline rose notice with a soft `--pennie-rose-wash` (12% tint) background pill, since it auto-reloads slots. This is good UX already — just brand it.

### 5. The ONE delight moment (confirmation screen)

Per the locked decision, delight lives ONLY on `confirmed` (lines 263–278), and motion must stay calm.

**Recommended illustration**: the iridescent 3D brand graphics are the calmest, most on-brand "success" device and read on all three surfaces (beige/sky/navy — confirmed in `graphics.html`). Best fits:
- **`assets/brand/graphics/pic-1.png` (floating coins)** — verified: soft iridescent sky+gold coins on transparent bg. Reads as "value / done," subtle, finance-appropriate.
- **`assets/brand/graphics/pic-3.png` (iridescent ribbon)** — verified: calm flowing sky→gold ribbon, the system's flagship hero piece. Slightly more celebratory; good if you want one warm flourish.
- Avoid the people-photo illustrations (`brand/illustrations/3.png`, `5.png`) here — they carry their own sticky-note stats and would compete with the recap.
- `assets/icon-smile-yellow.png` is **just a peach/orange circle** (verified — not a face); the actual smile is `assets/icons/smile.svg` (a clean line smiley). A small sky-washed puck with `smile.svg` (or `check-badge.svg`) is a tasteful lightweight alternative if a full graphic feels too heavy in an embed.

**Confirmation recipe**:
- Surface: `--pennie-green-wash` (`#F0F9F1`) or `--pennie-sky-soft` panel — a positive, calm wash (mint/green = "positive moments" per README §2.1).
- Top: the chosen brand graphic (`pic-1` or `pic-3`) at ~96–160px, or a sky-soft puck with `check-badge.svg`/`smile.svg` in graphite.
- Heading → `.pn-h3`/`.pn-h4` SemiBold: keep "You're booked" (warm, verb-adjacent) — or strengthen to "You're all set" / "See you then" (§6).
- Recap line: date · time · **timezone** (add the zone here for clarity, matching Calendly), `.pn-body`/`.pn-small` muted, tabular-nums on the time.
- Sub-line: keep the calendar-invite reassurance; warm copy in `--fg-muted`.
- Optional secondary `.pn-btn--link` "Add to calendar" style affordance is out of scope (logic) — don't add.

**Motion (calm)**:
- A single, gentle entrance: graphic fades+rises ~8–12px over ~300–400ms with the system's easing `cubic-bezier(.2,.8,.2,1)` (used for the button arrow, `buttons.html:45`). Optionally a one-shot soft scale-in on the check puck.
- **No confetti, no loops, no bounce.** Pennie is "calm, trustworthy." One subtle reveal, then still.
- **Must respect `prefers-reduced-motion`** — render the final state instantly (brief success criteria + accessibility agent).
- **Embed caution**: the entrance changes `scrollHeight` mid-animation; the `ResizeObserver` (lines 188–199) already lists `confirmed` as a dep and will re-post height — but animate `opacity`/`transform` (which don't change layout height) rather than `height`/`max-height` to avoid iframe resize jitter (see Pitfalls).

### 6. Copy (Pennie voice — verb phrases, optimistic, no jargon)

- CTA: "Confirm booking" → consider "Book my call" / "Confirm time" (verb phrase; README §4 forbids "Submit"). Keep short.
- Submitting state: "Booking…" is fine; "Booking your call…" is warmer.
- Confirmation heading: "You're booked" works; "You're all set" / "See you then" are warmer and on-voice.
- Empty: "No times available." → "No times left that day — pick another." (optimistic, directive).
- Race: keep "That time was just taken. Please pick another." (clear, not fear-based).
- Manage: "Reschedule" / "Cancel booking" are fine verb phrases. **Per memory `slate-copy-rules`: no em/en dashes in user-facing copy, and never name the platform "Cadence."** Use commas or periods instead of dashes in any new copy.

### 7. Accessibility-aware date/time picker patterns (high-level; full WCAG is a separate agent)

- **Calendar grid**: the day grid should expose `role="grid"` semantics ideally, but at minimum each day is a `<button>` (it already is, line 375) with an accessible name = full date (e.g. `aria-label="Tuesday, June 10 — 3 slots"`), not just the day number. Disabled days use `disabled` (already, line 377) so SR skips them.
- **Keyboard**: arrow-key roving focus across the day grid is the gold standard (Cal.com/most date pickers). Today it's plain Tab order. Visual redesign doesn't have to add arrow-key nav (that's logic), but **must preserve visible focus** — wire the system's sky focus ring (`--focus-ring`) to all day buttons, slots, inputs, nav, and CTA. The system already sets `:focus-visible { outline-color: var(--focus-ring) }` globally — ensure the booker doesn't suppress outlines.
- **Time list**: a vertical list of `<button>`s (already) is SR-friendly. Selected slot should be reflected (e.g. `aria-pressed` or moving to the form view announces context).
- **Live regions**: the error line and the 409 "just taken" message should be in an `aria-live="polite"` region so SR users hear the slot was taken. Confirmation success should be announced.
- **Targets ≥44px**: day cells (`aspect-square` in a 7-col grid) and the 12h/24h toggle buttons risk falling under 44px on small phones — size up on mobile.
- **Contrast**: graphite-on-sky and sky-on-beige are the two pairings to verify (brief §8); `--pennie-muted` text on beige must meet AA for body. Defer exact ratios to the WCAG agent but design with these in mind.

## Recommended Approach

1. **Replace the `PALETTE` object (Booker.tsx:47–92) with token-driven classes**, flipping the default from dark to beige/light (`theme = "light"`). Keep the same two-key (`light`/`dark`) shape so the embed `theme` prop and `brandColor` override keep working untouched — only the values change to Pennie tokens (`--bg`, `--surface`, `--fg`, `--fg-muted`, `--border`, `--pennie-sky`, `--pennie-sky-soft`, `--focus-ring`).
2. **Recolor the three stray semantic colors**: emerald today-dot + slot dots → `--pennie-sky`/`--pennie-green`; white/black CTAs → sky-fill + graphite-label `.pn-btn--primary` at `--radius-xl` (16px) with the arrow icon; all reds → muted rose `#C43D3D` (Booker + ManageBooking).
3. **Adopt the system's component recipes verbatim**: `.pn-card` shell (shadow not border), `.pn-btn--big/--primary` CTA, `forms.html` input spec (52px, 8px radius, sky focus ring, labels), `forms.html` segmented toggle, outlined slot rows.
4. **Build the confirmation delight**: green-wash/sky-soft panel + `pic-1.png` (coins) or `pic-3.png` (ribbon) or a `check-badge.svg` sky puck + warmer copy + add the timezone to the recap. One calm fade/rise entrance, `prefers-reduced-motion` honored, animate opacity/transform only (not height) for embed safety.
5. **Brand `/book` error and `ManageBooking` fully** (light + the reschedule grid, rose cancel, branded status). Surface the active timezone as a labeled chip near the slot list on the main booker.
6. **Vendor what's needed**: `arrow-right.svg`, `chevron-right.svg`, `Phone.svg`, `check-badge.svg`/`smile.svg`, and the chosen confirmation graphic into the Slate repo (brief Foundation step). Keep clean inline SVGs for clock/globe (no system equivalent).
7. **Verify in browser** (Playwright/Peekaboo): each state (loading, day selected, slot+form, error, 409, confirmed) in both themes + embed + mobile, against the `preview/*.html` cards.

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Keep `PALETTE` two-key object, swap values to tokens | Zero logic/prop change; embed theme + brandColor untouched; smallest diff | Still string-class soup | **Recommended** |
| Rip out `PALETTE`, drive everything from CSS vars + `data-theme` attr | Cleaner, fewer conditionals | Touches more lines; risk to embed theme path; more verification | Rejected for this pass (visual-only constraint favors minimal diff) |
| Confirmation delight = iridescent brand graphic (pic-1/pic-3) | On-brand flagship device; calm; reads on all surfaces; verified assets exist | Adds an image asset (~few KB PNG) to embed payload | **Recommended (primary)** |
| Confirmation delight = `check-badge.svg`/`smile.svg` in a sky puck | Tiny (inline SVG), zero image weight, crisp in embed | Less "wow" | Recommended fallback (esp. for embed) |
| Confirmation delight = confetti / Lottie | High delight | Violates "calm," motion-heavy, reduced-motion burden, bundle weight | Rejected |
| Add a real timezone *selector* | Matches Calendly fully | It's logic, not visual; brief forbids logic changes | Rejected (only surface the zone label) |
| Add arrow-key roving focus to calendar | Best-in-class a11y | Logic change | Defer to a11y agent; this pass only ensures visible focus + labels |

## Pitfalls and Edge Cases

- **README vs CSS conflict on button radius.** README says pills (radius 40/999); the *exported CSS* and the locked decision say 16px (`--radius-xl: 16px`, `.pn-btn--big`). Build to the CSS/locked value. Do not "fix" buttons into pills.
- **Graphite-on-sky, not white-on-sky.** Current code writes white text on the brand fill (line 134). The system pairing is graphite on sky (`--fg-on-sky`). White-on-sky also likely fails AA. Flip CTA label to graphite.
- **Don't let delight animation resize the iframe.** The embed posts `scrollHeight` via `ResizeObserver` (lines 188–199). Animating `height`/`max-height` on the confirmation will cause the host iframe to jitter. Animate `opacity`/`transform` only; the final layout height is posted once on mount.
- **Dark default is the trap.** `theme = "dark"` default (line 124) + `/book` passing `theme: light only if explicitly "light"` (book/page.tsx:55) means the *page* default is dark. Flip the component default to `"light"` AND confirm `/book` and `/booking/[id]` entry points don't force dark. Beige must be the true default.
- **80/15/5 color discipline.** It's tempting to sky-tint the avatar, dots, selected day, AND CTA. Reserve solid sky for the CTA; use `--pennie-sky-soft` washes elsewhere. One bold sky moment per screen.
- **Mint/yellow/peach are illustration-only.** The mint/green-wash confirmation panel is fine (positive moment), but never as a button fill. No yellow/peach CTAs.
- **44px targets on mobile.** `aspect-square` day cells in a 7-col grid get small on narrow phones; the 12h/24h toggle is `py-1` (~24px). Size up for touch.
- **Manage page is light-only and red-heavy.** Easy to miss — it has bright `red-600` cancel + errors (ManageBooking.tsx:100,117,124,141 region) and a native `confirm()`. Rebrand the visible chrome; leave `confirm()` logic alone.
- **No hard black, no `#000` shadows.** Use `--shadow-xs`/`--shadow-pop`; text in `--pennie-graphite`/`--pennie-navy`. The current `rounded-2xl border` look should become shadow-led, not border-led.
- **`icon-smile-yellow.png` is not a smiley** — it's a plain peach circle (verified). If a "smile" is wanted, use `assets/icons/smile.svg`.
- **Token sourcing.** Every value must come from `colors_and_type.css` vars via Tailwind `@theme` — no stray hex (brief §8). The rose error color and any sky-deep hover must be added as tokens if not already mirrored.

## References

- `src/components/Booker.tsx` (full flow, states, palette, embed coupling) — primary subject
- `src/app/book/page.tsx`, `src/app/booking/manage/[token]/page.tsx`, `src/components/ManageBooking.tsx` — sibling surfaces
- `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` — canonical tokens & `.pn-*` recipes (radii L127–132, shadows L135–143, buttons L234–280, card L283–288, focus L291)
- `~/Documents/Pennie Branding/Pennie Design System/README.md` (§2 colors, §2.2 type, §3 components, §4 voice, §5 layout) + `SKILL.md` (asset usage, what to avoid)
- `preview/buttons.html` (primary CTA = sky fill + graphite + arrow, hover translateX), `forms.html` (input/focus spec, segmented), `cards.html` (eyebrow + green-wash list + check ticks), `badges.html`, `graphics.html` (iridescent objects on all surfaces), `colors-core.html`/`colors-accents.html`
- Assets: `assets/brand/graphics/pic-1.png` (coins, verified), `pic-3.png` (ribbon, verified), `assets/icons/{arrow-right,chevron-right,check-badge,smile,Phone(bold)}.svg`
- Cal.com (open source reference, do NOT copy) — https://github.com/calcom/cal.com ; Calendly conventions (timezone surfacing, progressive form disclosure, confirmation recap)
- Memory: `calcom-reference` (reference-not-copy), `slate-copy-rules` (no dashes; never "Cadence"), `trypennie-cal-embed-contract` (embed parity), `slate-rbac`

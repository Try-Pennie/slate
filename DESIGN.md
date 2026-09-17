---
name: Slate
description: Pennie's booking and routing surface, in the Pennie Design System.
colors:
  beige: "rgb(249, 246, 240)"
  white: "rgb(255, 255, 255)"
  graphite: "rgb(52, 52, 52)"
  navy: "rgb(29, 33, 47)"
  sky: "rgb(130, 208, 255)"
  sky-hover: "#6dc5f7"
  sky-deep: "rgb(67, 159, 225)"
  sky-soft: "rgb(236, 248, 255)"
  brand-blue: "rgb(72, 108, 202)"
  mercury: "rgb(227, 227, 229)"
  muted: "rgb(106, 106, 112)"
  rose: "rgb(196, 61, 61)"
  green: "rgb(85, 207, 144)"
  yellow: "rgb(255, 208, 115)"
  mint: "rgb(134, 231, 179)"
typography:
  display:
    fontFamily: "PP Mori, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "50px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "PP Mori, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "PP Mori, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "normal"
  body:
    fontFamily: "PP Mori, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "PP Mori, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  1: "4px"
  2: "8px"
  3: "10px"
  4: "12px"
  5: "16px"
  6: "20px"
  7: "24px"
  8: "32px"
  9: "40px"
components:
  button-primary:
    backgroundColor: "{colors.sky}"
    textColor: "{colors.graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    height: "40px"
    padding: "0 20px"
  button-primary-hover:
    backgroundColor: "{colors.sky-hover}"
    textColor: "{colors.graphite}"
  button-primary-big:
    backgroundColor: "{colors.sky}"
    textColor: "{colors.graphite}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    height: "56px"
    padding: "0 24px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.graphite}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    height: "40px"
    padding: "0 20px"
  card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "24px"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.graphite}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: "44px"
    padding: "0 12px"
  chip:
    backgroundColor: "{colors.sky-soft}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.xs}"
    padding: "2px 8px"
  badge-pill:
    backgroundColor: "{colors.sky-soft}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
---

# Design System: Slate

## Overview

**Creative North Star: "The Warm Ledger"**

Paper, ink, and one blue pen. Slate looks like a financial record kept by somebody competent and kind: a warm beige page, graphite writing, numbers that line up so they can be scanned rather than read, and exactly one blue mark showing what to do next. The warmth comes from the paper itself, never from decoration, which is why the system has soft shadows and no hard black and yet almost no ornament anywhere.

The restraint is meant to read as competence rather than as coldness. There is no bolder weight to reach for (the typeface tops out at 600), no second action colour to escalate to, and no motion that is not carrying information. When a screen needs to feel more serious, it gets quieter, not louder. A navy band is the loudest move available and it is used sparingly, for a hero or a footer.

The same world covers two very different densities: a consumer booking flow with room to breathe, and internal tables carrying 136 rows of live roster. It holds together because both are the same ledger at different zoom levels. The booking screen is one page of it; the roster is the whole book open flat.

**Key Characteristics:**
- Beige and white surfaces dominate; navy appears as an occasional band.
- Sky is the only action colour, and its rarity is what makes it work.
- Numbers are tabular wherever they can be compared.
- Depth is a soft shadow in light and a border in dark, never a hard drop.
- Nothing animates unless the motion is the message.

## Colors

Warm neutrals doing almost all the work, with a single cool accent that means "this is the next action".

### Primary
- **Pennie Sky** (`rgb(130, 208, 255)`): the only action colour in the product. Primary buttons, the active nav marker, the top load bar, the working spinner. It carries graphite text in BOTH themes, never the theme's own foreground: beige on sky measures 1.57:1 and white on sky 1.69:1, so the dark theme pins graphite rather than letting the foreground flip.
- **Sky Hover** (`#6dc5f7`): the primary button's hover fill, chosen so graphite on it still measures 6.51:1.
- **Sky Wash** (`rgb(236, 248, 255)`): a pale sky tint for the selected state of a row or nav item, and for informational panels. Light theme only; the dark theme uses a translucent accent instead.
- **Brand Blue** (`rgb(72, 108, 202)`): the focus ring line on ordinary light surfaces, measuring 4.56:1 on beige. Not a fill colour and not a text colour.

### Neutral
- **Beige** (`rgb(249, 246, 240)`): the page. The single most common colour in the product and the source of its warmth.
- **White** (`rgb(255, 255, 255)`): cards, input wells, and anything that should read as a surface lifted off the page.
- **Graphite** (`rgb(52, 52, 52)`): all primary text, and the label on every sky fill. There is no black in the system.
- **Navy** (`rgb(29, 33, 47)`): the occasional full bleed band, a page hero or a footer, carrying beige text.
- **Muted** (`rgb(106, 106, 112)`): secondary and supporting text.
- **Quiet Letter** (`rgb(188, 188, 191)` light, `rgb(100, 98, 107)` dark): the turned down half of a mark whose lit half labels itself, which today is the tier ledger's uncovered letters. It carries the rhythm and the extent of a scale, not an identity, so it needs to be perceptible rather than legible and owes no 3:1. Measured at a 6.57:1 gap from the covered letters on light and 5.56:1 on dark, staying visible at 1.74:1 and 1.59:1 on a zebra row, which is the tightest surface in each theme. **The two values are deliberately not derived from one another:** light text on a dark ground blooms, so matching the numbers does not match the appearance, and one shared figure produces two different looking treatments. Collapsing them is a regression that reads as a tidy-up, so the guard asserts each gap separately and asserts that light stays the wider.
- **Mercury** (`rgb(227, 227, 229)`): strokes, outlines, and the unfilled half of a meter or track. It measures 1.28:1 on a card, which is below even a perceptibility floor, so it cannot serve as a turned down mark somebody has to be able to SEE; the tier ledger uses Quiet Letter for that.

### Tertiary
- **Rose** (`rgb(196, 61, 61)`): errors and destructive confirmations, at 4.77:1 on beige. Muted on purpose; the design system shipped without an error colour and this one was added to be readable rather than alarming.
- **Green** (`rgb(85, 207, 144)`): a healthy or bookable state, as a WASH behind dark text. It measures 1.82:1 on beige, so it can never be a mark on its own; see the Bare Mark Rule.
- **Green Mark** (`rgb(0, 155, 104)`): the one green legible with no word beside it, at 3.57:1 on a white card, 3.31 on the page and 3.32 on the green wash. Scoped to light surfaces and to the wash, since on a hovered dark row it is 2.68:1. The wash is theme independent, which is what makes a dot inside a status pill safe in both themes.
- **Yellow** (`rgb(255, 208, 115)`) and **Mint** (`rgb(134, 231, 179)`): illustration and accent only, with ONE named functional exception for yellow, the impersonation marker; see the Hazard Rule.

### Named Rules

**The One Pen Rule.** Sky is the only colour that may mean "do this". Yellow, mint and peach are illustration accents and may never carry a call to action. If two things on a screen are competing to be the next action, one of them is wrong.

**The Bare Mark Rule.** A colour carrying meaning with no word beside it needs 3:1, and most of the palette cannot. Measured: neither green (1.82 and 2.44 on beige) and not yellow (1.34), which is why those are washes and illustration. Rose can, in both themes, at 4.01 at its worst. Green Mark exists so healthy has something to reach for, and it is scoped rather than general. The trap is that the record reads as permission: somebody reaches for the colour named beside the meaning, gets a mark nobody can see, and nothing fails, which is exactly how 25 focus rings shipped at 1.57:1.

**The Hazard Rule.** A surface saying the product is in a DANGEROUS MODE is the one place yellow is functional, and it is a single named case rather than a general permission: the impersonation marker, recorded in full at `docs/design/impersonation-marker.html`. It is a mustard strip carrying a full sentence in graphite at 8.61:1, with a navy and mustard hazard stripe framing the viewport. The strip also has to be told apart from the rose calendar bar directly beneath it, which needs 3:1 as two adjacent surfaces: mustard is 3.56:1, where the graphite strip it replaced was 2.42:1, below the line. It breaks neither rule above, and the reasoning is the point: the One Pen Rule holds because the action on the strip is an outlined graphite button and sky is still the only colour meaning "do this"; the Bare Mark Rule holds because the strip has words on it and the stripes clear 3:1 through their graphite half. The stripe exists because a frame is one half of a pair with the page behind it and Slate has two pages: navy alone is 14.85:1 on beige and 1.23:1 on dark, mustard alone is 13.57:1 on dark and 1.34:1 on beige, so either one vanishes in one theme while measuring beautifully in the other. Carrying both colours is what makes it theme independent. The dark half of the stripe is NAVY rather than a near black, which is what keeps it inside the No Black Rule; the first version of this record was painted in an invented #1C1C1C that existed in no stylesheet, and `scripts/test-impersonation-marker-record.ts` is what caught it. Do NOT extend this to a second surface, and do NOT reach for yellow because a state feels serious: the rest of the palette's serious state is rose, and the whole value of this marker is that it looks like nothing else in Slate.

**The Functional Mark Rule.** A mark is decoration only if removing it loses nothing a reader needs, and the question that sorts them is whether the LIT marks name themselves. An axis tick or a meter rung with no label of its own is identified only by its position, so a reader has to make it out: that one is functional and takes the 3:1 floor, measured, whatever its neighbours in the same graphic do. Where the lit marks are self labelling, as the tier ledger's letters are, the turned down ones carry only rhythm and extent, so they need to be perceptible and owe no 3:1. Getting that backwards is not hypothetical: this rule shipped naming the ledger as the canonical functional case when it is the clearest case of the opposite, and a named rule is copied through its example.

**The Measured Pairing Rule.** No single colour clears the 3:1 that a focus indicator needs on both a beige page and a sky button, so the focus line is chosen by the surface it lands on: brand blue on light, sky on navy, graphite on a sky fill. Every pairing is measured in `scripts/test-contrast.ts`, and the colours that do NOT clear are kept there as tripwires. Never pick an accent by eye and never assume a token that passed on one surface passes on another.

**The No Black Rule.** There is no hard black anywhere, including in shadows. Graphite is as dark as text goes and shadow colours are tinted with the warm neutrals.

## Typography

**Display Font:** PP Mori (with `-apple-system`, `BlinkMacSystemFont`, sans-serif)
**Body Font:** PP Mori (same stack)

**Character:** One geometric sans doing everything, which is what keeps the system feeling like a single hand writing rather than a kit assembled from parts. Its slightly humanist curves are the reason the product reads as warm at 400 weight without needing a serif or an illustration to soften it.

### Hierarchy
- **Display** (600, 50px, 1.1, tracking `-0.02em`): the hero line on a landing surface. One per page at most.
- **Headline** (600, 40px, 1.1, tracking `-0.02em`): a page title.
- **Title** (600, 32px / 26px / 22px, 1.1): section headings, stepping down through `.pn-h2`, `.pn-h3`, `.pn-h4`.
- **Lead** (400, 20px, 1.3): the sentence under a heading that explains the screen.
- **Body** (400, 16px, 1.5): everything else. Prose is held to 110ch, measured against the card the text sits in rather than against the page.
- **Label** (600, 14px, 1.2): field labels, table headers, and the eyebrow above a section. Deliberately NOT uppercase and NOT letter spaced, which is where the system parts company with most admin UI.
- **Fine** (400, 12px, 1.2): timestamps, counts, and supporting detail.

### Named Rules

**The 600 Ceiling Rule.** PP Mori ships 200, 400 and 600. Medium is not used at all and 700 is aliased to 600, so there is no bolder weight to reach for. Emphasis comes from size, colour or space, never from a heavier face. `font-synthesis: none` is set so the browser cannot fake one.

**The Ledger Numerals Rule.** Anything a reader might compare down a column gets tabular numerals: rates, payments, counts, durations, times and dates. A figure that jumps sideways as it updates is a defect.

**The Plain Label Rule.** Labels are sentence case with no letter spacing. Uppercase tracked labels read as institutional, which is the opposite of the voice.

## Layout

A wide page container with the reading width enforced on the prose rather than on the page, so a table or a control grid can use the whole window while a paragraph inside the same screen stays readable.

Internal pages are a sticky sidebar (224px at `lg` and above) beside the content, and the sidebar becomes a horizontally scrolling row of the same grouped links below `lg`, so the map of the area reads the same on a phone as on a desktop. Cards are the primary content container and carry 24px of internal padding.

Spacing is a 4px based ladder (4, 8, 10, 12, 16, 20, 24, 32, 40), used through the semantic steps rather than arbitrary values. Vertical rhythm between sections is set on the page, not per element.

Every interactive control is at least 44px tall. Inputs are exactly 44px, and the small button is 40px with its own padding, so a control row lines up without ad hoc nudging.

### Named Rules

**The Prose Width Rule.** The 110ch limit goes on the paragraph, never on the container that holds a table or a grid of controls. Putting it on the container is how a wide data surface gets accidentally squeezed into a column. It is ONE number, written once as `proseCls` in `src/components/ui/styles.ts`: a second spelling renders identically today and diverges the moment somebody raises one of them, which is what happened when the cap moved from 65. Held by `scripts/test-prose-width.ts`, which also holds the number in this file to the number in the code.

## Elevation & Depth

Light mode is a paper stack: surfaces lift off the beige page with soft, wide, low opacity shadows tinted with the warm neutrals rather than with black. Cards sit on `--shadow-xs`, menus and popovers on `--shadow-md`, and the heaviest step is reserved for something genuinely floating over the page.

Dark mode does not use shadows at all, because a shadow on a dark ground is invisible. Depth there comes from a warm charcoal elevation scale that steps the surface lightness up as things come forward: the page recedes at `rgb(23, 22, 26)`, input wells sit at `rgb(40, 39, 45)`, cards float at `rgb(57, 55, 63)`, and hero bands, menus and popovers are brightest at `rgb(74, 71, 81)`. The scale is deliberately pulled off cold blue so dark mode reads warm rather than clinical, while staying in the navy family.

### Shadow Vocabulary
- **Ambient card** (`--shadow-xs`): three stacked layers at 4% opacity. The resting state of a card in light mode.
- **Soft lift** (`--shadow-sm`): a card or row that has been raised slightly.
- **Menu** (`--shadow-md`, `0 4px 16px rgba(52,52,52,0.08)`): dropdowns, popovers, date pickers.
- **Page float** (`--shadow-lg`): something overlaying the page rather than sitting in it.
- **Pop** (`--shadow-pop`, `0 12px 32px rgba(29,33,47,0.18)`): the strongest step, navy tinted, for a true overlay.

### Named Rules

**The Shadow Swap Rule.** A card's edge is carried by a shadow in light and by a border in dark. Any component that relies on a shadow to be legible needs a border added under `dark:`, or it dissolves into the page. Dark borders are also stronger than light's hairline (38% versus 16% alpha) because in dark they are the only thing separating a field from its card, and an input boundary has to clear 3:1.

## Shapes

A radius ladder that gets rounder as the element gets larger: chips at 4px, inputs and small wells at 8px, cards at 10px, buttons at 12px, large buttons and full bleed bands at 16px, and a true pill at 999px.

Borders are hairlines and are mostly absent in light mode, where the shadow does the work. Nothing is clipped to a decorative shape and there are no angled cuts, ribbons or blobs; the form language is rectangles with softened corners, which is what keeps a dense table calm.

### Named Rules

**The Pills Are Badges Rule.** A fully rounded shape means "this is a status", never "this is a button". Buttons are 12px or 16px. A pill shaped button reads as a tag and steals the affordance from the real controls on the screen.

## Components

### Buttons
- **Shape:** softly rounded (12px small, 16px large), never a pill.
- **Primary:** sky fill with graphite text, 40px tall with 20px of horizontal padding at the small size, 56px and 24px at the large one. Semibold label at 14px.
- **Hover / Focus:** the fill lightens to sky hover; pressing translates the button down 1px. Focus draws the shared ring (brand blue on light, sky on navy, graphite when the ring lands on the sky fill itself).
- **Secondary:** transparent with a hairline border and graphite text, same geometry. Used for anything that is not the one primary action on the screen.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** white on the beige page; a lifted warm charcoal in dark.
- **Shadow Strategy:** the ambient card shadow in light, swapped for a border in dark. See the Shadow Swap Rule.
- **Internal Padding:** 24px.

### Inputs / Fields
- **Style:** white well, 8px radius, hairline border, exactly 44px tall, 12px horizontal padding. The label sits above at 12px semibold in muted.
- **Focus:** the shared ring, offset 2px, with a decorative sky glow behind the contrast carrying line.
- **Error:** rose border and message, with a 12% rose wash available for the containing block. The message is always words, never colour alone.

### Navigation
- **Style:** grouped links under plain sentence case eyebrows. The current item is marked three ways at once: a filled 2px left edge in sky, a sky wash fill, and a weight change to semibold, so it never depends on colour.
- **Pending:** clicking a link shows the working spinner on the item itself plus a sky progress bar fixed across the top of the window, because the destination fetches data and a click must never read as nothing happening.

### Status Pills
- **Style:** fully rounded, sky wash or a semantic tint, graphite text, 14px semibold.
- **Rule:** the word carries the meaning and the tint is reinforcement, so a pill read with no colour at all still says what it says.

### The Working Signal
Two deliberate cues rather than one. Lead facing surfaces use three bobbing dots in sky, positional rather than fading, because a pulse that fades can be glanced at during its dim half and read as nothing happening. Internal surfaces use a spinner. Both are `aria-hidden`, with the announcement carried by a real status region beside them, and both stop under `prefers-reduced-motion` where the text alone carries the message.

## Do's and Don'ts

### Do:
- **Do** reserve sky for the single next action on a screen, and let its rarity do the work.
- **Do** put tabular numerals on anything a reader could compare down a column.
- **Do** add a border under `dark:` to anything whose edge is carried by a shadow in light.
- **Do** measure a new colour pairing in `scripts/test-contrast.ts` before shipping it, including against the sky wash and the sky fill, not just against the page.
- **Do** give every control at least 44px of height, and mark state with shape or weight as well as colour.
- **Do** keep the 110ch reading limit on the paragraph and off the container, and reach it through `proseCls` rather than writing the number.

### Don't:
- **Don't** use yellow, mint or peach for a call to action. They are illustration accents.
- **Don't** reach for a weight above 600, or let the browser synthesise one.
- **Don't** put the theme's foreground on a sky fill. Beige on sky is 1.57:1 and white on sky is 1.69:1, both far under 4.5. The label on sky is always graphite, in both themes.
- **Don't** use a hard black, in text or in a shadow.
- **Don't** make a button a pill. Pills are badges.
- **Don't** uppercase or letter space a label.
- **Don't** animate anything whose motion is not carrying information, and never animate a table of rows on load.
- **Don't** let a component depend on its parent for its spacing or its ring; a component that only looks right inside one particular parent is broken at the next call site.

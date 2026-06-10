# Verification checklist — Phase 2 sweep (Task 2.V, 2026-06-10)

Integrated current build, dev server localhost:3000. Viewports: desktop 1280x900, mobile 390x844.
Evidence prefix `p2v-` distinguishes sweep captures from 2.x task evidence.

| Surface | Theme | Viewport | Screenshot | a11y-tree snapshot | axe (count / ids) | Lighthouse a11y | Reduced-motion | Manual a11y checks | Notes | Result |
|---------|-------|----------|-----------|--------------------|-------------------|-----------------|----------------|--------------------|-------|--------|
| Booker /book?xbc=411 initial | light | desktop | reports/screens/p2v-book-initial-light-desktop.png | captured (roles, day labels, pressed states, "today" name) | 0 / — (p2v-book-initial-light.axe.json) | 1.0 (p2v-book-light-a11y.report.json) | — | beige bg rgb(249,246,240), graphite fg, PP Mori, h 600, today dot green | matches DS preview card recipe | PASS |
| Booker initial | dark | desktop | reports/screens/p2v-book-initial-dark-desktop.png | captured | 0 / — (p2v-book-initial-dark.axe.json) | — | — | root data-theme=dark, ink-2 rgb(52,55,68) card, beige fg, accent stays sky | beige page surround = 2.1 accepted design (theme scopes to Booker root) | PASS |
| Booker initial | light | mobile 390 | reports/screens/p2v-book-initial-light-mobile.png | — | — | — | — | day cell 44x44, month nav 44x44, no x-overflow (scrollW 390) | 12h/24h toggle 36px = documented 2.2 dense-control allowance | PASS |
| Booker initial | dark | mobile 390 | reports/screens/p2v-book-initial-dark-mobile.png | — | — | — | — | no x-overflow | | PASS |
| Booker — slots (day selected) | light | desktop | reports/screens/p2v-book-slots-light-desktop.png | captured (aria-pressed day, 45 slot buttons, tz chip sr-only) | — | — | — | slot rows 44px, tabular-nums, sky-soft + ring + 600 selected day | | PASS |
| Booker — slots | dark | desktop | reports/screens/p2v-book-slots-dark-desktop.png | — | — | — | — | sky/20 selected wash visible on ink-2 | | PASS |
| Booker — form | light | desktop | reports/screens/p2v-book-form-light-desktop.png | captured (labeled textboxes, Back aria-label) | 0 / — (p2v-book-form-light.axe.json) | — | — | CTA sky rgb(130,208,255) + graphite label, 56px, 16px radius, 600; inputs 48px/16px font/8px radius; name/email/tel + autocomplete + inputMode | | PASS |
| Booker — form | dark | desktop | reports/screens/p2v-book-form-dark-desktop.png | — | 0 / — (p2v-book-form-dark.axe.json) | — | — | CTA stays sky + graphite (text-fg-on-sky) in dark | | PASS |
| Booker — form | light | mobile 390 | reports/screens/p2v-book-form-light-mobile.png | — | — | — | — | input 48px, CTA 56px, no x-overflow | | PASS |
| Booker — error (real 409) | light | desktop | reports/screens/p2v-book-error-409-light-desktop.png | role=alert + icon confirmed | — | — | — | rose rgb(196,61,61), copy "That time was just taken. Please pick another." in slot-list branch | real POST /api/bookings → 409 (env blocker, see report) | PASS |
| Booker — error (real 409) | dark | desktop | reports/screens/p2v-book-error-409-dark-desktop.png | — | — | — | — | dark --error flip live: rgb(223,148,148) #DF9494 | | PASS |
| Confirmation (delight) | light | desktop | reports/screens/p2v-confirm-light-desktop.png | role=status sr announce confirmed | 0 / — (p2v-book-confirm-light.axe.json) | — | static under reduce | h2 "You're all set" receives focus (activeElement), pic-1-coins.png 144px in sky-soft panel, recap w/ timezone + tabular time | via route interception (env 409 blocker) | PASS |
| Confirmation | dark | desktop | reports/screens/p2v-confirm-dark-desktop.png | — | 0 / — (p2v-book-confirm-dark.axe.json) | — | — | h2 focused | | PASS |
| Confirmation reduced-motion | light | desktop | reports/screens/p2v-confirm-light-reducedmotion.png | — | — | — | animationDuration 1e-05s (S9 guard), final frame fully visible; normal run = 0.36s pn-confirm-rise, settles opacity 1/transform none | global @media (prefers-reduced-motion) guard present globals.css:326 | PASS |
| Booker — focus ring | light | desktop | reports/screens/p2v-book-focus-light.png | — | — | — | — | outline rgb(52,52,52) solid 2px + 2px offset + sky glow box-shadow; edge clearance month-nav 264px desktop / 24px mobile — NOT clipped | overflow-hidden shell clip risk stays flagged for 4.4 | PASS |
| Booker — focus ring | dark | desktop | reports/screens/p2v-book-focus-dark.png | — | — | — | — | outline rgb(130,208,255) sky solid 2px + glow | | PASS |
| Booker path entry /booking/seed-test?xbc=411 | light (default) | desktop | reports/screens/p2v-booking-path-light-desktop.png | — | — | — | — | defaults light, Booker inside main landmark | | PASS |
| /book (no xbc) branded error | light | desktop | reports/screens/p2v-book-missing-config-light-desktop.png | — | — | — | — | beige centered, fg-muted copy, main landmark | | PASS |
| Manage /booking/manage/&lt;token&gt; | light | desktop | reports/screens/p2v-manage-light-desktop.png | — | 0 / — (p2v-manage-light.axe.json) | — | — | beige bg; Reschedule outlined 44px/12px; Cancel rose rgb(196,61,61) outline 44px/12px (not pill, not bright red) | real token WH5kMSjilN7OuQPKY3t5ERAz, temp confirmed→reverted to completed (verified) | PASS |
| Manage — reschedule grid | light | desktop | reports/screens/p2v-manage-reschedule-light-desktop.png | — | — | — | — | 30 outlined slots, 44px, 10px radius, white surface | | PASS |
| Manage | dark | desktop | reports/screens/p2v-manage-dark-desktop.png | — | 0 / — (p2v-manage-dark.axe.json) | — | — | navy rgb(29,33,47) root, beige fg, --error #df9494 | dark via root data-theme flip (2.5 precedent) | PASS |
| Manage — cancelled token | light | desktop | reports/screens/p2v-manage-cancelled-light-desktop.png | — | — | — | — | rose status "This booking is cancelled.", actions hidden | token 6JcQRNnYkKTMtyaliKOQ1Zlt | PASS |
| Manage — bogus token | light | desktop | reports/screens/p2v-manage-notfound-light-desktop.png | — | — | — | — | branded beige "We couldn't find that booking." | | PASS |
| Embed /embed-example.html (modal) | host | desktop | reports/screens/p2v-embed-modal-desktop.png | — | — | — | — | default renders LIGHT, today dot sky rgb(130,208,255) (D14), prefill params forwarded | gray scrim/old chrome = widget.js, Phase 4.1 scope | PASS |
| Embed — confirmation | host | desktop | reports/screens/p2v-embed-confirm-desktop.png | — | — | — | — | SVG puck (hasImg false, hasSvg true), h2 focused; iframe height constant 560px across 12x60ms samples (zero jitter); slate:resize x8 + slate:bookingSuccessful x1; host Cal("on") callback logged "Booking complete" | booking completed via route interception (env 409) | PASS |
| Embed — brand override | host | desktop | (measured) | — | — | — | — | &brand=%23FF8800 → dot rgb(255,136,0); standalone /book keeps green rgb(85,207,144) dots | | PASS |
| Embed (modal) | host | mobile 390 | reports/screens/p2v-embed-modal-mobile.png | — | — | — | — | modal 359x760, 12px radius — NOT yet full-screen 100dvh | expected: mobile full-screen is Task 4.2 (widget.js untouched in Phase 2) | N/A (4.2) |

## Code gates

| Gate | Result | Evidence |
|------|--------|----------|
| pnpm build | exit 0 (re-run after fix) | reports/phase-2-build.log |
| pnpm lint | exit 0 | — |
| pnpm test | green, 15x "ALL PASSED" | — |
| scripts/test-contrast.ts | correctly absent (pending Task 4.3); D17 pairings verified via computed-style measurements above | — |
| Stray-color grep | only allowed literal: PENNIE_SKY "#82D0FF" (book/page.tsx:9, documented 2.4) | — |
| git diff | visual-only: 6 UI files + globals.css; sole new hook = 2.4's documented focus useEffect; no src/lib/api/auth/DB changes | — |

## Fix applied during sweep

- `landmark-one-main` (Lighthouse 0.98 → 1.0): wrapped the `<Booker>` render in a bare `<main>` in
  `src/app/book/page.tsx` and `src/app/booking/[id]/page.tsx` (both routes already used `<main>` in
  their error branch). Markup-only; embed re-verified after the fix (resize/bookingSuccessful intact,
  iframe height stable); build/lint/test re-run green.

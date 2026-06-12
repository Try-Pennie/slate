# Verification checklist — Slate brand redesign (Phase 5, canonical)

Task 5.1 fills Screenshot / a11y-tree / Notes / Result. Task 5.2 fills axe / Lighthouse /
Reduced-motion. Screenshot paths are relative to
`.claude/orchestration-slate-brand-redesign/reports/`. Viewports: desktop = 1280×900,
mobile = 390×844. Captured 2026-06-11 against the live dev server (real Google-busy
availability; June 12 auto-selected day). DS parity judged against
`~/Documents/Pennie Branding/Pennie Design System/preview/*.html` (buttons/forms/cards/
colors-core/type-headings) + computed-style measurements.

5.2 audit run 2026-06-12 against the same live dev server. axe-core 4.10.2,
tags `wcag2a/wcag2aa/wcag21a/wcag21aa`, injected via Playwright (vendored, no CDN
dependency at run time); JSON per surface×theme at `axe/p5-*.axe.json`. Lighthouse 12.x
`--only-categories=accessibility` at `lighthouse/p5-*-a11y.report.{json,html}`. axe runs at
1280×900 (DOM identical at 390; 4.5 covered mobile targets/overflow). "LH N/A (theme)" =
dark is localStorage-driven, unreachable from the Lighthouse CLI — axe covers dark.
"LH N/A (auth)" = headless Lighthouse Chrome carries no session — axe under the injected
Playwright session covers.

| Surface | Theme | Viewport | Screenshot | a11y-tree snapshot | axe (5.2) | Lighthouse (5.2) | Reduced-motion (5.2) | Notes | Result |
|---------|-------|----------|-----------|--------------------|-----------|------------------|----------------------|-------|--------|
| Booker /book?xbc=411 (initial) | light | desktop | screens/p5-book-light-desktop.png | captured: h1 "Senior Loan Advisor Call", labeled day buttons ("Friday, June 12" + [pressed] + ", today"), 12h/24h [pressed] toggle, sr "Timezone:" + zone, slot buttons | 0 (p5-book-light) | 1.0 (p5-book-light-a11y) | global guard verified (globals.css:339) | beige page rgb(249,246,240), white card 16px + shadow-xs, sky-soft selected day + ring + 600 weight, green dots, PP Mori; matches DS cards/colors-core | PASS |
| Booker /book?xbc=411 (initial) | dark | desktop | screens/p5-book-dark-desktop.png | same roles | 0 (p5-book-dark) | 1.0 (p5-book-dark-a11y) | same | card ink-2 navy, beige fg, accent stays sky; theme scoped to Booker root (standalone body stays beige = Phase-2 verified baseline) | PASS |
| Booker /book?xbc=411 (initial) | light | mobile | screens/p5-book-light-mobile.png | same roles | 0 (desktop run, same DOM) | — | — | stacks vertically, scrollWidth 390 (no x-overflow), PP Mori, h1 600 | PASS |
| Booker /book?xbc=411 (initial) | dark | mobile | screens/p5-book-dark-mobile.png | same roles | 0 (desktop run, same DOM) | — | — | consistent dark transform, no x-overflow | PASS |
| Booker — day selected | light | desktop | screens/p5-book-day-light-desktop.png | day [pressed] + font-semibold + ring (non-color signal) | 0 (state covered by p5-book-light/-form runs) | — | — | Jun 15 clicked; slots reload; selected-day cue is pressed-state + weight + ring, not color alone; 5.2 computed: aria-pressed=true + aria-current=date + fontWeight 600 + ring | PASS |
| Booker — attendee form | light | desktop | screens/p5-book-form-light-desktop.png | textboxes Name/Email/Phone (sr-only labels), "Confirm booking" button + arrow img, Back link | 0 (p5-book-form-light; re-run clean post focus fix) | — | — | sky CTA rgb(130,208,255) + graphite label + 16px radius; recap "Mon 15 · 9:00am" tabular; 5.2 FIX: slot pick now moves focus to #booker-name (was dropped to body) | PASS |
| Booker — form field errors (NEW #30–44 state) | light | desktop | screens/p5-book-form-fielderrors-light-desktop.png | 3 hints "Enter your name/email/phone number"; aria-invalid=true + aria-describedby on inputs | 0 (p5-book-fielderrors-light) | — | — | empty submit → 3 per-field rose rgb(196,61,61) errors, focus moved to #booker-name (graphite focus ring); client-side, no network; 5.2: aria-required=true + autocomplete name/email/tel + type text/email/tel all confirmed in DOM | PASS |
| Booker — form | dark | desktop | screens/p5-book-form-dark-desktop.png | same roles | 0 (p5-book-form-dark) | — | — | CTA stays sky + graphite label in dark | PASS |
| Booker — form field errors | dark | desktop | screens/p5-book-form-fielderrors-dark-desktop.png | same as light | 0 (p5-book-fielderrors-dark) | — | — | dark error token rgb(223,148,148) (lightened rose), sky focus ring on first field | PASS |
| Confirmation (delight) | light | desktop | screens/p5-confirm-light-desktop.png | heading "You're all set" receives focus (H2), recap + invite line | 0 (p5-book-confirm-light) | — | baseline pn-confirm-rise 0.36s ×1 (motion present) | 3D coins PNG in sky-soft 16px panel, warm copy, tabular time; reached via client-side fetch stub (no real booking; real E2E owed to 5.3); 5.2: H2 focused + role=status live region confirmed both themes | PASS |
| Confirmation | light | mobile | screens/p5-confirm-light-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| Confirmation | dark | desktop | screens/p5-confirm-dark-desktop.png | same | 0 (p5-book-confirm-dark) | — | — | ink-2 card, sky-soft panel + coins unchanged | PASS |
| Confirmation | dark | mobile | screens/p5-confirm-dark-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| Booker (path entry) /booking/seed-test?xbc=411 | light | desktop | screens/p5-booking-path-light-desktop.png | same Booker tree | 0 (same component as /book runs) | — | — | renders identically to /book entry | PASS |
| Booker (path entry) | dark | desktop | screens/p5-booking-path-dark-desktop.png | same | 0 (same component as /book runs) | — | — | **FAIL→FIXED in 5.1**: page never forwarded `theme`/`brand` to Booker (?theme=dark ignored, both captures were byte-identical light). Fixed by mirroring /book's two props (`theme`, `brandColor` incl. D14 embed default) in `src/app/booking/[id]/page.tsx`; lint+tsc clean; dark now renders (Booker root data-theme=dark, bg ink-2 rgb(52,55,68)) | PASS (after fix) |
| Manage /booking/manage/&lt;token&gt; | light | desktop | screens/p5-manage-light-desktop.png | h1, "Reschedule" button, "Cancel booking" button (img + text) | 0 (p5-manage-light) | — (token URL; not LH-run) | — | real token WH5kMSjilN7OuQPKY3t5ERAz (5.2 re-flip: completed→confirmed + starts_at temporarily future so the /api/cron/complete sweep can't re-complete it mid-audit; REVERTED to completed + Jun 4 13:00–13:30, verified against the untouched busy_blocks row); rose outlined cancel rgb(196,61,61), outlined reschedule, beige page | PASS |
| Manage | dark | desktop | screens/p5-manage-dark-desktop.png | same | 0 (p5-manage-dark) | — | — | `?theme=dark` honored (full navy page rgb(29,33,47), lightened-rose cancel) | PASS |
| Manage | light | mobile | screens/p5-manage-light-mobile.png | same | 0 (desktop run) | — | — | scrollWidth 390, no x-overflow | PASS |
| Manage | dark | mobile | screens/p5-manage-dark-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| Manage — reschedule grid | light | desktop | screens/p5-manage-reschedule-light-desktop.png | "Pick a new time" + 30 slot buttons, Close + Cancel booking | 0 (p5-manage-reschedule-light) | — | — | white outlined 44px slots, tabular times, Booker 2.2 recipe | PASS |
| Manage — reschedule grid | dark | desktop | screens/p5-manage-reschedule-dark-desktop.png | same | 0 (p5-manage-reschedule-dark) | — | — | ink-2 slot surfaces | PASS |
| Manage — cancelled state | light | desktop | screens/p5-manage-cancelled-light-desktop.png | "This booking is cancelled." | 0 (p5-manage-cancelled-light) | — | — | real cancelled token a8RWptWgoz405IBj5thDDk6C; rose status text, actions hidden | PASS |
| Manage — cancelled state | dark | desktop | screens/p5-manage-cancelled-dark-desktop.png | same | 0 (p5-manage-cancelled-dark) | — | — | | PASS |
| Login /login | light | desktop | screens/p5-login-light-desktop.png | captured: img "Pennie", h1 "Sign in to Slate" (in card), button "Continue with Google" + arrow | 0 (p5-login-light) | 1.0 (p5-login-light-a11y) | — | marketing split: navy panel + cream logo + "Welcome back." + yellow sticky note; white card + sky CTA + graphite label; matches DS hero/buttons | PASS |
| Login | dark | desktop | screens/p5-login-dark-desktop.png | same | 0 (p5-login-dark) | LH N/A (theme) | — | page navy, card ink-2, CTA stays sky+graphite, panel stays navy | PASS |
| Login | light | mobile | screens/p5-login-light-mobile.png | same | 0 (desktop run) | — | — | panel hidden, card logo swap, scrollWidth 390 | PASS |
| Login | dark | mobile | screens/p5-login-dark-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| Landing / | light | desktop | screens/p5-landing-light-desktop.png | h1 "Slate", links Admin (sky CTA + arrow) + Embed demo (outline) | 0 (p5-landing-light) | 1.0 (p5-landing-light-a11y) | — | single beige hero, charcoal logo, pn-h1 600 | PASS |
| Landing | dark | desktop | screens/p5-landing-dark-desktop.png | same | 0 (p5-landing-dark) | LH N/A (theme) | — | navy, cream logo swap, sky CTA unchanged | PASS |
| Landing | light | mobile | screens/p5-landing-light-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| Landing | dark | mobile | screens/p5-landing-dark-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| /admin | light | desktop | screens/p5-admin-light-desktop.png (full page) | captured: h1 "Slate admin", h2s Default working hours / Agents (1 bookable / 102) / Event types / Buckets / Recent routing / Reassign API / Webhook endpoint / Webhook deliveries / Audit log | 0, 29 passes (p5-admin-light; re-minted injected session, READ-ONLY) | LH N/A (auth) | — | injected Supabase session (READ-ONLY; theme via localStorage; no form submits); beige dashboard, white pn-cards, pills, tabular nums; @layer-components move (#39) renders identically | PASS |
| /admin — "Replay failed deliveries" (NEW #30–44 control) | light | desktop | screens/p5-admin-replay-control-light-desktop.png | combobox "Replay every failed delivery from the last" (24 hours…) + button "Replay failed deliveries" | 0 (in p5-admin-light run; select carries accessible name) | — | — | outlined pn-btn--small recipe: transparent bg, graphite label, 1px var(--border), 12px radius, 40px tall (documented --small allowance); NOT clicked (screenshot only) | PASS |
| /admin | dark | desktop | screens/p5-admin-dark-desktop.png (full page) | same | 0, 29 passes (p5-admin-dark) | LH N/A (auth) | — | uniform navy full-page (102-agent roster), no light patches | PASS |
| /admin | light | mobile | screens/p5-admin-light-mobile.png | same | 0 (desktop run) | — | — | scrollWidth 390 both themes | PASS |
| /admin | dark | mobile | screens/p5-admin-dark-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| /me | light | desktop | screens/p5-me-light-desktop.png (full page) | AppHeader (logo, Admin/My availability tabs, email, Dark toggle, reconnect), h1 "Your availability", Bookable pill, Working hours card | 0, 23 passes (p5-me-light) | LH N/A (auth) | — | branded shell, status-ok pill (graphite-on-green-wash per 3.V fix), sky Save, blue reset link; reconnect affordance expected (injected session has no Google token) | PASS |
| /me | dark | desktop | screens/p5-me-dark-desktop.png (full page) | same | 0, 23 passes (p5-me-dark) | LH N/A (auth) | — | | PASS |
| /me | light | mobile | screens/p5-me-light-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| /me | dark | mobile | screens/p5-me-dark-mobile.png | same | 0 (desktop run) | — | — | | PASS |
| Embed /embed-example.html (modal) | host | desktop | screens/p5-embed-modal-desktop.png | modal role=dialog aria-modal=true | 0, 19 passes (p5-embed-host-modal-open; sole incomplete = axe-undeterminable color-contrast over scrim/iframe, 4.2/4.V parity); frame-title "Slate booking" + aria-label "Book a call" confirmed | 1.0 (p5-embed-host-a11y; 0.96→1.0 after 5.2 landmark fix on the static host page) | loader static "Loading…", zero animated nodes, iframe transition 0s (p5-embed-loader-reducedmotion.png) | D15 literal chrome verified by computed style: scrim rgba(29,33,47,0.55), modal white 16px radius, shadow rgba(29,33,47,0.18) 0 12px 32px, PP Mori-first stack; sky dots in iframe (D14 embed default); 5.2 keyboard gauntlet: keyboard-only open → focus on Close → trap holds (6 Tabs contained) → host-side Escape AND in-iframe Escape via slate:escape relay both close + restore trigger focus + body overflow + un-inert | PASS |
| Embed — branded loading | host | desktop | screens/p5-embed-loading-desktop.png | role=status loader | 0 (in modal-open run) | — | static under reduce (see above) | captured live: white card + sky spinner, iframe hidden until load; close button focus ring (graphite + sky glow) visible | PASS |
| Embed — in-iframe confirmation | host | desktop | screens/p5-embed-confirm-puck-desktop.png | heading focused in iframe | 0 (iframe content = /book confirm runs) | — | static (4.4/4.V: reduce propagates into iframe) | SVG puck (CheckBadge in sky-soft), NO coins PNG in iframe (hasImg false / hasSvg true); host console fired "Booking complete: {booking…}" (contract intact); fetch-stub, no real booking | PASS |
| Embed (modal) | host | mobile | screens/p5-embed-modal-mobile.png | same dialog | 0 (desktop run) | — | — | full-screen measured 0,0,390×844; radius 0, shadow none, maxHeight none (100dvh) | PASS |
| Favicon + fonts (global) | both | — | (verified via DOM/HTTP) | — | — | — | — | /icon.svg 200 image/svg+xml navy `#1D212F` mark, linked rel=icon; body font ppMori everywhere; headings 600; tabular-nums computed on day cells + slot times (74 nodes) + admin When/Tries columns | PASS |

## 5.1 Findings

1. **FIXED (visual-only, trivial):** `/booking/[id]` (path entry) ignored `?theme=dark` —
   page never forwarded `theme`/`brandColor` to `<Booker>` (embed entry `/book` did).
   Fixed in `src/app/booking/[id]/page.tsx` by mirroring the two presentational props
   (+ D14 sky default when `embed=1`). `pnpm lint` + `tsc --noEmit` clean; dark verified
   live (Booker root data-theme=dark, bg ink-2). Diff: 1 file, +9/−1, props only — no
   logic. 5.3 should include this file in its git-diff review.
2. **Note (not a fail):** standalone Booker dark scopes `data-theme` to the Booker root;
   the page body around the card stays beige — matches the Phase-2 verified baseline and
   is invisible in the embed (iframe sized to content).
3. **Note:** Next.js Dev Tools floating button (bottom-left dark circle) appears in all
   screenshots — dev-server overlay, not app UI.
4. DB hygiene: booking WH5kMSjilN7OuQPKY3t5ERAz temp-flipped confirmed→ for the manage
   captures and REVERTED to completed (verified via REST read). No other writes; Replay
   button not clicked; admin/me visited read-only.
5. Session/server left LIVE for 5.2/5.3 (cookies expire ~1h from 2026-06-11 ~20:15 ET;
   re-mint via /tmp/slate-inject-session.mjs if expired).

## 5.2 Findings (a11y audit, 2026-06-12)

1. **axe: 0 violations on every surface × theme × state** — 23 runs saved at
   `axe/p5-*.axe.json` (Booker initial/form/field-errors/confirmation × light+dark; manage
   view/reschedule/cancelled × light+dark; login, landing × light+dark; embed host with
   modal open; /admin + /me × light+dark via re-minted injected session, READ-ONLY).
   Sole `incomplete` anywhere = embed host `color-contrast` over the scrim/iframe
   (axe-undeterminable, 4.2/4.V parity), not a violation.
2. **Lighthouse a11y 1.0** on all 5 reachable public surfaces: book light, book dark,
   login, landing, embed host (`lighthouse/p5-*-a11y.report.{json,html}`).
   Dark login/landing = N/A (localStorage-driven; axe covers). /admin + /me = N/A (no
   session in headless LH Chrome; axe under the live session covers).
3. **FIXED (trivial, a11y-markup-only): embed-example.html missing `<main>` landmark** —
   Lighthouse `landmark-one-main` scored the host page 0.96. Wrapped the static demo
   page's content in `<main>` (public/embed-example.html, +2 lines). Re-run: 1.0. The
   widget contract is untouched (host-page markup only); modal-open axe re-verified clean
   in the same session.
4. **FIXED (a11y-only, focus management): slot pick dropped keyboard focus to `<body>`** —
   when a slot is chosen the slot list unmounts and the attendee form mounts; focus was
   lost and a keyboard user had to re-traverse the whole calendar to reach the form.
   Added a `useEffect` in `src/components/Booker.tsx` (+7 lines, mirrors the existing
   confirmed-heading and field-error focus patterns from 2.3/#30–44): on `selectedSlot`
   set, focus `#booker-name`. Verified both themes: Enter on slot → focus lands on the
   name input with the theme-correct ring → Tab continues email → phone → Confirm CTA.
   `pnpm lint`/`tsc`/`pnpm build` clean; axe form-state re-run 0 violations. 5.3 must
   include Booker.tsx in its git-diff review.
5. **Contrast guard:** `scripts/test-contrast.ts` ALL PASSED standalone (19 assertions,
   exit 0) and inside `pnpm test` (22 blocks ALL PASSED incl. the css-layering tripwire).
   Deliberate-break check: lightening `--pennie-muted` → `FAIL: muted-on-beige = 2.41:1`,
   exit 1; revert verified byte-identical (`git diff` empty), guard green again.
6. **Theme-aware focus rings (the case axe misses):** computed-style on every Tab stop of
   the full Booker walk (month nav → 14 day cells → 12h/24h toggle → slots → form →
   CTA): 2px solid graphite rgb(52,52,52) on light, 2px solid sky rgb(130,208,255) on
   dark, every stop; same on login + landing both themes. No positive tabindex anywhere.
   Screenshots `screens/p5-book-focus-{light,dark}.png` + `p5-book-focus-form-light.png`
   show unclipped rings (incl. grid-edge cells). Previous-month nav correctly `disabled`
   at the current month.
7. **Keyboard nav model (documented, not a fail):** the date grid and slot list are
   Tab-operable labeled buttons (`aria-pressed`, full accessible names) — the documented
   2.2 deviation from the APG roving-tabindex grid (aria-selected is invalid on
   role=button). All functionality is keyboard-operable (WCAG 2.1.1 satisfied); arrow-key
   grid nav is an APG enhancement, not an AA requirement. Flagged as a possible future
   polish item only.
8. **Reduced-motion:** baseline confirmation animation `pn-confirm-rise` 0.36s ×1; under
   `reduce` emulation 1e-05s, settled opacity 1 / transform none, full final frame
   visible, H2 still focused (`screens/p5-confirm-light-reducedmotion.png`). Embed loader
   under reduce = static "Loading…" text, zero animated descendants, iframe transition 0s
   (`screens/p5-embed-loader-reducedmotion.png`, iframe response artificially delayed to
   hold the loader open). Global guard present (`globals.css:339`).
9. **Embed modal keyboard gauntlet (incl. NEW Escape relay):** keyboard-only open (Tab →
   trigger → Enter) → focus lands on Close → scroll lock on → 6 forward Tabs stay inside
   the overlay → host-side Escape closes + restores trigger focus + body overflow +
   un-inerts; reopened, clicked into the iframe (focus inside the iframe document),
   Escape → `slate:escape` postMessage relay (source-checked against
   `activeIframe.contentWindow`) closes the modal with identical restore. Both paths PASS.
10. **Color never the sole signal (computed/DOM evidence):** selected day = aria-pressed
    + aria-current="date" + fontWeight 600 + ring; "today" = the word in the accessible
    name; unavailable days = `disabled`; per-field errors = visible hint text +
    aria-invalid + aria-describedby (icon lives on the 409/500 alert banner per the DS
    field-hint recipe — text is the non-color cue); admin push-health = title tooltip +
    "push 1/1 watched" text; bookable = pill/button text ("Bookable" / "Not bookable");
    webhook status = pill text ("success").
11. **SR semantics:** sr-only labels + autocomplete (name/email/tel) + correct input
    types on all three Booker fields; aria-required="true"; sr-only "Timezone:" prefix;
    every decorative SVG aria-hidden; confirmation H2 receives focus + role=status live
    region (both themes); modal role=dialog + aria-modal + aria-label "Book a call" +
    iframe title "Slate booking".
12. DB hygiene: manage booking re-flipped for the audit (the 1-min
    `/api/cron/complete` sweep auto-re-completes past confirmed bookings, so 5.2 also
    temporarily moved starts_at/ends_at to Jun 20 to dodge it) and REVERTED to
    completed / Jun 4 13:00–13:30 — verified byte-exact against the untouched
    busy_blocks cache row. Note: the first (status-only) flip attempt was swept by the
    cron, which fired one duplicate `booking.completed` webhook to the dev endpoint.
13. Injected session cookies cleared at the end of the audit (/me → /login verified);
    `.tmp-inject.mjs` copy deleted immediately after minting; all temp Playwright
    scripts and the minted-session JSON deleted.

---

## Task 5.3 — Functional regression + build/deploy safety (2026-06-12)

Full detail: `reports/p5-regression.md` + `reports/diff-review.md`.

| Check | Result | Evidence |
|-------|--------|----------|
| pnpm build | PASS exit 0 | reports/p5-build.log |
| pnpm lint | PASS exit 0 | reports/p5-lint.log |
| pnpm test (22 scripts) | PASS exit 0, 22× ALL PASSED incl. contrast guard | reports/p5-test.log |
| tsc --noEmit | PASS exit 0 | reports/p5-tsc.log |
| pnpm cf:build (OpenNext/CF) | PASS exit 0 — worker bundle emitted | reports/p5-cf-build.log |
| git-diff review (D5 gate) | PASS — 5 visual commits clean; 16 approved logic commits (#30–#44, #56) match purposes; 3 uncommitted files = documented 5.1/5.2 fixes only; ZERO unintended logic | reports/diff-review.md |
| Standalone booking E2E (REAL) | PASS — booked 459ccb66 (confirmed + gcal event + busy_block + booking.created success) then cancelled (200, block removed, booking.cancelled success) | reports/p5-e2e-standalone.log |
| Embed booking E2E (REAL, modal UI) | PASS — booked 218d3579 via /embed-example.html (slate:resize stable, slate:bookingSuccessful + host callback, salesforce_id forwarded) then cancelled clean | reports/p5-e2e-embed.log, screens/p5-3-embed-real-confirm.png |
| Validation 400 / rate-limit 429 | PASS — empty attendee → 400 fieldErrors ×3; 4th rapid post from spoofed IP → 429; spoof rate_limits keys deleted | reports/p5-e2e-limits.log |
| cal.com contract | PASS — Cal() API + data-cal-* + param forwarding (embed=1, no default theme, xbc/external_id/prefill) + slate:resize/bookingSuccessful unchanged + slate:escape additive; widget.js still vanilla (0 var(--pennie, 0 imports) | reports/p5-regression.md |
| Cron sanity | PASS — /api/cron/sync 200 truncated:false 0 errors; overlapping call → skipped:"overlapping-run" | reports/p5-cron-sanity.log |
| Fonts + brand assets | PASS — 2 PPMori woff2 + 7 public/brand assets present, build resolves | reports/p5-build.log |

Note: benign /favicon.ico 404 on the static embed host page only (no icon link in the
static HTML); not a contract issue. Working-tree fixes left uncommitted for the Phase 5
orchestrator commit.

# Phase 4 Verification Sweep (Task 4.V) — 2026-06-11

Result: **PASS** (1 fix applied during sweep, re-verified green on both hostile and neutral hosts; all gates re-run after the fix).

All evidence lives under `.claude/orchestration-slate-brand-redesign/reports/`.

---

## 1. Build / lint / test gate — PASS

- `pnpm build` exit 0, `pnpm lint` exit 0, `pnpm test` exit 0 — **16x ALL PASSED**, including
  `# scripts/test-contrast.ts` (4.3 contrast guard ran and passed: 19 assertions, D17 ratios exact,
  forbidden tripwires still failing as designed).
- Re-run after the sweep fix (widget.js): BUILD_EXIT=0 / LINT_EXIT=0 / TEST_EXIT=0, 16x ALL PASSED again.
- Log: `reports/phase-4-test.log` (initial run + post-fix re-run appended).

## 2. cal.com contract — INTACT (static + live)

Static (`public/widget.js`):
- `slate:resize` + `slate:bookingSuccessful` present (lines 357/359 post-fix), handler logic untouched.
- `var(--pennie` matches: **0**. `import |require(|tailwind|react` matches: **0**.
- No default theme: `if (ui.theme) params.set("theme", ui.theme)` — theme/brand only forwarded when the host supplies them; `embed=1` always set; loader-queue draining (`prior.q`/`priorNs[ns].q`) and delegated `data-cal-link` listener unchanged.

Live (`/embed-example.html`, Playwright):
- `Cal.loaded === true`, `Cal.ns.review` is a function; `Cal("on", { action: "bookingSuccessful" })` callback fires (extra callback registered during the sweep also fired).
- iframe src: `book?xbc=411&external_id=…&embed=1` (no theme param with empty `ui` — S5 confirmed); `ui {theme:dark, brandColor:#FF8800}` → `theme=dark&brand=%23FF8800&embed=1`; `xbc`/`external_id`/prefill keys intact.
- `slate:resize` live: synthetic 999 applied to the iframe; during the real walk the iframe tracked 1315px → 256px in a single step.
- **Full in-iframe booking E2E** (client-side fetch stub for POST `/api/bookings`, the documented env-409 precedent): day → slot → prefilled form → Confirm → `slate:bookingSuccessful` fired once → host console logged `Booking complete: {booking, salesforceId}`.
- **No jitter:** iframe height sampled 12x60ms across the confirmation animation = exactly two values (the view-swap resize, then constant). Confirmation animates opacity/transform only.

## 3. Embed chrome literals — PASS

Computed styles with the modal open (1280x900), `reports/screens/embed-chrome-4V.png`:
- Modal: `borderRadius: 16px`, `background: rgb(255,255,255)`, `boxShadow: rgba(29,33,47,0.18) 0 12px 32px`, color graphite `rgb(52,52,52)`, PP Mori-first stack, computed `maxHeight: 810px` (90dvh of 900).
- Overlay: `rgba(29,33,47,0.55)` navy scrim, `position: fixed`.
- Close: 44x44, muted→graphite, focus ring `2px solid rgb(52,52,52)` + offset 2 + decorative sky glow `rgba(130,208,255,0.45)` (the 4.4 theme-aware recipe re-verified).

## 4. Embed modal a11y — PASS

- `role=dialog`, `aria-modal=true`, `aria-label="Book a call"`; iframe `title="Slate booking"`; close `aria-label="Close"`.
- Keyboard-only open (Tab → Enter on the trigger); focus lands on close.
- Trap: Tab close→iframe; Shift+Tab iframe→close; Shift+Tab from close wraps back into the overlay (never to host/body); 10 forward Tabs stayed contained (4.2's 25-Tab walk previously verified the same boundary code).
- Escape (focus host-side) closes; **focus restored to the "Schedule your call" trigger**; `body.style.overflow` restored; all inert flags cleared. While open: body overflow hidden, all body children inert except the overlay.
- The Escape-only-when-focus-is-host-side behavior is the 4.2 **documented limitation**, not a failure (in-iframe keydowns don't reach the host; a relay would be a contract addition).
- axe (wcag2a/2aa/21a/21aa) with the modal open: **0 violations**, 19 passes; sole incomplete = `color-contrast` (axe undeterminable over scrim/iframe, same as 4.2). JSON: `reports/axe/embed-host-modal-open-4V.axe.json`.

## 5. Loading state — PASS

- Live timing: at t=0 after trigger click the loader is present (`role=status`, `aria-label=Loading`, sky `slate-spin` spinner, iframe opacity 0); at t=150ms the loader is removed and the iframe is mid fade-in (opacity 0.85).
- Frozen evidence (iframe load stalled): `reports/screens/embed-loading-4V.png` — white card, navy scrim, sky spinner, focused 44px close.
- Reduced-motion variant: static "Loading…" text, no spinner, iframe `transitionDuration: 0s` (see §7).

## 6. Mobile full-screen — PASS

- 390x844: modal rect `0,0,390x844` edge-to-edge, `borderRadius: 0`, `boxShadow: none`, `maxHeight: none` (the 4.2 `100dvh` injected override). Screenshot: `reports/screens/embed-mobile-4V.png`.

## 7. Reduced-motion — PASS (embed end-to-end + standalone)

Embed (`page.emulateMedia reducedMotion=reduce`):
- Host side: static "Loading…" loader (no spinner), iframe transition 0s, instant reveal; `matchMedia('(prefers-reduced-motion: reduce)')` **matches inside the iframe** (preference propagates).
- In-iframe booking completed under reduce: confirmation delight `animationDuration: 1e-05s`, settled `opacity: 1`, `transform: none`, "You're all set" heading focused, iframe height settled in one step (no jitter).

Standalone `/book?xbc=411&theme=light` under reduce:
- Same: `1e-05s`, opacity 1, transform none, heading focused, coins graphic fully visible (final frame, not stuck invisible). Screenshot: `reports/screens/confirm-reducedmotion-4V.png`. (Motion-present baseline: 4.4's `confirm-light-motion-4-4.png`, 0.36s rise.)

## 8. Theme-aware focus — PASS

Tab walks on `/book?xbc=411` (computed `outline*` on every focused control + overflow-ancestor clip check):
- `theme=light`: `2px solid rgb(52,52,52)` graphite on month-nav, 12h/24h toggle, slot region — zero clipped. `reports/screens/focus-light-4V.png`.
- `theme=dark`: `2px solid rgb(130,208,255)` sky on the same controls — zero clipped. `reports/screens/focus-dark-4V.png`.

## 9. Hostile-host isolation test — PASS after 1 fix

Fixture: `reports/fixtures/embed-hostile-host.html` (skill checklist item 8: `* { font-family:"Comic Sans MS" !important; box-sizing:content-box; letter-spacing:3px; text-align:center }`, `html { font-size:22px; line-height:2.4; color:#ff00ff }`, `button { all:unset }`). Served as a temp copy in `public/` (deleted after, deletion verified — grep count 0).

Before fix (`embed-hostile-4V-before-fix.png`): all structural chrome held (16px radius, white card, navy scrim/shadow, graphite color, border-box, 44px close, cursor, flex — inline resets beat the non-important hostile rules; host `.cta` untouched), **but** the host's `!important` font-family beat the inline non-important reset (chrome glyph/loader text → Comic Sans) and the host `html font-size:22px` inherited into the modal.

**Fix (visual-only, widget.js):** extended the 4.2-injected `#slate-widget-css` host stylesheet with
`.slate-widget-modal{font-size:16px!important}` and
`.slate-widget-modal,.slate-widget-modal *{font-family:'PP Mori',…,sans-serif!important;letter-spacing:normal!important}` —
a class rule out-specifies a host `* { … !important }` reset. Same literal values the inline styles already declare, so neutral hosts render identically. Single IIFE, dependency-free, zero contract-surface lines touched (`node --check` OK; contract greps unchanged).

After fix (`embed-hostile-4V.png`): chrome computed styles **identical to the neutral host** (PP Mori stack, 16px font, 24px line-height, letter-spacing normal, all literals, close 44x44 @ 24px glyph). Host `.cta` computed styles byte-identical before/after modal open — **no leak in either direction**. Neutral host re-verified post-fix: chrome unchanged + `slate:resize`/`slate:bookingSuccessful`/host callback all still fire.

## 10. Cross-surface coherence + regression spot-checks — PASS

- Embed default renders **light** (`data-theme="light"` on the Booker root with no host `ui.theme` — D10 live).
- Host `brand` reaches only the Booker via the `brand` URL param (chrome is literal-valued by construction; 4.1 verified the fixed shell under `brandColor:#FF8800`, re-confirmed via param forwarding this sweep).
- Chrome (fixed white/navy/sky shell) + in-iframe Booker (beige-first, sky CTA, PP Mori) + standalone Booker read as one Pennie experience; in-iframe confirmation uses the lightweight SVG puck, standalone uses the coins graphic (D16 split intact).
- `/book` regression: rendered normally throughout the sweep (calendar, slots, form, confirmation, both themes).
- `/admin` regression (READ-ONLY, injected Supabase session per the 3.V recipe; temp `.tmp-inject.mjs` deleted; cookies cleared after): beige bg, PP Mori, AppHeader + Pennie logo, "Slate admin" h1, light theme. `reports/screens/admin-regression-4V.png`.

## 11. Documented allowances (NOT failures)

- Escape closes only when focus is host-side (4.2 documented limitation).
- Sub-44px allowances: 12h/24h toggle 36px, Booker Back 36px, status pills 24px, `pn-btn--small` 40px internal secondaries, me reset link (2.2/2.3/3.x/4.5 documented).
- Real-booking E2E (no fetch stub) still owed to 5.3 (env: verify-on-book 409s in dev).
- `forwardQueryParams` commented out in the example host (host's choice, not a regression).

## Evidence index

| Item | Path |
|---|---|
| Build/lint/test log (initial + post-fix) | `reports/phase-4-test.log` |
| Embed chrome (desktop, modal open) | `reports/screens/embed-chrome-4V.png` |
| Branded loading state | `reports/screens/embed-loading-4V.png` |
| Mobile full-screen 390x844 | `reports/screens/embed-mobile-4V.png` |
| Hostile host, before fix | `reports/screens/embed-hostile-4V-before-fix.png` |
| Hostile host, after fix (PASS) | `reports/screens/embed-hostile-4V.png` |
| Hostile fixture | `reports/fixtures/embed-hostile-host.html` |
| Focus ring light / dark | `reports/screens/focus-light-4V.png`, `focus-dark-4V.png` |
| Reduced-motion confirmation (standalone) | `reports/screens/confirm-reducedmotion-4V.png` |
| /admin regression spot-check | `reports/screens/admin-regression-4V.png` |
| axe, modal open (0 violations) | `reports/axe/embed-host-modal-open-4V.axe.json` |

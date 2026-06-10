# Phase 2 Verification Sweep (Task 2.V) — PASS

Date: 2026-06-10 · Surfaces: Booker (/book, /booking/[id]), confirmation, manage, embed · Build: integrated working tree on `main` (uncommitted Phase 2 changes)

## Verdict

**PASS.** All Phase 2 deliverables (2.1–2.5) re-verified green on the integrated build. One minor
fix applied during the sweep (main landmark, Lighthouse 0.98 → 1.0). One pre-known environmental
blocker re-confirmed (real-booking 409); not a Phase 2 regression. Full per-surface matrix:
`reports/checklist-phase-2.md` (repo root).

## Gate results

| Gate | Result |
|------|--------|
| pnpm build | exit 0 (re-run after the sweep fix) — `reports/phase-2-build.log` |
| pnpm lint | exit 0 |
| pnpm test | green — 15x ALL PASSED across scripts/test-*.ts; contrast guard correctly absent until 4.3 (D17 pairings verified via live computed styles instead) |
| Stray-color grep | clean — sole literal `PENNIE_SKY = "#82D0FF"` (book/page.tsx:9, documented 2.4 allowance); zero neutral-/emerald-/red-5xx/amber-/green-N in Booker.tsx, ManageBooking.tsx, book/page.tsx, booking/ |
| axe (wcag2a/2aa/21a/21aa) | 0 violations on every state run: Booker initial/form/confirmation x light+dark, manage x light+dark — `reports/axe/p2v-*.axe.json` (8 files) |
| Lighthouse a11y (/book?xbc=411&theme=light) | **1.0** after fix (was 0.98, sole deduction `landmark-one-main`) — `reports/lighthouse/p2v-book-light-a11y.report.{json,html}`; run against `pnpm dev` (a11y category is dev-build-safe) |
| Booker states, both themes, desktop+390 | all captured + measured — `reports/screens/p2v-*.png` (20 captures) |
| Tap targets @390 | day 44x44, month nav 44x44, slot rows 44px, inputs 48px, CTA 56px; no x-overflow (scrollW 390). 12h/24h toggle 36px = documented 2.2 dense-secondary-control allowance |
| Theme-aware focus | light: 2px graphite outline + 2px offset + sky glow; dark: 2px sky outline. Not clipped at either viewport (month-nav clearance 264px desktop / 24px mobile). `overflow-hidden` shell clip risk remains flagged for 4.4 |
| Reduced motion | global guard at globals.css:326; under emulation animationDuration 1e-05s with final frame fully visible (`p2v-confirm-light-reducedmotion.png`); normal run 0.36s `pn-confirm-rise`, settles opacity 1 / transform none |
| Confirmation delight | standalone: pic-1-coins.png 144px in sky-soft panel, "You're all set" h2 receives focus, recap with timezone, sr-only role=status. Embed: lightweight SVG puck, NO img in iframe, h2 focused |
| Embed contract | `Cal()` loader + `data-cal-link` trigger open the modal; `forwardQueryParams` prefills attendee; `slate:resize` x8 + `slate:bookingSuccessful` x1 observed; host `Cal("on", bookingSuccessful)` logged "Booking complete"; iframe height constant (560px across 12x60ms samples) during the confirmation entrance — zero jitter |
| Embed defaults (D14/D10) | no `ui.theme` → renders **light**; no `brand` → dots **sky** rgb(130,208,255); `&brand=%23FF8800` override → rgb(255,136,0); standalone /book keeps green dots + palette |
| Manage/reschedule/cancel | beige + PP Mori; Reschedule outlined 44px/12px; Cancel muted-rose outline 44px (not bright red, not a pill); 30-slot outlined grid 44px/10px; cancelled token shows rose status; bogus token shows branded error; dark = navy root + `--error` #DF9494 |
| Cross-surface coherence | same tokens/type/shapes measured across Booker, confirmation, manage (beige/graphite/sky, ppMori, 600 headings, radius scale, rose errors); /book and /booking/[id] both default light; standalone vs embed confirmations share copy, differ only in graphic |
| Visual-only diff | git diff: Booker.tsx, ManageBooking.tsx, 3 route files, globals.css (+ sweep's `<main>` wrappers). Sole new hook = 2.4's documented focus useEffect. No src/lib/, src/app/api/, server-action, auth, or DB changes |

## Fix applied during the sweep (1)

**`landmark-one-main`** — Lighthouse flagged no `<main>` landmark on /book (0.98). Wrapped the
`<Booker>` render in a bare `<main>` in `src/app/book/page.tsx` and `src/app/booking/[id]/page.tsx`
(their error branches already used `<main>`). Markup-only, no classes, no layout change. Re-verified:
Lighthouse 1.0, build/lint/test green, embed walk repeated after the fix (contract + resize stability
intact), both routes confirmed rendering the Booker inside `main`.

## Environmental blocker (pre-known, re-confirmed — NOT a regression)

**Real booking E2E still 409s in this dev env.** A real `POST /api/bookings` (standalone, fresh slot
on Jun 11) returned 409: the verify-on-book live Google check rejects while `busy_blocks` still lists
the slot (2.4's finding, unchanged). Handled per the task's allowance:
- The 409 path itself is a **styling PASS**: rose `role=alert` + icon, "That time was just taken.
  Please pick another." — rgb(196,61,61) light / rgb(223,148,148) dark (`p2v-book-error-409-*.png`).
- Confirmation/embed E2E completed via client-side route interception (2.3/2.4 precedent).
- **Real-booking E2E remains owed to Task 5.3** once the env (Google calendar state for the seed
  agents) is fixed.

## Notes for Phase 4

- Embed modal chrome is still the old widget.js styling (gray scrim, 12px radius, no full-screen
  100dvh at 390px — measured 359x760). Expected: widget.js untouched in Phase 2; Tasks 4.1/4.2.
- `.pn-btn--primary` latent dark bug (2.3) and shell `overflow-hidden` ring-clip risk (2.1) remain
  flagged for 4.4. No clipping observed at 1280/390 in this sweep.
- Contrast guard `scripts/test-contrast.ts` lands in 4.3; dark `--error` is rgb (token-parser-safe).

## Evidence

- Checklist: `reports/checklist-phase-2.md`
- Screens (20): `reports/screens/p2v-*.png`
- axe (8): `reports/axe/p2v-*.axe.json` (all 0 violations)
- Lighthouse: `reports/lighthouse/p2v-book-light-a11y.report.{json,html}` (1.0)
- Build log: `reports/phase-2-build.log`
- DB hygiene: booking WH5kMSjilN7OuQPKY3t5ERAz temporarily `completed`→`confirmed` for the manage
  action/grid states, reverted to `completed` and re-read to verify (REST, no logic touched).

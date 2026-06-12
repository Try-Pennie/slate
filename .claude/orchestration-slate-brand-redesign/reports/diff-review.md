# Task 5.3 — git-diff review (the "no logic change" gate)

Date: 2026-06-12 · Branch: `redesign/pennie-brand` vs `origin/main` (21 commits + 3 uncommitted working-tree files)

## How this gate was judged

The original D5 gate was "the redesign touched no logic." Since then the user explicitly
approved **sixteen logic fixes**, each its own reviewed + merged PR (issues #30–#44, #56;
PRs #45–#58). The gate therefore fails only on **unintended** logic changes — anything not
explained by (a) the 5 visual-only commits, (b) the 16 approved logic commits, or (c) the 3
documented uncommitted files from 5.1/5.2.

## Commit inventory (exact match with the approved set — no extras, none missing)

### Visual-only commits (verified: no logic)

| Commit | Subject | Verification |
|--------|---------|--------------|
| 7b21364 | Add Pennie design system context and brand redesign plan | docs/skills/orchestration files only — zero `src/`/`public/` app code |
| 99eaa17 | Apply Pennie brand foundation: tokens, PP Mori, theming, icons | fonts/assets/globals.css/layout.tsx/icons/ThemeToggle; logic-keyword grep over the src diff = EMPTY |
| 23b547c | Restyle the booking flow to the Pennie brand | Booker/ManageBooking/book/booking pages + globals.css; only hits = indentation shifts on `salesforceId=` lines + a comment mentioning ResizeObserver |
| 0e5db78 | Restyle the internal pages to the Pennie brand | admin/me/login/landing/AppHeader/Pill/styles; only hits = `className="break-all"` on code chips, indentation on `onClick={signIn}`, copy line |
| 3d7799d | Brand the embed chrome and lock in accessibility | widget.js chrome/a11y + scripts/test-contrast.ts + 2-line class tweaks; logic-keyword grep = EMPTY |

Forbidden-zone check: **none** of the 5 visual commits touch `src/lib/`, `src/app/api/`,
`supabase/`, `src/middleware.ts`, or `src/app/admin/actions.ts` (per-commit name-only grep = CLEAN ×5).

### Intentional logic commits (each verified against its stated purpose)

| Commit | Issue | Subject | Files match purpose |
|--------|-------|---------|---------------------|
| 74c35a4 | #35 | Fix silent gcal sync failure starving the availability cache | migration 0022 + sync.ts throw-on-failure + diag script ✓ |
| 1cd3d4d | #40 | Redirect the OAuth callback to the request origin | api/auth/callback/route.ts only ✓ |
| 1b467bb | #42 | Count only the primary calendar toward agent busy time | google/calendar-select.ts + its test ✓ |
| ad55675 | #37 | Require attendee contact details before booking | lib/attendee.ts + bookings route 400 + Booker form validation + test ✓ |
| e17927b | #41 | Relay Escape from the booking iframe (slate:escape, additive) | widget.js + Booker.tsx, +25 lines, contract msgs untouched ✓ |
| 6dd9e99 | #34 | Surface busy_blocks write-through failures | booking/service.ts retry+alert only ✓ |
| 7e06f14 | #38 | Pass the theme query param through to the manage page | booking/manage/[token]/page.tsx only ✓ |
| 98fb58e | #30 | Coalesce Google push syncs + cron overlap lock | migration 0023 + sync-coalesce.ts + locks.ts + push/cron routes + test ✓ |
| cee4405 | #31 | Rate-limit the public booking endpoint per IP | migration 0024 + rate-limit{,-core}.ts + bookings route + test ✓ |
| 90d45e3 | #32 | Delivery-id idempotency key on outbound webhooks | webhooks/wire.ts extraction + emit.ts + test ✓ |
| 6a7ca20 | #33 | Batch replay of dead-lettered webhook deliveries | emit.ts + retry.ts + admin action/page + test ✓ |
| 56eec2f | #36 | CTA label color by brand-color luminance in the embed | lib/brand-label.ts + 2-line Booker hook + test ✓ |
| b5e3318 | #39 | Wrap ported .pn-* recipes in a cascade layer | globals.css + test-css-layering.ts (CSS-only + test) ✓ |
| c5a40d4 | #43 | Alert on consecutive calendar sync failures | cron/sync route + notify/alerts.ts + test ✓ |
| 3f6de37 | #44 | Budget calendar sync work per cron tick | cron/sync + auth/callback budget + sync-coalesce helpers + test ✓ |
| 546e4dc | #56 | Rate-limit the public availability endpoint per IP | availability route + rate-limit{,-core}.ts + test ✓ |

Every file in the forbidden zones (`src/lib/**`, `src/app/api/**`, `supabase/migrations/**`,
`src/app/admin/actions.ts`) is attributed to exactly these 16 commits — `git log` over those
paths returns only the 13 logic commits that touch them, nothing else.

### Uncommitted working-tree changes (5.1/5.2 fixes — reviewed hunk-by-hunk, NOT committed)

| File | Diff contents | Matches PROGRESS row |
|------|---------------|----------------------|
| `public/embed-example.html` | +2 lines: `<main>` wrapper only | 5.2 fix 1 ✓ |
| `src/app/booking/[id]/page.tsx` | PENNIE_SKY const + `theme`/`brandColor` presentational prop forwarding (mirrors /book, D14); `embedded` hoisted to a const | 5.1 fix ✓ |
| `src/components/Booker.tsx` | +7 lines: `useEffect` focusing `#booker-name` when a slot is picked (a11y focus management) | 5.2 fix 2 ✓ |

Nothing else dirty in the working tree besides PROGRESS.md and untracked `reports/` evidence.

## Changed-file classification (branch, evidence files excluded — 205 orchestration evidence/task files omitted)

| Category | Files |
|----------|-------|
| visual (app code) | globals.css, layout.tsx, page.tsx (landing), login/page.tsx, me/page.tsx, admin/page.tsx, book/page.tsx, booking/[id]/page.tsx, booking/manage/[token]/page.tsx, Booker.tsx, ManageBooking.tsx, AppHeader.tsx, ThemeToggle.tsx, ui/Pill.tsx, ui/styles.ts, icons/* (11), apple-icon.tsx, icon.svg, fonts/pp-mori.ts, widget.js (chrome/a11y literals + approved slate:escape/brand-label hooks) |
| asset | public/brand/* (7), fonts/PPMori/*.woff2 (2), deleted slate-logo.png/icon.png/apple-icon.png |
| verification | scripts/test-contrast.ts, scripts/test-css-layering.ts, reports/evidence, .gitignore |
| approved logic (#30–#44, #56) | src/lib/{attendee,brand-label,locks,rate-limit,rate-limit-core}.ts, lib/booking/service.ts, lib/db/{schema,types}.ts, lib/google/{calendar-select,sync,sync-coalesce}.ts, lib/notify/alerts.ts, lib/webhooks/{emit,retry,wire}.ts, api/{auth/callback,availability,bookings,cron/sync}/route.ts, admin/actions.ts, supabase/migrations/0022–0024, scripts/test-* (8 new suites), scripts/diag-409.mjs |
| docs/skills | CLAUDE.md, .impeccable.md, .claude/skills/* (3), orchestration plan files |
| **FORBIDDEN (unexplained)** | **NONE** |

## Verdict

**PASS.** Every changed file is explained by the visual-only set, the 16 user-approved logic
PRs, or the documented 5.1/5.2 working-tree fixes. Zero unintended logic changes.

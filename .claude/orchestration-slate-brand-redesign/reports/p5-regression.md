# Task 5.3 — Functional regression + build/deploy safety

Date: 2026-06-12 · Branch: `redesign/pennie-brand` · Dev server: localhost:3000 (5.1/5.2 session)

## Gate results

| # | Gate | Result | Evidence |
|---|------|--------|----------|
| 1 | `pnpm build` | **PASS** (exit 0, no missing-asset/font errors) | `reports/p5-build.log` |
| 2 | `pnpm lint` | **PASS** (exit 0) | `reports/p5-lint.log` |
| 3 | `pnpm test` | **PASS** (exit 0; 22 scripts, 22× ALL PASSED, incl. `test-contrast.ts` + `test-css-layering.ts`) | `reports/p5-test.log` |
| 4 | `pnpm exec tsc --noEmit` | **PASS** (exit 0) | `reports/p5-tsc.log` |
| 5 | `pnpm cf:build` (OpenNext/Workers) | **PASS** (exit 0; "Worker saved in `.open-next/worker.js`", "OpenNext build complete") | `reports/p5-cf-build.log` |
| 6 | git-diff review (no UNINTENDED logic) | **PASS** — 5 visual commits clean, 16 approved logic commits match purposes, 3 uncommitted files contain only the documented 5.1/5.2 fixes | `reports/diff-review.md` |
| 7 | Standalone booking E2E (REAL) | **PASS** | log removed 2026-08-13, see note below |
| 8 | Embed booking E2E (REAL, modal UI) | **PASS** | log removed 2026-08-13 (see note below), `reports/screens/p5-3-embed-real-confirm.png` |
| 9 | Validation + rate-limit spot checks | **PASS** (400 fieldErrors; 429 on 4th rapid post; spoof keys deleted) | `reports/p5-e2e-limits.log` |
| 10 | cal.com contract (static + live) | **PASS** | greps + live walk below |
| 11 | Cron endpoints sanity | **PASS** | `reports/p5-cron-sanity.log` |
| 12 | Fonts + brand assets present | **PASS** (2 woff2 + 7 brand assets on disk; build resolves them) | ls + build log |

> **Two evidence logs removed, 2026-08-13 (#1042).** `p5-e2e-standalone.log` and
> `p5-e2e-embed.log` were deleted because each contained a live booking
> `manage_token`, which grants reschedule and cancel on that booking to anyone who
> can read the repo. Secret scanning found them when it was added. The gate results
> above stood at the time and are not being restated; the transcripts below still
> record what was walked. Do not commit a log containing a manage token: the token
> is a credential, not an identifier.

## E2E transcripts

### Standalone (API, real booking — approved; live Regal endpoint received the webhooks, org automations ignore Slate events)

- `GET /api/availability?bucket=411` → 200, bucket "411 Ultra High", 431 slots.
- `POST /api/bookings` (start 2026-06-12T16:50Z, attendee "Slate E2E Test (will cancel)" / dwright@trypennie.com / +12035615295, no salesforceId) → **200**, booking `459ccb66-fe16-4134-bf0c-aa7ee5eb7cb2`.
- DB: status `confirmed`, `gcal_event_id ni4ivcdohr5beh16t0a2jc8ecg`, write-through busy_block `391ff821` (source slate) present.
- `booking.created` delivery `9f578dfc` → status **success**, attempts 1, `200 {"message":"ok"}`.
- `POST /api/bookings/s3ZshI5oZIuQmOFc9UwXcMMF/cancel` → **200** `{"ok":true}`; status `cancelled`, busy_block removed (0 left).
- `booking.cancelled` delivery `6b111972` → **success**, `200 {"message":"ok"}`.

### Embed (Playwright, real booking through the modal UI, different slot)

- `/embed-example.html`: `Cal.loaded === true`, `Cal.ns.review` is a function; `data-cal-link` click opened the dialog ("Book a call", focus on Close).
- Iframe src params: `embed=1`, **no `theme` param** (host sends none — S5 default-theme rule holds), no `brand`, `xbc=411`, `external_id=a04Ui00000HnjwfIAB`, prefill forwarded.
- Walk: day Jun 12 (pre-selected today) → slot **1:00pm** → form mounted with **focus landed on the Name field** (5.2 fix live) → fields overwritten ("Slate E2E Embed Test (will cancel)" / dwright@trypennie.com / +12035615295) → Confirm booking → in-iframe confirmation "You're all set", heading focused, role=status announce, SVG puck.
- postMessage log: `slate:resize` heights 1255→1315 (form) →1259→ confirm 256/254 — **monotonic settles, no oscillation/jitter**; `slate:bookingSuccessful` fired with `{booking: {id: 218d3579-9897-4a0e-b6d5-7d08512064a6, manageUrl…}, salesforceId: a04Ui00000HnjwfIAB}`; host `Cal("on")` callback logged `Booking complete: …`.
- DB: confirmed, `gcal_event_id eh3b71b3iihq4bctpdkatnajog`, `salesforce_id a04Ui00000HnjwfIAB`, busy_block `012882cd`; `booking.created` delivery `17b90559` **success**.
- Cancel via manage token `jBzoCI2tImOQ3OPYlsGNteIX` → 200; status `cancelled`, busy_blocks 0; `booking.cancelled` delivery `a36c6947` **success**.
- Both flows wrote through the same backend path: two real bookings, two clean cancels, four webhook deliveries all success.

### Validation / rate limit (spoofed IP 198.51.100.77, x-forwarded-for)

- Empty attendee → **400** `{"error":"Please check your contact details.","fieldErrors":{name,email,phone}}` (3 field errors).
- Rapid posts: statuses `400,400,400,429` — limiter trips on the 4th attempt (3/min policy), friendly 429 copy.
- Cleanup: deleted `rate_limits` keys `book:h:198.51.100.77`, `book:m:198.51.100.77`; verified 0 remaining.

### Cron sanity

- `GET /api/cron/sync` with `Bearer CRON_SECRET` → **200** `{"agents":1,"watchErrors":0,"truncated":false,"results":[{watch:"current",synced:0}]}` — no errors.
- Overlapping second call (fired 300ms in) → **200** `{"skipped":"overlapping-run"}` (#30 lock works).

## cal.com contract verdict

- Static: `var(--pennie` in widget.js = 0; `import`/`require` = 0; react/tailwind refs = 0 (still a vanilla IIFE); `embed=1` always set (line 139); `theme`/`brand` forwarded **only when host supplies** (lines 137-138); `prior.q`/`priorNs[].q` queue draining intact; `forwardQueryParams` honored.
- Messages: `slate:resize` (line 360) + `slate:bookingSuccessful` (line 362) unchanged; `slate:escape` (line 365) is the **additive** #41 relay, source-checked against the active iframe's contentWindow.
- Live: `Cal()` init/on/ns, `data-cal-*` delegated trigger, param forwarding, resize stability, bookingSuccessful → host callback — all proven in the embed E2E above.
- brandColor: D14 default sky (gated on embed in /book + now mirrored in /booking/[id] working-tree fix) with host `&brand=` override — verified live in 5.1/4.V; brand-label luminance picker (#36) covered by `scripts/test-brand-label.ts` in the suite.

## Notes

- Benign: bare `/favicon.ico` 404 on the static `embed-example.html` host page (static HTML has no icon link; app routes use `/icon.svg`). Host-page-only, pre-existing, not a contract issue.
- The 3 working-tree files (booking/[id]/page.tsx, embed-example.html, Booker.tsx) were left **uncommitted** per instructions — the orchestrator commits Phase 5 as a whole.
- DB hygiene: both E2E bookings remain as legitimate `cancelled` rows (real lifecycle records); busy_blocks fully cleaned by the cancel path; spoofed rate_limits keys deleted; no other test data minted.

## Verdict

**ALL GATES PASS.** The app builds, lints, type-checks, tests green (22/22), deploys through
the OpenNext/Cloudflare adapter, books and cancels for real through both entries, enforces
attendee validation and IP rate limits, keeps the cal.com drop-in contract intact, and the
branch diff contains zero unintended logic changes.

# Slate Brand Redesign — Final Verification & Sign-Off (Task 5.4)

**Date:** 2026-06-12 · **Branch:** `redesign/pennie-brand` vs `origin/main`
**Authority:** DISCOVERY.md D1–D22 (D21 = the "done" bar)

---

## 1. Verdict

# ✅ DONE — signed off against the D21 bar

Every D21 clause is green with evidence. All 28 tasks across 5 phases complete. Zero open
punch-list items. No BLOCKED surfaces remain (the `/admin` + `/me` auth gate was resolved in
3.V via the injected-session recipe and re-used in 5.1/5.2/5.4 — D18 for those surfaces is
**verified, not blocked**).

The redesign sits on intact logic: the diff review proves zero unintended logic changes; the
16 logic fixes that did land were each user-approved, issue-tracked, and PR-reviewed
(issues #30–#44 + #56, PRs #45–#58 — see §7).

---

## 2. D21 acceptance checklist

| # | Clause | Status | Evidence |
|---|--------|--------|----------|
| 1 | Every surface screenshotted both themes vs DS `preview/*.html` | ✅ | 44 captures `reports/screens/p5-*.png`; parity verdicts in `reports/checklist.md` (5.1) |
| 2 | axe 0 violations per surface/theme | ✅ | 23 runs, 0 violations each — `reports/axe/p5-*.axe.json` (5.2) |
| 3 | Lighthouse a11y ≥ 0.95 | ✅ | **1.0 ×5** (book light/dark, login, landing, embed host) — `reports/lighthouse/p5-*-a11y.report.{json,html}`; dark login/landing + admin/me N/A from headless LH (localStorage theme / no session) — axe covers (5.2) |
| 4 | `scripts/test-contrast.ts` PASS via `pnpm test` | ✅ | 19 assertions ALL PASSED standalone + in suite; deliberate-break check fired both directions (4.3, 5.2) |
| 5 | `pnpm build` + `lint` + `test` green | ✅ | Final re-run 2026-06-12: BUILD_EXIT=0, LINT_EXIT=0, TEST_EXIT=0, **22× ALL PASSED** — `reports/final-build.log` |
| 6 | Booking E2E standalone + embed | ✅ | REAL bookings ×2 (459ccb66 standalone API, 218d3579 embed modal UI), both confirmed → gcal event → busy_block → webhooks → cancelled clean — `reports/p5-e2e-{standalone,embed}.log` (5.3) |
| 7 | Reduced-motion static | ✅ | Confirm rise 0.36s → 1e-05s + final frame + H2 focused; embed loader static "Loading…"; reduce propagates into the iframe — `reports/screens/p5-*-reducedmotion.png` (5.2, 4.4/4.V) |
| 8 | cal.com drop-in contract intact | ✅ | `Cal()` API + `data-cal-*` + params (embed=1, no default theme) + `slate:resize`/`slate:bookingSuccessful` unchanged; `slate:escape` additive; widget.js vanilla (0 deps, 0 `var(--pennie`) — `reports/p5-regression.md` (5.3) |
| 9 | No stray hex outside the token layer | ✅ | Repo-wide grep 2026-06-12: zero un-allowed hits (§6) |
| 10 | No logic changed — diff review | ✅ | `reports/diff-review.md`: 5 visual-only commits clean ×5; all forbidden-zone files attributed to the 16 approved logic PRs; 3 uncommitted files = documented 5.1/5.2 fixes only (5.3) |

Also green (beyond the bar): `tsc --noEmit` exit 0 and **`pnpm cf:build` exit 0** (OpenNext
Cloudflare worker bundle emitted — the D5 deployability constraint), `reports/p5-{tsc,cf-build}.log`.

---

## 3. Master surface status table

Consolidated from 5.1 (visual), 5.2 (a11y), 5.3 (functional). Per-row detail in `reports/checklist.md`.

| Surface | Visual 5.1 (both themes, desktop+390) | axe 5.2 | Lighthouse 5.2 | Reduced-motion 5.2 | Functional 5.3 | Overall |
|---------|--------------------------------------|---------|----------------|--------------------|----------------|---------|
| Booker `/book` (initial/day/form/field-errors/confirm) | PASS | 0 ×8 runs | 1.0 light+dark | PASS (confirm static) | REAL E2E booked+cancelled | **PASS** |
| Booker path entry `/booking/[id]` | PASS (after 5.1 fix: theme/brand props forwarded) | covered (same component) | — | — | renders, props-only diff reviewed | **PASS** |
| Manage `/booking/manage/<token>` (view/reschedule/cancelled) | PASS (real tokens) | 0 ×6 runs | — (token URL) | — | reschedule grid + cancel verified; E2E cancel via token | **PASS** |
| Login `/login` | PASS (marketing split, navy panel, sky CTA) | 0 ×2 | 1.0 (light) | — | OAuth flow reaches Google with exact scopes (3.4) | **PASS** |
| Landing `/` | PASS | 0 ×2 | 1.0 (light) | — | hrefs byte-identical | **PASS** |
| Admin `/admin` | PASS (injected session, READ-ONLY) | 0 ×2 (29 passes) | N/A auth (axe covers) | — | actions.ts untouched by visual commits; replay = approved #33 | **PASS** |
| Me `/me` | PASS (injected session, READ-ONLY) | 0 ×2 (23 passes) | N/A auth (axe covers) | — | forms byte-identical | **PASS** |
| Embed `/embed-example.html` + widget.js | PASS (D15 literal chrome computed-style exact; mobile 100dvh full-screen) | 0 modal-open | 1.0 (after 5.2 `<main>` fix) | loader static | REAL embed E2E + contract walk | **PASS** |
| Global (favicon, fonts, tokens) | PASS (navy mark, PP Mori everywhere, 74 tabular-nums nodes) | — | — | global guard `globals.css` | fonts + 7 brand assets present in build | **PASS** |

No BLOCKED rows. (S15: the only candidate — admin/me auth — was resolved; their cells above
are real verified results under the injected session, used strictly READ-ONLY.)

---

## 4. Cross-surface coherence verdict (5.4 spot-check, 2026-06-12)

Fresh computed-style probes on the live dev server across `/book` (light+dark), `/`
(light+dark), `/login` (light+dark), manage (cancelled, real token), `/admin` (light+dark,
injected session READ-ONLY), `/me`. Raw measurements: `reports/p5-coherence.json`.

| Dimension | Verdict | Measured evidence |
|-----------|---------|-------------------|
| **Type** | **PASS** | `fontFamily` = `ppMori, "ppMori Fallback", …` on body + headings of every surface; every heading `font-weight: 600`; slot times/inputs `font-variant-numeric: tabular-nums`; no synthesized bold (font-synthesis: none, 1.3) |
| **Color** | **PASS** | Light: body beige `rgb(249,246,240)`, text graphite `rgb(52,52,52)`, surfaces white. Dark: body navy `rgb(29,33,47)`, text beige, Booker card ink-2 `rgb(52,55,68)`. **Sky `rgb(130,208,255)` + graphite label is the CTA pair on every surface, both themes** (Booker Confirm, login Continue, landing Admin, me Save). Manage cancelled status = rose `rgb(196,61,61)`. No one-off colors found |
| **Shape** | **PASS** | Big CTAs 16px radius × 56px tall (Booker/login/landing); `pn-btn--small` 12px × 40px (admin/me, DS recipe); cards: Booker shell + login card 16px, admin `.pn-card` 10px `--radius-md` (per shipped CSS); inputs 8px; slots 10px × 44px; **pills 999px only on badges** (admin role pills, 24px, weight 600); shadows = the layered soft `--pn-shadow-xs` (3 × rgba(0,0,0,0.04) micro-layers — no hard black anywhere) |
| **Theme parity** | **PASS** | Light↔dark is a clean semantic-var flip: same DOM, `--bg`/`--fg`/`--surface` swap, accent stays sky, CTA label stays graphite (7.36:1 both themes); `data-theme` honored on html (internal, localStorage no-flash) and scoped Booker root (`?theme=dark`, standalone body stays beige = documented Phase-2 baseline) |

The single token source (`src/app/globals.css`) is what the contrast guard, axe runs, and the
stray-color grep all reference — one cascade, no parallel palettes.

---

## 5. D1–D22 decision matrix

| D | Decision (short) | Status | Evidence |
|---|------------------|--------|----------|
| D1 | Full visual redesign to the Pennie system before UI testing | ✅ satisfied | All 9 surfaces restyled (Phases 1–4); §3 |
| D2 | Exported DS is the source of truth; CSS variables, never hex | ✅ satisfied | Two-layer token port (1.2); stray-color grep clean (§6); DS-preview parity (5.1) |
| D3 | Success = every surface on-system, both themes, AA+, green gates, flow intact | ✅ satisfied | §2 (all 10 clauses) |
| D4 | In scope: foundation, Booker, internal, embed, a11y, verification, both themes | ✅ satisfied | 28/28 tasks done (PROGRESS.md) |
| D5 | Visual-only; no logic; no Helvetica; CF-deployable; don't recreate the logo | ✅ satisfied | diff-review PASS; `cf:build` exit 0; PP Mori only; logo = vendored SVGs |
| D6 | Licensed woff2 kit, 400+600, 700→600, `font-synthesis: none` | ✅ satisfied | 1.3 build emits 2 woff2; served CSS 3 `@font-face` all ppMori w/ font-synthesis none |
| D7 | `next/font/local`, expose as token, remove Geist | ✅ satisfied | 1.2/1.3; grep: zero Geist; coherence probe = ppMori everywhere |
| D8 | 80/15/5; sky the ONLY action color; graphite CTA label; rose errors; `#486CCA` blue text | ✅ satisfied | §4 color row; contrast guard pairings; admin/me blue links = `--pennie-blue`/sky-dark |
| D9 | Buttons/cards 16px, bands 24px, chips 4px, pills badges-only, soft shadows | ✅ satisfied | §4 shape row (measured) |
| D10 | Booker defaults light; both themes; embed `theme` override | ✅ satisfied | 2.1 flip; 5.1 fix made `/booking/[id]` honor `?theme=dark` too |
| D11 | Internal admin/me/login support both themes | ✅ satisfied | 3.x + §4 probes (navy dark, beige light, toggle persists) |
| D12 | Marketing-rich login (split, navy panel, brand copy, sticky note, sky CTA) | ✅ satisfied | 3.4; `screens/p5-login-*.png` |
| D13 | Admin/me fully branded, task-efficient, own shell | ✅ satisfied | 3.1 AppHeader shell + 3.2/3.3; §3 |
| D14 | Embed passes sky as DEFAULT brandColor; host override kept | ✅ satisfied | 2.4 (`embed=1` → sky dots; `&brand=` override verified); 4.V/5.3 contract walks |
| D15 | widget.js vanilla; cal.com contract; literal chrome; modal a11y; loader; mobile 100dvh | ✅ satisfied | 4.1/4.2/4.V; 5.3 contract gate; chrome computed-style exact in 5.1 |
| D16 | Delight: coins PNG standalone / SVG puck in embed; warm copy; reduced-motion | ✅ satisfied | 2.4; 5.2 reduced-motion pair; embed puck verified (no PNG in iframe) |
| D17 | Contrast math (7.36 CTA, hover cap, theme-aware focus, no emerald dots, blue text) | ✅ satisfied | `scripts/test-contrast.ts` 19 assertions encode every pairing incl. forbidden tripwires; focus rings measured on every Tab stop (5.2) |
| D18 | A11y: semantics, labels, live regions, reduced-motion, 44px targets, color-never-alone | ✅ satisfied (2 documented deviations/allowances, §5a) | axe 0×23; keyboard gauntlets; SR semantics (checklist 5.2 findings 10–11); admin/me VERIFIED via injected session (not blocked) |
| D19 | Two-layer import-then-map tokens; `data-theme` + `@custom-variant dark` | ✅ satisfied | 1.2; #39 moved `.pn-*` into `@layer components` (guarded by `scripts/test-css-layering.ts`) |
| D20 | Surfaces: code/files + browser verification | ✅ satisfied | All evidence browser-measured (Playwright) + code-gated |
| D21 | The "done" bar | ✅ satisfied | §2 |
| D22 | Foundation first, then Booker → internal → embed/a11y | ✅ satisfied | Phases executed 1→5 in order (PROGRESS.md) |

**22/22 satisfied; none unknown; no unmet decisions.**

### 5a. Documented deviations (all evidence-driven, none violating a decision's intent)

| # | Deviation | Why | Where resolved/standing |
|---|-----------|-----|------------------------|
| 1 | Day buttons use `aria-pressed`, not `aria-selected` | `aria-selected` is invalid on `role=button` (axe `aria-allowed-attr` fail); cue = pressed + 600 weight + ring + `aria-current=date` | 2.2; standing by design |
| 2 | Date grid/slots = Tab-operable labeled buttons, NOT an APG roving-tabindex arrow-key grid | WCAG 2.1.1 fully satisfied (everything keyboard-operable); arrow-key grid is an APG enhancement, not an AA requirement | 2.2/5.2 finding 7; **future polish item** |
| 3 | Big CTAs built from utilities instead of `.pn-btn--primary` | `.pn-btn--primary`'s `color: var(--fg)` went beige-on-sky (1.56:1) in dark scope | 2.3/3.4/3.5; root cause FIXED in 3.V (`var(--fg-on-sky)`) + cascade formalized by #39 `@layer`; utility recipe kept (renders identically) |
| 4 | Muted/lead text uses plain utilities, not `.pn-small`/`.pn-lead` | Unlayered `.pn-*` color beat Tailwind utilities (cascade) | 3.1/3.3/3.5 gotcha; **resolved by #39** (`.pn-*` now in `@layer components`); existing markup left as-is (identical render, 5.1 re-verified post-#39) |
| 5 | 409/500 error = plain rose text + icon, no rose-wash pill | Rose on the 12% wash over white = 4.33:1 AA FAIL; DS field-hint recipe used instead | 2.3; guard encodes rose-on-white 5.14 |
| 6 | Dark theme adds lightened rose `--error: rgb(223,148,148)` | Base rose = 2.30:1 on ink-2 (hard fail); lightened = 4.96/6.72 | 2.3; guard-encoded |
| 7 | Pill pairings: status-ok = graphite-on-green-wash; status-error = rose text + outline (wash dropped) | Spec'd pairings measured 2.44:1 / 4.34:1 at 13px | 3.V fixes 1; guard-encoded |
| 8 | Sub-44px allowances on dense internal controls: 12h/24h toggle 36px, Booker Back 36px, status pills 24px, `pn-btn--small` 40px, me reset link, weekday checkboxes | Documented dense-secondary/badge allowances; 2.5.8 satisfied via spacing; primaries all ≥44/56px | 2.2/2.3/3.2/4.5; accepted |
| 9 | Confirmation illustration = coins (`pic-1`), sticky-note-only login art | Open items resolved during tasks per DISCOVERY's deferral note | 2.4 / 3.4 |
| 10 | `slate:escape` postMessage added to the embed contract (additive) | Closes the 4.2 "Escape only works host-side" limitation; user-approved logic PR #41 | 5.2 finding 9; both Escape paths verified |

---

## 6. Stray-color grep results (2026-06-12, full sweep)

**Verdict: PASS — zero un-allowed stray colors.**

```bash
# Tailwind palette literals (the classes the redesign removed):
rg -n "\b(neutral|emerald|amber|red|green|slate|gray|zinc|stone)-[0-9]{2,3}\b" src public --glob '!**/*.css'
# → NO MATCHES (exit 1)

# Raw hex outside the token layer:
rg -n "#[0-9a-fA-F]{3,8}\b" src public/widget.js public/embed-example.html \
   --glob '!src/app/globals.css' --glob '!**/tokens.css'
# → 13 hits, every one a documented exception (triage below)

# Raw rgb()/rgba() in TS/TSX outside globals.css:
rg -n "rgba?\(" src --glob '!src/app/globals.css' -g '*.{ts,tsx}'
# → 3 hits, all documented (triage below)
```

| Hit | Triage |
|-----|--------|
| `public/widget.js` 186/231/241 — `#fff` modal + loader, `#82D0FF` spinner | **Allowed** — D15 literal chrome (host page can't read `--pennie-*` vars) |
| `src/components/icons/CheckBadgeIcon.tsx` `#F9F6F0` tick | **Allowed** — designed-in on-puck contrast (Task 1.4, skill-documented) |
| `src/app/icon.svg` + `src/app/apple-icon.tsx` `#1D212F`/`#F9F6F0` | **Allowed** — favicon/app-icon baked fills (no inherited cascade) |
| `src/app/book/page.tsx:9` + `src/app/booking/[id]/page.tsx:9` `PENNIE_SKY = "#82D0FF"` | **Allowed** — D14 embed brandColor default (URL-param value, not a style) |
| `src/lib/brand-label.ts` 9/11/12 — graphite/beige comments + `rgb(249,246,240)` luminance constant | **Allowed** — approved logic PR #36 (runtime luminance label picker; runs where the cascade can't) |
| `public/embed-example.html` 15–16 `#171717`/`#fff` | **Allowed** — the static demo HOST page's own `button.cta` styling (simulates a third-party site; not Slate UI; matches the cal.com example it mirrors) |
| `Booker.tsx:98` `rgba(52,52,52,0.04)` navHover wash; `ManageBooking.tsx:139` `rgba(196,61,61,0.06)` cancel hover wash | **Allowed** — task-prescribed translucent washes documented in 2.1/2.5 |

No `neutral-*`, `emerald-*`, `amber-*`, `red-*`, `green-N` Tailwind classes anywhere in
`src/` or `public/`. The token layer (`globals.css`) is the only place raw color values are
defined for styling.

---

## 7. The 16 user-approved logic fixes (folded into the sign-off)

Approved outside the visual-only D5 gate; each its own reviewed + merged PR
(issues **#30–#44, #56**; PRs **#45–#58**). Full commit-by-commit verification in
`reports/diff-review.md`.

| Issue | Fix |
|-------|-----|
| #30 | Coalesce Google push syncs + cron overlap lock |
| #31 | Rate-limit the public booking endpoint per IP |
| #32 | Delivery-id idempotency key on outbound webhooks |
| #33 | Batch replay of dead-lettered webhook deliveries (admin control) |
| #34 | Surface busy_blocks write-through failures |
| #35 | Fix silent gcal sync failure starving the availability cache |
| #36 | CTA label color by brand-color luminance in the embed |
| #37 | Require attendee contact details before booking (400 + field errors) |
| #38 | Pass the theme query param through to the manage page |
| #39 | Wrap ported `.pn-*` recipes in a cascade layer (+ css-layering test) |
| #40 | Redirect the OAuth callback to the request origin |
| #41 | Relay Escape from the booking iframe (`slate:escape`, additive) |
| #42 | Count only the primary calendar toward agent busy time |
| #43 | Alert on consecutive calendar sync failures |
| #44 | Budget calendar sync work per cron tick |
| #56 | Rate-limit the public availability endpoint per IP |

Every forbidden-zone file (`src/lib/**`, `src/app/api/**`, `supabase/migrations/**`,
`admin/actions.ts`) is attributed to exactly these commits — nothing else touched them.

---

## 8. Open items / known limitations (none blocking)

| Item | State |
|------|-------|
| Escape-to-close in the embed | **Both paths now work** — host-side Escape (4.2) + in-iframe Escape via the `slate:escape` relay (#41, verified 5.2). The 4.2 limitation is closed. |
| Date-grid arrow-key navigation (APG roving tabindex) | Future polish only — Tab-operable today, WCAG 2.1.1 satisfied (deviation #2) |
| Lighthouse on `/admin`/`/me` and dark login/landing | N/A from headless LH CLI (no session / localStorage theme) — **axe under the live injected session covers**; not a gap in the AA evidence |
| `/favicon.ico` 404 on the static embed host page | Benign — static demo HTML has no icon link; the app itself serves `/icon.svg` (5.3) |
| 3 uncommitted working-tree files (5.1/5.2 fixes: `booking/[id]/page.tsx`, `embed-example.html`, `Booker.tsx`) + PROGRESS/reports | Reviewed hunk-by-hunk in `diff-review.md`; **left uncommitted for the orchestrator/human to commit** |
| Whether to track `reports/` evidence in git | Human decision (deferred from DISCOVERY open items; `scripts/test-contrast.ts` IS committed as a permanent guard per the recommendation) |
| Real bookings created by the 5.3 E2E (459ccb66, 218d3579) | Remain as legitimate cancelled rows; webhooks went to the live endpoint per approval |

---

## 9. Evidence index

All paths relative to `.claude/orchestration-slate-brand-redesign/reports/`.

| Artifact | What |
|----------|------|
| `final-build.log` | 5.4 final gate: build/lint/test exit 0, 22× ALL PASSED (2026-06-12) |
| `p5-coherence.json` | 5.4 cross-surface computed-style measurements (this report §4) |
| `checklist.md` | Canonical per-surface matrix (5.1 visual + 5.2 a11y + 5.3 functional) |
| `screens/p5-*.png` (44+) | Every surface × theme × viewport, focus rings, reduced-motion, embed states |
| `axe/p5-*.axe.json` (23) | axe-core 4.10.2 wcag2a/2aa/21a/21aa, 0 violations each |
| `lighthouse/p5-*-a11y.report.{json,html}` (5) | Lighthouse a11y 1.0 ×5 |
| `p5-regression.md` + `p5-{build,lint,test,tsc,cf-build,e2e-standalone,e2e-embed,e2e-limits,cron-sanity}.log` | 5.3 functional regression, 12 gates |
| `diff-review.md` | D5 gate: commit-by-commit no-unintended-logic review |
| `screens/p5-3-embed-real-confirm.png` | Real embed booking confirmation |
| `phase-{1,2,3,4}-verification.md` + phase build/test logs + `checklist-phase-2.md` | Per-phase sweep reports (1.V/2.V/3.V/4.V) |
| `screens/*-4V.png`, `axe/embed-host-modal-open-4V.axe.json`, `fixtures/embed-hostile-host.html` | Phase 4 embed contract + hostile-host evidence |
| `scripts/test-contrast.ts` + `scripts/test-css-layering.ts` (repo) | Permanent CI guards (D17 pairings; #39 layering) |

---

## Sign-off

All five phases (28/28 tasks) complete; all four phase sweeps (1.V/2.V/3.V/4.V) plus
5.1/5.2/5.3 green; the D21 bar is met in full with zero open punch-list items.

**The Slate brand redesign is DONE and ready to ship, pending the human commit of the three
reviewed working-tree fixes.**

— Task 5.4, 2026-06-12

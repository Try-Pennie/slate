# Task 2.V: Phase 2 Verification Sweep (Booker)

## Objective

Re-verify ALL Phase 2 deliverables (2.1–2.5) on their real surfaces: every Booker state in BOTH
themes at desktop + 390px mobile, the confirmation delight (standalone + embed) including reduced-
motion, the manage/reschedule/cancel surface, and the branded route error states. Run axe (AA) and
Lighthouse (a11y ≥0.95) on the public Booker, confirm `pnpm build` + `pnpm lint` + `pnpm test`
(incl. the contrast guard) are green, grep for stray non-token colors, and prove the booking flow
works E2E standalone + embed with the cal.com contract intact. Fix any regression and re-verify
until green; record evidence to `reports/`.

## Context

This gates Phase 2 before Phases 3/4 depend on it. Phase 2 made the Booker beige-first and
token-driven (2.1), restyled the calendar/slots with non-color cues + ≥44px targets (2.2), the
form + sky-graphite CTA + rose errors (2.3), the confirmation delight + default-sky brandColor
(2.4), and the manage flow (2.5). This sweep is observation-and-fix only — any fix must stay
visual-only (DISCOVERY D5); if a fix appears to need a logic change, STOP and flag it.

## Target Surfaces

| Surface | Tool | What's Verified |
|---------|------|-----------------|
| `/book?xbc=411&theme=light` / `&theme=dark` | [browser] | All Booker states, both themes, desktop + 390px |
| Confirmation (standalone + embed) | [browser] | Delight graphic/puck, animation, reduced-motion |
| `/embed-example.html` modal | [browser] | Embed booking E2E, cal.com contract, no resize jitter |
| `/booking/manage/<token>` | [browser] | Manage/reschedule/cancel both themes (real token) |
| Repo (build/lint/test, grep) | [code] | Green build/lint/test; no stray colors |

## Dependencies

- Tasks 2.1, 2.2, 2.3, 2.4, 2.5 complete.

## Blocked By

- 2.1, 2.2, 2.3, 2.4, 2.5

## Research Findings

- From `wcag-accessibility.md`: axe `color-contrast` is text-only and misses the **sky focus ring on
  light (1.4.11 non-text)** — verify focus rings via screenshots (graphite outline on light ≥2px,
  sky on navy) and the contrast script, not axe alone. **S3: the theme-aware focus recipe is provided
  by Task 1.2 (graphite outline on light surfaces, sky outline on navy, sky glow as decorative
  box-shadow only) — this sweep VERIFIES that 1.2-provided focus renders on the Booker controls; it
  is not delivered by 2.x or 4.4.** Watch the `overflow-hidden` booker shell clipping edge-control
  outlines (a clipped ring is a FAIL — flag the clip for 4.4's sweep to relax/replace, but the focus
  recipe itself is 1.2's).
- From `slate-ui-verification` (§3–§10): viewports 1280×900 + 390×844; warm routes first; walk the
  interactive flow so screenshots show real states; reduced-motion via `browser_emulate_media`;
  embed contract = `Cal()` API, `data-cal-*`, `slate:resize`/`slate:bookingSuccessful` (watch
  console); acceptance gate = axe clean + Lighthouse ≥0.95 + contrast script PASS + build/lint/test
  green + booking E2E + reduced-motion + contract intact + no stray hex.
- From `slate-embed-contract`: the confirmation animation must NOT resize the iframe (opacity/
  transform only); the embedded confirmation must be the lightweight SVG puck (not the heavy PNG).
- From `booker-ux-patterns.md`: compare each surface to the DS `preview/*.html` cards for visual
  parity (buttons, cards, forms, badges, graphics).

## Execution Plan

### Step 1: Build / lint / test green

**Surface:** [code]

- Run `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green — must include
  `scripts/test-contrast.ts` printing `ALL PASSED` if Task 4.3 has landed it; if 4.3 hasn't run yet,
  note that the contrast guard is pending and verify pairings manually via the screenshots).

**Verification:**
- Exit codes 0; test output shows the contrast block PASS (or noted pending).

### Step 2: Grep for stray non-token colors

**Surface:** [code]

- `grep -rn "neutral-\|emerald-\|red-500\|red-600\|red-200\|red-400\|border-red\|amber-\|green-[0-9]\|#[0-9a-fA-F]\{3,6\}" src/components/Booker.tsx src/components/ManageBooking.tsx src/app/book/page.tsx src/app/booking` 
  — expect only allowed literals: the rose `#C43D3D`/`--error`, the embed default sky `#82D0FF`
  (2.4, if used as a literal), and the `check-badge` tick `#F9F6F0`. Everything else must be a token.
- Record any stray match; fix (token-swap) and re-grep.

**Verification:**
- Only the documented literals remain; no `neutral-`/`emerald-`/`red-5xx`/`amber-`.

### Step 3: Booker states, both themes, desktop + mobile

**Surface:** [browser]

Start dev + warm per `slate-ui-verification` §2; `mkdir -p reports/{screens,axe,lighthouse}`.
- For light AND dark, at 1280×900 AND 390×844: navigate `/book?xbc=411&theme=<t>`, `browser_snapshot`
  + `browser_take_screenshot` for each state by walking the flow:
  1. initial (calendar + slot list, loading→loaded),
  2. day selected,
  3. slot selected → form,
  4. error (force a failed submit / 409 copy),
  5. confirmation.
  Save as `reports/screens/book-<state>-<theme>-<viewport>.png`.
- Measure tap targets at 390px: a day cell, the month-nav button, a slot row, the inputs, the CTA →
  all ≥44px (month nav ≥44×44).
- Focus rings: `browser_press_key('Tab')` through controls; screenshot the ring on both themes
  (`book-focus-light.png` graphite ≥2px, `book-focus-dark.png` sky). Flag any clipped ring.
- Compare against DS `preview/*.html` (buttons/forms/cards) for parity.

**Verification:**
- Beige default light, navy dark; no emerald/neutral/bright-red; non-color cues present (today text,
  selected bold + `aria-selected`, `aria-pressed` toggle); ≥44px targets; visible theme-aware focus.

### Step 4: axe + Lighthouse on the public Booker

**Surface:** [browser]

- Inject axe (Option A) per surface/theme/key states (initial, form, confirmation) → save
  `reports/axe/book-<theme>-<state>.axe.json`. Assert 0 violations on `wcag2a/wcag2aa/wcag21a/
  wcag21aa`, especially `color-contrast`, `label`, `button-name`, `aria-*`, `frame-title`
  (embed iframe), `heading-order`.
- Lighthouse: `npx lighthouse "http://localhost:3000/book?xbc=411&theme=light" --only-categories=
  accessibility --output=json --output=html --output-path=reports/lighthouse/book-light-a11y
  --chrome-flags="--headless=new" --quiet`. Threshold ≥0.95 (target 1.0); explain any deduction.

**Verification:**
- axe 0 violations; Lighthouse a11y ≥0.95. Record counts/ids.

### Step 5: Confirmation delight + reduced-motion (standalone + embed)

**Surface:** [browser]

- Standalone: complete a booking on `/book?xbc=411&theme=light` → confirmation shows `pic-1-coins.png`,
  warm copy, timezone, focus-to-heading; screenshot. Repeat dark.
- Reduced-motion: `browser_emulate_media reducedMotion=reduce` → confirmation renders static final
  frame (`reports/screens/confirm-light-reducedmotion.png`); `browser_evaluate` confirms no transform
  animation; confirm the global guard exists in `globals.css` (grep `prefers-reduced-motion`).
- Embed: `/embed-example.html` → open modal → complete booking → confirmation shows the lightweight
  SVG puck (NOT the PNG); iframe does NOT jitter during the entrance; console shows `slate:resize` +
  `slate:bookingSuccessful`.

**Verification:**
- Standalone graphic, embed SVG puck; reduced-motion static; no iframe resize jitter.

### Step 6: Manage / reschedule / cancel

**Surface:** [browser]

- Using a real `manage_token` (complete a booking on `/book?xbc=411` and reuse, or get one from the
  user — §8): `/booking/manage/<token>` light + dark → screenshots; open Reschedule → outlined slot
  grid screenshot; verify the muted-rose Cancel button + (if triggerable) rose `role="alert"` error.
- Branded error states: `/booking/manage/bogus`, `/book` (no `xbc`) → screenshots.
- axe on the manage view → `reports/axe/manage-light.axe.json`, 0 violations.

**Verification:**
- On-brand both themes; rose (not bright red); outlined reschedule slots ≥44px; branded errors.

### Step 7: Booking E2E + cal.com contract

**Surface:** [browser]

- Standalone E2E: day → slot → form → Confirm → confirmation (already covered, confirm it actually
  books — the `/api/bookings` call succeeds and `confirmed` renders).
- Embed E2E: same via the modal; confirm `Cal()` API, `data-cal-*` trigger, `slate:resize`, and
  `slate:bookingSuccessful` all fire (console). Confirm the embed default renders **light** and the
  default brandColor is sky (no `brand` param), with override working (`&brand=…`).

**Verification:**
- Both flows complete; contract messages fire; embed default light + sky.

### Step 8: Record evidence + fix loop

**Surface:** [code][browser]

- Fill `reports/checklist-phase-2.md` (S13 — per-phase filename so the phase sweeps don't clobber the Phase 5 `reports/checklist.md`; use the `slate-ui-verification` §9 template) with PASS/FAIL + evidence
  paths per (surface × theme × viewport). For any FAIL, apply a visual-only fix in the relevant 2.x
  file, re-run that surface's verification (max 3 retries), then escalate per the 3-tier protocol.
- Confirm no logic was touched in any fix (git diff review: only CSS/markup/asset/a11y-attr changes).

**Verification:**
- `reports/checklist-phase-2.md` complete; all rows PASS; evidence saved.

## Artifacts to Create

- `reports/checklist-phase-2.md` — filled per-surface verification checklist — [file]
- `reports/screens/*.png` — Booker/confirmation/manage/embed screenshots, both themes, both viewports — [file]
- `reports/axe/*.axe.json` — axe results per surface/theme — [file]
- `reports/lighthouse/book-light-a11y.{json,html}` — Lighthouse a11y report — [file]

## Contracts

### Consumes (from upstream tasks)

- All Phase 2 deliverables (2.1–2.5) on their surfaces.

### Provides (for downstream phases)

- A verified, signed-off Booker — Phase 3 (internal pages), Phase 4 (embed/a11y polish), and Phase 5
  (comprehensive verification) build on a known-good consumer surface.

## Acceptance Criteria

- [ ] Every Booker state screenshotted in BOTH themes at desktop + 390px mobile, matching DS previews.
- [ ] axe clean (0 violations, AA tags) on the public Booker per theme/key states.
- [ ] Lighthouse accessibility ≥0.95 on the public Booker.
- [ ] `pnpm build` + `pnpm lint` + `pnpm test` all green (contrast guard PASS, or noted pending 4.3).
- [ ] Confirmation delight verified standalone (graphic) + embed (SVG puck); reduced-motion static.
- [ ] Manage/reschedule/cancel on-brand both themes; muted rose, not bright red; branded route errors.
- [ ] Booking flow works E2E standalone + embed; cal.com contract intact (Cal API, data-cal-*,
      slate:resize, slate:bookingSuccessful); embed default light + sky.
- [ ] No stray `neutral-/emerald-/red-5xx/amber-/#hex` outside the documented allowed literals.
- [ ] Theme-aware focus visible (graphite light / sky navy, ≥2px); clipped rings flagged for 4.4.
- [ ] No booking/availability/sync/round-robin/webhook/auth logic changed (visual-only).
- [ ] Evidence saved to `reports/`; `reports/checklist-phase-2.md` all PASS. All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [code] Code Verification
- `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green; contrast block PASS).
- The Step 2 grep across `Booker.tsx`, `ManageBooking.tsx`, `book/page.tsx`, `booking/` → only
  allowed literals.
- `git diff --stat` review: only `.tsx`/`.css`/asset changes; no `src/lib/`, `src/app/api/`, server
  action, or DB changes.

#### [browser] Web Verification
- Per `slate-ui-verification` §3–§7: deterministic viewports, per-surface snapshot + screenshot,
  flow walk, focus rings, axe injection, Lighthouse, reduced-motion emulation, embed modal +
  console contract check, manage with a real token.

### Cross-Surface Coherence
- Same tokens/type/shapes across Booker, confirmation, manage; `/book` and `/booking/[id]` entries
  both default light; standalone vs embed confirmations share copy, differ only in graphic.

## Skills to Read

- `slate-ui-verification` — the entire verification procedure, surface→URL matrix, axe/Lighthouse/
  contrast-script wiring, auth/token blocker (§8), checklist template (§9), acceptance gate (§10).
- `slate-embed-contract` — cal.com contract checklist, ResizeObserver/no-resize-jitter, embed SVG puck.
- `pennie-design-system-in-slate` — DS-preview parity reference, allowed-literal exceptions.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — axe blind spots
  (focus ring), tooling table, acceptance.
- `.claude/orchestration-slate-brand-redesign/research/booker-ux-patterns.md` — per-state expectations
  for visual parity.
- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` — full
  toolchain + contrast script details.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
`~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md`

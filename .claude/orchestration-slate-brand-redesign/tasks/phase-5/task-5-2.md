# Task 5.2: Accessibility Audit (WCAG 2.1 AA + extra care)

## Objective

Prove every redesigned Slate surface meets WCAG 2.1 AA + the D18 extra-care bar: **axe-core
clean** (0 violations on `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`) on every public surface and the
embed host page; **Lighthouse accessibility ≥ 0.95** (target 1.0) on reachable public surfaces;
the committed **`scripts/test-contrast.ts` contrast guard passes** (via `pnpm test`); and the
checks axe can't reach — keyboard/arrow-key nav, focus movement + theme-aware focus rings,
`prefers-reduced-motion`, screen-reader labels/live regions, and "color is never the sole
signal" — manually verified with captured evidence. Output: `reports/axe/*.json`,
`reports/lighthouse/*`, the contrast-script stdout, focus + reduced-motion screenshots, and the
filled a11y columns of `reports/checklist.md`.

## Context

Task 5.1 produced the visual screenshot set and left `pnpm dev` running with the auth session
live. Task 5.2 runs the accessibility gates against that same running app. DISCOVERY.md D17
(contrast math) and D18 (semantics, focus, keyboard, motion, targets, color-not-alone) are the
acceptance spec; D21 lists axe + Lighthouse + contrast-script + reduced-motion as part of "done."
This task feeds 5.3 (functional/build, which runs `pnpm test` including the contrast guard) and
5.4 (sign-off, which reads the axe/Lighthouse verdicts).

This is a **VERIFICATION task** (D5). You run audits and capture evidence. If a surface fails
axe or a manual check, log it in `reports/checklist.md` as a FAIL with the violation
`id`/`target`/`failureSummary` and flag the owning phase task to fix — do not patch app code
here. The ONE exception: if `scripts/test-contrast.ts` does not yet exist (it should from Task
4.3), create it per §6 of the `slate-ui-verification` skill, because it is a committed CI guard,
not a styling change.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Browser | Playwright MCP | Inject axe via `browser_evaluate`; keyboard walk; focus-ring capture; reduced-motion emulation |
| Browser | npx lighthouse (11.6) | Accessibility score per public surface |
| Code | Bash | Run `pnpm test` (contrast guard); run/verify `scripts/test-contrast.ts` standalone |
| Files | Read/Write | Save axe JSON + Lighthouse JSON/HTML; fill a11y columns of `reports/checklist.md` |
| Browser (manual) | VoiceOver (optional) | SR announcement timing on confirmation/error (high-stakes only) |

## Dependencies

- Task 5.1 — running `pnpm dev` server (warmed), the auth session strategy, the minted
  `manage_token`, and the screenshot baseline.
- Task 4.3 — `scripts/test-contrast.ts` committed (create it here if missing).

## Blocked By

- 5.1 (visual sweep). 5.2 runs on the same live server/session 5.1 leaves up.

## Research Findings

Key findings relevant to this task:

- From `research/verification-toolchain-execution.md`: axe via Playwright `browser_evaluate`
  injection (no new dep) is the primary DOM-WCAG gate — inject axe-core 4.10.2 from CDN (or
  vendor `node_modules/axe-core/axe.min.js` if offline), run with tags
  `['wcag2a','wcag2aa','wcag21a','wcag21aa']`, save `violations` to
  `reports/axe/<surface>-<theme>.axe.json`. Lighthouse a11y threshold **≥ 0.95** (target 1.0);
  perf is informational on a dev build. The contrast script is the one a11y check in `pnpm test`.
- From `research/verification-toolchain-execution.md`: axe `color-contrast` is text-only and
  **misses the sky-focus-ring 1.4.11 case** — a clean axe run is NOT proof the D17 focus rules
  hold; the contrast script + focus screenshots cover that gap. axe can't verify roving tabindex
  arrow-key nav, focus movement between steps, or live-region announcement timing — verify those
  by hand.
- From `research/wcag-accessibility.md` (D17 math): primary CTA graphite `#343434` on sky
  `#82D0FF` = **7.36:1 PASS**. FAILS engineered around: pressed CTA on sky-deep `#439FE1` =
  4.32:1 (cap fill at sky-hover `#6dc5f7` = 6.51:1, signal press via translate); sky focus ring
  on light = 1.57:1 (theme-aware: 2px graphite outline on light, 2px sky on navy, glow is
  decorative box-shadow only); emerald dots 2.54:1 + color-only (replaced with sky/green token +
  non-color cue); muted `#6A6A70`-on-beige = 4.98:1 (thin pass, never lighten); blue text on
  light must use `#486CCA`.
- From `research/wcag-accessibility.md` (D18): date grid = APG date-picker grid (roving tabindex,
  arrow keys, composed `aria-label`s incl. availability count + "today"); time list = listbox/
  radiogroup; labeled+autocompleted inputs; `role="alert"` errors; `aria-live="polite"` for
  loading/availability/confirmation; focus moves to the panel heading between steps; touch
  targets ≥ 44px (month-nav was ~24px, slots/inputs ~40px); color never the sole signal
  (selected day, today, best-match, errors, selected slot).
- From DISCOVERY.md D16: confirmation delight must collapse to a static final frame under
  reduced-motion (opacity/transform only normally); capture a before/after pair.
- From `reports/surface-verification.md`: `/me` + `/admin` are auth-gated → Lighthouse and axe
  can only reach them under a live session; if BLOCKED in 5.1, they stay BLOCKED here.

## Execution Plan

### Step 1: Confirm/refresh the environment

**Surface:** [code]

- [code] Confirm `pnpm dev` (from 5.1) is still serving on port 3000:
  `curl -sf -o /dev/null http://localhost:3000/book?xbc=411 && echo up`. If down, restart per
  the `slate-ui-verification` skill §2 (background) and re-warm routes.
- [code] Confirm `reports/{screens,axe,lighthouse}` exist (5.1 created them); `mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}` if not (S6 — all three canonical subdirs).
- [code] Confirm the auth session from 5.1 is still live (`/me` returns 200, not 307). If it
  expired, re-resolve per skill §8.

**Verification:**
- Server up; `reports/axe` + `reports/lighthouse` exist; auth session status known.

### Step 2: axe-core on every public surface + embed host (both themes)

**Surface:** [browser][file]

For each public surface (Booker light/dark, Booker mobile, confirmation, login light/dark,
landing, embed host page) — and `/me` + `/admin` if the auth session is live — navigate, then
run axe via `browser_evaluate`:

```js
async () => {
  if (!window.axe) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }
  const r = await window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });
  return { violations: r.violations, passes: r.passes.length, incomplete: r.incomplete };
}
```

- [file] Save the returned `violations` array to `reports/axe/<surface>-<theme>.axe.json`
  (e.g. `book-light.axe.json`, `login-dark.axe.json`, `embed-host.axe.json`).
- [browser] Run axe on the Booker in its **interactive states** too (day picked → slot picked →
  form shown → confirmation) — the placeholder-only-input / listbox / `role="alert"` fixes only
  appear once those subtrees mount. Save as `book-form-light.axe.json`, `confirm-light.axe.json`.
- [browser] For the embed: run axe on the **host page** with the modal open
  (`embed-host.axe.json`) — check `frame-title` on the iframe.
- If CDN is offline: read `node_modules/axe-core/axe.min.js` and inject its text instead.

**Blocker rules:** treat as FAIL any of `color-contrast`, `label`/`label-title-only`/
`form-field-multiple-labels`, `aria-required-attr`/`aria-valid-attr-value`/`aria-roles`,
`button-name`/`link-name`, `aria-allowed-attr`, `aria-hidden-focus`, `region`, `heading-order`
(one `<h1>` per surface), `frame-title`. Record each violation's `id`, `impact`,
`nodes[].target`, `nodes[].failureSummary` in the checklist.

**Verification:**
- One `reports/axe/<surface>-<theme>.axe.json` per surface/theme; violation count = 0 for each
  (or logged FAILs). axe-tree confirms listbox/grid roles, labeled inputs, live regions present.

### Step 3: Lighthouse accessibility score (public surfaces)

**Surface:** [browser][file]

- [browser] Run Lighthouse a11y per reachable public surface:
  ```bash
  npx lighthouse "http://localhost:3000/book?xbc=411&theme=light" \
    --only-categories=accessibility \
    --output=json --output=html \
    --output-path=reports/lighthouse/book-light-a11y \
    --chrome-flags="--headless=new" --quiet
  ```
  Repeat for `book-dark`, `login-light`, `login-dark`, `landing-light` (and `/me`, `/admin` only
  if the live session can carry into the headless Lighthouse Chrome — usually it can't, so those
  are typically Lighthouse-N/A and rely on axe under the live PW session instead).
- [file] Outputs land at `reports/lighthouse/<surface>-a11y.report.{json,html}`.

**Threshold:** accessibility **≥ 0.95** (target 1.0). Treat any score < 1.0 as "explain each
deduction" in the checklist. Do NOT gate on the perf number (dev build). Lighthouse can't reach
auth-gated surfaces without a session.

**Verification:**
- One Lighthouse JSON+HTML per reachable public surface; each a11y score ≥ 0.95 recorded.

### Step 4: Contrast guard — `scripts/test-contrast.ts`

**Surface:** [code]

- [code] Confirm `scripts/test-contrast.ts` exists (from Task 4.3). If missing, create it per
  the `slate-ui-verification` skill §6 (node-native, reads resolved token hex from
  `src/app/globals.css`, implements WCAG 2.x luminance, asserts the D17 passing pairings AND the
  forbidden-as-text tripwires, throws on token-not-found). Point `readFileSync` at the file
  Foundation actually wrote (globals.css, or a `tokens.css` it imports — read/merge both if
  split).
- [code] Run it standalone:
  `node --experimental-strip-types scripts/test-contrast.ts` → expect `ALL PASSED`, exit 0.
- [code] Confirm it runs in the test loop: `pnpm test` should print the
  `# scripts/test-contrast.ts` block ending `ALL PASSED`.
- [code] Sanity-check the guard actually guards: temporarily edit a token (e.g. lighten
  `--pennie-beige`) → re-run → script should FAIL (non-zero exit) → **revert the edit**. Record
  that the tripwire fired.

**Verification:**
- `scripts/test-contrast.ts` prints `ALL PASSED` standalone and inside `pnpm test`; deliberate
  token break makes it fail (then reverted).

### Step 5: Theme-aware focus rings (the D17 case axe misses)

**Surface:** [browser]

- [browser] On `/book?xbc=411&theme=light`, `browser_press_key('Tab')` through controls
  (event panel → month nav → day grid → slot list → form → CTA). Screenshot the focus ring →
  `reports/screens/book-focus-light.png`. Confirm a **graphite** outline **≥2px** (the
  contrast-carrying line, 11.54:1 on beige), with the sky glow as a decorative `box-shadow`.
- [browser] Repeat on `theme=dark` → `book-focus-dark.png`. Confirm a **sky** outline ≥2px on
  navy (9.47:1).
- [browser] Watch for the `overflow-hidden` booker shell clipping the ring on edge-adjacent
  controls (month nav, last calendar column) — a clipped ring is a **FAIL** (log it).
- [browser] Confirm via `browser_evaluate` reading `getComputedStyle(activeEl).outlineWidth` /
  `outlineColor` that the focused element's outline is ≥2px and the expected color.

**Verification:**
- Focus screenshots both themes; outline is graphite-on-light / sky-on-navy, ≥2px, not clipped;
  computed-style confirmation logged.

### Step 6: Keyboard / arrow-key navigation + focus movement (axe can't reach)

**Surface:** [browser]

- [browser] In the date grid: arrow keys move day-by-day (Left/Right), week-by-week (Up/Down),
  Home/End, PageUp/PageDown change month (APG date-picker grid + roving tabindex — only the
  active day is `tabindex=0`). Verify via key presses + snapshot which element holds focus.
- [browser] In the slot list: Up/Down move between options, Enter/Space selects
  (listbox/radiogroup semantics, announced count).
- [browser] On choosing a slot, confirm **focus moves** to the form panel heading/first input
  (not left on the slot). On the 409 "time taken" path (if reproducible), focus moves to the
  error and the slot list is re-announced.
- [browser] Confirm tab order is sane (event panel → month nav → grid → slots → form) and no
  positive `tabindex`.

**Verification:**
- Snapshot-confirmed focus lands on the expected element after each key sequence; focus moves
  between steps; documented in the checklist manual-a11y column.

### Step 7: prefers-reduced-motion

**Surface:** [browser][code]

- [browser] `browser_emulate_media` reducedMotion=`reduce`. Navigate
  `/book?xbc=411&theme=light`, complete a booking to reach confirmation, screenshot →
  `reports/screens/confirm-light-reducedmotion.png`.
- [browser] `browser_evaluate`: read `getComputedStyle` on the delight element; assert
  `animationName === 'none'` || `animationDuration` ~ `0s`, and no looping.
- [browser] Capture the SAME surface with `reducedMotion='no-preference'` (the normal
  `confirm-light-desktop.png` from 5.1) so the checklist has a before/after pair proving motion
  exists normally and is suppressed under the pref.
- [code] Grep the token file for the global guard:
  `rg -n "prefers-reduced-motion" src/app/globals.css` → confirm the
  `@media (prefers-reduced-motion: reduce)` block zeroing animation/transition durations exists.

**Verification:**
- Before/after confirmation screenshots; computed animation is `none`/`~0s` under reduce; global
  CSS guard present.

### Step 8: Color-is-never-the-sole-signal + SR labels (manual)

**Surface:** [browser]

- [browser] From the snapshots/screenshots, confirm each color-coded state ALSO has a non-color
  cue: selected day (filled pill / checkmark / bold, plus `aria-selected`/`aria-current`),
  "today" (the word "today" in the accessible name, not just a dot), available vs unavailable
  days (availability count in the label / `aria-disabled`), best-match agent if surfaced (text
  badge), errors (leading icon + `role="alert"` + `aria-describedby`, not just rose text),
  selected slot (checkmark/`aria-selected`).
- [browser] Confirm inputs have real/visually-hidden `<label>`s (not placeholder-only) +
  `autocomplete` tokens; confirmation `<h2>`/heading receives focus + is announced via live
  region.
- [browser] (Optional, high-stakes) VoiceOver pass on the booker confirmation + error to verify
  live-region announcement timing (the region must be mounted before the text changes).

**Verification:**
- Each color-coded state has a documented non-color cue; inputs labeled; live regions present
  in the a11y tree. Logged in the checklist manual-a11y column.

### Step 9: Fill the a11y columns of the checklist

**Surface:** [file]

- [file] Update `reports/checklist.md`: fill **axe (count / ids)**, **Lighthouse a11y**,
  **Reduced-motion**, and **Manual a11y checks** columns for every row; set Result to
  PASS/FAIL/BLOCKED. Attach evidence paths (axe JSON, Lighthouse HTML, focus + reduced-motion
  screenshots).

**Verification:**
- Every checklist row has its a11y columns filled with evidence paths and a verdict.

## Artifacts to Create

- `reports/axe/<surface>-<theme>.axe.json` — axe violations per surface/theme — [file]
- `reports/lighthouse/<surface>-a11y.report.{json,html}` — Lighthouse a11y per public surface — [file]
- `reports/screens/book-focus-light.png`, `book-focus-dark.png` — theme-aware focus evidence — [browser]
- `reports/screens/confirm-light-reducedmotion.png` — reduced-motion confirmation — [browser]
- `scripts/test-contrast.ts` — ONLY if missing from Task 4.3 (committed CI guard) — [code]

## Artifacts to Modify

- `reports/checklist.md` — fill the a11y columns + verdicts — [file]
- (Do NOT modify app styling/logic. Log FAILs for the owning phase task.)

## Contracts

### Provides (for downstream tasks)

- `scripts/test-contrast.ts` passing: 5.3 runs it inside `pnpm test`.
- `reports/axe/*.json` + `reports/lighthouse/*` + focus/reduced-motion screenshots: 5.4 reads
  these for the final a11y sign-off (D17/D18).
- The list of any a11y FAILs/BLOCKED surfaces: feeds 5.4 sign-off and any fix loop.

### Consumes (from upstream tasks)

- 5.1: running warmed `pnpm dev` server, auth session, `manage_token`, screenshot baseline,
  `reports/checklist.md` scaffold.
- 4.3: `scripts/test-contrast.ts` (created here if absent).

## Acceptance Criteria

- [ ] axe-core run on every public surface + interactive booker states + embed host page, both
      themes; **0 violations** on `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` (or logged FAILs);
      JSON saved per surface/theme.
- [ ] Lighthouse accessibility **≥ 0.95** (target 1.0) on every reachable public surface; JSON+HTML saved.
- [ ] `scripts/test-contrast.ts` prints `ALL PASSED` standalone AND inside `pnpm test`; the
      tripwire fires on a deliberate token break (then reverted).
- [ ] Theme-aware focus verified: graphite outline ≥2px on light, sky outline ≥2px on navy, not
      clipped; screenshots captured.
- [ ] Keyboard/arrow-key nav works on date grid + slot list; focus moves between steps.
- [ ] Reduced-motion: confirmation static under emulation (computed animation `none`/`~0s`);
      before/after pair captured; global CSS guard present.
- [ ] Color never the sole signal on selected day, today, availability, best-match, errors,
      selected slot; inputs labeled; live regions present.
- [ ] `/me` + `/admin` audited (if session live) or marked BLOCKED with reason.
- [ ] `reports/checklist.md` a11y columns filled with evidence + verdicts.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- Navigate each public surface (+ interactive booker states, + embed modal); inject + run axe;
  save violations JSON.
- Keyboard walk: Tab/arrow-key sequences; screenshot focus rings both themes; confirm focus
  movement between steps.
- Emulate reduced-motion; capture confirmation static frame; read computed animation style.

#### [code] Code Verification
- `node --experimental-strip-types scripts/test-contrast.ts` → exit 0, `ALL PASSED`.
- `pnpm test` → contrast block prints `ALL PASSED`.
- `rg -n "prefers-reduced-motion" src/app/globals.css` → guard present.

#### [file] File Verification
- `reports/axe/*.json` parse as valid JSON with `violations: []` (or logged failures).
- `reports/lighthouse/*.report.json` → `categories.accessibility.score ≥ 0.95`.
- `reports/checklist.md` a11y columns filled.

### Cross-Surface Coherence
- Confirm the focus-ring treatment is consistent across surfaces (graphite-on-light /
  sky-on-navy everywhere, not per-surface ad-hoc).
- Confirm error styling (muted rose + icon + `role="alert"`) is consistent across Booker form,
  manage/cancel, and any other surface with errors.
- Confirm the contrast script's token reads match the same tokens that produce the rendered
  colors axe/Lighthouse audited (single source of truth: `globals.css`).

## Skills to Read

- `slate-ui-verification` — axe injection (§4), Lighthouse (§5), the full contrast-guard script
  (§6), reduced-motion (§7), auth blocker (§8), checklist (§9), acceptance gate (§10). Primary.
- `pennie-design-system-in-slate` — token names/values so the contrast script and color-signal
  checks reference the right vars.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` — the D17 exact
  ratios, focus/keyboard/motion/target/color-signal requirements, and what axe can't catch.
- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` —
  axe/Lighthouse/contrast-script wiring, thresholds, and the auth/Lighthouse reachability gates.
- `.claude/orchestration-slate-brand-redesign/reports/surface-verification.md` — admin/me auth
  blocker for Lighthouse/axe reachability.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at:
~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

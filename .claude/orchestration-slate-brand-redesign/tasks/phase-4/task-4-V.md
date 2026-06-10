# Task 4.V: Phase 4 Verification Sweep (Embed + accessibility polish)

## Objective

Re-verify every Phase 4 deliverable on its surface and prove the phase is complete: the embed modal is Pennie-branded with literal values and is keyboard-accessible + mobile full-screen, the contrast guard runs green in `pnpm test`, theme-aware focus is AA on both surfaces, reduced-motion is honored everywhere, the responsive sweep holds at 390px, and — critically — the cal.com drop-in contract (`Cal()` API, `data-cal-*` triggers, URL params, `slate:resize`/`slate:bookingSuccessful` postMessage) is still byte-for-byte intact. Fix any failures and re-verify until green; record all evidence in `reports/`.

## Context

The Phase 4 closing verification sweep. It does not introduce new styling; it confirms tasks 4.1–4.5 hold together on their surfaces, in both themes, at desktop + 390px mobile, and that nothing in the visual work broke the embed contract or regressed accessibility. This gates Phase 5 (comprehensive verification). Follow the verification-sweep protocol in PHASES.md: re-verify all deliverables, run build/lint/test, run axe on changed surfaces, check coherence, fix failures, record evidence.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Browser | Playwright MCP | Embed modal a11y + mobile; focus rings both themes; reduced-motion; axe on the embed host page; cal-contract live checks |
| Files / Code | Bash / Read | `pnpm build`/`lint`/`test` (contrast guard); grep contract integrity in `widget.js`; collect evidence |

## Dependencies

- 4.1, 4.2, 4.3, 4.4, 4.5 all complete.

## Blocked By

- 4.1, 4.2, 4.3, 4.4, 4.5

## Research Findings

Key findings consolidated for the sweep:

- From `slate-embed-contract` skill (Verification section) — the canonical embed checklist:
  1. Load `embed-example.html`, open the modal; 2. chrome literals (16px radius, white card, navy `--shadow-pop`, navy scrim `rgba(29,33,47,0.55)`, sky focus ring); 3. `slate:resize` tracks height without jitter (and the confirmation animation does NOT resize the iframe — opacity/transform only); 4. `slate:bookingSuccessful` still fires (the `Cal("on",…)` callback logs); 5. modal a11y (Tab cycles, Escape, focus restore, scroll lock, close ≥44px); 6. Booker inside in light/dark/with `brand`, default renders light; 7. mobile full-screen 375–390px `100dvh`, branded loading visible mid-boot; 8. **isolation test** on a hostile host (`* { font-family:"Comic Sans MS" !important } button { all:unset }`) — chrome renders identically and Slate doesn't restyle the host's `.cta`.
- From DISCOVERY D17/D18/D21: theme-aware focus (graphite-on-light / sky-on-navy ≥3:1), reduced-motion static, contrast guard green in `pnpm test`, build/lint/test green, embed contract intact, AA via axe.
- From `research/verification-toolchain-execution.md`: axe via Playwright `evaluate` injection (no new dep) on the embed host page; the contrast script is the in-`pnpm test` gate; evidence under `reports/{screens,axe}`; `mkdir -p reports/...` first; warm routes (Next 16 on-demand compile); always pass explicit `?theme=`.

## Execution Plan

### Step 1: Prep evidence tree + build/lint/test gate

**Surface:** [code]

- [code] `mkdir -p reports/screens reports/axe`.
- [code] Run `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green). The contrast guard `scripts/test-contrast.ts` (4.3) MUST appear in the test output (`# scripts/test-contrast.ts`) and pass. Save the test log to `reports/phase-4-test.log`.

**Verification:**
- [code] All three pass; the contrast guard ran and passed.

### Step 2: Confirm the cal.com contract is intact (static + live)

**Surface:** [code] then [browser]

- [code] Static grep on `public/widget.js`:
  - `grep -nE "slate:resize|slate:bookingSuccessful" public/widget.js` — both present, unchanged.
  - `grep -n "var(--pennie" public/widget.js` — no matches (literals only).
  - `grep -nE "import |require\(|tailwind|react" public/widget.js` — no dependencies.
  - Confirm `bookingUrl` still sets `embed`, forwards `theme`/`brand`, and the `Cal`/`ns` handlers + delegated `data-cal-link` listener are unchanged.
- [code] Start `pnpm dev` (background); poll `/embed-example.html`.
- [browser] Navigate `/embed-example.html`, open the modal. Watch the console: confirm the `Cal("on", { action: "bookingSuccessful" })` callback remains registered; the iframe `src` contains `book?...&embed=1`. Complete a booking and confirm the console logs `Booking complete:` (the `bookingSuccessful` re-emit). Confirm `slate:resize` sets the iframe height without jitter and the confirmation animation does NOT resize the iframe.

**Verification:**
- [browser] `bookingSuccessful` fires through to the host callback; `slate:resize` works without jitter; URL params intact. [code] grep confirms no contract drift.

### Step 3: Embed chrome literals + a11y + mobile + loading

**Surface:** [browser]

- [browser] With the modal open (desktop 1280×900): `browser_evaluate` computed styles — modal `borderRadius:16px` + `boxShadow` contains `rgba(29,33,47,0.18)` + white bg; overlay bg `rgba(29,33,47,0.55)`; close `color:rgb(106,106,112)` and a sky focus ring on focus. Screenshot `reports/screens/embed-chrome-4V.png`.
- [browser] **a11y:** Tab cycles close ⇄ iframe (never to host); Escape closes; focus returns to trigger; background inert + scroll locked; close target ≥44px (`getBoundingClientRect`). Inject axe (`browser_evaluate`) on the host page with the modal open → 0 violations on `dialog-name`/`aria-required-attr`/`button-name`/`frame-title`/`aria-hidden-focus`; save `reports/axe/embed-host-modal-open.axe.json`.
- [browser] **Loading:** confirm the branded loader shows before the iframe paints (throttle if possible); screenshot `reports/screens/embed-loading-4V.png`.
- [browser] **Mobile:** `browser_resize` 390×844; open the modal → full-screen `100dvh`, radius 0; screenshot `reports/screens/embed-mobile-4V.png`.

**Verification:**
- [browser] Chrome literals correct; a11y (trap/Escape/restore/inert/scroll-lock/≥44px) all pass; axe 0 violations; loader visible; mobile full-screen.

### Step 4: Theme-aware focus + reduced-motion across surfaces

**Surface:** [browser]

- [browser] `/book?xbc=411&theme=light`: Tab through controls; `browser_evaluate` `getComputedStyle(document.activeElement).outline*` → graphite outline ≥2px (not translucent sky); screenshot `reports/screens/focus-light-4V.png`. Confirm edge controls (month-nav, last day) not clipped.
- [browser] `/book?xbc=411&theme=dark`: repeat → sky outline ≥2px; screenshot `reports/screens/focus-dark-4V.png`.
- [browser] **Reduced-motion:** `browser_emulate_media` reducedMotion=reduce; complete a booking on `theme=light`; the confirmation delight renders the final frame statically + visibly (`getComputedStyle` → `animationName:none` / ~0s, element not stuck invisible). Screenshot `reports/screens/confirm-reducedmotion-4V.png`. Confirm the embed path is also static end-to-end under reduced-motion (host loader + in-iframe delight).

**Verification:**
- [browser] Light focus graphite ≥2px, dark focus sky ≥2px, edge rings unclipped; reduced-motion renders confirmation static + visible on both standalone and embed paths.

### Step 5: Isolation test on a hostile host page

**Surface:** [browser]

- [code] Create a temporary hostile copy of the embed host page under `reports/` (or a temp path served by dev): a copy of `public/embed-example.html` with `<style>* { font-family:"Comic Sans MS" !important; box-sizing:content-box } button { all:unset }</style>` added. (Serve it via the dev server or `browser_navigate` to a `file://` copy that still points the loader at `http://localhost:3000/widget.js`.)
- [browser] Open the modal from the hostile host; screenshot `reports/screens/embed-hostile-4V.png`. Confirm the chrome (16px radius, white card, navy scrim, close button) renders **identically** to the neutral host (the inheritable-property resets / Shadow DOM from 4.1/4.2 held). Confirm Slate's chrome did NOT restyle the host's own `.cta` button.

**Verification:**
- [browser] Chrome identical on neutral vs hostile host; no leak in either direction.

### Step 6: Cross-surface coherence + fix loop

**Surface:** [browser] / [code]

- [browser] Compare the embed chrome, the in-iframe Booker, and the standalone Booker — they read as one Pennie experience (chrome = fixed shell, Booker = themed content). Confirm the embed default renders light (D10 flip) and a host `brand` color tints only the Booker, not the chrome.
- For any failure in Steps 1–5: analyze → apply the minimal visual-only fix in the owning task's files → re-verify (retry ≤3) → escalate if still failing.

**Verification:**
- [browser] All surfaces coherent; any failures fixed and re-verified green.

### Step 7: Record evidence

**Surface:** [file]

- [file] Write `reports/phase-4-verification.md` summarizing: build/lint/test result, contract grep + live `bookingSuccessful`/`resize` results, embed chrome literals, embed a11y + axe counts, focus (light/dark), reduced-motion, mobile full-screen, isolation test, and links to every screenshot/JSON. Note any deferred items (e.g. `/admin` `/me` mobile pending an auth session) with the blocker.

**Verification:**
- [file] `reports/phase-4-verification.md` exists and references all evidence; deferred items flagged.

## Artifacts to Create

- `reports/phase-4-verification.md` - the phase sweep summary - [file]
- `reports/phase-4-test.log` - build/lint/test output incl. the contrast guard - [code]
- `reports/screens/embed-chrome-4V.png`, `embed-loading-4V.png`, `embed-mobile-4V.png`, `embed-hostile-4V.png`, `focus-light-4V.png`, `focus-dark-4V.png`, `confirm-reducedmotion-4V.png` - [browser]
- `reports/axe/embed-host-modal-open.axe.json` - [browser]

## Artifacts to Modify

- Only failure-fixes in the owning task's files (`public/widget.js`, `src/app/globals.css`, Booker/components) if a check fails; otherwise none.

## Contracts

### Provides (for downstream tasks)

- A verified, signed-off Phase 4 — embed branded + accessible + mobile, contrast guard live, focus/motion AA, contract intact. Phase 5 (comprehensive verification) builds on this evidence.

### Consumes (from upstream tasks)

- 4.1 (chrome literals), 4.2 (modal a11y/loading/mobile), 4.3 (contrast guard), 4.4 (focus + reduced-motion), 4.5 (responsive sweep) — all re-verified here.

## Acceptance Criteria

- [ ] `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` green with the contrast guard running and passing.
- [ ] Embed chrome literals correct (white 16px card, navy `--shadow-pop`, navy scrim, muted/graphite close with sky focus ring); no `var(--pennie-*)` in `widget.js`.
- [ ] Embed modal a11y passes: role/aria-modal/aria-label, focus trap + restore, Escape, scroll lock + inert, close ≥44px; axe 0 violations on the dialog/aria/frame rules.
- [ ] Embed mobile full-screen at 390px; branded loading visible before iframe paint.
- [ ] Theme-aware focus: graphite ≥2px on light, sky ≥2px on navy, edge rings unclipped.
- [ ] Reduced-motion renders the confirmation delight statically + visibly on both standalone and embed paths.
- [ ] Isolation test: chrome identical on neutral vs hostile host; no leak either direction.
- [ ] cal.com contract intact: `Cal()` API, `data-cal-*`, URL params (`xbc`/`external_id`/`embed`/`theme`/`brand`), `slate:resize`/`slate:bookingSuccessful` — verified live (`bookingSuccessful` logs to the host callback) and by grep.
- [ ] Evidence recorded in `reports/`; deferred items (auth-gated `/admin` `/me`) flagged.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- `/embed-example.html`: open modal → chrome literal computed-style assertions; keyboard trap/Escape/restore; inert + scroll lock; close ≥44px; axe 0 violations (JSON saved); loader before paint; mobile full-screen 390px; live `bookingSuccessful` + `resize`; hostile-host isolation identical.
- `/book?xbc=411&theme=light|dark`: focus rings graphite/sky ≥2px, unclipped; reduced-motion confirmation static + visible.

#### [code] Code Verification
- Run: `pnpm build` (exit 0), `pnpm lint` (clean), `pnpm test` (green, contrast guard present).
- Run: `grep -nE "slate:resize|slate:bookingSuccessful" public/widget.js` (both present), `grep -n "var(--pennie" public/widget.js` (none), `grep -nE "import |require\(|tailwind|react" public/widget.js` (none).

#### [file] File Verification
- `reports/phase-4-verification.md` exists and links all evidence; `reports/phase-4-test.log` captures the suite output.

### Cross-Surface Coherence
- Embed chrome (fixed Pennie shell) + Booker (themed content) read as one experience; embed default renders light; a host `brand` tints only the Booker. Reduced-motion is honored end-to-end on the embed path (host loader + in-iframe delight). The contrast guard's static math agrees with the in-browser focus/contrast observations.

## Skills to Read

- `slate-embed-contract` - the embed verification checklist (literals, a11y, mobile, isolation test) and the full contract list.
- `slate-ui-verification` - Playwright drive of `/embed-example.html` and `/book`, axe injection, reduced-motion emulation, evidence locations, the auth blocker for `/admin` `/me`.
- `pennie-design-system-in-slate` - to confirm coherence against the design system.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md` - the contract parity flags and the isolation/verification strategy.
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - focus + reduced-motion acceptance.
- `.claude/orchestration-slate-brand-redesign/research/verification-toolchain-execution.md` - axe-via-Playwright, evidence tree, route warming, theme-explicit URLs.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

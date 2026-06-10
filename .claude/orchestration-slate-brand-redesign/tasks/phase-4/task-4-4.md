# Task 4.4: Theme-aware focus + reduced-motion sweep (VERIFY/sweep — not the deliverer)

## Objective

Sweep and **verify** accessible focus and motion across every restyled Slate surface. The
theme-aware focus TOKEN/recipe (`--focus-ring-line` + the `:focus-visible` graphite-on-light /
sky-on-navy outline + decorative sky `box-shadow`) and the global `prefers-reduced-motion` guard
are **authored in Task 1.2 (Foundation)** — this task does NOT define them (S3/S9). Instead it: (1)
proves the 1.2-provided theme-aware focus actually renders ≥2px and contrast-correct on every
surface, fixes any `overflow-hidden` clipping, and wires any control that escaped the global
recipe; and (2) verifies every entry/float/hover/delight animation collapses to a static final
state under reduced motion, with the **confirmation delight verified-only** (S11 — do NOT re-edit
the 2.4 component; its resting state must already be the final visible frame). This is a
cross-surface accessibility pass over the work done in Phases 1–3 (and complements the embed's own
reduced-motion gating from 4.2).

## Context

Phase 4 polish task that gates on the Booker (2.V) and internal pages (3.V) being styled, because it sweeps focus and motion across all of them. The focus fix is the single most important focus correction in the whole redesign: the system default focus ring is sky `rgba(130,208,255,0.45)`, which is only 1.57:1 against beige and 1.69:1 against white — below the WCAG 3:1 non-text-contrast bar. The fix is a theme-aware focus token that puts the contrast burden on a dark (graphite) outline on light themes and a sky outline on navy, keeping the sky glow purely decorative — **this token (`--focus-ring-line`) and the `:focus-visible` recipe, plus the global `prefers-reduced-motion` guard, are already defined in Task 1.2 (S3/S9).** This task is the cross-surface VERIFY/sweep: confirm 1.2's focus renders correctly everywhere, fix the `overflow-hidden` clip and any control that bypassed the recipe, and verify reduced-motion behavior end to end. It does not re-author the token or re-edit the 2.4 delight component (S11 — verify-only).

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Files / Code | Read / Edit / Bash | Define theme-aware focus tokens + `.pn-*`/`:focus-visible` recipe and the global reduced-motion guard in `globals.css`; branch JS-driven delight motion on reduced-motion |
| Browser | Playwright MCP | Tab through each surface (focus ring proof on beige + navy); emulate reduced-motion → no animation |

## Dependencies

- Phase 2 (Booker restyle) and Phase 3 (internal pages) — focus and motion are swept across all of them.
- 1.2 (token layer) — the focus tokens are defined alongside the ported tokens.

## Blocked By

- 2.V, 3.V

## Research Findings

Key findings from research and DISCOVERY relevant to this task:

- From `research/wcag-accessibility.md` §2 (Focus indicators) — the core fix:
  - System default `.pn-btn:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }` where `--focus-ring: rgba(130,208,255,0.45)`.
  - Against navy: sky-on-navy = 9.47:1 — excellent, keep sky there.
  - Against beige/white: sky ring is **1.57:1 / 1.69:1 — below the 3:1 bar**. This is the single most important focus fix.
  - **Recommendation — theme-aware focus token.** Split the soft glow (`--focus-ring`) from a contrast-carrying line (`--focus-ring-line`):
    - Light theme: `outline: 2px solid var(--fg) /* graphite, 11.5:1 */; outline-offset: 2px; box-shadow: 0 0 0 4px var(--focus-ring);`
    - Dark/navy theme: `outline: 2px solid var(--accent) /* sky, 9.5:1 */; box-shadow: 0 0 0 4px var(--focus-ring);`
  - Meet SC 2.4.13 "Focus Appearance" (≥2px perimeter, ≥3:1 against adjacent colors).
  - **`overflow-hidden` clips outlines:** the booker shell (`overflow-hidden rounded-2xl`) clips child outlines at the edge — use `box-shadow` rings for edge-adjacent controls, or relax the clip. Never `outline:none` without a replacement.
- From `research/wcag-accessibility.md` §4 (prefers-reduced-motion):
  - Global guard in `globals.css`:
    ```css
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
        scroll-behavior: auto !important;
      }
    }
    ```
  - Per-effect intent: entry/float → instant fade-to-final (opacity only, no transform); hover transform/scale → drop transform, keep color; `.pn-btn:active { transform: translateY(1px) }` is sub-perceptual but include it in the guard for consistency.
  - **Confirmation delight** is the highest risk: under reduced-motion render the **final composed frame statically** (illustration + warm copy, no loop/parallax/confetti). Never auto-play looping motion >5s without a pause control. If JS drives the animation, branch with `useReducedMotion()` — do not rely solely on CSS.
- From DISCOVERY D17 (focus): theme-aware focus is the prescribed fix; sky glow stays decorative box-shadow only.
- From DISCOVERY D18: honor `prefers-reduced-motion`; color never the sole signal (this task is focus+motion; the color-signal work is in Phase 2/3 tasks — verify it wasn't regressed here but don't re-implement).
- From DISCOVERY D16: confirmation delight = calm single fade/rise, opacity/transform only, reduced-motion honored.

## Execution Plan

### Step 1: Audit current focus + motion across surfaces

**Surface:** [file]

- [file] Read `src/app/globals.css` — find the existing `:focus-visible` / `.pn-btn:focus-visible` rules and the `--focus-ring` token; confirm whether a global reduced-motion guard already exists (grep `prefers-reduced-motion`).
- [code] Grep the codebase for focus and motion surfaces to sweep:
  - `grep -rnE ":focus-visible|outline:|outline-none|focus:ring|focus-visible" src/` — find every focus treatment (Booker, admin, me, login, landing, ManageBooking).
  - `grep -rnE "animate-|transition|transform|@keyframes|animation:|useReducedMotion|motion\." src/` — find every animation/transition, especially the confirmation delight (Phase 2.4) and any entry/float effects.
- Note the JS-driven delight component (the standalone confirmation graphic + the embedded SVG puck from Task 2.4) — it needs a reduced-motion branch in code, not just CSS.

**Verification:**
- [file] You have a list of: every focus treatment, every animation/transition, and the JS-driven delight component(s) that need a reduced-motion branch.

### Step 2: Verify the 1.2-provided theme-aware focus recipe + wire any stragglers

**Surface:** [code]

- **S3: Task 1.2 OWNS the focus token/recipe — do NOT redefine it here.** First confirm it exists:
  - `grep -n "focus-ring-line" src/app/globals.css` → `--focus-ring-line` defined in `:root`
    (`var(--fg)`, graphite ~11.5:1 on beige) and flipped to `var(--accent)` (sky ~9.5:1 on navy)
    inside `[data-theme="dark"]`.
  - Confirm the global `:focus-visible` (and `.pn-btn:focus-visible`) recipe is:
    ```css
    :focus-visible {
      outline: 2px solid var(--focus-ring-line);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px var(--focus-ring); /* sky glow, decorative only */
    }
    ```
  - If 1.2 did not land this (STOP and hand back to 1.2 — it is 1.2's deliverable). The only edit
    this task makes to `globals.css` is **wiring stragglers**: any control that bypasses the global
    recipe (e.g. set `outline: 3px solid var(--focus-ring)` directly, or `outline:none`/Tailwind
    `outline-none` without a replacement) → route it through the 1.2 recipe. Do NOT re-author
    `--focus-ring-line`.
- [code] Ensure no surface uses `outline: none` / Tailwind `outline-none` without the 1.2
  replacement. Confirm the Booker's day/slot/month-nav buttons, inputs, and the CTA inherit the 1.2
  `:focus-visible` recipe (add the class hook only if a control isn't picking it up).

**Verification:**
- [code] `pnpm build` exits 0. Grep confirms `--focus-ring-line` defined in both `:root` and `[data-theme="dark"]` (authored by 1.2), and the `:focus-visible` recipe uses outline + box-shadow.

### Step 3: Fix the `overflow-hidden` outline clipping

**Surface:** [code]

- [code] Find the booker shell (`overflow-hidden rounded-2xl` per research) and any other container that clips child focus outlines at the edge. For edge-adjacent controls (month-nav `‹ ›`, last calendar column), either:
  - use a `box-shadow`-based ring (which isn't clipped the same way) for those controls, OR
  - relax the clip on the shell (e.g. allow `overflow: visible` where it doesn't break layout, or add inner padding so outlines aren't at the boundary).
- Keep the change minimal and visual-only; do not alter layout logic.

**Verification:**
- [browser] (deferred to Step 6) Tab to the month-nav and last-column day; the focus ring is fully visible, not clipped by the shell edge.

### Step 4: Verify the global reduced-motion guard (authored in 1.2)

**Surface:** [code]

- **S9: Task 1.2 OWNS the global `prefers-reduced-motion` guard** (it must exist before any Phase 2
  animation lands). This task only verifies it is present and effective:
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .01ms !important;
      scroll-behavior: auto !important;
    }
  }
  ```
  Confirm it sits after the base/`.pn-*` styles so it wins, and that it neutralizes the loading
  `animate-pulse`, hover transitions, and entry animations CSS-side. If it is missing, hand back to
  1.2 (do not add a second copy here).

**Verification:**
- [code] `grep -n "prefers-reduced-motion" src/app/globals.css` shows the guard present once
  (authored by 1.2), after the base styles.

### Step 5: VERIFY the 2.4 delight under reduced-motion (do NOT re-edit the component — S11)

**Surface:** [code][browser]

- **S11: Task 2.4 OWNS the confirmation delight component and already branches its motion on
  reduced-motion / sets the resting state to the final visible frame. This task is verify-only — do
  NOT re-edit the 2.4 component.** Its resting (no-animation) state must already BE the final
  composed frame (illustration + warm copy), so when the 1.2 global guard zeroes the animation, the
  content is fully visible — never `opacity:0` waiting on a disabled animation.
- [code] Verify (read-only) that 2.4's delight does not gate visibility on an animation the guard
  disables, and that there is no auto-playing loop >5s without a control (SC 2.2.2). If a problem is
  found, **flag it back to Task 2.4** to fix at its source rather than patching it here.
- [code] Per-effect across surfaces: confirm hover `transform`/scale effects degrade to a valid
  color-only resting state under reduced-motion (the 1.2 guard zeroes the transition duration;
  confirm the hover end-state is still a valid resting state). These are non-2.4 surfaces and may be
  wired here if a control bypasses the recipe.

**Verification:**
- [browser] (deferred) With reduced-motion emulated, the confirmation shows the final illustration + copy immediately, no motion; nothing is stuck invisible. Any 2.4 issue is flagged back to 2.4, not patched here.

### Step 6: Verify focus + motion live across surfaces

**Surface:** [browser]

- [code] Start dev server: `cd /Users/danhankins-wright/Documents/Slate && pnpm dev`; warm and poll each route.
- [code] S6: `mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}` before any capture. Canonical names for this task: `reports/screens/focus-book-light-4-4.png`, `reports/screens/focus-book-dark-4-4.png`, `reports/screens/confirm-light-reducedmotion-4-4.png`.
- [browser] **Focus on light:** navigate `/book?xbc=411&theme=light`; `browser_press_key('Tab')` through month-nav → day grid → time list → form → CTA; at each stop `browser_take_screenshot` (e.g. `reports/screens/focus-book-light-4-4.png`) and `browser_evaluate` `getComputedStyle(document.activeElement).outlineColor` — assert it resolves to graphite (the `--fg` value), ≥2px, and is NOT the translucent sky.
- [browser] **Focus on navy:** navigate `/book?xbc=411&theme=dark`; repeat; assert the active element's outline resolves to sky (`--accent`), ≥2px. Screenshot `reports/screens/focus-book-dark-4-4.png`.
- [browser] **Edge controls:** confirm the month-nav and last-column day focus rings are not clipped by the shell.
- [browser] **Other surfaces:** Tab through `/login` (both themes) and `/landing` (`page.tsx`) and confirm visible theme-appropriate focus rings; capture a representative screenshot each. (For `/admin` and `/me`, which are auth-gated, follow the auth note in PHASES.md / `slate-ui-verification`; if a session isn't available, verify the focus recipe via the shared `.pn-*`/`:focus-visible` rules and note the auth blocker.)
- [browser] **Reduced-motion:** `browser_emulate_media` reducedMotion=reduce; complete a booking on `/book?xbc=411&theme=light` to reach the confirmation delight; screenshot `reports/screens/confirm-light-reducedmotion-4-4.png`; `browser_evaluate` `getComputedStyle(<delight element>)` → assert `animationName === 'none'` (or `animationDuration` ≈ `0.01ms`/`0s`) and the element is visible (not stuck at opacity 0). Capture the non-reduced version too for a before/after pair.

**Verification:**
- [browser] Light-theme focus outlines are graphite ≥2px; dark-theme are sky ≥2px; edge controls not clipped; reduced-motion renders the delight statically and visibly with no animation.

## Artifacts to Create

- `reports/screens/focus-book-light-4-4.png` - graphite focus ring on beige - [browser]
- `reports/screens/focus-book-dark-4-4.png` - sky focus ring on navy - [browser]
- `reports/screens/confirm-light-reducedmotion-4-4.png` - static delight under reduced-motion - [browser]

## Artifacts to Modify

- `src/app/globals.css` - NOT re-authored here (S3/S9 — `--focus-ring-line`, the `:focus-visible` recipe, and the global reduced-motion guard are owned by Task 1.2). Touch only to wire a straggler control through the existing 1.2 recipe if one bypasses it - [code]
- The booker shell component (and any container clipping outlines) - relax/replace the edge-clipping focus so outlines are visible - [code]
- (S11: the confirmation delight component (Task 2.4) is NOT modified here — verify-only. Its resting state is already the final visible frame; flag any issue back to 2.4.)

## Contracts

### Provides (for downstream tasks)

- A theme-aware focus system and a global reduced-motion guard relied on by 4.5 (responsive sweep) and Phase 5 (5.2 a11y audit, 5.4 coherence). Every restyled surface now has AA-compliant focus on both themes and motion that honors the OS preference.

### Consumes (from upstream tasks)

- Phase 2/3: the styled surfaces (Booker, login, landing, admin, me, manage) whose focus/motion this task sweeps.
- 1.2: the token layer where `--focus-ring-line`, the `:focus-visible` recipe, and the global reduced-motion guard are authored (S3/S9) — this task verifies/sweeps them, not authors them.
- 2.4: the confirmation delight component — verified here for reduced-motion (S11, verify-only; not re-edited).

## Acceptance Criteria

- [ ] `--focus-ring-line` (authored by 1.2, S3) is confirmed theme-aware: graphite (`--fg`) on light, sky (`--accent`) on navy — this task verifies, does not re-author.
- [ ] `:focus-visible` (and `.pn-*` focus) use a ≥2px outline carrying the contrast + the sky glow as a decorative box-shadow only (1.2's recipe).
- [ ] No surface uses `outline:none` without a compliant replacement; edge-adjacent control outlines are not clipped (the one fix this task makes to markup/shell).
- [ ] Light-theme focus rings are graphite and pass ≥3:1; dark-theme are sky and pass ≥3:1 (verified in-browser).
- [ ] The global `prefers-reduced-motion` guard is present in `globals.css` (authored by 1.2, S9) — verified here.
- [ ] Every entry/float/hover/delight animation collapses to a static final state under reduced-motion; nothing is left invisible by a disabled animation. The 2.4 delight is verified-only (S11 — not re-edited; issues flagged back to 2.4).
- [ ] `pnpm build` exits 0; `pnpm lint` clean; `pnpm test` (incl. the contrast guard) green.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- Navigate `/book?xbc=411&theme=light` and `&theme=dark`; Tab through controls; screenshot focus rings; `browser_evaluate` outline color/width on `document.activeElement` (graphite≥2px light / sky≥2px dark).
- Confirm month-nav + last-column day focus rings are not clipped.
- `/login` + landing both themes: visible theme-appropriate focus.
- Reduced-motion emulated: complete a booking → confirmation renders statically + visibly; `getComputedStyle` shows no active animation.

#### [code] Code Verification
- Run: `pnpm build` — exit 0.
- Run: `pnpm lint` — clean.
- Run: `pnpm test` — green (contrast guard included).
- Run: `grep -n "focus-ring-line\|prefers-reduced-motion" src/app/globals.css` — both present.
- Run: `grep -rn "outline-none\|outline: none" src/` — none without a compliant replacement.

#### [file] File Verification
- Read back `globals.css`: `--focus-ring-line` in `:root` + `[data-theme="dark"]`; the focus recipe; the reduced-motion guard after base styles.

### Cross-Surface Coherence
- The same focus recipe and reduced-motion behavior apply everywhere (Booker, internal pages, embedded confirmation). The embed's host-side reduced-motion gating (Task 4.2) and the in-iframe Booker motion both honor the preference — confirm a reduced-motion booking through the embed is static end-to-end.

## Skills to Read

- `slate-ui-verification` - Playwright Tab walk, focus-ring assertion, reduced-motion emulation, the auth note for `/admin` `/me`.
- `pennie-design-system-in-slate` - the token layer and `.pn-*` focus conventions, theme `data-theme` mechanics.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - §2 (theme-aware focus, the exact ratios, the overflow-hidden clip) and §4 (reduced-motion guard + per-effect intent + the delight static-frame rule).

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

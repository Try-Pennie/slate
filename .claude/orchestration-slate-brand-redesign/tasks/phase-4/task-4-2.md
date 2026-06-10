# Task 4.2: Modal a11y + branded loading + mobile full-screen

## Objective

Make the injected `widget.js` modal a fully accessible, production-grade dialog: `role="dialog"` + `aria-modal="true"` + `aria-label`, a host-side focus trap (cycle between close button and iframe) with focus restore to the trigger, Escape-to-close, body scroll lock + background `inert`, a ≥44×44px close target, a branded loading state on the white modal surface before the iframe paints, mobile full-screen below 640px (`100dvh`), and `prefers-reduced-motion` gating for any fade/transition. All of this is added **host-side in vanilla JS**, on top of Task 4.1's restyled chrome, without touching the cal.com drop-in contract.

## Context

Second task of Phase 4. Task 4.1 restyled the chrome literals; this task makes that chrome behave correctly for keyboard and screen-reader users, on slow connections, and on phones. The iframe handles its *own* internal focus (the Booker's keyboard nav is Phase 2 work) — the host side here only manages the modal shell: trapping focus between the close button and the iframe, locking the page behind the scrim, and announcing the dialog. `widget.js` must stay a single vanilla, dependency-free IIFE. Task 4.5 (responsive sweep) and 4.V will re-verify this at 390px.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Files / Code | Read / Edit / Bash | Add a11y attributes, focus trap, Escape, scroll lock/inert, loading state, mobile branch, reduced-motion gating to `openModal`/`hide` in `public/widget.js` |
| Browser | Playwright MCP | Keyboard-only open/close on `/embed-example.html`; mobile 390px full-screen; axe on the host page; loading-state capture |

## Dependencies

- 4.1 (chrome literals restyled) — this task layers behavior on top of the restyled shell.

## Blocked By

- 4.1

## Research Findings

Key findings from research and skills relevant to this task:

- From `research/embed-css-isolation.md` §7 (Accessibility, "currently missing most of this"):
  - **Focus trap:** none today. On open, move focus into the modal (close button); Tab cycles within the overlay (close button ⇄ iframe), never escaping to the host behind the scrim.
  - **Escape to close:** none today. Add `keydown` Escape → `hide()`. (Click-on-overlay-to-close already exists at `widget.js:173-175`.)
  - **ARIA:** overlay/modal need `role="dialog"` + `aria-modal="true"` + an `aria-label` (e.g. "Book a call"). The close button already has `aria-label="Close"` (`widget.js:157`) and the iframe has `title="Slate booking"` (line 165) — KEEP both.
  - **Focus restoration:** store the trigger element (`el` from the delegated click, `widget.js:188`) before `openModal`; restore focus to it in `hide()`.
  - **Inert background:** set `inert` (or `aria-hidden="true"`) on the rest of `document.body` while open so SR users don't wander into the host page. Combine with the scroll lock.
  - **Close target:** currently ~24px glyph with small padding — enlarge the hit area to **≥44×44px**.
  - **Reduced motion:** any added fade/transition must respect `prefers-reduced-motion`.
- From `research/embed-css-isolation.md` §4 (Responsive): below ~**640px**, make the modal **full-screen / bottom-sheet**: `inset:0; width:100%; height:100dvh; max-height:none; border-radius:0` (or top-rounded sheet). Use `window.matchMedia('(max-width: 640px)')` at open time and/or a `@media` rule in an injected style block. Use **`100dvh` not `100vh`** (iOS URL-bar bug); switch the desktop `max-height:90vh` → **`90dvh`**.
- From `research/embed-css-isolation.md` §5 (Loading state): **No loading state exists today** — between `appendChild` and the iframe's first paint the user sees an empty white box. Render a branded Pennie loading state (centered spinner or wordmark + subtle pulse) on the white surface; remove it on the iframe's `load` event **or** on a new `slate:ready` message; optionally fade the iframe in. Keep `min-height:560px` so it never collapses. `transition:height .15s ease` on the iframe for smooth resize (matches the DS `.15s` transitions).
- From `slate-embed-contract` skill (Modal a11y to ADD): the canonical checklist for this task — role/aria-modal/aria-label, focus trap, focus restore, Escape, scroll lock, background inert, ≥44×44px close, reduced-motion gating, branded loading state, mobile full-screen `100dvh`.
- From `slate-embed-contract` skill (postMessage contract): if the loading state needs a new signal, **ADD** `slate:ready` — do NOT rename or drop `slate:resize` / `slate:bookingSuccessful`. (Removing the loader on the iframe `load` event is the simplest option and needs NO new message; only add `slate:ready` if `load` proves insufficient — and if you do, it must be additive and the Booker side change is out of this task's host-side scope, so prefer the `load` event.)
- From `slate-embed-contract` skill (ResizeObserver gotcha): the iframe height is driven by `slate:resize` posting `scrollHeight`. Do NOT animate height. Loader fade and iframe fade-in must be **opacity/transform only**.
- From DISCOVERY D15/D18: widget.js stays vanilla; ≥44px targets; honor reduced-motion; mobile `100dvh`.

## Execution Plan

### Step 1: Re-read the 4.1 chrome and plan additive behavior

**Surface:** [file]

- [file] Read the current `public/widget.js` `openModal` (post-4.1). Identify: the overlay/modal/close construction, the `hide()` closure, the `close.addEventListener("click", hide)`, the overlay click-to-close, and the delegated `data-cal-link` listener that calls `openModal(...)`.
- Plan the additive changes (all host-side, vanilla):
  1. ARIA on the modal element.
  2. Capture the trigger element and restore focus on hide.
  3. Focus trap (close button ⇄ iframe) + Escape handler.
  4. Scroll lock + background inert on open; restore on hide.
  5. Branded loading state element, removed on iframe `load`.
  6. Mobile full-screen branch via `matchMedia('(max-width: 640px)')` and/or injected `@media` style; `90vh` → `90dvh`.
  7. Reduced-motion gating for the loader fade / iframe fade-in.

- **S5 — DO NOT inject a default `theme` URL param.** None of this task's additive a11y/loading/mobile work touches `bookingUrl`, but confirm the iframe `src` building still forwards `theme` ONLY when the host supplied it and never defaults `theme=light`/`theme=dark` — the page-level light default (in `/book/page.tsx`) is the single owner. Leave `bookingUrl` untouched.

**Verification:**
- [file] You can enumerate the exact additive edits and confirm none of them rename/remove `slate:resize` / `slate:bookingSuccessful` or alter `bookingUrl`/`Cal` handlers, and none inject a default `theme` param (S5).

### Step 2: ARIA roles + trigger capture + focus restore

**Surface:** [code]

- [code] On the `modal` element set: `modal.setAttribute("role","dialog")`, `modal.setAttribute("aria-modal","true")`, `modal.setAttribute("aria-label","Book a call")`. (Keep the close button's existing `aria-label="Close"` and the iframe's `title="Slate booking"`.)
- [code] In the delegated click listener, capture the trigger before opening: pass `el` into `openModal(link, ns, el)` (extend the signature) OR store it in the closure. In `hide()`, after `overlay.remove()`, call the stored trigger's `.focus()` (guard for null).
- [code] On open, move focus into the modal: after `document.body.appendChild(overlay)`, call `close.focus()` (or the iframe — close button is the simpler, reliable first stop).

**Verification:**
- [code] Re-read: modal has role/aria-modal/aria-label; trigger is captured and re-focused on hide; focus moves to the close button on open.

### Step 3: Focus trap + Escape

**Surface:** [code]

- [code] Implement a host-side focus trap. The two focusable stops on the host side are the **close button** and the **iframe** (focus inside the iframe is the iframe's own concern). Add a `keydown` listener on the overlay (or document, scoped while open):
  - `Tab` / `Shift+Tab`: keep focus cycling between `close` and `iframe`; when at the boundary, wrap to the other. (A simple approach: on `keydown` Tab, if `document.activeElement === iframe` and not shift, move to `close`; if `activeElement === close` and shift, move to `iframe`. The browser handles focus *inside* the iframe; you only catch the boundary.)
  - `Escape`: call `hide()`.
- [code] Remove the `keydown` listener in `hide()` (clean teardown; store the handler reference).

**Verification:**
- [browser] (deferred to Step 8) Tab from close → iframe → back to close; Shift+Tab reverses; focus never lands on host page elements behind the scrim; Escape closes.

### Step 4: Scroll lock + background inert

**Surface:** [code]

- [code] On open: store `document.body.style.overflow` (prev value), then set `document.body.style.overflow = "hidden"`. In `hide()`: restore the previous value.
- [code] On open: set the rest of the host page inert. Prefer the `inert` attribute on sibling elements of the overlay (i.e., mark `document.body`'s children inert except the overlay). Simplest robust approach: iterate `document.body.children`, and for each that is not the overlay, store whether it already had `inert` and set `child.inert = true`; in `hide()`, restore. If `inert` is unsupported, fall back to `aria-hidden="true"` on those siblings. (Keep it small; guard for the overlay itself never being inert.)

**Verification:**
- [browser] (deferred) With the modal open, the host page behind the scrim does not scroll, and a screen reader / the a11y tree shows host content as inert/hidden.

### Step 5: Branded loading state

**Surface:** [code]

- [code] Build a loading element appended to the modal BEFORE the iframe (so it shows immediately on the white surface). Vanilla, inline-styled, literals only:
  - A centered container filling the modal area (`min-height:560px` to match the iframe), `display:flex;align-items:center;justify-content:center;background:#fff`.
  - A simple branded indicator: a small Pennie-sky spinner (a `<div>` with `border:3px solid rgba(130,208,255,0.35); border-top-color:#82D0FF; border-radius:50%; width:36px; height:36px; animation:slate-spin .8s linear infinite`) OR the Pennie wordmark text. A CSS spinner needs a keyframes rule — inject a tiny `<style>` string into the document (acceptable, vanilla) OR drive a JS rotation. Keep it lightweight.
  - Optional sky-soft accent so it reads on-brand (`#82D0FF` spinner accent).
- [code] Set the iframe to `opacity:0;transition:opacity .15s ease` initially. Add `iframe.addEventListener("load", function(){ /* remove loader, fade iframe in */ })`: remove the loader element, set `iframe.style.opacity = "1"`.
- [code] Keep `iframe.style.minHeight = "560px"` (or in `cssText`) so the box never collapses blank. Add `transition:height .15s ease` to the iframe for smooth `slate:resize`.
- [code] Do NOT add a `slate:ready` message unless the `load` event proves insufficient — the iframe `load` event is sufficient and needs no contract change. (If you must, `slate:ready` is additive only; never touch `slate:resize`/`slate:bookingSuccessful`.)

**Verification:**
- [browser] (deferred) Throttle network; on open the branded loader is visible on the white surface, then the iframe fades in and the loader is removed on `load`.

### Step 6: Mobile full-screen below 640px

**Surface:** [code]

- [code] At open time, branch on `window.matchMedia("(max-width: 640px)").matches`:
  - **Mobile:** modal `inset:0; width:100%; height:100dvh; max-height:none; border-radius:0; box-shadow:none` (full-screen). Overlay can keep its flex centering (the modal fills it) or set `align-items:stretch`. Loader fills `100dvh`.
  - **Desktop:** keep the 4.1 sizing but change `max-height:90vh` → `max-height:90dvh`.
- [code] For robustness across orientation/resize, you MAY also inject a `@media (max-width:640px)` rule via a `<style>` string with an id-scoped selector on the modal, so a rotate-to-portrait after open still applies. A `matchMedia` read at open time is the minimum; the `@media` rule is the belt-and-suspenders. Keep `100dvh` with a `vh` fallback (`height:100vh;height:100dvh`).

**Verification:**
- [browser] (deferred) At 390×844, the modal is full-screen edge-to-edge (`100dvh`), no scrim gutter, border-radius 0; the iframe Booker fills it.

### Step 7: Reduced-motion gating

**Surface:** [code]

- [code] Gate the loader fade / iframe fade-in / any transition on `prefers-reduced-motion`: read `window.matchMedia("(prefers-reduced-motion: reduce)").matches` at open time; if true, skip the opacity transition (set `iframe.style.transition = "none"` and show it instantly once loaded) and use a non-animated loader (no spin — show a static "Loading…" label or a static mark). The spinner keyframes should also be neutralized under reduced-motion (don't start the animation, or set `animation:none`).
- [code] Ensure the `transition:height .15s ease` on the iframe is also dropped under reduced-motion (set to `none`).

**Verification:**
- [browser] (deferred) With reduced-motion emulated, opening the modal shows no spin/fade; content appears instantly.

### Step 8: Verify live in the browser (keyboard, mobile, axe, loading)

**Surface:** [browser]

- [code] Start dev server in background: `cd /Users/danhankins-wright/Documents/Slate && pnpm dev`; poll `curl -sf -o /dev/null http://localhost:3000/embed-example.html && echo up`.
- [code] S6: `mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}` before any capture. Canonical names for this task: `reports/screens/embed-loading-4-2.png`, `reports/screens/embed-modal-mobile-4-2.png`, `reports/screens/embed-a11y-4-2.png`, `reports/axe/embed-host-modal-open.axe.json`.
- [browser] Navigate to `/embed-example.html`, click "Schedule your call".
- [browser] **Keyboard:** `browser_press_key('Tab')` repeatedly — focus must cycle close ⇄ iframe and never reach host page links/buttons; `browser_press_key('Escape')` closes the modal; after close, the a11y tree / `document.activeElement` shows focus returned to the trigger button.
- [browser] **Scroll lock / inert:** snapshot the a11y tree with the modal open — host content (the page `<h1>`, `<p>`, etc.) should be inert/hidden; confirm the page behind doesn't scroll.
- [browser] **Loading state:** capture `reports/screens/embed-loading-4-2.png` (open with network throttled if possible; otherwise capture the loader element existing before `load`).
- [browser] **Mobile:** `browser_resize` to 390×844, open the modal, screenshot `reports/screens/embed-modal-mobile-4-2.png` — full-screen `100dvh`.
- [browser] **axe:** inject axe via `browser_evaluate` (per `slate-ui-verification` / verification research) on the host page with the modal open; assert 0 violations for `dialog-name`/`aria-required-attr`/`button-name`/`aria-allowed-attr`/`frame-title`/`aria-hidden-focus`.
- [browser] **Reduced-motion:** `browser_emulate_media` reducedMotion=reduce; open the modal; confirm no spin/fade.
- [browser] **Contract:** confirm console shows no errors; the iframe `src` still has `embed=1`; the `bookingSuccessful` callback is still registered.

**Verification:**
- [browser] Focus trap + Escape + focus restore work; modal is full-screen at 390px; axe shows 0 violations on the listed dialog rules; loader renders before iframe paint; reduced-motion suppresses motion; cal contract intact.

## Artifacts to Create

- `reports/screens/embed-loading-4-2.png` - branded loading state mid-boot - [browser]
- `reports/screens/embed-modal-mobile-4-2.png` - mobile full-screen modal at 390px - [browser]
- `reports/screens/embed-a11y-4-2.png` - modal open with focus on close button (focus ring visible) - [browser]
- `reports/axe/embed-host-modal-open.axe.json` - axe violations JSON for the host page with modal open - [browser]

## Artifacts to Modify

- `public/widget.js` - add role/aria-modal/aria-label, focus trap + restore, Escape, scroll lock + inert, branded loading state, mobile full-screen branch, reduced-motion gating — all host-side vanilla; NO contract changes - [code]

## Contracts

### Provides (for downstream tasks)

- A fully accessible, mobile-ready embed modal — consumed by Task 4.5 (responsive sweep re-verifies the 390px full-screen) and 4.V (a11y + contract sign-off).

### Consumes (from upstream tasks)

- 4.1: the restyled chrome shell (white 16px card, navy scrim, sky focus ring on close) that this task makes accessible and responsive.

## Acceptance Criteria

- [ ] Modal has `role="dialog"`, `aria-modal="true"`, and an `aria-label`; close button keeps `aria-label="Close"`; iframe keeps `title`.
- [ ] Focus moves into the modal on open, traps between close button and iframe, and restores to the trigger on close.
- [ ] Escape closes the modal; scroll is locked and the host background is inert while open.
- [ ] Close-button hit area is ≥44×44px.
- [ ] A branded loading state shows on the white modal surface before the iframe paints, removed on iframe `load`.
- [ ] Below 640px the modal is full-screen (`100dvh`, `border-radius:0`); desktop uses `90dvh`.
- [ ] All fade/transition motion is gated by `prefers-reduced-motion`.
- [ ] `widget.js` is still a single vanilla, dependency-free IIFE; the cal contract (`Cal()` API, `data-cal-*`, URL params, `slate:resize`/`slate:bookingSuccessful`) is intact; no message renamed/dropped.
- [ ] S5: no default `theme` param injected — `theme` is forwarded only when the host passes it (page defaults to light); grep confirms no `theme=light`/`theme=dark` default.
- [ ] axe shows 0 violations on the dialog/aria/button/frame rules with the modal open.
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- Navigate to: `http://localhost:3000/embed-example.html`; open the modal.
- Keyboard walk: Tab cycles close ⇄ iframe only; Escape closes; focus returns to trigger.
- Inert/scroll-lock: a11y tree shows host content inert; page doesn't scroll behind the scrim.
- Loading: capture the branded loader before iframe `load`.
- Mobile (390×844): full-screen `100dvh`, no gutter, radius 0.
- axe: inject axe, assert 0 violations on `dialog-name`/`aria-required-attr`/`button-name`/`aria-allowed-attr`/`frame-title`/`aria-hidden-focus`; save JSON.
- Reduced-motion: emulate reduce → no spin/fade.

#### [code] Code Verification
- Run: `git diff public/widget.js` — additive a11y/loading/mobile/motion changes only; no contract plumbing touched.
- Run: `grep -nE "slate:resize|slate:bookingSuccessful" public/widget.js` — both still present, unchanged.
- Run: `grep -nE "theme=(light|dark)|['\"]theme['\"]\s*[,:]\s*['\"](light|dark)['\"]" public/widget.js` — expected: no injected default `theme` value (S5); `theme` only forwarded from a host-supplied param.
- Run: `grep -nE "import |require\(|tailwind|react" public/widget.js` — no new dependencies.
- Run: `pnpm lint` — clean.

#### [file] File Verification
- Read back `public/widget.js`: `bookingUrl`, the `Cal`/`ns` handlers, and the delegated `data-cal-link` listener are unchanged; the message listener still handles `slate:resize` and `slate:bookingSuccessful` exactly as before.

### Cross-Surface Coherence
- The host-side trap stops are close button + iframe; focus *inside* the iframe (Booker keyboard nav) is the iframe's own concern (Phase 2) — confirm the two layers compose: Tab into the iframe enters the Booker, and the boundary wraps back to the close button.

## Skills to Read

- `slate-embed-contract` - the "Modal a11y to ADD" checklist, the postMessage contract (add `slate:ready` only additively; prefer the `load` event), the ResizeObserver gotcha (opacity/transform only), and mobile full-screen guidance.
- `slate-ui-verification` - Playwright keyboard walk, axe injection, reduced-motion emulation, mobile viewport.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md` - §4 responsive, §5 loading state, §7 accessibility (the full host-side a11y gap list).
- `.claude/orchestration-slate-brand-redesign/research/wcag-accessibility.md` - focus management, reduced-motion, target size, dialog semantics context.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

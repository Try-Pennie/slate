# Task 4.1: Restyle widget.js modal chrome (literal Pennie values)

## Objective

Re-skin the host-page modal chrome that `public/widget.js` injects (overlay scrim, modal card, close button) from its generic grayscale look to the Pennie brand, using **literal** color/shape values — because the injected chrome lives in the arbitrary host page's DOM and **cannot read `--pennie-*` CSS variables**. This is a visual-only change: the `Cal()` API, `data-cal-*` triggers, URL params, and the `slate:resize` / `slate:bookingSuccessful` postMessage contract must remain byte-for-byte intact. `widget.js` stays a single vanilla, dependency-free IIFE.

## Context

This is the first task of Phase 4 (Embed + accessibility polish). Phases 1–3 gave the Booker (inside the iframe) the full Pennie system; this task brings the surrounding host-page chrome up to brand. It only touches the cosmetic literals of the three injected elements in `openModal` (`public/widget.js:144-182`). Task 4.2 (modal a11y + loading + mobile) builds directly on top of this restyle, so leave the structure clean and easy to extend (it will add `role="dialog"`, focus trap, Escape, scroll lock, a loading state, and a mobile full-screen branch). Do **not** pre-implement 4.2's behavior here — keep this task to the visual literals.

## Target Surfaces

| Surface | Tool | What's Done on This Surface |
|---------|------|----------------------------|
| Files / Code | Read / Edit / Bash | Edit the inline `cssText` literals in `openModal` in `public/widget.js` |
| Browser | Playwright MCP | Open the modal from `/embed-example.html` against `pnpm dev`; confirm chrome literals render; confirm the cal contract still fires |

## Dependencies

- Phase 2 (Booker restyle) — the iframe content is on-brand, so the chrome wraps a branded Booker. (The chrome restyle does not strictly need Booker done, but DISCOVERY/PHASES gate 4.1 on 2.V so the visual whole reads correctly.)
- The Pennie literal token values are documented in the `slate-embed-contract` skill and `research/embed-css-isolation.md` — read them, do not re-derive.

## Blocked By

- 2.V (Phase 2 verification sweep complete)

## Research Findings

Key findings from research and skills relevant to this task:

- From `research/embed-css-isolation.md`: There are **two CSS worlds**. The Booker lives inside the iframe and gets the full design system; the **modal chrome lives in the host page DOM and cannot read `--pennie-*` vars** — "Referencing `var(--pennie-*)` in the chrome is a no-op and will silently break." Every Pennie value in the chrome must be a **literal**.
- From `research/embed-css-isolation.md` §3 — recommended literal mappings (sourced from `colors_and_type.css`):
  - Modal card `background`: `#ffffff` (white — keep; the beige lives inside the iframe on the Booker).
  - Modal card `border-radius`: bump `12px` → **`16px`** (`--radius-xl`).
  - Modal card `box-shadow`: add **`0 12px 32px rgba(29,33,47,0.18)`** (`--shadow-pop`, navy-tinted).
  - Overlay scrim: `rgba(0,0,0,.5)` → **`rgba(29,33,47,0.55)`** (navy scrim; the brief bans hard black).
  - Close button `color`: `#666` → **`rgb(106,106,112)`** (`--pennie-muted`); hover/focus → **`rgb(52,52,52)`** (graphite).
  - Close button focus ring: **`outline:3px solid rgba(130,208,255,0.45); outline-offset:2px`** (`--focus-ring`, sky glow).
  - Chrome text/glyph `font-family`: **`'PP Mori',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif`** — but PP Mori will NOT load on the host page, so the `×` glyph falls back to system-ui by design. Do not depend on PP Mori.
- From `slate-embed-contract` skill: **Chrome stays a fixed Pennie shell; only the Booker honors `brand`/`theme`.** Do NOT half-theme the chrome from host `ui.brandColor`.
- From `slate-embed-contract` skill (Style leakage pitfall): inline styles avoid leaking *out*, but host `!important` / inherited `font`/`color` can bleed *in*. Minimum acceptable hardening: explicitly reset inheritable props (`font-family`, `font-size`, `line-height`, `color`, `letter-spacing`, `text-align`, `box-sizing`, `margin`/`padding`) on every injected node — especially the close `<button>` (inherits host button resets). Shadow DOM is the stronger fix but is OPTIONAL this pass; if you do not add it, you MUST add the inheritable-property resets.
- From DISCOVERY D14/D15: keep the `brandColor` override knob; widget.js stays vanilla/dependency-free; chrome uses literals only.

## Execution Plan

### Step 1: Read the current chrome and the contract guardrails

**Surface:** [file]

- [file] Read `public/widget.js` — focus on `openModal` (lines ~144-182): the three `el.style.cssText` blocks for `overlay`, `modal`, `close`, plus the `iframe`.
- [file] Read the `slate-embed-contract` skill in full (`.claude/skills/slate-embed-contract/SKILL.md`), especially the "Zone 2 — Modal chrome: LITERAL values only" table and the "drop-in contract (must NOT break)" list.
- Note the exact lines you will and will not touch:
  - **TOUCH (visual literals only):** `overlay.style.cssText`, `modal.style.cssText`, `close.style.cssText`, and add hover/focus styling for the close button.
  - **DO NOT TOUCH:** `bookingUrl(...)` and its param building (`xbc`, `external_id`, `embed=1`, `theme`, `brand`), the `Cal`/`ns` command handlers, the delegated `data-cal-link` click listener, the `message` listener (`slate:resize` / `slate:bookingSuccessful`), the iframe `src`/`title`/`allow`.
  - **S5 — DO NOT inject a default `theme` URL param.** The light-default flip is single-owned by `/book/page.tsx` (the page defaults to light when no `theme` is present). `widget.js` must only forward a `theme` the HOST explicitly passed; it must NOT add a default `theme=light`/`theme=dark` of its own, or it would override the page-level light default. Pass `theme` through only when the host supplied it (the existing `bookingUrl` behavior); never default it here.

**Verification:**
- [file] You can state which lines are visual literals vs contract plumbing. Confirm no `var(--pennie-*)` exists anywhere in `widget.js` (there should be none; never add one).

### Step 2: Restyle the overlay scrim

**Surface:** [code]

- [code] In `overlay.style.cssText`, change `background:rgba(0,0,0,.5)` → `background:rgba(29,33,47,0.55)` (navy scrim).
- Keep everything else on the overlay unchanged: `position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center`. (Keeping `position:fixed` prevents host layout shift — do not change it.)

**Verification:**
- [code] Re-read the edited `cssText`; scrim is `rgba(29,33,47,0.55)`, no hard black anywhere.

### Step 3: Restyle the modal card

**Surface:** [code]

- [code] In `modal.style.cssText`:
  - Keep `background:#fff` (white surface — correct; beige is inside the iframe).
  - Change `border-radius:12px` → `border-radius:16px`.
  - Add `box-shadow:0 12px 32px rgba(29,33,47,0.18)` (the `--shadow-pop` literal).
  - Keep `width:min(720px,92vw);max-height:90vh;overflow:auto;position:relative`. (Leave `max-height:90vh` for now; Task 4.2 switches it to `90dvh` and adds the mobile full-screen branch — do not pre-empt that here.)
  - Add the inheritable-property reset so a hostile host page can't bleed in: append `box-sizing:border-box;font-family:'PP Mori',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:rgb(52,52,52);line-height:1.5;text-align:left;letter-spacing:normal`.

**Verification:**
- [code] Re-read the modal `cssText`: white bg, `border-radius:16px`, the navy `--shadow-pop` shadow, and the inheritable resets present.

### Step 4: Restyle the close button (visual only — a11y target sizing is 4.2)

**Surface:** [code]

- [code] In `close.style.cssText`, restyle to the Pennie graphite/muted treatment with explicit inheritable resets:
  - Keep `position:absolute;border:0;background:transparent;cursor:pointer;z-index:1`.
  - Set `color:rgb(106,106,112)` (muted) instead of `#666`.
  - Set glyph styling: `font-size:24px;line-height:1;font-family:'PP Mori',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif`.
  - Reset inheritable/box props (host `button { all:unset }` defense): `box-sizing:border-box;margin:0;padding:0;letter-spacing:normal;text-align:center`.
  - Keep its position (`top:8px;right:12px`) for now — Task 4.2 enlarges the hit area to ≥44×44px. (You may leave a small padding, but the 44px target is 4.2's job; do not over-build.)
- [code] Add hover/focus interactivity in vanilla JS (no CSS file): attach `mouseenter`/`mouseleave` listeners that set `close.style.color` to `rgb(52,52,52)` (graphite) on hover and back to `rgb(106,106,112)` on leave; and `focus`/`blur` listeners that set/clear `close.style.outline = '3px solid rgba(130,208,255,0.45)'` and `close.style.outlineOffset = '2px'` (the sky focus glow). Keep it minimal and vanilla.
  - Note: 4.2 will add a proper theme-aware/keyboard focus story; here just give the close button a visible sky focus ring and a graphite hover so it reads on-brand. Use simple inline-style toggles; do not introduce a `<style>` injection yet unless you prefer it (a `<style>` string inside the IIFE is acceptable and vanilla, but inline listeners are the smaller change).

**Verification:**
- [code] Re-read: close button is muted graphite, has a sky focus ring on focus, graphite on hover, and inheritable resets.

### Step 5: Confirm the contract is untouched

**Surface:** [code]

- [code] Diff your change (`git diff public/widget.js`). Confirm the ONLY changes are inside the three `cssText` strings plus the added hover/focus listeners. Confirm zero changes to: `bookingUrl`, the `Cal`/`ns` handlers, the `data-cal-link` delegated listener, the `message` listener, the iframe attributes, and the IIFE structure.
- [code] Confirm no new dependencies, imports, `<link>`, font loads, React, or Tailwind were added — widget.js is still a standalone IIFE.

**Verification:**
- [code] `git diff --stat public/widget.js` shows only `public/widget.js` changed; the diff body is confined to chrome cosmetics + close-button hover/focus listeners.

### Step 6: Verify live in the browser

**Surface:** [browser]

- [code] Start the dev server in the background: `cd /Users/danhankins-wright/Documents/Slate && pnpm dev` (run_in_background). Poll until ready: `curl -sf -o /dev/null http://localhost:3000/embed-example.html && echo up`.
- [code] S6: ensure the evidence tree exists before any capture: `mkdir -p /Users/danhankins-wright/Documents/Slate/reports/{screens,axe,lighthouse}`. Canonical screenshot name for this task: `reports/screens/embed-modal-chrome-4-1.png`.
- [browser] `browser_navigate` to `http://localhost:3000/embed-example.html`.
- [browser] `browser_click` the "Schedule your call" trigger button.
- [browser] `browser_snapshot` + `browser_take_screenshot` (path `reports/screens/embed-modal-chrome-4-1.png`) of the open modal.
- [browser] `browser_evaluate` to read the computed styles of the injected nodes and assert the literals:
  - overlay `background` ≈ `rgba(29, 33, 47, 0.55)`
  - modal `borderRadius` === `16px`, `boxShadow` contains `rgba(29, 33, 47, 0.18)`, `backgroundColor` === `rgb(255, 255, 255)`
  - close button `color` === `rgb(106, 106, 112)`
- [browser] Watch the console: the `Cal("on", { action: "bookingSuccessful", ... })` callback in `embed-example.html` and the `slate:resize` flow must still work — confirm the iframe loads `/book?...&embed=1` and its height tracks (no JS errors).

**Verification:**
- [browser] Screenshot shows a white 16px-radius modal with a navy-tinted shadow over a navy (not black) scrim; close button is muted graphite.
- [browser] Computed-style assertions pass for all five literals above.
- [browser] No console errors; the iframe `src` still contains `embed=1` and forwards `theme`/`brand` if present.

## Artifacts to Create

- `reports/screens/embed-modal-chrome-4-1.png` - evidence screenshot of the restyled modal chrome - [browser]

## Artifacts to Modify

- `public/widget.js` - restyle the `overlay`/`modal`/`close` inline `cssText` literals + add close-button hover/focus listeners; add inheritable-property resets; NO contract changes - [code]

## Contracts

### Provides (for downstream tasks)

- A Pennie-branded modal shell (white 16px card, navy `--shadow-pop`, navy scrim, muted/graphite close with sky focus ring) — consumed by Task 4.2, which layers a11y (role/dialog, focus trap, Escape, scroll lock, ≥44px close), a branded loading state, and the mobile full-screen branch onto this shell.
- A clean, contract-preserving `openModal` baseline for 4.5's responsive sweep.

### Consumes (from upstream tasks)

- Phase 2 Booker restyle: the iframe content (`/book`) is on-brand, so the chrome wraps a branded Booker.
- The literal token values from `colors_and_type.css` as documented in `slate-embed-contract` and `research/embed-css-isolation.md`.

## Acceptance Criteria

- [ ] Modal card is white, `border-radius:16px`, with the `0 12px 32px rgba(29,33,47,0.18)` shadow.
- [ ] Overlay scrim is `rgba(29,33,47,0.55)` (navy) — no hard black anywhere.
- [ ] Close button is muted `rgb(106,106,112)`, graphite `rgb(52,52,52)` on hover, with a sky `rgba(130,208,255,0.45)` focus ring.
- [ ] No `var(--pennie-*)` appears anywhere in `widget.js`; only literals.
- [ ] Inheritable props are reset on the injected nodes (host-bleed defense).
- [ ] `widget.js` is still a single vanilla, dependency-free IIFE (no imports/React/Tailwind/font loads).
- [ ] The cal.com contract is byte-for-byte intact: `Cal()` API, `data-cal-*`, URL params (`xbc`/`external_id`/`embed`/`theme`/`brand`), `slate:resize` / `slate:bookingSuccessful`.
- [ ] S5: `widget.js` does NOT inject a default `theme` param — `theme` is only forwarded when the host explicitly passes it, letting `/book` default to light. (grep confirms no `theme=light`/`theme=dark` default.)
- [ ] All verifications pass.

## Verification Protocol

### Per-Surface Verification

#### [browser] Web Verification
- Navigate to: `http://localhost:3000/embed-example.html` (after `pnpm dev`).
- Click "Schedule your call" → modal opens.
- Snapshot: confirm an injected overlay/modal/close exists; the iframe `src` contains `book?...&embed=1`.
- Screenshot: `reports/screens/embed-modal-chrome-4-1.png` — white 16px modal, navy shadow, navy scrim, muted close.
- `browser_evaluate` computed-style assertions: overlay bg `rgba(29,33,47,0.55)`, modal `borderRadius` `16px` + shadow contains `rgba(29,33,47,0.18)` + bg white, close `color` `rgb(106,106,112)`.
- User-emulating flow: open the modal, hover the close button (color → graphite), Tab to it (sky ring), and confirm the Booker iframe loads inside. Console shows no errors and the `bookingSuccessful` listener is still registered.

#### [code] Code Verification
- Run: `git diff public/widget.js` — changes confined to chrome cosmetics + hover/focus listeners.
- Run: `grep -n "var(--pennie" public/widget.js` — expected: no matches (exit 1 / empty).
- Run: `grep -nE "theme=(light|dark)|['\"]theme['\"]\s*[,:]\s*['\"](light|dark)['\"]" public/widget.js` — expected: no injected default `theme` value (S5). `theme` may only be forwarded from a host-supplied param, never defaulted in `widget.js`.
- Run: `grep -nE "import |require\(|tailwind|react" public/widget.js` — expected: no new dependency lines.
- Run: `pnpm lint` — clean (widget.js is plain JS in `public/`; confirm lint config still passes / is unaffected).

#### [file] File Verification
- Read back `public/widget.js`: the three `cssText` blocks carry the literal values from the table; the `bookingUrl`, `Cal` handlers, delegated click, and message listener are unchanged.

### Cross-Surface Coherence
- The chrome (white/navy-scrim/sky-focus) and the Booker inside (beige, sky CTA) read as one Pennie experience: chrome is a fixed shell, Booker is the themed content. Confirm the chrome did NOT adopt the host `brandColor` (it stays a fixed Pennie shell).

## Skills to Read

- `slate-embed-contract` - the two styling zones, the literal-value table for the chrome, and the full drop-in contract that must not break. THE primary skill for this task.
- `slate-ui-verification` - how to drive `/embed-example.html` with Playwright and capture evidence.

## Research Files to Read

- `.claude/orchestration-slate-brand-redesign/research/embed-css-isolation.md` - the chrome-vs-iframe isolation model, the literal mappings, and the contract parity flags.

## Execution Surfaces Reference

Read execution surface definitions and the verification loop at: ~/.claude/skills/general-task-agent-orchestration/execution-surfaces.md

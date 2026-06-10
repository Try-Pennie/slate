# Embeddable Widget Theming & CSS Isolation - Research

**Wave**: First
**Researcher**: Embed theming & CSS isolation research agent
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code + Browser

---

## Summary

Slate embeds into arbitrary Pennie landing pages (today: trypennie.com) by injecting a modal overlay + iframe into the **host page** via `public/widget.js`, then rendering `Booker.tsx` inside the iframe at `<origin>/book?…`. The iframe gives us a clean CSS boundary for the Booker itself (the full Pennie design system lives inside, no leakage), but the **modal chrome injected into the host page** (`openModal`, widget.js:144-182) is inline-styled, hard-codes generic values (`background:#fff`, `border-radius:12px`, `rgba(0,0,0,.5)`, `color:#666`), and has **no CSS isolation, no loading state, no focus trap, and no Escape handler**. The redesign should keep the iframe approach (it is the strongest isolation Slate already has), make the injected chrome self-contained and Pennie-branded with **hard-coded literal token values** (the host page does not expose `--pennie-*` vars), add a loading state to prevent FOUC, and add modal a11y — all without changing the `Cal()` API surface, the URL param contract, or the `slate:resize`/`slate:bookingSuccessful` postMessage contract that keep it a drop-in cal.com replacement.

## Key Findings

### 1. Current architecture & the two distinct styling zones

There are **two separate CSS worlds**, and they must be treated differently:

| Zone | Lives in | CSS isolation today | Has Pennie tokens? |
|------|----------|---------------------|--------------------|
| **Modal chrome** (overlay, modal box, close button) | Host page DOM, injected by widget.js | None — relies on inline styles only | No |
| **Booker** (the actual UI) | Inside the iframe at `/book` | Full — iframe document boundary | Yes (gets `globals.css` + PP Mori once the redesign ships) |

- **widget.js:144-182 `openModal`** builds three elements with `el.style.cssText`:
  - `overlay` (line 146-148): `position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)`
  - `modal` (line 151-153): `background:#fff;border-radius:12px;width:min(720px,92vw);max-height:90vh;overflow:auto;position:relative`
  - `close` (line 158-160): absolutely-positioned `×` button, `font-size:24px;color:#666`
  - `iframe` (line 162-166): `width:100%;border:0;min-height:560px`, `src = bookingUrl(...)`, `title="Slate booking"`, `allow="fullscreen"`
- **Theming handoff** is via URL params in `bookingUrl` (widget.js:121-140): the namespace's `ui.theme` → `theme=` and `ui.brandColor` → `brand=`, plus always `embed=1`. `/book/page.tsx:54-57` reads these: `embedded`, `theme` (defaults **dark** unless `theme=light`), `brandColor`.
- **Booker** (`Booker.tsx`) consumes them: `PALETTE[theme]` (lines 47-92, currently neutral grayscale Tailwind classes) and inline `brandColor` overrides for dots/ring/confirm/avatar (lines 132-134). It posts `slate:resize` (lines 188-199, ResizeObserver-driven) and `slate:bookingSuccessful` (lines 244-249) back to the parent.
- widget.js listens for those messages (lines 195-202): `slate:resize` sets `activeIframe.style.height`; `slate:bookingSuccessful` re-emits the cal-style `bookingSuccessful` host event.

**Critical implication for the redesign:** The injected chrome (overlay/modal/close) is in the host page and therefore **cannot read `--pennie-*` CSS variables** (they only exist inside Slate's own documents). Any Pennie token used in the chrome must be written as a **literal value** in the inline `cssText`. It also must not rely on any host stylesheet, because host pages are arbitrary.

### 2. CSS isolation: iframe (current) vs Shadow DOM vs scoped classes

- **iframe (keep this).** The iframe is the single best isolation primitive available and Slate already uses it. Host CSS cannot reach inside; Slate CSS cannot leak out. The Booker gets the entire Pennie design system (PP Mori, beige surfaces, sky CTA) with zero risk to the host page. This is exactly how cal.com's own embed works, so keeping it preserves drop-in parity.
- **Shadow DOM for the chrome (recommended *addition*).** The overlay/modal/close currently sit in the host's light DOM as plain inline-styled elements. Inline styles win over host selectors **except** for `!important` host rules and inherited properties. The robust fix is to attach the chrome inside a **closed Shadow DOM host element** appended to `document.body`. Shadow DOM blocks inheritance of host `font`, `color`, `line-height`, `letter-spacing`, etc., and prevents host CSS from selecting the chrome at all. This is how mature embed SDKs (Intercom, Drift, modern cal.com) isolate injected chrome.
  - Belt-and-suspenders: inside the shadow root, set a reset on the host element / `:host { all: initial }` is too aggressive for a flex container, so prefer a scoped reset on the chrome wrapper (`all: revert` then explicit properties) plus explicit `font-family`, `color`, `box-sizing:border-box` on every injected node.
- **Scoped classes / prefixed class names (rejected as the primary mechanism).** Injecting a `<style>` with `.slate-embed-*` classes into the host `<head>` is fragile: host `* { box-sizing }`, `button { … !important }`, reset stylesheets, or aggressive `body *` rules can still bleed in, and Slate's `<style>` can theoretically affect the host. Inline styles already avoid the leak-*out* direction; Shadow DOM closes the leak-*in* direction. Scoped classes add no isolation that Shadow DOM doesn't do better.

**Verdict:** Keep the iframe for the Booker. Wrap the injected chrome in a Shadow DOM host. If Shadow DOM is deemed too large a change for this redesign pass, the **minimum acceptable** fallback is to keep inline styles but explicitly set the inheritable properties that a host page could push onto the chrome: `font-family`, `font-size`, `line-height`, `color`, `letter-spacing`, `text-align`, `box-sizing`, `margin`/`padding` reset on each injected node (especially the close `<button>`, which inherits host button resets and `font`).

### 3. Theming handoff & whether the chrome should adopt Pennie tokens

Two layers, two strategies:

- **Inside the iframe (Booker):** Already wired. The redesign will give `/book` the full Pennie system (beige default surface, sky CTA, PP Mori, 16px button radius). `theme`/`brand` params flow through unchanged. **One flag (see Pitfall):** PROJECT-BRIEF says the Booker should default to **beige/light**, but `/book/page.tsx:55` currently defaults to **dark** when no `theme` param is present, and trypennie's cal config sends no `ui.theme`. Decide the default deliberately; the brief implies beige-first, so the embed default should likely flip to light (this is a Booker-domain decision, flagged here because it affects what the embed renders by default).
- **The injected chrome (overlay/modal/close):** It does NOT have the design system, so it must be **self-contained with literal token values**. Recommended literal mappings (sourced from `colors_and_type.css`):
  - Modal `background`: `var(--surface)` → **`#ffffff`** (white surface is correct for the modal card; the *Booker inside* carries the beige). Keep white.
  - Modal `border-radius:12px` → Pennie `--radius-xl` is **`16px`** (the system's card/button radius). Bump to **16px** to match the redesign's "16px buttons" language and feel native.
  - Modal shadow: add `--shadow-pop` = **`0 12px 32px rgba(29,33,47,0.18)`** (navy-tinted popover shadow) so the modal reads as a Pennie surface, not a bare box.
  - Overlay scrim `rgba(0,0,0,.5)`: the brief bans hard black; use a **navy scrim** `rgba(29,33,47,0.55)` (navy is `rgb(29,33,47)`) for a warmer, on-brand dim.
  - Close button `color:#666` → Pennie graphite/muted **`rgb(106,106,112)`** (`--pennie-muted`); on hover/focus go to graphite **`rgb(52,52,52)`**. Give it a visible focus ring using the sky glow **`rgba(130,208,255,0.45)`** (`--focus-ring`): `outline:3px solid rgba(130,208,255,0.45);outline-offset:2px`.
  - Font on any chrome text (the `×`, future loading label): `font-family:'PP Mori',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif`. Note: PP Mori will NOT be loaded on the host page, so it will fall back to system-ui for the chrome — acceptable because the only chrome text is the `×` glyph. Do **not** depend on PP Mori for the chrome.
- **Keeping the two in sync:** The chrome and the Booker should share the same accent. Today `brandColor` only tints the Booker. If a host sets `ui.brandColor`, the chrome's close-button focus ring / accents could optionally reuse it, but the cleaner story is: **chrome = fixed Pennie shell (white modal, navy scrim, sky focus), Booker = themeable content**. Recommend keeping the chrome a fixed Pennie shell and letting only the Booker honor `brand`/`theme`. This avoids a half-themed chrome and keeps the chrome self-contained.

### 4. Responsive behavior of the modal

- Current desktop sizing is fine: `width:min(720px,92vw)` (widget.js:152) + `max-height:90vh` + `overflow:auto`. The 3-column Booker grid collapses to a single column under `md` (`Booker.tsx:284`, `grid-cols-1 md:grid-cols-[260px_1fr_240px]`).
- **Mobile gap:** at ~`min(720px,92vw)` on a 375px phone the modal is ~345px wide with the single-column Booker, which works, but the centered card + visible scrim wastes space and the close button is small. **Recommended mobile pattern:** below ~640px (the system's stack breakpoint per the brief's open question), make the modal **full-screen / bottom-sheet**: `inset:0`, `width:100%`, `height:100%` (or `100dvh`), `max-height:none`, `border-radius:0` (or top-rounded for a sheet feel). This is the standard embedded-booker mobile pattern (cal.com goes full-screen on mobile too) and gives the iframe maximum room so the in-iframe form isn't cramped. Use a media query inside the injected `<style>`/shadow root (chrome) — since the chrome is JS-injected, read `window.matchMedia('(max-width: 640px)')` at open time and/or include a `@media` rule in an injected style block within the shadow root.
- Use **`100dvh` not `100vh`** for mobile full-screen to avoid the iOS URL-bar height bug. Add `dvh` with a `vh` fallback.
- `max-height:90vh` should become `max-height:90dvh` for the same reason on tablet.

### 5. Loading state & preventing layout shift

- **No loading state exists today.** Between `document.body.appendChild(overlay)` (widget.js:180) and the iframe's first paint, the user sees an empty white box. The iframe is `min-height:560px` (line 164) so the box is sized, but it's blank → reads as broken on slow connections.
- **Recommendation:** render a branded loading state in the modal *before/under* the iframe: a centered Pennie spinner or the Pennie wordmark + a subtle pulse, on the white surface. Remove it on the iframe's `load` event **or** on the first `slate:resize`/`slate:ready` message. Add a tiny `iframe.addEventListener('load', …)` in `openModal`. Optionally fade the iframe in (`opacity 0 → 1`) once loaded to hide the inner FOUC.
- **Layout shift on the host page:** the overlay is `position:fixed`, so it never shifts host layout — good. Keep it that way (don't switch to an inline/`position:absolute` container). The only shift risk is the *iframe height jumping* as `slate:resize` fires; mitigate by keeping `min-height:560px` so it never collapses smaller than the booker, and animate height changes with `transition: height .15s ease` on the iframe (matches the design system's `.15s` transitions in `colors_and_type.css`).
- **Scroll lock:** when the modal opens, set `document.body.style.overflow = 'hidden'` and restore on close, so the host page behind the scrim doesn't scroll. Currently absent.

### 6. Drop-in cal.com parity — what must NOT change

The whole value prop (per `trypennie-cal-embed-contract`) is that swapping cal→Slate is ~3 edits in trypennie. The visual redesign must preserve every contract surface:

- **`Cal()` API surface** (widget.js:78-112): `init` (origin per-ns), `ns[ns]("ui"|"prerender"|"on")`, `on(bookingSuccessful)`, `window.Cal.config.forwardQueryParams`. Visual changes touch none of this — safe, but don't refactor the queue draining while restyling.
- **`data-cal-link` / `data-cal-namespace` / `data-cal-config` delegated click** (widget.js:185-193). Keep delegated listener.
- **URL param contract** (widget.js:121-140): `xbc`, `external_id`, prefill keys, `embed=1`, `theme`, `brand`. The redesign must keep forwarding `theme`/`brand` and `embed=1`. If the embed default flips to light (see #3), that's a default change inside `/book`, not a contract change.
- **postMessage contract**: `slate:resize {height}` and `slate:bookingSuccessful {data}` (Booker.tsx:188-249 ↔ widget.js:195-202). The redesign must not rename or drop these. If a loading state keys off a new `slate:ready` message, **add** it, don't replace the existing two.
- **The single-file, dependency-free, `IIFE` nature of widget.js** (it's served from `/widget.js` as plain ES5-ish JS, no build step). Any redesign of the chrome must stay vanilla JS with inline styles / injected style strings — **do not** import Tailwind, React, or `globals.css` into widget.js. That would break the standalone-script contract and bloat the host payload.

**Parity flags (things in a visual redesign that could break the contract):**
- Pulling Pennie tokens into the chrome by *referencing* `var(--pennie-*)` — they don't exist on the host page; must inline literals (see #3).
- Importing fonts/CSS into the chrome — breaks zero-dependency loading and adds host-page network cost / FOUC.
- Changing iframe `min-height` smaller than the booker's collapsed height → reintroduces the blank/short flash before `slate:resize`.
- Switching the overlay off `position:fixed` → causes host layout shift.

### 7. Pitfalls: fonts, FOUC, postMessage, accessibility

- **Font loading inside the iframe / FOUC.** PP Mori must load inside the iframe document. The design system ships **OTF** (`Pennie Design System/fonts/*.otf`) and a separately-licensed **woff2 web kit** exists at `PP Mori Font/woff2 (licensed web kit)/` (Regular/Medium/SemiBold/Bold). For an embedded iframe especially, use **woff2 via `next/font/local`** (smaller, faster, `font-display:swap`) to minimize FOUT inside the modal — OTF is much heavier and the embed is latency-sensitive. Note the woff2 kit has *Medium* and *Bold* but the system design (`colors_and_type.css`) deliberately uses only 200/400/600 and aliases 700→600 and bans Medium — so map woff2 SemiBold→600 (and 600→700 alias) and woff2 Regular→400; do **not** introduce Medium. (Font choice is a Foundation-domain decision; flagged because FOUC inside the iframe is an embed concern.)
- **FOUC inside the iframe.** Even with the iframe sized, the Booker can flash unstyled/wrong-theme before hydration. Because `theme` arrives as a URL param read server-side in `/book/page.tsx`, the server can render the correct theme class immediately (no client flash) — preserve that (don't move theme to a client-only effect). Set the iframe document `color-scheme` and background to match the resolved theme so the iframe's own background paints branded immediately rather than white-then-beige.
- **postMessage origin.** Both sides post with target origin `"*"` (Booker.tsx:192/247) and widget.js reads `e.data` without checking `e.origin` (line 195). For a redesign this is out of scope functionally, but worth noting as a hardening item: the host could lock to the Slate origin and Slate could target the known parent origin. Don't change it as part of *visual* work, but flag for the security/hardening pass.
- **Accessibility of the modal on the host page (currently missing most of this):**
  - **Focus trap:** none today. When the modal opens, focus should move into the modal (e.g., the close button or the iframe), and Tab should cycle within the overlay, not escape to the host page behind the scrim. Implement a focusable-sentinel or `focus` wrap in widget.js. Note: focus *inside* the iframe is the iframe's own concern; the host-side trap just needs the iframe + close button as the two stops.
  - **Escape to close:** none today. Add `keydown` Escape → `hide()`. (Click-on-overlay-to-close exists, widget.js:173-175.)
  - **ARIA:** the overlay/modal need `role="dialog"` + `aria-modal="true"` + an `aria-label` (e.g. "Book a call"). The close button already has `aria-label="Close"` (widget.js:157) and the iframe has `title="Slate booking"` (line 165) — keep both.
  - **Focus restoration:** on close, return focus to the trigger element that opened the modal (`el` from the delegated click, widget.js:188). Store it before `openModal`, restore in `hide()`.
  - **Inert background:** ideally set `inert` (or `aria-hidden="true"`) on the rest of `document.body` while open so screen readers don't wander into the host page behind the scrim. Combine with the scroll lock from #5.
  - **Reduced motion:** any added fade/height transition must respect `prefers-reduced-motion` (the brief requires reduced-motion support).
  - **Contrast:** navy scrim `rgba(29,33,47,0.55)` over arbitrary host content — fine for a scrim. Close `×` muted-on-white (`rgb(106,106,112)` on `#fff`) passes AA for the glyph; hover to graphite improves it. 44px+ target: the close button is currently ~24px font with small padding — **enlarge the hit area to ≥44×44px** per the brief's target-size requirement.

## Recommended Approach

1. **Keep the iframe** for the Booker (best isolation, already cal-parity). Give `/book` the full Pennie system in the Booker-domain work; theme/brand params flow unchanged.
2. **Rebuild the injected chrome in widget.js as a self-contained Pennie shell**, ideally inside a (closed) Shadow DOM host appended to `document.body`; if Shadow DOM is out of scope this pass, at minimum reset inheritable props on every injected node. Use **literal token values** (not `var(--pennie-*)`): white modal, `border-radius:16px`, `--shadow-pop`, navy scrim `rgba(29,33,47,0.55)`, muted/graphite close button, sky focus ring.
3. **Add a branded loading state** in the modal, removed on iframe `load` (or a new `slate:ready` message); fade the iframe in; keep `min-height` so there's no collapse; `transition:height .15s ease` for resize smoothness.
4. **Mobile full-screen below 640px** (`100dvh`, `border-radius:0`/top-rounded sheet); switch `90vh`→`90dvh`.
5. **Add modal a11y to the host-side chrome**: `role="dialog"`+`aria-modal`, focus trap + restore, Escape to close, scroll lock + background `inert`, ≥44px close target, reduced-motion-aware transitions.
6. **Preserve the contract**: no changes to the `Cal()` API, `data-cal-*` triggers, URL params (`xbc`/`external_id`/`embed`/`theme`/`brand`), or the `slate:resize`/`slate:bookingSuccessful` messages. widget.js stays vanilla, dependency-free, no Tailwind/font imports.

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| iframe for Booker (current) | True style isolation both directions; cal-parity; full design system inside | Cross-document postMessage for height/events (already solved) | **Recommended (keep)** |
| Shadow DOM for injected chrome | Blocks host CSS inheritance into the chrome; no leak out; closed encapsulation | Slightly more JS; must inject `<style>` into shadow root for `@media`; closed root harder to debug | **Recommended (add)** |
| Inline-styles-only chrome (current) + reset inheritables | Minimal change; no new APIs | Host `!important` + inherited `font/color` can still bleed; verbose resets on every node | Acceptable fallback if Shadow DOM is deferred |
| Scoped/prefixed classes in host `<head>` | Familiar | Fragile vs host resets; can leak into host; no real isolation guarantee | Rejected |
| Drop the iframe, render Booker in Shadow DOM directly on host | One fewer document; no postMessage | Loses true isolation (Shadow DOM doesn't block all inheritance/`!important` perfectly); breaks cal-parity model; huge rewrite; can't easily ship Next.js app inside | Rejected |
| `var(--pennie-*)` in chrome styles | DRY with the system | Vars don't exist on host page → no-ops/broken | Rejected (must inline literals) |

## Pitfalls and Edge Cases

- **Chrome cannot read `--pennie-*` vars** (host page scope) — use literal hex/rgb in `cssText`. The single highest-leverage gotcha.
- **PP Mori won't load on the host page** — chrome must fall back to system-ui; don't depend on PP Mori for chrome text. The Booker (in-iframe) loads PP Mori itself.
- **iOS `vh` bug** — use `dvh` for mobile full-screen and `max-height`.
- **Embed theme default mismatch** — `/book/page.tsx:55` defaults to **dark**; brief wants beige/**light** default. Confirm with Booker domain; affects default embed appearance when trypennie sends no `ui.theme`.
- **`min-height` collapse / blank flash** — keep iframe `min-height` ≥ booker collapsed height; add loading state.
- **No focus trap / Escape / scroll lock / inert today** — all must be added host-side; the iframe handles its *internal* focus, host handles trap between iframe ⇄ close button and background inert.
- **postMessage `"*"` origin, unchecked `e.origin`** — leave for the security pass, don't entangle with visual work, but flag.
- **Don't refactor the `Cal` queue / param / message plumbing while restyling** — visual scope only; a regression here breaks the trypennie drop-in.
- **Don't import Tailwind/React/CSS into widget.js** — it's a standalone CDN-style script; keep it vanilla and small (currently ~6KB).
- **Reduced-motion** — gate any fade/height transitions on `prefers-reduced-motion`.

## References

- `public/widget.js` — `openModal` chrome (lines 144-182), `bookingUrl` theming handoff (121-140), message listener (195-202), delegated trigger (185-193).
- `src/app/book/page.tsx` — reads `embed`/`theme`/`brand` params (lines 44-58); theme defaults to dark (line 55).
- `src/components/Booker.tsx` — `PALETTE` light/dark (47-92), brandColor inline overrides (132-134), `slate:resize` ResizeObserver (188-199), `slate:bookingSuccessful` (244-249), responsive grid (284), confirm/success screen (263-278).
- `public/embed-example.html` — the cal loader snippet + `data-cal-link` trigger Slate must remain compatible with.
- `~/Documents/Pennie Branding/Pennie Design System/colors_and_type.css` — token literals: navy `rgb(29,33,47)`, surface `#fff`, muted `rgb(106,106,112)`, graphite `rgb(52,52,52)`, `--radius-xl:16px`, `--shadow-pop:0 12px 32px rgba(29,33,47,0.18)`, `--focus-ring:rgba(130,208,255,0.45)`, `.15s` transitions.
- `~/Documents/Pennie Branding/PP Mori Font/woff2 (licensed web kit)/` — woff2 web kit (Regular/Medium/SemiBold/Bold) for in-iframe font perf; map to 400/600 only per the system's weight rules.
- `~/.claude/.../memory/trypennie-cal-embed-contract.md` — the exact cal embed contract Slate mirrors (Cal API, `data-cal-*`, `forwardQueryParams`, `router?form=` shape, `external_id`, 3-edit swap).
- trypennie: `src/assets/CalScheduleScript/CalScheduleScript.tsx` (loader + `Cal.ns["review"]("ui",…)` with `brandColor:"#000000"`, `layout:"month_view"`), `src/components/BookButton/BookButton.tsx` (`data-cal-*` trigger + `forwardQueryParams`), `src/hooks/useCalParams.ts` (param set written to URL).

---

## Second Wave Additions (if applicable)

### Execution Details (filtered by DISCOVERY.md)

To be filtered against DISCOVERY decisions. Key open decisions that affect this domain:
- Shadow DOM for chrome vs inline-reset-only (isolation depth vs change size).
- Embed theme default: flip to light/beige (brief intent) vs keep dark.
- Whether the chrome accent ever reflects host `ui.brandColor` (recommend: no, fixed Pennie shell).
- Mobile breakpoint: confirm 640px to match the system's stack guidance.

### Tool and Surface Configuration

| Tool/Service | Surface | Purpose | Setup Required | Agent Can Self-Configure? |
|-------------|---------|---------|----------------|---------------------------|
| Playwright MCP | Browser | Open `public/embed-example.html` against `pnpm dev`, click trigger, snapshot modal chrome + Booker in both themes, desktop + mobile viewport | Slate dev server running | Yes |
| Peekaboo CLI | Native macOS | Fallback screenshots if Playwright stalls | None | Yes |
| Bash / Read / Write | Files | Edit `public/widget.js`, `Booker.tsx`, `/book/page.tsx`, font/CSS foundations | None | Yes |

### Verification Strategy

- **Method:** Serve a host page that is *deliberately hostile* to test isolation — e.g. add `* { font-family: "Comic Sans MS" !important; box-sizing: content-box; } button { all: unset; }` to a copy of `embed-example.html`, then open the modal and confirm the chrome (modal radius, close button, scrim) is unaffected. Confirm Slate's chrome doesn't restyle the host's own `.cta` button.
- **Evidence:** Playwright snapshots of (1) modal chrome on a neutral host, (2) modal chrome on the hostile host, (3) Booker inside in light + dark + with a `brand` color, (4) mobile full-screen at 375px width, (5) loading state mid-boot (throttle network), (6) focus order via keyboard (Tab cycles within modal, Escape closes, focus returns to trigger).
- **Acceptance threshold:** Chrome renders identically on neutral vs hostile host (isolation proven); modal radius=16px, navy scrim, sky focus ring on close; no host layout shift; loading state visible before iframe paints; mobile = full-screen; Escape + focus trap + restore work; close target ≥44px; `slate:resize`/`bookingSuccessful` still fire (cal `on` callback logs); reduced-motion disables transitions.

### Human Actions Required

| Action | Who | How | Status |
|--------|-----|-----|--------|
| Confirm woff2 web kit license permits embedding the font inside the iframe served from Slate's domain | User | Check `woff2 (licensed web kit)/README.txt` license terms | Pending |
| Confirm embed default theme (light/beige vs dark) | User / DISCOVERY | Decision in DISCOVERY.md | Pending |
| Coordinate trypennie param change (`external_id`) if testing real routing end-to-end | User | trypennie `useCalParams` edit (already noted in contract) | Pending (out of redesign scope) |

# Slate Brand Redesign - Discovery Document

**Created**: 2026-06-09
**Status**: Complete
**Category**: Operations/Workflow (code-centric UI redesign)
**Rounds of Q&A**: 2 (teach-impeccable session 2026-06-05/09 + this orchestration round)

> Top-authority document. Overrides PROJECT-BRIEF.md and all research files on conflict.

---

## 1. Vision & Goals

**D1: What is being built?**
A: A full visual redesign of Slate's UI to the Pennie Design System, before any UI testing.
Quote: "Before we worry about testing the UI I want to actually redesign." Borrower-facing
Booker should feel like an extension of trypennie.com; internal pages consistently on-brand.

**D2: What is the single source of truth for the design?**
A: The EXPORTED Pennie Design System at `~/Documents/Pennie Branding/Pennie Design System/`
(`colors_and_type.css` tokens + `.pn-*` classes + `assets/` + `preview/*.html`). It
SUPERSEDES the markdown `pennie-brand.skill` on any conflict. Use CSS variables, never hex.

**D3: What does success look like?**
A: Every surface (Booker, /book, manage/reschedule/cancel, admin, me, login, embed) renders
in the Pennie system; both themes correct; embed brandColor works; AA+ verified; build/lint/
test green; booking flow intact; no stray hex.

---

## 2. Scope & Boundaries

**D4: What is IN scope?**
A: Foundation (tokens+fonts+assets), Booker restyle, internal admin/me/login restyle, embed
(widget.js) restyle, accessibility pass, verification. Both light & dark themes.

**D5: What is explicitly OUT of scope?**
A: NO functional/logic changes — booking logic, availability cache, Google sync, round-robin,
webhooks, auth all untouched. This is visual-only. Helvetica Now Display NOT used (PP Mori
only). Must remain Cloudflare Workers (OpenNext) deployable. Don't recreate logo in code.

---

## 3. Typography & Fonts

**D6: Which PP Mori files/weights ship in Slate?**
A: The LICENSED woff2 web kit (the same Pennie uses on trypennie.com), weights **400 (body)
+ 600 (headings)**, with **700 aliased to 600**, `font-synthesis: none`. User confirmed
"We have a license." The design-system OTFs are Free-For-Personal-Use (EULA forbids
commercial web use) — DO NOT ship them. Extralight 200 + italics are declared in the DS but
unused by any `.pn-*` class — skip. No Medium 500.

**D7: OTF→woff2 conversion?**
A: Not needed — the licensed kit is already woff2. Load via `next/font/local`, expose as a
`--font-*` token, point the DS `--font-sans` + Tailwind `@theme` at it. Don't paste the DS
`@font-face` block (next/font generates it). Remove Geist + `--font-geist-mono`.

---

## 4. Color & Shape (from design system, locked)

**D8: Color rules?**
A: 80/15/5 — Beige `#F9F6F0`/White surfaces dominant, Navy `#1D212F` for occasional hero/
stat/footer bands, Graphite `#343434` text. **Sky `#82D0FF` is the ONLY action color**
(primary CTA = sky fill + graphite label). Yellow/mint/peach = illustration/accent only,
never CTAs. No hard black; errors use muted rose `#C43D3D` (12% tint). For blue TEXT on
light, use `#486CCA` (sky fails as text on light — see D17).

**D9: Shape/radius?**
A: Buttons & cards 16px (`--radius-xl`/`--radius-md` per shipped CSS — NOT pills; README's
"pill" wording is superseded by the CSS). Large bands 24px. Chips/tags 4px. Pills (999px)
for badges only. Soft `--shadow-*` tokens; never a hard black drop shadow.

---

## 5. Surfaces & Theming

**D10: Booker default theme?**
A: **Beige/light** (follow the system's beige-first default). Currently the component
defaults to `theme="dark"` (Booker.tsx ~line 124) and /book only goes light if asked — FLIP
this. Both light & dark themes maintained; embed host can override via `theme` param.

**D11: Internal admin/me/login themes?**
A: Support BOTH light and dark (these currently default to dark in code).

**D12: Login page treatment?**
A: **Marketing-rich** — split layout: navy or illustrated panel beside the form, brand copy,
optional sticky-note; Pennie logo; sky CTA. (More than a plain auth card.)

**D13: Admin/me treatment?**
A: Fully branded, task-efficient (utilitarian but on-brand). [Layout shell vs reuse of Booker
primitives to be decided during the per-surface task — default: own admin shell.]

---

## 6. Embed / widget.js

**D14: brandColor override behavior?**
A: KEEP the override knob (preserves cal.com drop-in contract). The embed **explicitly passes
Pennie's sky through as the default** brandColor; a host page may still override it. (Not
sky-only-ignore.)

**D15: Embed constraints?**
A: widget.js stays vanilla/dependency-free. Don't break the cal.com contract: `Cal()` API,
`data-cal-*` triggers, URL params (`xbc`/`external_id`/`embed`/`theme`/`brand`), and the
`slate:resize`/`slate:bookingSuccessful` postMessage contract. Injected host-page modal
chrome CANNOT read `--pennie-*` vars → use LITERAL values (white modal, 16px radius,
`--shadow-pop` navy shadow, navy scrim `rgba(29,33,47,0.55)`, sky focus ring). Add modal a11y
(role=dialog, focus trap, Escape, scroll lock, ≥44px close), branded loading state, mobile
full-screen (<640px, `100dvh`). Animate opacity/transform only (ResizeObserver posts
scrollHeight — height animation breaks resize).

---

## 7. Delight & Motion

**D16: Confirmation delight moment?**
A: **Iridescent Pennie 3D graphic on the standalone confirmation page; lightweight SVG icon
(check-badge/smile in a sky-soft puck) inside the embed iframe** (performance). Warm copy
both places ("You're booked! Sarah will call you Thursday at 2:00."). Calm single fade/rise,
reduced-motion honored, opacity/transform only.

---

## 8. Accessibility (WCAG 2.1 AA + extra care)

**D17: Contrast decisions (verified math from research).**
A: Primary CTA graphite `#343434` on sky `#82D0FF` = **7.36:1 PASS** (no darker sky needed).
FAILS to engineer around:
- Pressed CTA on sky-deep `#439FE1` = 4.32:1 FAIL → cap fill at sky-hover `#6dc5f7` (6.51:1),
  signal press via translate, not a darker fill.
- Sky focus ring on light = 1.57:1 FAIL → theme-aware focus: 2px **graphite** outline on
  light surfaces, 2px **sky** outline on navy; keep sky glow as decorative box-shadow only.
- Emerald today/slot dots = 2.54:1 FAIL + color-only → replace with sky/green token + a
  non-color cue (text/icon/shape) for selected day & best-match.
- Sky/sky-deep as TEXT/icon on light fails → use `#486CCA` for blue text on light.
Passing pairings to preserve: graphite-on-beige 11.54:1, white-on-navy 16.02:1,
muted `#6A6A70`-on-beige 4.98:1 (don't lighten), rose `#C43D3D`-on-beige 4.77:1.

**D18: Other a11y requirements.**
A: Calendar/listbox semantics + arrow-key nav for date/time picker; labeled inputs (not
placeholder-only); `aria-live` for availability loading + `role="alert"` for errors + live
confirmation announcement; honor `prefers-reduced-motion`; 44px+ touch targets (current
month-nav ~24px, slots/inputs ~40px — enlarge); color never the sole signal.

---

## 9. Tooling & Execution Surfaces

**D19: Foundation/token approach?**
A: Two-layer "import-then-map": Layer A = raw `--pennie-*`/semantic/radii/shadow/spacing in
`:root` + `[data-theme="dark"]` flipping semantic vars; Layer B = expose subset as Tailwind
utilities via `@theme inline`. Theming via `data-theme` attribute + `@custom-variant dark`
(NOT OS media query). Verified stack: Tailwind 4.3.0, Next 16.2.7, OpenNext 1.19.11 — all
build-time, CF-compatible.

**D20: Execution surfaces?**
A: Code/Files (the work) + Browser via Playwright MCP (verification). Calendar/comms/APIs
untouched by the redesign.

**D21: Verification bar / "done"?**
A: Each surface screenshotted in both themes and compared to DS `preview/*.html`; AA+ checks
(axe-core via Playwright, Lighthouse, contrast script `scripts/test-contrast.ts`, reduced-
motion emulation); `pnpm build` + `pnpm lint` + `pnpm test` green; booking flow works E2E;
embed drop-in contract intact.

---

## 10. Build Sequence

**D22: Order of work?**
A: **Foundation first** — port tokens + fonts + assets so all surfaces inherit the system,
THEN restyle in order: Booker → internal pages → embed/polish/AA. (User: "foundation".)

---

## Open items deferred to execution (non-blocking)
- Admin/me: own layout shell vs shared Booker primitives (default: own shell).
- Exact illustration choice for standalone confirmation (coins vs ribbon) — pick during task.
- Whether to commit `scripts/test-contrast.ts` as a permanent guard (recommended yes).

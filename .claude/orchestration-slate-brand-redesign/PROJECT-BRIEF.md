# Slate Brand Redesign - Project Brief

**Created**: 2026-06-09
**Status**: Draft
**Source**: User brain dump + prior teach-impeccable design context
**Category**: Operations/Workflow (code-centric UI redesign)

---

## 1. Vision

Slate is Pennie's Cal.com-style booking tool — it routes landing-page bookings to a
round-robin pool of agents ("debt buckets"), syncs Google Calendar, embeds via `widget.js`,
and emits webhooks to Regal/Cadence. Today its UI is stock Next.js boilerplate: Geist font,
neutral grayscale, dark-default booker. It does not look like a Pennie product.

This project redesigns Slate's entire UI to the **Pennie Design System** before any UI
testing. The borrower-facing booking widget should feel like a natural extension of
trypennie.com — warm, beige-first, calm, trustworthy — and the internal staff pages should
be consistently on-brand. Success = every Slate surface visibly belongs to Pennie, built on
the design team's own tokens (not a hand-interpreted approximation), accessible to WCAG 2.1
AA + extra care, with no regressions to booking functionality.

> User intent: "Before we worry about testing the UI I want to actually redesign."

## 2. Core Objectives

### Foundation
- Port the exported Pennie Design System tokens (`colors_and_type.css`: colors, type, radii,
  shadows, spacing + `.pn-*` base classes) into Slate's Tailwind v4 `@theme`.
- Load PP Mori (weights 200/400/600) via `next/font/local`; remove Geist.
- Vendor the design system's logo + icon SVGs and any needed illustrations into the repo.
- Replace the boilerplate `globals.css` / `layout.tsx` with brand foundations.

### Consumer Booker (highest visibility)
- Restyle the booking flow (`src/components/Booker.tsx`, `/book`, `/booking/[id]`,
  `/booking/manage/[token]`) to the Pennie system.
- Beige/light default surface; sky CTA (sky fill + graphite label); 16px buttons.
- Clean, focused booking steps + ONE branded delight moment on the confirmation/success screen.
- Preserve existing light/dark theming and the embed `brandColor` override.

### Internal pages
- Restyle `admin`, `me`, `login` to Pennie. Support BOTH light and dark themes
  (these currently default to dark).

### Embed + quality
- Restyle the `widget.js` modal/overlay to match.
- Accessibility pass: WCAG 2.1 AA + extra care.
- No functional regressions; `pnpm build`, `lint`, and `test` all pass.

## 3. Workflows

### Workflow 1: Token → surface inheritance
1. Design system `colors_and_type.css` tokens are mapped into Tailwind `@theme` + a Slate
   token layer.
2. Fonts + assets vendored into the repo.
3. Every page/component consumes tokens (CSS vars / Tailwind classes), never raw hex.
4. Restyling each surface then inherits the system automatically.

### Workflow 2: Per-surface restyle → verify
1. Restyle a surface using `.pn-*` equivalents + tokens.
2. Run the app; capture the surface (each step / both themes) via browser verification.
3. Compare against the design system `preview/*.html` reference + brand rules.
4. Fix drift; re-verify until it matches.

### Workflow 3: Final acceptance
1. Comprehensive multi-state verification (all surfaces, both themes, embed, mobile).
2. AA+ accessibility checks (contrast, focus, reduced-motion, keyboard, SR labels).
3. `pnpm build` / `lint` / `test` green; booking flow still works end to end.

## 4. Tools and Platform Signals

- **Source of truth:** exported Pennie Design System at
  `~/Documents/Pennie Branding/Pennie Design System/` (supersedes the markdown
  `pennie-brand.skill` on conflicts).
- Stack: Next.js 16 (App Router, TS), Tailwind v4 (`@theme`), Luxon, pnpm. Hosts on
  Cloudflare Workers (OpenNext) — keep deploy compatibility in mind.
- Fonts: PP Mori OTFs ship in the export's `fonts/` (200/400/600; no Medium; 700→600).
- Verification: Playwright MCP (now connected) for browser navigation + snapshots;
  Peekaboo available as a fallback.
- Design context already captured in `~/Documents/Slate/.impeccable.md` and a condensed
  section in `CLAUDE.md`.

## 5. Execution Surfaces

| Surface | How Used | Primary Tool |
|---------|----------|-------------|
| Browser (Web) | Verify rendered UI: navigate Slate locally, snapshot booker/admin/embed, both themes | Playwright MCP |
| Native macOS | Fallback screenshot/inspection if browser tooling stalls | Peekaboo CLI |
| Files | The core work: edit React/CSS/TS, vendor fonts + SVG assets | Bash / Read / Write |
| Communication | Not used | - |
| Calendar | Not used (Google Calendar sync is existing app logic, untouched by redesign) | - |
| APIs/MCPs | Read the design system files; no external API calls for the redesign itself | MCP / Bash |
| Code | Build/lint/test/dev: `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm dev` | Bash |

## 6. Open Questions

(Most resolved already in prior teach-impeccable session — restated here, to be confirmed
in DISCOVERY.)

- Exact Tailwind v4 token-mapping approach: mirror `--pennie-*` vars in `@theme`, or import
  `colors_and_type.css` and layer Tailwind on top?
- Convert PP Mori OTF → woff2 for web perf, or use OTFs as shipped via `next/font/local`?
- Which design-system illustration(s) for the Booker confirmation delight moment?
- Do internal pages reuse the same Booker theming primitives or get their own layout shell?
- How far does "fully branded" go for `login` (full marketing-style treatment vs minimal)?
- Embed: keep `brandColor` host override semantics exactly as-is, or align to sky default?
- Mobile breakpoints: match the system's 640px stack guidance?

## 7. Explicit Constraints

- **No functional changes** to booking logic, availability cache, Google sync, round-robin,
  webhooks, or auth — this is a visual/UI redesign only.
- Skip Helvetica Now Display (not used by the system or trypennie prod; PP Mori only).
- Yellow/mint/peach are illustration/accent only — never CTAs. Sky is the only action color.
- No hard black (`#000`); use Navy/Graphite. Errors use muted rose `#C43D3D`.
- Must remain Cloudflare Workers (OpenNext) deployable.
- Don't recreate the logo in code — use the SVG assets.

## 8. Success Criteria

- Every Slate surface (Booker, `/book`, manage/reschedule/cancel, admin, me, login, embed)
  renders in the Pennie system: beige-first, PP Mori, sky CTAs, 16px buttons, correct shadows.
- Booker defaults to beige/light; light + dark both correct; embed `brandColor` override works.
- Internal pages support light + dark.
- Confirmation screen has one tasteful branded delight moment.
- AA + extra care verified: contrast (incl. sky-on-beige / graphite-on-sky), visible focus,
  reduced-motion, keyboard nav, SR labels, 44px+ targets.
- `pnpm build`, `pnpm lint`, `pnpm test` all pass; booking flow works end to end.
- All tokens sourced from the design system (CSS vars), no stray hex.

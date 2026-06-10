# Internal Pages Design (login, admin, me, landing) - Research

**Wave**: Second
**Researcher**: Second-wave research agent — internal pages design (login, admin, me) for the Slate brand redesign
**Date**: 2026-06-09
**Status**: Complete
**Target Surface(s)**: Code + Browser (verification)

---

## Summary

The four internal surfaces (`/login`, `/admin`, `/me`, `/` landing) are currently raw Tailwind `neutral-*` grayscale prototypes that ignore the Pennie system entirely — `bg-neutral-900` buttons, `text-neutral-500` copy, `border-neutral-200/300` cards, bright `green/amber/red` status, no font var, no theme. This is a **visual-only** restyle: every server action, RBAC check, form `name=`, `searchParams`, and data fetch stays byte-for-byte identical. The work is swapping the shared style-constant strings (`btnCls`/`inputCls`/`cardCls`/`labelCls`) and a handful of inline class strings for Pennie tokens and `.pn-*` recipes, then wrapping each page in a branded shell.

Two structural facts make this clean: (1) admin and `/me` already centralize their styling in four reused constants at the top of each file — change those four strings and ~80% of the surface re-skins at once; (2) the foundation work (DISCOVERY D19, wave-1 tailwind research) ships the `--pennie-*`/semantic tokens, `data-theme` flipping, `@custom-variant dark`, and PP Mori before this task runs, so these pages just consume `bg-bg`/`text-fg`/`bg-accent`/`dark:` utilities and the `.pn-*` classes. The one page that needs net-new markup is `/login` (D12 marketing-rich split) and the landing stub. Both themes (D11) are driven entirely by the inherited `data-theme` attribute; internal users get a persisted toggle (localStorage, no-flash inline script). The single styling-couples-to-structure snag is the **bright-status logic in admin** (push-health dot, bookable button, webhook status pill, audit `text-amber-600`) where the *color choice is computed in a ternary in the markup* — those ternaries must be rewritten to Pennie status tokens but the branch logic stays.

## Key Findings

### Current state of the four surfaces (verified, file:line)

- **`/login`** (`src/app/login/page.tsx`, full file 50 lines). Client component. Single centered `max-w-sm` card: `<h1>Slate</h1>` (line 35, `text-2xl font-semibold`), one muted `<p>` (line 36), one button "Continue with Google" → `signIn()` which calls `supabase.auth.signInWithOAuth` with the calendar scopes (lines 14-30). Button is `bg-neutral-900 text-white` (line 43). **No split, no brand panel, no logo, no theme.** The auth mechanism (lines 6-30) is the load-bearing part — do NOT touch it; only restyle the JSX returned at lines 32-49.
- **`/admin`** (`src/app/admin/page.tsx`, 1065 lines). Server component, `force-dynamic`. RBAC gates: `canManageAgents` (line 250) → manager+; `canEditOrgSettings`/`isAdmin` (line 258) gates all admin-only sections. Styling is centralized in **four module constants** (lines 76-81): `labelCls`, `inputCls`, `cardCls`, `btnCls` — these are reused across every section and are the primary restyle lever. Sections (each a `cardCls` `<section>`): default working hours (admin), Agents roster + push-health + search, event types (admin), buckets/round-robin (admin), recent routing (table), reassign API key, webhook endpoint, webhook deliveries (table), audit log (table). Three `<table>`s share an identical pattern: `text-xs`, `thead.text-neutral-500`, rows `border-t border-neutral-100`.
- **`/me`** (`src/app/me/page.tsx`, 138 lines). Server component. Its own copy of `labelCls`/`inputCls`/`btnCls` (lines 8-12). Header with bookable status (`text-green-600`/`text-neutral-400`, line 51), an amber "no hours" warning banner (line 58: `border-amber-200 bg-amber-50`), one working-hours card with the same weekday-checkbox + time-input form as admin, and a reset link. Simpler shell, same primitives.
- **`/` landing** (`src/app/page.tsx`, 27 lines). Stub: centered `<h1>Slate</h1>`, one muted paragraph, two links — "Admin" (`bg-neutral-900`) and "Embed demo" (outlined → `/embed-example.html`).
- **Root shell** (`src/app/layout.tsx`): currently loads Geist + Geist_Mono, sets `h-full antialiased`, `<body>` is `min-h-full flex flex-col`. The foundation task replaces fonts with PP Mori via `next/font/local` and adds `data-theme` + `suppressHydrationWarning` to `<html>` (wave-1 tailwind research §3-4). This page-design task **assumes that foundation is already in place** and consumes it.

### Shared restyle levers (change once, re-skin everywhere)

These four constants in `admin/page.tsx` (lines 76-81) and the three in `me/page.tsx` (lines 8-12) carry the bulk of the visual weight. Target replacements (Tailwind utilities backed by the foundation tokens, equivalent raw `var()` in comments):

```ts
// admin/page.tsx 76-81  →  Pennie equivalents
const labelCls = "block text-xs font-semibold text-fg-muted";              // was text-neutral-500
const inputCls  = "mt-1 w-full rounded-sm bg-surface px-3 text-fg "         // rounded-sm = 8px (--radius-sm),
                + "shadow-xs h-[44px] outline-none "                        //   forms.html: 52px tall, no border,
                + "focus-visible:outline-3 focus-visible:outline-focus-ring "// sky ring on focus
                + "focus-visible:outline-offset-2 placeholder:text-fg-muted";
const cardCls  = "rounded-md bg-surface shadow-xs p-6";                     // .pn-card recipe (10px radius, --shadow-xs)
const btnCls   = "pn-btn pn-btn--small pn-btn--primary";                   // sky fill + graphite label, 12px radius small btn
```

Use the `.pn-btn` classes directly rather than re-deriving the recipe — they already resolve to the live token cascade (`--accent` fill, `--fg` label, sky focus ring, `:active` translateY). For the **primary "Save"/"Create" actions** keep `.pn-btn--small --primary` (40px tall, fits the dense forms); for **destructive/secondary** (Cancel, clear, "Sync from Salesforce") use `.pn-btn--small --additional` (outlined). The current `border border-neutral-300 hover:border-neutral-500` outlined buttons (admin lines 462, 484, 524, 531, 542, 960) all map to `.pn-btn--additional`.

> **forms.html field spec (verified, lines 29-45):** height **52px** (admin's dense forms can use 44px to honor the 44px touch minimum without ballooning the page; pick 44–52), `border-radius: 8px`, **`border: none`** + white surface + soft shadow (NOT a 1px border — the README's "1px charcoal 16%" prose is superseded by the shipped CSS, same way the button-radius prose was), `padding: 0 16px`, `font-size: 16px`, placeholder `rgba(52,52,52,.45)` = `--fg-muted`-ish, focus = sky ring. Error field: `border: 1px solid` rose + rose label + rose hint (use `--pennie-rose`/`#C43D3D` per D8/wave-1, NOT the `#E25C3F` in forms.html).

### Status colors are coupled to markup logic (the one tricky spot — D8 mapping)

Admin computes status *colors* inside JSX ternaries. Visual-only means rewriting the color values, keeping the branch conditions. Map bright → Pennie status tokens:

| Location (admin/page.tsx) | Current | Pennie replacement |
|---|---|---|
| Push-health dot (449-455) | `bg-green-500` / `bg-amber-500` / `bg-neutral-300` | `bg-[--pennie-green]` / `bg-[--pennie-yellow]` / `bg-[--pennie-mercury]` + **keep the existing `title=` text and the "watched x/y" label so color is never the sole signal (D18)** |
| Bookable button (543-547) | `border-green-300 text-green-700` / `border-neutral-300 text-neutral-500` | a pill badge: bookable = `bg-[--pennie-green-wash] text-[--pennie-green-deep]` with the `✓`; not-bookable = `--pennie-mercury` outline + muted text |
| Eligible-agent warning (155) | `text-amber-600` | `text-[--pennie-yellow]`-on-light fails AA → use graphite text + a yellow dot/`--pennie-rose` if it's truly a "bookings will fail" error. Treat the "no fallback, bookings will fail" branch as an **error** (rose), the "using fallback" branch as a **notice** (muted). |
| Webhook delivery status pill (945-951) | `bg-green-100 text-green-700` / `bg-red-100 text-red-700` / `bg-amber-100 text-amber-700` | success `bg-[--pennie-green-wash] text-[--pennie-green-deep]`; failed `bg-[rgba(196,61,61,.12)] text-[--pennie-rose]` (12% rose tint per D8); pending `bg-[--pennie-sky-soft] text-[--pennie-blue]` |
| Routing-trace reassignment (806) | `text-amber-600` | `text-[--pennie-blue]` (informational, AA-safe blue-text-on-light per D8/D17) |
| `/me` bookable status (51) | `text-green-600` / `text-neutral-400` | `text-[--pennie-green-deep]` / `text-fg-muted` |
| `/me` no-hours banner (58) | `border-amber-200 bg-amber-50` | a notice card: `bg-[--pennie-sky-soft]` (or `--pennie-cream-3`) surface, `text-fg`, with `info.svg` icon — calm, not alarmist (Pennie voice) |

These are the ONLY places where structure couples to styling. Everywhere else the restyle is a pure class swap. **Flag for the implementer:** all of these are color values living in conditional expressions in `.tsx` — they will not be caught by a "search globals.css for hex" check; they need a manual grep for `green-|amber-|red-|neutral-` in the two page files.

### Badges & pills (status/role) — DS §3 spec

README §3 (badges): `999px` radius, `6px/12px` padding, `13/700` type, sky/mint/yellow fills for status, ink fill for trust, outlined for neutral. `badges.html` confirms `height:24px; padding:0 8px`. Build a tiny `Pill` helper (presentation-only React component, no logic) in the admin file or a shared `components/ui/Pill.tsx`:
- **Role pills** (agent/manager/admin): neutral outlined (`border --border`, `text-fg`) for agent; `--pennie-sky-soft` fill for manager; `--pennie-navy` fill + cream text for admin (the "trust/ink" treatment).
- **Status pills** (bookable, webhook status): green-wash/rose-tint/sky-soft per the table above.
- Pills are `rounded-pill` (999px) — the only place 999px is used (D9: pills for badges only).

### Tables in the Pennie system

The three admin tables (recent routing 770, webhook deliveries 913, audit log 986) and the agents roster (`space-y-5` list, 496) should read as **quiet rows on a white card**, shadow-led not border-led (D9, "Loan offer row" pattern README §3):
- Table container: already inside `cardCls`; keep `overflow-x-auto`.
- `thead`: `.pn-small` muted (`text-fg-muted`), `font-semibold`, no fill.
- Row dividers: `border-t border-[--border]` (replaces `border-neutral-100`) — hairline at 16% graphite, soft.
- Row hover (optional, nice for scannability): `hover:bg-[--pennie-wild-sand]` light / `hover:bg-[--pennie-ink-2]` dark.
- Numbers/timestamps: add `tabular-nums` (README §2.2 — "Numbers are tabular") on the When/Tries/count columns.
- Cell text: `text-fg` for primary, `text-fg-muted` for secondary (replaces `text-neutral-600/500/400`).

### Theming approach for internal pages (D11 + wave-1)

- **Mechanism:** `data-theme="light|dark"` on `<html>` (set by the foundation in `layout.tsx`), `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))` already specified in wave-1. Internal pages just use semantic utilities (`bg-bg`, `text-fg`, `bg-surface`, `border-[--border]`) and `dark:` where a one-off needs it. Because `@theme inline` makes utilities re-resolve through the live cascade, flipping `data-theme` reskins all four pages with zero per-page dark code.
- **Default:** beige/light (D8/D10 beige-first; the current dark-ish neutral default is wrong). Internal users may prefer dark, so:
- **Toggle:** a persisted user toggle (NOT OS media query — D19 forbids it for the app). Recommended placement: in the admin/me **header bar**, a small `.pn-btn--additional --small` icon button (sun/moon; no DS moon icon exists — use a clean 2px inline SVG, or reuse `smile.svg`-style stroke). Persist to `localStorage.slate-theme`. Re-use the documented no-flash inline `<head>` script (wave-1 ref: `preventing-flash-before-hydration.md`) that reads `localStorage.slate-theme ?? "light"` and sets `data-theme` before first paint, with `suppressHydrationWarning` on `<html>`. **Login defaults to light** (it's marketing-rich/beige) but still honors a stored preference. This is a tiny client island (`"use client"` toggle button calling `document.documentElement.setAttribute` + `localStorage.setItem`); it adds no server logic. Keep it presentation-only.
- **Embed is unaffected** — these are first-party internal pages, not the embed; the embed scopes `data-theme` to the Booker root (separate concern).

## Recommended Approach

### LOGIN — marketing-rich split (D12)

A two-column split (DS `cta-block` / `about-us-block` pattern): brand panel + auth card. Keep the entire `signIn()` mechanism and the single Google button — only the surrounding layout/visuals change.

**Layout & responsive (mirrors `cta-block.html` `.cta-grid`, lines 31-50):**
- Desktop ≥1024px: `grid lg:grid-cols-2 min-h-screen`. **Left = brand panel, right = form card.** (Or left-form/right-panel — left-panel reads more "product".)
- Tablet/mobile <1024px (DS stacks at 640, but a login benefits from collapsing the marketing panel earlier): **stack to one column**, brand panel becomes a short top band (logo + one line), form card below. Below 640px the panel can hide entirely except the logo, so the form is above the fold. Honor 44px targets and `100dvh`.

**Left brand panel — navy hero (D8 navy = hero moment, white-on-navy is the 16.02:1 AA-pass pairing per D17):**
- `bg-[--pennie-navy]` full-bleed, `--radius-lg` (24px) on the inner card edge if floated, or full-bleed to the viewport edge.
- **Logo:** `assets/logo-pennie-cream.svg` (cream wordmark for ink bg — README §6, and `navigation.html` line 223 uses exactly this on navy) + optional `logo-mark.svg`. Vendor both into Slate's `public/` during foundation. Top-left, ~22px tall (matches nav `.word{height:18px}` / footer 22px).
- **Brand copy** (`.pn-h2`/`.pn-h1` cream + `.pn-lead` beige-muted). On-brand, verb-phrase, optimistic, discloses nothing sensitive (no agent counts, no "buckets", no Salesforce). Options:
  - Headline: "Welcome back." / "Let's get you set up." / "Your scheduling, sorted."
  - Sub: "Manage your availability and let the right calls find you." / "Sign in to set your hours and stay bookable."
  - Avoid anything that names internals or implies security posture. NO "Cadence" (memory `slate-copy-rules`), NO em/en dashes in copy.
- **Optional sticky-note** (DS signature device, README §3.2; one max): a small ~`−3°` rotated yellow note (`--pennie-yellow`, `--radius-sm` 8px, `--shadow-sm`) pinned over the panel with a warm line like "Leads always see times in their own timezone." Decorative; skip on mobile.
- Optionally an iridescent brand graphic (`assets/brand/graphics/pic-3.png` ribbon) low-opacity bottom corner for warmth — calm, not busy.

**Right form card:**
- Surface: `bg-surface` (white) on the beige page, `.pn-card` style (`--radius-md`/`--radius-lg`, `--shadow-xs`), `p-8`, `max-w-sm` centered vertically.
- Heading `.pn-h3` "Sign in to Slate" + `.pn-small` muted helper (keep the existing "Sign in with your Pennie Google account…" intent, warmed up).
- **CTA = sky primary** `.pn-btn .pn-btn--big .pn-btn--primary` full-width, label graphite (D17 7.36:1 PASS), with the **right-arrow icon** (`arrow-right.svg`; primary CTAs that advance a flow get the arrow per buttons.html). Loading state keeps "Redirecting…". A Google "G" glyph before the label is fine and conventional; keep label a verb phrase ("Continue with Google").
- Focus ring: theme-aware (D17) — graphite outline on light, sky on navy; the `.pn-btn:focus-visible` already does `3px --focus-ring`, but for the **light page** override to graphite per D17 (the foundation should set this globally; login inherits it).
- Dark theme: page `--bg` flips navy, the form card `--surface` flips to `--pennie-ink-2`, text to beige — automatic via `data-theme`.

### ADMIN — branded task-efficient dashboard shell (D13)

Own shell (DISCOVERY "default: own admin shell"), built from DS nav + card patterns. Keep the single-column scroll of `<section>`s; just brand the chrome and the sections.

**App header / nav (DS `navigation.html` header, but simplified for an internal tool):**
- A slim top bar, NOT the 5-item marketing mega-nav. `bg-[--pennie-navy]` ink band (`navigation.html` `.nav-stage` is navy) OR a cream/beige bar with bottom hairline — for an internal dashboard a **beige bar with `--border` bottom hairline** reads lighter and lets the beige page dominate (80/15/5). Recommend: beige bar.
- Left: `logo-pennie-charcoal.svg` (charcoal wordmark on beige) + mark, ~22px. Center/left tabs: "Admin" (active) and "My availability" (`/me`) as `.pn-small-bold` nav links (active = `text-fg`, inactive = `text-fg-muted`). Right: the current user email (`me.email`, currently admin line 363) as `.pn-small` muted, the theme toggle, and the "Connect / reconnect Google" action (currently line 365-367 `btnCls`) → `.pn-btn--small --additional`.
- Replace the per-page `<header className="flex items-center justify-between">` with this shared shell (extract to `components/AppHeader.tsx`, presentation-only, takes `email`/`role`/`active` props).

**Page background:** beige. The root `<main>` sits on `bg-bg` (beige), sections are `bg-surface` (white) `.pn-card`s with `--shadow-xs`. This is the core beige-page/white-card rhythm (D8). Replace `mx-auto max-w-4xl space-y-8 p-8` (line 359) → keep the max-width/spacing, ensure the page bg is beige (inherited) and add comfortable top padding under the new header.

**Section headers:** `<h2 className="text-sm font-semibold">` → `.pn-h4` or `.pn-small-bold` + optional `.pn-eyebrow` category label. Section descriptive `<p className="text-xs text-neutral-500">` → `.pn-small text-fg-muted`.

**Agent roster (lines 496-675):** keep the `space-y-5` list. Each agent row: name `.pn-body-bold`, meta `.pn-small text-fg-muted`, role as a **role pill** (see Badges), bookable as a **status pill** (green-wash/outline). The inline working-hours + attributes forms restyle via the shared `inputCls`/`labelCls`/`btnCls` swap. The weekday checkboxes (lines 388-410, 569-591) are tiny `text-[10px]` letters — bump to `.pn-small`, give the checked state a sky-soft chip feel if time permits (optional; checkbox restyle is fiddly — at minimum recolor labels to `text-fg-muted` and ensure the native checkbox accent is sky via `accent-[--pennie-sky]`).

**Search bar (lines 468-495):** the search input → forms.html search field recipe (rounded, soft surface, search icon `search.svg`, sky focus). "Search" button → `.pn-btn--small --additional`. "clear" link → `.pn-btn--link` (text, `text-[--pennie-blue]` AA-safe).

**Buckets / event types / webhooks forms:** pure `inputCls`/`btnCls`/`labelCls`/`cardCls` swap. The `<code>` chips (criteria keys line 108, reassign key line 835) → `--pennie-wild-sand` bg, `--radius-xs` (4px, chips), `text-fg`, `font` monospace stays. The reassign API `<code>` block (835) is a read-only secret display — keep it boxed but reskin to `bg-[--pennie-wild-sand]` `--radius-sm`.

**Tables:** per "Tables in the Pennie system" above.

**Light + dark:** all automatic via semantic utilities. Verify the navy-on-navy edge cases in dark (e.g. the ink-fill admin role pill needs a lighter treatment in dark — use `--pennie-sky-soft` text-on-ink instead).

### ME — same shell, simpler (D13)

- Reuse `AppHeader` (active tab = "My availability"). Page is `bg-bg`, one or two `.pn-card` sections, `max-w-xl` (keep line 46).
- Header block (lines 47-55): `.pn-h2`/`.pn-h3` "Your availability" + `.pn-small` line with name + **bookable status pill** (not bare green text).
- No-hours banner (line 58): a calm **notice card** (`bg-[--pennie-sky-soft]` or `--pennie-cream-3`, `info.svg` icon, `text-fg`), not amber. Keep the "Use default hours" `.pn-btn--small --primary` inside it.
- Working-hours card: `cardCls` + the shared form swap. "Reset to company default hours" link (line 127) → `.pn-btn--link text-[--pennie-blue]`.
- Closing helper `<p>` (line 133): `.pn-small text-fg-muted`.

### LANDING (`/`) — clean branded version

This is internal/dev-facing (links to Admin + embed demo), so keep it minimal but on-brand — a single beige hero, not a full marketing page.
- `bg-bg` (beige) centered column, `max-w-2xl`.
- Logo (`logo-pennie-charcoal.svg`) + mark at top.
- `.pn-h1`/`.pn-display` "Slate" (one display per screen — README §2.2) + `.pn-lead text-fg-muted` keeping the current product description (line 7-10), warmed to Pennie voice (it already reads on-brand: "Availability aware booking for Pennie…").
- Two actions: "Admin" → `.pn-btn --big --primary` (sky + arrow); "Embed demo" → `.pn-btn --big --additional` (outlined). Replace the `bg-neutral-900` / `border-neutral-300` buttons.
- Optional: a small iridescent graphic or sticky-note for warmth (one, calm).
- Light + dark via `data-theme` (inherits).

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Swap the 4 shared style constants + `.pn-*` for buttons, wrap in shared `AppHeader`** | Smallest diff; re-skins ~80% in one edit per file; zero logic risk; `.pn-*` already token/theme-correct | Status-color ternaries still need manual recolor | **Recommended** |
| Rewrite admin into reusable `<Card>/<Table>/<Field>` components | Cleaner long-term | Big diff, touches structure → risk to forms/actions; over-scoped for visual-only | Rejected (this pass) |
| Reuse Booker primitives for admin shell | Consistency with Booker | Booker is a 3-pane widget, wrong shape for a dense dashboard; DISCOVERY says own shell | Rejected |
| Login: navy left brand panel + white form right | On-brand hero, AA-safe white-on-navy, matches nav/footer logo usage | Slightly more markup than a plain card | **Recommended** |
| Login: full marketing page (testimonials/stats) | Maximally rich | Overkill for an internal Google-OAuth login; more to maintain/verify | Rejected (D12 says "marketing-rich split", not full page) |
| Theme: OS `prefers-color-scheme` | Zero JS | D19 forbids it; can't force light-default; no user choice | Rejected |
| Theme: persisted localStorage toggle + no-flash script | Honors D11 both-themes + user choice; no flash | Tiny client island | **Recommended** |
| Status colors: keep bright green/amber/red | No work | Violates D8 (muted rose, no bright red), off-brand | Rejected |

## Pitfalls and Edge Cases

- **Status colors live in JSX ternaries, not CSS.** A "no stray hex in globals.css" check will miss `bg-green-500`/`text-amber-600`/`bg-red-100`/`text-neutral-*` embedded in admin/me. Grep both page files for `green-|amber-|red-|neutral-|emerald-` and recolor each branch (table above). This is the only place structure couples to styling.
- **Color must never be the sole signal (D18).** The push-health dot, bookable pill, and webhook status pill all currently lean on color alone (well, the push dot has a `title=` + label — keep them). When recoloring, preserve/add the text label or `✓`/icon.
- **`text-amber-600`/yellow-on-light fails AA.** Don't map amber→`--pennie-yellow` as *text* on beige (yellow is illustration-only per D8 and fails as text). Use graphite text + a yellow dot, or rose for true errors, or `--pennie-blue` for info.
- **Login auth is untouchable.** `signIn()` (login lines 14-30: provider, scopes, `redirectTo`, `access_type`, `hd`) is functional — only restyle the returned JSX. Same for every admin server action import (lines 7-21) and every `name=` on inputs (the actions read `form.get("...")`).
- **`/me` and admin duplicate the style constants.** They're separate copies (admin 76-81, me 8-12) — must edit both, or extract to a shared `components/ui/styles.ts`. Extraction is cleaner but adds a file; either is visual-only.
- **`.pn-btn--small` is 40px, `--big` is 56px.** Admin's dense forms want `--small`; login/landing want `--big`. Don't use `--big` in the roster (it'll blow out the row height).
- **Native checkboxes / `<select>` / `type="time"` inputs** (weekday grids, role select, time pickers) can't be fully `.pn-`styled without logic; recolor with `accent-[--pennie-sky]` and the shared `inputCls` for selects. Don't rebuild them as custom widgets (that's logic/scope creep).
- **Theme toggle is a client island.** Admin/me are server components; the toggle button must be a small `"use client"` child, not convert the whole page. It only touches `document.documentElement` + `localStorage` — no server logic.
- **No-flash script ordering.** The inline `<head>` script (from foundation) must run before paint and read the same `localStorage` key the toggle writes (`slate-theme`). Keep them in sync.
- **Dark-mode ink-on-ink pills.** Admin's "trust/ink" role pill (navy fill) becomes invisible on the dark navy page — give it a `dark:` variant (sky-soft fill or beige outline).
- **No hard black, no `#000` shadows, no pills on buttons** (D9): buttons are `--radius-xl`/`--radius-lg` (16/12px), pills (999px) are badges-only. Cards are shadow-led not border-led — drop `border-neutral-200` on cards in favor of `--shadow-xs`.
- **Cloudflare/OpenNext:** all of this is static class/markup + build-time tokens; nothing new runs at the edge. The localStorage toggle is client-side only. Fully CF-compatible (consistent with wave-1).
- **Don't ship DS OTF/`@font-face`** — fonts come from the foundation's `next/font/local` (D6/D7). These pages just use `font-sans`/the `.pn-*` classes.

## References

- `src/app/login/page.tsx` (lines 14-30 auth — untouchable; 32-49 JSX — restyle), `src/app/admin/page.tsx` (76-81 style constants; 250/258 RBAC gates; 449-455, 543-547, 945-951, 806 status ternaries; 770/913/986 tables), `src/app/me/page.tsx` (8-12 constants; 51 status; 58 banner), `src/app/page.tsx` (landing stub), `src/app/layout.tsx` + `src/app/globals.css` (current grayscale boilerplate, replaced by foundation)
- `src/app/admin/actions.ts` (all server actions — read for `name=` contract; do NOT change)
- DISCOVERY.md: D8 (color 80/15/5, sky-only CTA, rose errors, blue text on light), D9 (radii/shape), D11 (both themes internal), D12 (marketing-rich login), D13 (branded task-efficient admin/me), D17 (contrast pairings), D18 (color-not-sole-signal, 44px), D19 (two-layer tokens, `data-theme`, `@custom-variant dark`)
- Wave-1: `research/tailwind-v4-token-mapping.md` (two-layer model, `@theme inline`, `@custom-variant dark`, no-flash `data-theme` script, fonts), `research/booker-ux-patterns.md` (`.pn-*` recipes, rose error token, focus ring, button mapping)
- DS: `colors_and_type.css` (tokens + `.pn-btn`/`.pn-card`/`.pn-h*`/`.pn-eyebrow` recipes — read in full), README.md §2 (color/type/radii), §3 (buttons/fields/cards/badges/header/footer), §3.2 (sticky-note), §4 (voice), §5 (layout/stack-at-640)
- DS previews: `navigation.html` (header: logo-cream-on-navy line 223, `.nav__cta` sky+graphite 40px pill, nav links 14/700; footer brand/cols/divider lines 426-470), `forms.html` (`.input` 52px/8px/no-border/sky-focus lines 29-45; search field; error rose), `buttons.html` (sky+graphite+arrow primary, translateX on hover), `cards.html`/`cta-block.html` (`.cta-grid` split layout lines 31-50, eyebrow+title+body recipe), `badges.html` (24px pill, README §3 fills), `logo.html` (variants), `about-us-block.html`/`statistics-block.html` (split/band patterns)
- Assets to vendor (foundation): `logo-pennie-cream.svg` (login navy panel), `logo-pennie-charcoal.svg` (admin/landing beige), `logo-mark.svg`, `icons/arrow-right.svg`, `icons/search.svg`, `icons/info.svg`, `icons/check.svg`, optional `brand/graphics/pic-3.png`
- Memory: `slate-copy-rules` (no dashes; never "Cadence"), `slate-rbac` (agent<manager<admin — visual-only, don't touch gates)

---

## Second Wave Additions

### Execution Details (filtered by DISCOVERY.md)

1. **Assume foundation is done first (D22).** Tokens, `data-theme` + `@custom-variant dark`, no-flash script, PP Mori, and vendored assets land in the foundation task. These page edits only *consume* them — do not re-port tokens here.
2. **Order within this task:** (a) extract a shared `AppHeader` + theme-toggle island; (b) restyle the 4 shared style constants in admin + me (biggest win); (c) recolor the status ternaries (table in Key Findings); (d) build the login split; (e) brand the landing; (f) the three tables + badges/pills. Each step is independently verifiable.
3. **Strictly visual-only:** no edits to `actions.ts`, no changed `name=`/`value=`/`searchParams`, no RBAC gate changes (D5). If a restyle would require moving a form field or changing a server action signature, stop — it's out of scope.
4. **Both themes for all four pages (D11).** Light is default; dark is the toggle. Login defaults light regardless (marketing/beige), still honors stored pref.
5. **Copy (D12 + voice + `slate-copy-rules`):** login brand-panel copy is verb-phrase, optimistic, discloses nothing sensitive (no agent counts/buckets/Salesforce); no em/en dashes; never "Cadence".

### Tool and Surface Configuration

| Tool/Service | Surface | Purpose | Setup Required | Agent Can Self-Configure? |
|---|---|---|---|---|
| Next.js dev server (`pnpm dev`) | Code/Browser | Render the four pages for visual QA | None | Yes |
| Playwright MCP | Browser | Screenshot login/admin/me/landing in both themes; flip `data-theme`; axe-core a11y; reduced-motion | None | Yes (Playwright) |
| `scripts/test-contrast.ts` | Code | Verify graphite-on-sky, white-on-navy, muted-on-beige, rose-on-beige pairings used here (D17) | Exists (per memory/D21) | Yes |
| Supabase (admin data) | Code | Admin/me are `force-dynamic` and need a signed-in manager+ and seeded agents/buckets to render fully | Test session + seed data | Partial — needs a logged-in session (user provides creds or a seeded session); login page itself renders without auth |
| `pnpm build` / `pnpm lint` / `pnpm test` | Code | Green gate (D21) | None | Yes |

### Verification Strategy

- **Login:** loads unauthenticated → screenshot light + dark; confirm split layout, cream logo on navy, sky+graphite CTA with arrow, no white-on-sky, AA via axe-core, 44px+ targets, mobile stack (<640px). The Google OAuth click is mechanism-only — don't complete the OAuth flow; just confirm the button styles + that `signIn` still fires (no console error).
- **Admin:** requires a manager/admin session + seeded data (agents, a bucket, a webhook, some bookings/deliveries/audit rows) to exercise every section and every status branch (bookable/not, push healthy/partial/none, delivery success/failed/pending). Screenshot each section light + dark; verify pills, tables, beige-page/white-card rhythm, recolored status (no bright green/amber/red), tabular numerals on timestamps. Confirm the manager-only vs admin-only sections still gate (visual presence unchanged).
- **Me:** signed-in agent → both themes; bookable pill, calm no-hours notice (force the empty-rules state), working-hours form fields (sky focus ring), `--max-w-xl` shell.
- **Landing:** unauthenticated → both themes; one display, branded buttons, no `neutral-900`.
- **Evidence:** paired light/dark screenshots per page/section compared against `preview/*.html` (navigation, forms, cards, badges, cta-block); axe-core report (0 serious/critical); contrast-script output; `grep -nE "neutral-|green-[0-9]|amber-|red-[0-9]|emerald-" src/app/{login,admin,me,page}.tsx` returns nothing (all status recolored).
- **Acceptance:** all four pages render in both themes matching the DS visual language; no stray grayscale/bright-status utilities remain; AA pairings pass; build/lint/test green; zero changes to actions/RBAC/form contracts.

### Human Actions Required

| Action | Who | How | Status |
|---|---|---|---|
| Provide a manager/admin test session (or seeded Supabase data) so admin renders all sections + status branches for QA | User | Sign in once in the dev browser / confirm seed data exists, OR hand off a session per memory `shell-isolation-handoff` | Pending |
| Confirm login brand-panel headline/sub copy choice (from the options listed) | User | Pick one (or approve a default: "Welcome back." + "Manage your availability and let the right calls find you.") | Pending |
| Confirm theme-toggle placement + default (recommend: header icon button, default light, persisted) | User | Approve or adjust | Pending |
| Decide whether to ship the optional sticky-note / iridescent graphic on login + landing | User | Approve (recommend: one sticky-note on login, no graphic, to stay calm) | Pending |

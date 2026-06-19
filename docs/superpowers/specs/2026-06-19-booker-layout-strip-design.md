# Booker layout: compact strip (default) + month grid (setting) — design

> PR2 of the precompute-availability work (PR1 = #256, the backend). This is the
> visual/UX layer. Source: the `/plan-council` decisions + the true-to-life mockup
> at `~/Documents/slate-booker-mockups.html`.

## Goal

Give the booker two date-picker layouts and let the org choose which one leads see:

1. **Strip (default)** — the next few bookable days as chips, with the selected day's
   full time list right below. Matches the real 0-3 day booking window so leads never
   scan an empty month.
2. **Month grid** — today's existing `BookerCalendar`, unchanged.

Everything else (event panel, timezone picker, 12h/24h toggle, slot list, attendee
form, confirm flow, theming, embed auto-resize) is shared and identical between them.

Also in scope (small, related): **remove the internal bucket name from the event panel**
— it currently renders `bucket.name` (e.g. "Very High | Both | Legal", the XBC routing
descriptor) above the event title, which leaks routing internals to leads.

## Constraints / invariants

- Visual-only: no change to availability, booking, routing, or the `/api/availability`
  contract (PR1). The two layouts consume the same data.
- Pennie Design System (read `pennie-design-system-in-slate` before restyling): tokens
  only, sky is the sole action color, 16px card radius, both **light and dark** themes.
- Keep the embed contract (`slate-embed-contract`): the iframe still posts its height
  (`slate:resize`) so the host modal resizes with either layout, and Escape still relays.
- Accessibility (WCAG 2.1 AA+): full keyboard nav, visible sky focus ring, 44px targets,
  honor `prefers-reduced-motion`.

## Storage + setting

- Migration `0036_org_booker_layout.sql`: `alter table organizations add column if not
  exists booker_layout text not null default 'strip'` (values `'strip' | 'month'`).
  (Unqualified table name; ALTER, so no RLS-lint concern.) Add `booker_layout` to
  `Organization` in `src/lib/db/types.ts`.
- Admin control: a small two-option toggle on `/admin` (org-wide) that writes the column
  via a server action, mirroring the existing admin patterns. Default 'strip'; flippable
  anytime (no deploy needed).

## Data flow

- `src/app/book/page.tsx` (server) currently passes only `bucketCode` (the org name
  arrives later via `/api/availability`, unchanged). Add a small server-side read here:
  resolve the bucket's org and its `booker_layout`, and pass it as `<Booker layout=... />`.
  Falls back to `'strip'` if missing. (One extra indexed read on the page render, off the
  cached availability hot path.)
- Admin toggle fits the EXISTING org-defaults form on `/admin` (`setOrgDefaultHours`
  server action) — extend that same pattern rather than inventing a new settings surface.
- `Booker.tsx` takes a `layout: 'strip' | 'month'` prop and renders the middle/times
  region accordingly. The event panel, timezone/12h controls, slot list, attendee form,
  confirmed state, and all state/handlers are unchanged and shared.

## Components

- **New `BookerStrip.tsx`** — presentational, like `BookerCalendar`: receives the
  available days (derived from `slotsByDay`), the active day, and `onSelect`; renders the
  day chips. Keyboard: Left/Right between chips, Enter/Space to select (roving tabindex,
  same pattern as `BookerCalendar`). No data/IO; the Booker still owns slots.
- **`Booker.tsx`** — switch: `layout === 'month'` renders the existing 3-column grid
  (panel | `BookerCalendar` | times); `layout === 'strip'` renders a 2-column grid
  (panel | [strip over the times list]). The times list, toggle, timezone select, empty/
  error states, and attendee form are the SAME components in both, just positioned. Remove
  the `bucket.name` `<p>` from the event panel.
- **`BookerCalendar.tsx`** — unchanged.

## Responsive + embed

- Both layouts collapse to a single column on narrow widths (the existing `md:` grid
  breakpoints). The strip's day chips wrap or scroll horizontally on very narrow embeds.
- The `ResizeObserver` → `slate:resize` postMessage stays; verify the iframe height
  tracks correctly in BOTH layouts and when switching days (no clipped slot list).

## States

- Loading: existing skeleton rows.
- Empty (bucket has no slots in the window): "No times available in the next few days"
  (genuine empty), distinct from the load-error/retry. PR1's fail-open means a real bucket
  always returns real slots, so the booker only ever sees slots or an error.
- Error: existing "Couldn't load available times" + Try again.

## Out of scope (YAGNI)

- Headless-auto-booker determinism hooks (`data-state`/`data-slot-iso`): the auto-booker
  is being replaced by the routing API (#253), so the booker needn't be automation-proof.
- Per-event-type or embed-param layout control: org-wide is enough (one org).

## Testing + verification

- Pure/extractable logic gets a `scripts/test-*.ts` (e.g. the available-days derivation if
  extracted). The layouts are mostly presentational → verified visually.
- `slate-ui-verification`: Playwright screenshots of BOTH layouts in BOTH themes (freeze
  motion per AGENTS.md), axe, contrast (sky-on-surface, graphite-on-sky), Lighthouse.
- `pnpm build` / `lint` / `test` green. Run the FULL `pnpm test` before pushing (includes
  `test-migrations`, which requires unqualified table names).
- Confirm the embed still books end-to-end in both layouts and the iframe resizes cleanly.

## Rollout

- PR2 branches on PR1 (`feat/booker-layout-strip` off `feat/precompute-availability`);
  rebase onto main once #256 merges. Default `'strip'`; the org can flip to `'month'`.

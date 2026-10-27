@AGENTS.md

# Slate

Cal.com style booking for Pennie: routes landing page bookings to a round robin
pool of agents ("debt buckets"), syncs Google Calendar, embeds via `widget.js`,
emits webhooks to Regal/Cadence. Setup and the URL contract: `README.md`.

Stack: Next.js 16 (App Router, TS), Supabase (Postgres + Auth), googleapis,
Tailwind v4, Luxon, pnpm.

## Architecture rules

- **Availability is cache first.** The embed reads the cache through
  `/api/availability`, never live Google; Slate bookings write through, and
  Google push plus the 1 minute `/api/cron/sync` keep it fresh. The only live
  Google call on the hot path is verify on book at confirm time
  (`src/lib/booking/service.ts`). ADR 0003.
- **One predicate judges a bookable time:** `bookableSlotReason`
  (`src/lib/availability/compute.ts`) checks the org's business hours, then the
  agent's working hours, then their calendar. **Each hours window is judged in
  its own zone and never intersected**: the roster spans several zones
  (`scripts/test-availability-zones.ts`). `loadBusinessHours` throws on an
  unreadable week rather than degrading.
- **The org window also applies at read time** (`slotsWithinBusinessHours` in
  `resolveBucketSlots`); the cache keeps the unfiltered payload, and anything
  counting cached slots uses the same filter.
- **The lead's calling window** (08:00 to before 20:00 in the lead's zone,
  `src/lib/booking/lead-calling-window.ts`) is a separate gate outside the slot
  cache: `pickerSlots` filters it and `createBooking`/`rescheduleBooking` refuse
  with `OutsideCallingWindowError`. ADR 0010.
- Server code uses the secret key client `supabaseAdmin` (bypasses RLS); RLS is
  default deny. DB types are hand written (`src/lib/db/types.ts`, `schema.ts`).
  Weekdays follow Luxon (1=Mon..7=Sun).

History and measurements behind these: `docs/architecture.md`, "The availability
rules in full".

## Placeholder bookings (milestone 75)

A call no real advisor is free for goes on the one placeholder advisor as `staff_placed`,
which nobody dials, so its own `placeholder_*` alerts watch it, never the advisor ones.
Path, switch and runbook: `docs/architecture.md`, "The placeholder advisor path".

## Design

UI follows the Pennie Design System: read `.impeccable.md` and the
`pennie-design-system-in-slate` skill before restyling. In short: CSS variables,
never raw hex; Sky `#82D0FF` is the only action colour (sky fill, graphite text);
PP Mori 200/400/600 only; 16px radius on buttons and cards, pills for badges
only; no hard black, errors in rose; WCAG 2.1 AA with a visible focus ring, 44px
targets, reduced motion honoured, colour never the sole signal, and contrast
verified in both themes; light and dark both maintained. Voice: warm and plain,
verb phrase buttons, never guarantee rates. Pennie is a lending marketplace, not
the pennie.com health insurer.

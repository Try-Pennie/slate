@AGENTS.md

# Slate

Cal.com-style booking for Pennie. Routes landing-page bookings to a round-robin
pool of agents ("debt buckets"), syncs Google Calendar, embeds via `widget.js`,
emits webhooks to Regal/Cadence. See `README.md` for setup + the URL contract.

## Stack

Next.js 16 (App Router, TS) · Supabase (Postgres + Auth) · googleapis · Tailwind
v4 · Luxon. Package manager: pnpm.

## Architecture notes

- **Availability is cache-first.** `busy_blocks` is the cached index: Slate
  bookings write through synchronously; Google push (`/api/google/push`) +
  the 1-min `/api/cron/sync` backstop keep external changes fresh. The embed
  reads the cache via `/api/availability` — never live Google. The only live
  Google call on the hot path is the single-agent verify-on-book at confirm
  time (`src/lib/booking/service.ts`).
- **Server code uses the secret-key client** (`supabaseAdmin`, bypasses RLS; the
  new-style `sb_secret_…` key — anon/service_role JWTs are legacy).
  RLS is default-deny; the only client-readable row is a user reading itself.
- **DB types are hand-written** (`src/lib/db/types.ts` + `schema.ts`). Regenerate
  with `supabase gen types typescript` once a project is linked.
- Weekday convention is Luxon's (1=Mon..7=Sun).


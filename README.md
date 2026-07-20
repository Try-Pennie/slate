# Slate

Availability-aware booking for Pennie — a Cal.com-style scheduler that routes
landing-page bookings to a round-robin pool of agents ("debt buckets"), syncs
with each agent's Google Calendar, embeds anywhere, and emits webhooks for
Regal/Cadence.

## Why it's fast

The embed pain in Cal.com is the live Google free/busy call for every agent on
every modal open. Slate reads availability from a **cached busy store** in
Postgres instead:

- **Write-through** — Slate's own bookings update the cache synchronously, so
  rapid bookings never go stale.
- **Push sync** — Google Calendar push notifications (+ a 1-min backstop cron)
  keep externally-made calendar changes fresh within seconds.
- **Verify-on-book:** at confirmation, one live free/busy check of the
  round-robin candidates in batched waves (one Google call per wave, #167) takes
  the first actually-free agent, guaranteeing no double-book.

So the modal reads cache (instant); correctness is held by one targeted verify.

## Stack

Next.js 16 (App Router, TS) · Supabase (Postgres + Auth) · googleapis · Tailwind
v4 · Luxon. Package manager: pnpm.

## Setup

1. **Supabase project:** create one, link it (`supabase link`), then apply the
   whole migration set with `supabase db push`. The `supabase/migrations/` folder
   runs to `0060_monitor_settings.sql`; applying only `0001_init.sql` leaves a
   broken schema (missing `bucket_slots`, the booking outbox, `monitor_settings`,
   `is_test`, and more).
2. **Google Cloud** — create an OAuth client (Web). Authorized redirect URIs
   must include your Supabase auth callback **and** `${APP_URL}/api/auth/callback`.
   Enable the Calendar API.
3. **Supabase Auth** — enable the Google provider with the same client
   id/secret. Add the Calendar scopes.
4. **Env:** copy `.env.example` to `.env.local` and fill it in. Beyond Supabase
   and the Google OAuth client, a working instance now also needs the Google
   **service account** for domain-wide delegation (`GOOGLE_SA_CLIENT_EMAIL` /
   `GOOGLE_SA_PRIVATE_KEY`, which drive all calendar reads/writes and
   availability) and **Salesforce** roster sync (`SF_CLIENT_ID` /
   `SF_CLIENT_SECRET` / `SF_INSTANCE_URL`).
5. Install + run:
   ```bash
   pnpm install
   pnpm dev
   ```

### Cron (production)

Crons run on **Cloudflare Workers**, not Vercel. `wrangler.jsonc`'s
`triggers.crons` declare the schedules; `worker/index.ts` dispatches each trigger
through `worker/cron-routes.ts` to the app's `/api/cron/*` endpoints, and
`scripts/test-cron-routes.ts` keeps the two in lockstep. A single trigger can fan
out to several independent lanes, each under its own lock. The every-minute
trigger drives sync, recompute, outbox, and self-heal. Every endpoint requires
`Authorization: Bearer $CRON_SECRET`. See `DEPLOY.md` for the full lane table.

## End-to-end verification

1. Visit `/login`, sign in with a Pennie Google account. Every login provisions
   an `agent` (no login ever auto-grants admin). Repeat for 2–3 agent accounts to
   connect their calendars. To bootstrap the first admin, promote an agent with a
   direct DB update: `update users set role = 'admin' where email = '…';` then use
   role management in `/admin` to grant the rest.
2. In `/admin`: create an event type, set each agent's working hours, and create
   a bucket with code `411` containing those agents. Set the webhook URL to a
   stub (e.g. webhook.site).
3. Open the embed test page at `/embed-example.html` (or load
   `/booking/<sfId>?xbc=411&name=...&email=...&phone=...`). Slots should render
   instantly.
4. Book a slot → a real event + invite lands on the assigned agent's calendar,
   and a `booking.created` webhook hits the stub (carrying the Salesforce id).
5. Block time directly in that agent's Google Calendar → the slot disappears
   from `/api/availability?bucket=411` within seconds (push) / 1 min (backstop).
6. Use the manage link to reschedule, then cancel → calendar + webhooks update.

## URL contract (Cal.com parity)

```
/booking/{salesforceId}?xbc={bucketCode}&name=&email=&phone=&attendeePhoneNumber=&smsReminderNumber=&loanPurpose=&loanRequest=&estimatedPmt=&active=
```

- `{salesforceId}` — opaque, stored and echoed in webhooks (no Salesforce calls).
- `xbc` — resolves to the bucket / round-robin pool.
- Everything else prefills the form and is forwarded in the webhook payload.

## Programmatic booking

For AI / programmatic booking without the embed, use the key-authed
**[Direct Booking API](docs/booking-api.md)** (`GET /api/availability` to find
slots + `POST /api/bookings` to book), which applies the same routing,
round-robin, verify-on-book, and one-appointment-per-person dedupe.

## Webhooks: the tier-fallback signal (#492)

Slate emits `booking.created` / `.rescheduled` / `.cancelled` / `.completed` to each
subscribed endpoint. Endpoints with `format: 'regal'` get the Regal event shape
(`src/lib/webhooks/regal.ts`).

Routing does not always book the tier that was asked for. When the requested tier has
nobody free, Slate **deliberately** walks down a rung rather than showing the lead no
availability. That is a healthy outcome, but it looks identical to a misroute from the
outside, which is what makes Regal's "Non-Ultra High Team Booking Detected" alert fire
on it.

Every event therefore carries how it was routed, so a consumer can tell the two apart:

| property | meaning |
|---|---|
| `slateTierFallback` | **true = Slate meant to do this.** The requested tier had nobody free, so it dropped a rung. |
| `slateEmptyPoolFallback` | The pool was empty and the bucket's fallback agent took it (a different case). |
| `slateRequestedTier` / `slateBookedTier` | The tier asked for, and the tier actually booked. |
| `slateRungsDropped` | How far it fell (0 when no drop). |

**Regal side:** gate the "Non-Ultra High Team Booking Detected" journey on
`slateTierFallback == false`, so an intentional drop stays quiet and a genuine misroute
still alerts. Without that, the alert fires on every intentional drop and stops being
trusted.

**One caveat on replays.** An admin resend and the dead-letter replay rebuild the event
from the *stored* payload, and bookings written before this signal shipped (2026-07-13)
have no routing summary at all. Those degrade to "nothing unusual happened"
(`slateTierFallback: false`) rather than failing the replay, so resending an old booking
that *was* an intentional drop can trip the alert once. It only affects manual resends of
pre-2026-07-13 bookings.

`src/lib/webhooks/regal.test.ts` is the regression lock on this contract: the properties
above are only useful if they actually reach Regal, and the original bug was that they
silently did not.

## Embed

```html
<div id="slate"></div>
<script src="https://YOUR-SLATE/widget.js"></script>
<script>
  Slate.inline({ selector: "#slate", url: "https://YOUR-SLATE/booking/SF_ID?xbc=411" });
  // or: Slate.popup({ url: "...", text: "Book a call" });
</script>
```

## Layout

```
src/lib/availability   slot computation (compute.ts) + cache-first loading (service.ts)
src/lib/booking        create / reschedule / cancel + round-robin + verify-on-book + reservations/outbox (crash-safety)
src/lib/routing        bucket resolution + equal-share ranking + tier fallback + routing-decision log
src/lib/google         OAuth, calendar ops, push/incremental sync, freeBusy
src/lib/monitor        availability-health probe + booking-volume alert + tunable settings
src/lib/webhooks       HMAC-signed delivery + retry
src/lib/salesforce     hourly roster sync (agents, teams, attributes)
src/lib/ooo            out-of-office requests, approvals, digests
src/lib/slack          ops alerts + OOO DMs + Approve/Decline interactions
src/lib/notify         throttled alert dispatch (shared by monitor/booking/routing)
src/lib/offboarding    deactivate / reactivate departed agents
src/lib/bookable       move an agent in/out of the booking pool (bookable flag) + activation guard
src/lib/auth           login provisioning + role/RBAC + admin impersonation
src/lib/{calcom,date,db,embed,supabase}   cal.com dual-write, Luxon helpers, hand-written DB types, embed origin, Supabase clients
src/app/api            availability, bookings, auth callback, google push, cron/* lanes, keyed reassign/booking/offboarding APIs
src/app/admin          admin: agents, hours, event types, buckets, webhook, settings, monitor tuning
src/app/booking        public booking page + self-serve manage page
src/app/book           short-code booking entry
src/app/me             agent self-serve (hours, calendar, OOO)
src/app/login          Google SSO
worker/                Cloudflare Worker entry (index.ts) + cron dispatch (cron-routes.ts)
scripts/               node-native tests (test-*.ts) + migration / env / doc drift guards
public/widget.js       embed SDK (inline + popup)
supabase/migrations    schema (runs to 0060)
```

Deeper context: `CONTEXT.md` (domain glossary), `DEPLOY.md` (deploy + cron runbook),
`docs/api.md` (full HTTP API reference), `docs/booking-api.md` (Direct Booking API
integrator guide), and `docs/adr/` (architecture decisions).

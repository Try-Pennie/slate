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
- **Verify-on-book** — at confirmation, one live free/busy check for the *single*
  round-robin-assigned agent guarantees no double-book.

So the modal reads cache (instant); correctness is held by one targeted check.

## Stack

Next.js (App Router, TS) · Supabase (Postgres + Auth) · googleapis · Tailwind.

## Setup

1. **Supabase project** — create one, then run the migration in
   `supabase/migrations/0001_init.sql` (SQL editor or `supabase db push`).
2. **Google Cloud** — create an OAuth client (Web). Authorized redirect URIs
   must include your Supabase auth callback **and** `${APP_URL}/api/auth/callback`.
   Enable the Calendar API.
3. **Supabase Auth** — enable the Google provider with the same client
   id/secret. Add the Calendar scopes.
4. **Env** — copy `.env.example` to `.env.local` and fill it in.
5. Install + run:
   ```bash
   pnpm install
   pnpm dev
   ```

### Cron (production)

`vercel.json` schedules:
- `/api/cron/sync` every minute — backstop incremental sync + watch renewal.
- `/api/cron/complete` every 5 min — mark finished bookings complete, retry
  failed webhooks.

Both require `Authorization: Bearer $CRON_SECRET`.

## End-to-end verification

1. Visit `/login`, sign in with a Pennie Google account (first user becomes
   admin). Repeat for 2–3 agent accounts to connect their calendars.
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
slots + `POST /api/bookings/direct` to book), which applies the same routing,
round-robin, verify-on-book, and one-appointment-per-person dedupe.

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
src/lib/availability   slot computation (compute.ts) + data loading (service.ts)
src/lib/booking        create / reschedule / cancel + round-robin + verify-on-book
src/lib/google         OAuth, calendar ops, push/incremental sync
src/lib/webhooks       HMAC-signed delivery + retry
src/app/api            availability, bookings, auth callback, google push, cron
src/app/admin          minimal admin (agents, hours, event types, buckets, webhook)
src/app/booking        public booking page + self-serve manage page
public/widget.js       embed SDK (inline + popup)
supabase/migrations    schema
```

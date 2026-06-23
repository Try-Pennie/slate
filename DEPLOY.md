# Deploying Slate to Cloudflare (slate.trypennie.dev)

The app runs on Cloudflare Workers via `@opennextjs/cloudflare`. Run these in a
**real Terminal** (not the `!` prefix — wrangler needs a TTY for login + secret
prompts, so values never land in a transcript).

## Prerequisites
- `trypennie.dev` is a zone in the target Cloudflare account (the `custom_domain`
  route in `wrangler.jsonc` auto-creates the DNS record + TLS cert for the
  subdomain). If it isn't, add the domain to Cloudflare first, or remove the
  `routes` entry and bind the domain in the dashboard later.
- `.env.local` is filled in (it provides the `NEXT_PUBLIC_*` values inlined at
  build time; `NEXT_PUBLIC_APP_URL` is already set to `https://slate.trypennie.dev`).

## 1. Authenticate
```bash
cd ~/Documents/Slate
wrangler login
```

## 2. Set runtime secrets (server-only; entered at prompts)
These are NOT inlined at build — the Worker reads them at runtime. Paste each
value (from `.env.local`) when prompted:
```bash
wrangler secret put SUPABASE_SECRET_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_HOSTED_DOMAIN
wrangler secret put CRON_SECRET
wrangler secret put GOOGLE_CHANNEL_TOKEN
wrangler secret put OFFBOARDING_API_KEY   # optional; unset = offboarding endpoints return 503
wrangler secret put BOOKING_API_KEY        # optional; unset = direct booking API returns 503
# wrangler secret put BOOKING_API_KEY_2    # optional 2nd key — set only when rotating
```

## 3. Build + deploy
```bash
pnpm run cf:deploy   # build + deploy (NOT `pnpm deploy` — that's a pnpm builtin)
```

## 4. Post-deploy config
- **Offboarding API (optional):** to let the offboarding automation deactivate
  departed users, set `OFFBOARDING_API_KEY` (above), then point the automation at
  `POST https://slate.trypennie.app/api/users/deactivate` (and `/reactivate` for a
  rehire) with header `Authorization: Bearer <key>` and JSON body
  `{ "email": "person@trypennie.com" }`. Deactivate-not-delete (history is kept);
  idempotent. Unset key ⇒ the endpoints return 503 (disabled). Same pattern as
  `REASSIGN_API_KEY`.
- **Direct booking API (optional):** to let the programmatic/AI auto-booker book
  without the embed, set `BOOKING_API_KEY` (above) and share it with the
  integrator. Unset ⇒ `POST /api/bookings/direct` returns 503. Set a second
  `BOOKING_API_KEY_2` only when rotating (both keys are accepted at once). Full
  request/response/error contract: `docs/booking-api.md`.
- **Supabase → Authentication → URL Configuration → Redirect URLs:** add
  `https://slate.trypennie.dev/api/auth/callback`. (Set Site URL to
  `https://slate.trypennie.dev` too.)
- **Google Calendar push (real-time availability):** verify domain ownership of
  `slate.trypennie.dev` (or `trypennie.dev`) in Google Search Console, then add
  it under the Cloud project's **Domain verification** so `events.watch` accepts
  the push endpoint. Until then, calendar changes still sync — just not in
  real-time (see Cron below).
- The Google OAuth client redirect URI is unchanged (it points at Supabase).

## Cron
Cron runs entirely on the **main** Worker: `worker/index.ts` `scheduled()`
dispatches each Cloudflare trigger through `worker/cron-routes.ts` to the app's
cron endpoints (`Authorization: Bearer $CRON_SECRET`). Triggers live in
`wrangler.jsonc`; `scripts/test-cron-routes.ts` pins them in lockstep. A single
trigger may drive more than one independent lane (each guards itself with its
own lock):
- `* * * * *`   → `/api/cron/sync` (backstop calendar sync) **+** `/api/cron/recompute` (bucket_slots freshness)
- `*/5 * * * *` → `/api/cron/complete` (mark-complete sweep + webhook retries) **+** `/api/cron/watch` (calendar watch renewal)
- `0 * * * *`   → `/api/cron/agents` (hourly Salesforce roster reconcile + default hours, single locked path)
- OOO digest / approvals slots (see `cron-routes.ts`)

No secret beyond `CRON_SECRET` (already set on the app) is needed — the crons
deploy with the app via `pnpm cf:deploy`. Until the domain is Google-verified,
the watch-registration attempt fails harmlessly (caught); real-time push starts
working once verification is done.

> **One-time teardown (#267):** the old companion **`slate-cron`** Worker
> (`cron-worker/`, now deleted from the repo) double-fired the every-minute and
> 5-minute jobs and was the only place the unlocked `*/15` Salesforce sync ran.
> After deploying the main Worker, retire it once with `wrangler delete slate-cron`.

## Verify after deploy
1. Visit `https://slate.trypennie.dev/login` → sign in with Google → land on `/admin`.
2. Configure event type + working hours + bucket `411` + webhook URL.
3. Load `/booking/SF_TEST?xbc=411&...` → book → check calendar invite + webhook.

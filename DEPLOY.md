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
```

## 3. Build + deploy
```bash
pnpm run cf:deploy   # build + deploy (NOT `pnpm deploy` — that's a pnpm builtin)
```

## 4. Post-deploy config
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
Implemented as a separate **`slate-cron`** Worker (`cron-worker/`) — the OpenNext
app Worker only exports `fetch`, so a companion Worker handles `scheduled` and
calls the app's cron endpoints with `Authorization: Bearer $CRON_SECRET`:
- `* * * * *`   → `/api/cron/sync`     (backstop calendar sync + watch renewal)
- `*/5 * * * *` → `/api/cron/complete` (mark-complete sweep + webhook retries)

Deploy/update it with:
```bash
wrangler deploy --config cron-worker/wrangler.jsonc
wrangler secret put CRON_SECRET --config cron-worker/wrangler.jsonc   # same value as the app
```
Watch it run: `wrangler tail slate-cron`. Until the domain is Google-verified,
the per-minute sync's watch-registration attempt fails harmlessly (caught);
real-time push starts working once verification is done.

## Verify after deploy
1. Visit `https://slate.trypennie.dev/login` → sign in with Google → land on `/admin`.
2. Configure event type + working hours + bucket `411` + webhook URL.
3. Load `/booking/SF_TEST?xbc=411&...` → book → check calendar invite + webhook.

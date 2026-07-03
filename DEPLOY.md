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

## 2. Set runtime configuration
Slate reads its configuration from three places, so a rebuild-from-scratch deploy
needs ALL of them. This is the full list (source of truth: `.env.example` and
`src/lib/env.ts`); `scripts/test-deploy-env-coverage.ts` fails CI if a var read by
the app or listed in `.env.example` is ever missing here.

### 2a. Build-time public values (`.env.local`, inlined into the client bundle)
Set these in `.env.local` BEFORE `pnpm run cf:deploy`: they are baked in at build,
not read at runtime.
- `NEXT_PUBLIC_APP_URL` (required): base URL, no trailing slash. Drives OAuth
  redirects, the embed SDK, manage links, and the Google push callback URL.
- `NEXT_PUBLIC_SUPABASE_URL` (required): the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (required): the client-safe
  `sb_publishable_…` key.
- `NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN` (optional): sets Google's `hd` login hint. The
  enforced server-side twin is `GOOGLE_HOSTED_DOMAIN` (in 2c).

### 2b. Runtime secrets (`wrangler secret put`, entered at prompts)
Sensitive values the Worker reads at runtime. Paste each (from `.env.local`) when
prompted. The **required** ones each break a core feature when unset:
```bash
wrangler secret put SUPABASE_SECRET_KEY    # required; server DB access (bypasses RLS). Unset = every server route + cron fails.
wrangler secret put GOOGLE_CLIENT_ID        # required; Google SSO login. Unset = nobody can sign in.
wrangler secret put GOOGLE_CLIENT_SECRET    # required; Google SSO login (paired with the id).
wrangler secret put GOOGLE_SA_CLIENT_EMAIL  # required; service account for domain-wide delegation. Unset = no calendar reads/writes, no availability, no OOO.
wrangler secret put GOOGLE_SA_PRIVATE_KEY   # required; the SA private key (literal \n newlines, as in the JSON key).
wrangler secret put SF_CLIENT_ID            # required; Salesforce roster sync. Unset = the agent roster never syncs.
wrangler secret put SF_CLIENT_SECRET        # required; Salesforce roster sync (paired with the id).
wrangler secret put SF_INSTANCE_URL         # required; the Salesforce org URL, no trailing slash.
wrangler secret put CRON_SECRET             # required; authorizes every cron endpoint. Unset = all cron lanes reject (sync, complete, watch, agents, monitor, outbox, selfheal).
wrangler secret put GOOGLE_CHANNEL_TOKEN    # required; signs/verifies Google calendar push pings. Unset = real-time push verification fails.
wrangler secret put MAIN_OOO_CAL_ID         # required; the OOO approval calendar + default impersonation actor for manager-calendar writes. Unset = OOO approval throws.
wrangler secret put SLACK_BOT_TOKEN         # optional; ops alerts + OOO DMs/digest. Empty = Slack is a no-op.
wrangler secret put SLACK_ALERTS_CHANNEL    # optional; default alert channel id. Empty = alerts have nowhere to post. (Channel id, not sensitive; may live in wrangler.jsonc vars instead.)
wrangler secret put SLACK_INFO_CHANNEL      # optional; quieter info-only channel (#567). Empty = falls back to SLACK_ALERTS_CHANNEL.
wrangler secret put SLACK_SIGNING_SECRET    # optional; verifies inbound Slack Approve/Decline requests. Empty = /api/slack/interactions rejects everything.
wrangler secret put CALCOM_API_KEY          # optional; cal.com dual-write during cutover (needs OOO_CALCOM_DUAL_WRITE). Empty = dual-write no-op.
wrangler secret put REASSIGN_API_KEY        # optional; bearer for the reassign API. Empty = POST /api/bookings/reassign returns 503.
wrangler secret put OFFBOARDING_API_KEY     # optional; bearer for deactivate/reactivate. Empty = offboarding endpoints return 503.
wrangler secret put BOOKING_API_KEY         # optional; bearer for the direct booking API. Empty (both) = POST /api/bookings returns 503.
# wrangler secret put BOOKING_API_KEY_2     # optional 2nd booking key; set only when rotating (both accepted at once).
```

### 2c. Runtime vars (`wrangler.jsonc` under `vars`, committed and redeployed)
Non-secret config + launch flags. They live in `wrangler.jsonc` (version-controlled
so they survive every deploy; a dashboard-only plain var gets WIPED on the next
`wrangler deploy`), so they ship with `pnpm cf:deploy` and need no `secret put`.
Change one by editing `wrangler.jsonc` and redeploying.
- `GOOGLE_HOSTED_DOMAIN` (required): the server-side SSO domain gate (e.g.
  `trypennie.com`). Empty = any Google account may sign in. Its build-time
  `NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN` twin is set in 2a.
- `AGENT_SCHEDULING_LIVE`: launch flag. `"false"` = OOO-only phase; `"true"` reveals
  scheduling self-service to agents.
- `OOO_CALENDAR_ACTOR_EMAIL` (optional): impersonation actor for OOO calendar writes.
  Unset = defaults to `MAIN_OOO_CAL_ID`.
- `OOO_APPROVALS_TO` / `OOO_APPROVALS_BCC` / `OOO_APPROVALS_REPLY_TO`: recipients of
  the daily OOO-approvals digest email. Empty `TO` = the digest no-ops.
- `OOO_CALCOM_DUAL_WRITE`: `"true"` mirrors approved OOO into cal.com during the
  cutover (requires `CALCOM_*` + `CALCOM_API_KEY`). `"false"`/unset = no-op.
- `CALCOM_BASE_URL` / `CALCOM_ORG_ID`: cal.com API base + org for the dual-write.
- `BOOKING_VOLUME_ALERT_ARMED` / `BOOKING_VOLUME_FLOOR_30` / `BOOKING_VOLUME_FLOOR_120`:
  low-volume booking alert arming + floors (see Post-deploy config below). Unset =
  disarmed (counts still logged; floors default 5 / 20).

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
  integrator. Unset ⇒ `POST /api/bookings` returns 503. Set a second
  `BOOKING_API_KEY_2` only when rotating (both keys are accepted at once). Full
  request/response/error contract: `docs/booking-api.md`.
- **Low-volume booking alert (#370, arm at cutover):** the monitor lane counts
  bookings every 5 min during Eastern business hours, but the Slack alert is
  DISARMED by default so it can't cry wolf during the cal.com to Slate ramp (low
  volume is expected then). When Slate owns roughly full traffic, set
  `BOOKING_VOLUME_ALERT_ARMED=1` to enable it, and tune the expected floors
  `BOOKING_VOLUME_FLOOR_30` / `BOOKING_VOLUME_FLOOR_120` (defaults 5 / 20) to the
  real volume. Until armed it still logs the counts each tick (visible in Worker
  logs) so you can calibrate the floors before turning it on.
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

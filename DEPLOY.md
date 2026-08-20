# Deploying Slate to Cloudflare (slate.trypennie.app)

The app runs on Cloudflare Workers via `@opennextjs/cloudflare`. Run these in a
**real Terminal** (not the `!` prefix — wrangler needs a TTY for login + secret
prompts, so values never land in a transcript).

## Prerequisites
- The canonical production host is **`slate.trypennie.app`**. `wrangler.jsonc`'s
  `routes` bind it as a `custom_domain` (and also bind a secondary domain);
  `custom_domain` auto-creates the DNS record + TLS cert. Each host's apex zone
  must exist in the target Cloudflare account. If one isn't there, add it to
  Cloudflare first, or drop that `routes` entry and bind the domain in the
  dashboard later.
- `.env.local` is filled in (it provides the `NEXT_PUBLIC_*` values inlined at
  build time; `NEXT_PUBLIC_APP_URL` is set to `https://slate.trypennie.app`).

## 1. Authenticate
<!-- runbook-unverified: an interactive browser OAuth flow, so it cannot be executed
     non-interactively. Its EFFECT (a working wrangler login) is what every other
     wrangler step in this file depends on and demonstrates. -->

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

<!-- runbook-unverified: each line WRITES a live Worker secret, so running them would
     overwrite production config. The NAMES are checked both directions on every push by
     scripts/test-deploy-env-coverage.ts: a var the app reads that is missing here fails
     the build, and a name here that nothing reads fails it too. A `wrangler secret list`
     on 2026-08-03 additionally confirmed which are SET in production; see the note
     directly below. -->

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
wrangler secret put BOOKABLE_API_KEY        # optional; bearer for the bookable-toggle API. Empty = POST /api/users/bookable returns 503.
wrangler secret put BOOKING_API_KEY         # optional; bearer for the direct booking API. Empty (both) = POST /api/bookings returns 503.
# wrangler secret put BOOKING_API_KEY_2     # optional 2nd booking key; set only when rotating (both accepted at once).
wrangler secret put GITHUB_CANARY_TOKEN     # optional; fine-grained GitHub token (Actions read/write on Try-Pennie/slate) so the monitor lane can re-fire the smoke-canary workflow when GitHub drops a scheduled run. Empty = gap-filler is a no-op (GitHub's schedule alone runs the canary).
wrangler secret put SNOWFLAKE_PRIVATE_KEY   # optional; RSA private key (PKCS#8 PEM) for the Snowflake archival mirror export lane. Empty = the export lane is a safe no-op (logs "not configured" and skips). See docs/snowflake-setup.md.
```

**Which of these are actually set (measured 2026-08-03, #1200).** A
`wrangler secret list` against the live Worker returned 20 secrets. Every name in
this file is either set or deliberately not, and nothing is set that this file
does not document. The three not set:

1. `BOOKING_API_KEY_2` is correctly absent. It is the commented line above, set
   only during a key rotation.
2. `SLACK_INFO_CHANNEL` is unset, so info-only alerts fall back to
   `SLACK_ALERTS_CHANNEL` as documented. That works, but it means the quieter
   channel separation (#567) is not actually in effect today.
3. `BOOKABLE_API_KEY` is unset, so `POST /api/users/bookable` really does return
   `503 {"error":"bookable api not configured"}` in production right now
   (measured, not inferred). Its two siblings return `401`, so they are
   configured and this one is genuinely off. The consequence is narrow: an admin
   can still promote an agent into the booking pool through the admin UI, which
   runs the same guarded path (`src/app/admin/actions.ts:555`). What cannot
   happen is the roster or onboarding automation doing it programmatically. Set
   the key if that automation is meant to be live.

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
- `SLATE_BOOKING_HORIZON_DAYS`: fallback for the org-wide booking horizon (how far
  ahead leads can book) when the admin settings screen has not set one. Optional; a
  whole number 1 to 7. Unset = the coded default (4). The admin UI value (stored in
  `booking_settings`) always wins over this.
- `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER` / `SNOWFLAKE_DATABASE` / `SNOWFLAKE_SCHEMA`
  / `SNOWFLAKE_WAREHOUSE` / `SNOWFLAKE_ROLE`: non-secret connection config for the
  archival mirror export lane (milestone #15). `SNOWFLAKE_ACCOUNT` is the account
  URL prefix, the part before `.snowflakecomputing.com`. Slate's is
  `vrkfjso-rwc54963` (the `orgname-accountname` form). This bullet used to say
  "locator plus region, e.g. `ab12345.us-east-1`", which is a form Snowflake also
  accepts but is **not** the one this account uses, so a rebuild-from-scratch
  deploy following it would set an account that cannot authenticate (#1200).
  `docs/snowflake-setup.md` step 4 derives the value. The rest default to
  `SLATE_SERVICE` / `SLATE` / `PUBLIC` / `SLATE_WH` / `SLATE_ROLE` as provisioned by
  `docs/snowflake-setup.sql`. The paired secret is `SNOWFLAKE_PRIVATE_KEY` (2b).
  With the private key unset the export lane is a safe no-op. Full setup:
  `docs/snowflake-setup.md`.

## 3. Build + deploy
<!-- runbook-verified: 2026-08-03 (e753ab99) this exact command is what CI runs on every
     push to main (.github/workflows/ci.yml, the deploy job), so it is executed several
     times a week against the real target. Most recent success 2026-08-03 for PR #1221,
     followed by a green post-deploy probe. -->

```bash
pnpm run cf:deploy   # build + deploy (NOT `pnpm deploy` — that's a pnpm builtin)
```

### What CI does around that command (#1037)
A merge to `main` reaches 100% of traffic instantly, so the `deploy` job wraps
`cf:deploy` in two extra steps. Both matter if you ever deploy by hand:

1. **Before** the build, `scripts/stamp-build-info.ts` writes the deploying commit
   into `src/lib/build-info.ts`, which is compiled into the Worker bundle. The
   committed value is the placeholder `"dev"` and is *expected* to be stale in git.
2. **After** the deploy, `scripts/post-deploy-probe.ts` polls
   `GET /api/smoke/version` (key-authed with `BOOKING_API_KEY`) until the live site
   reports that commit, and only then checks `/api/health` and the availability read
   path for the isolated `SMOKE` bucket.

The order is the point. Checking health without first confirming the new version is
live gets a 200 from the *previous* version during Cloudflare's propagation window,
so a completely broken deploy would report healthy. The probe **does not roll back**:
it fails the job, and a failed job on a push to `main` posts a Slack alert
(`.github/workflows/deploy-alert.yml`), which turns "broken until the scheduled
canary notices, up to 30 minutes" into "broken and someone is told in about a
minute".

A hand-run `pnpm cf:deploy` skips both steps, so the live site will report commit
`dev` and the next CI probe is the first thing to confirm the version again.

## 4. Post-deploy config
- **Offboarding API (optional):** to let the offboarding automation deactivate
  departed users, set `OFFBOARDING_API_KEY` (above), then point the automation at
  `POST https://slate.trypennie.app/api/users/lifecycle` with header
  `Authorization: Bearer <key>` and JSON body
  `{ "email": "person@trypennie.com", "action": "activate" | "deactivate" }`
  (one URL, both directions). The original `/api/users/deactivate` and
  `/api/users/reactivate` (body `{ "email": … }`) still work for callers not yet
  migrated. Deactivate-not-delete (history is kept); idempotent. Unset key ⇒ the
  endpoints return 503 (disabled). Same pattern as `REASSIGN_API_KEY`.
- **Bookable-toggle API (optional):** to let the roster/onboarding automation
  promote an agent into the booking pool (agents synced from Salesforce land
  un-bookable), set `BOOKABLE_API_KEY` (above), then point the automation at
  `POST https://slate.trypennie.app/api/users/bookable` with header
  `Authorization: Bearer <key>` and JSON body
  `{ "email": "person@trypennie.com", "bookable": true | false }`. Idempotent;
  orthogonal to deactivate (this never touches the offboarding state). Activation
  is guarded: if the agent's Google calendar is unreachable, the flip is refused
  with a `409` and a Slack alert fires (the agent stays out of the pool until the
  calendar is fixed). Unset key ⇒ the endpoint returns 503 (disabled).
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
  `https://slate.trypennie.app/api/auth/callback`. (Set Site URL to
  `https://slate.trypennie.app` too.)
- **Google Calendar push (real-time availability):** verify domain ownership of
  `slate.trypennie.app` (or `trypennie.app`) in Google Search Console, then add
  it under the Cloud project's **Domain verification** so `events.watch` accepts
  the push endpoint. Until then, calendar changes still sync — just not in
  real-time (see Cron below).
- The Google OAuth client redirect URI is unchanged (it points at Supabase).
- **http → https redirect (#1024): nothing to configure, it is in the Worker.**
  The public booker collects lead name, email and phone, so a first-time visitor
  arriving on an `http://` link is redirected before the browser sends anything.
  `worker/index.ts` returns a **308** to the https form of the URL
  (`src/lib/http/https-redirect.ts`), so there is no Cloudflare setting to
  maintain and the behavior is versioned, tested and revertible.

  **Do not try to solve this with a Cloudflare Redirect Rule: it cannot work
  here.** `slate.trypennie.app` is attached to the Worker as a **Custom Domain**
  (`custom_domain: true`, `wrangler.jsonc`), and Cloudflare treats a Worker on a
  Custom Domain as the ORIGIN, so zone Redirect Rules are never consulted for it.
  This was established the expensive way: a valid, correctly scoped rule was
  deployed and plaintext requests went straight past it. If you find such a rule
  on the zone, it is dead weight from that attempt and can be deleted.

  The zone-wide **Always Use HTTPS** toggle *would* work, because it is an
  SSL/TLS edge setting applied before the pipeline a Custom Domain bypasses. It
  was rejected on blast radius: the zone carries nine proxied hostnames
  (`automations`, `le`, `main`, `prescreen`, `rml.smartly`,
  `skyfall-offer-wall`, `slate`, `smsassign`, `training`), several of them
  machine-to-machine, and a zone-wide redirect would silently break any that call
  an `http://` address without following redirects.

  Two details that are deliberate rather than incidental. **308, not 301**, so a
  `POST` keeps its method and body: a 301 lets clients rewrite it to `GET` and
  drop the payload, which would turn an integrator's booking call into an empty
  page request. And the guard **passes through anything it cannot positively
  establish as plaintext**, which is the opposite of the usual fail-closed
  instinct, because redirecting an already-secure request loops the browser
  forever.

  Set the repo Actions variable `EXPECT_HTTPS_REDIRECT=1` so the smoke canary's
  every-30-minute live check **pages** on a regression instead of only warning
  (`scripts/lib/https-redirect.ts`).

## Cron
Cron runs entirely on the **main** Worker: `worker/index.ts` `scheduled()`
dispatches each Cloudflare trigger through `worker/cron-routes.ts` to the app's
cron endpoints (`Authorization: Bearer $CRON_SECRET`). Triggers live in
`wrangler.jsonc`; `scripts/test-cron-routes.ts` pins them in lockstep. A single
trigger may drive more than one independent lane (each guards itself with its
own lock). This table mirrors `worker/cron-routes.ts` exactly (the full lane set,
not a subset; `scripts/test-cron-routes.ts` fails CI if any lane below drifts):
- `* * * * *`   → `/api/cron/sync` (backstop calendar sync) **+** `/api/cron/recompute` (bucket_slots freshness) **+** `/api/cron/outbox` (booking-outbox drain, #429) **+** `/api/cron/selfheal` (deletion drain + cancelled/missing reconcile sweeps, #433)
- `*/5 * * * *` → `/api/cron/complete` (mark-complete sweep + webhook retries) **+** `/api/cron/watch` (calendar watch renewal) **+** `/api/cron/monitor` (availability-health probe, #371) **+** `/api/cron/bulk-reassign` (bulk coverage-reassign drain, #973)
- `0 * * * *`   → `/api/cron/agents` (hourly Salesforce roster reconcile + default hours, single locked path)
- `0 13 * * 1-5` **and** `0 14 * * 1-5` → `/api/cron/ooo-digest` (pending-OOO morning digest; the two UTC slots straddle DST and the route's time gate lets exactly one fire at 9am ET)
- `0 11 * * *` **and** `0 12 * * *` → `/api/cron/ooo-approvals` (7am ET email of yesterday's OOO approvals; two DST slots, one fires)
- `0 3 * * *`   → `/api/cron/prune-routing` (daily prune of routing_decisions rows older than 12 months) **+** `/api/cron/prune-webhook-payloads` (blank webhook_deliveries payload PII on terminal deliveries older than 90 days, #1073) **+** `/api/cron/prune-bookings-pii` (redact consumer PII on bookings whose appointment is past the 24-month window, enqueue gcal-event deletion, prune delivered outbox rows, #1071) **+** `/api/cron/prune-busy-blocks` (delete cached gcal busy_blocks whose `ends_at` is more than 36 hours past, #1252; that table had no retention and reached 403k rows / 247 MB while only ~3.6k sat inside the readable window. Past rows only: every reader requires `ends_at > now`, so a finished block is unreadable and can never re-enter a window. NOT mirror-gated, unlike its three neighbours, because busy_blocks is a rebuildable cache rather than a mirrored table. Bounded to 30k rows per run, and the run logs `capped` when prunable rows remain)
- `*/15 * * * *` → `/api/cron/hydrate-calendars` (re-bootstraps a slice of the agent calendars over the cached window, #1261; the batch is DERIVED from the live calendar count so every calendar is refreshed at least once a day at any roster size, rather than a fixed number that is right today and halves the refresh rate as the roster grows. Its own expression, never co-scheduled: the every-minute invocation is the one already short of CPU headroom, and this lane makes a real Google call per calendar. Needed because Google's incremental delta is not scoped to the bootstrap window and delivers an unchanged event exactly once, so without a periodic re-bootstrap a far-future event would be dropped by any window filter and never re-added. Stamps `hydrate-calendars` with a matching bound in `LANE_STALE_BOUNDS_MS`, because this lane going quiet means coverage expiring everywhere)
- `*/10 * * * *` → `/api/cron/snowflake-export` (archival-mirror export to Snowflake, #1099; its own expression so it gets its own CPU budget, resumable via export_cursor, no-op until SNOWFLAKE_PRIVATE_KEY is set)
- `0 */6 * * *` → `/api/cron/snowflake-reconcile` (counts Supabase vs Snowflake per mirrored table + a positive control, Slack-alerts on drift, #1101; the precondition future deletion must pass) **+** `/api/cron/erasure-audit` (reads the pii.erasure audit trail and Slack-alerts if Snowflake still holds contact PII for an erased booking, i.e. the warehouse purge is incomplete, #1103; also executes the purge SQL itself against the warehouse with an id that cannot match, so a statement that stops compiling pages on `snowflake_purge_sql_broken` instead of being discovered during a real deletion request, #1128)

No secret beyond `CRON_SECRET` (already set on the app) is needed — the crons
deploy with the app via `pnpm cf:deploy`. Until the domain is Google-verified,
the watch-registration attempt fails harmlessly (caught); real-time push starts
working once verification is done.

> **One-time teardown (#267):** the old companion **`slate-cron`** Worker
> (`cron-worker/`, now deleted from the repo) double-fired the every-minute and
> 5-minute jobs and was the only place the unlocked `*/15` Salesforce sync ran.
> After deploying the main Worker, retire it once with `wrangler delete slate-cron`.
>
> **Done, confirmed 2026-08-03 (#1200).** `wrangler deployments list --name
> slate-cron` returns `This Worker does not exist on your account [code: 10007]`,
> so the teardown really happened rather than being assumed. Left in place as
> history: it explains why the repo has no `cron-worker/` and why every trigger
> lives on the one Worker. Nothing to do here on a fresh deploy, because a
> rebuild never creates the second Worker in the first place.

## Verify after deploy
1. Hit `https://slate.trypennie.app/api/health` → expect HTTP `200` with
   `{"status":"ok",...}`. A `503` `{"status":"degraded",...}` means the DB is
   unreachable (`db:"unreachable"`) or a cron lane heartbeat is stale
   (`reason:"heartbeat_stale"`, with the offending `staleLane`). This endpoint is
   unauthenticated and safe to point an uptime monitor at.
2. Visit `https://slate.trypennie.app/login` → sign in with Google → land on `/admin`.
3. Configure event type + working hours + bucket `411` + webhook URL.
4. Load `/booking/SF_TEST?xbc=411&...` → book → check calendar invite + webhook.

## External uptime monitoring (noodge, #749)
Slate's internal cron monitor only alerts while the Worker is alive. An external
monitor is what catches a dead Worker, a broken deploy, or a DNS failure. Register
these checks in noodge (https://noodge.trypennie.dev/), all against
`https://slate.trypennie.app`, alerting to the same Slack channel the cron monitor
uses. (Cloudflare's native Health Checks were considered but need a paid plan; the
`trypennie.app` zone is on Free, so noodge is the free choice.)

1. `GET /api/health` expects `200`. Covers liveness, DB reachability, and cron lane
   freshness (a stalled recompute lane surfaces here). Interval: 5 min.
2. `GET /api/health/availability` expects `200`. The availability canary (#749):
   `200` when the booker is genuinely offering times, `503` when a well-staffed tier
   or the whole fleet is silently empty (which check 1 cannot see, the DB is up and
   the crons tick while the booker offers nothing). It is PTO-aware, so a tier that
   is empty only because its agents are all off does not page. Interval: 5 min.
   Because the verdict rides on the status code, noodge needs no body assertion.
3. `GET /widget.js` expects `200` with a JavaScript content type. The embed script;
   if it stops serving, every landing page that embeds Slate loses its booker.
4. `GET /login` expects `200`. Cheap catch for a broken deploy: it proves the
   Next.js page-rendering path serves (not just the API routes). The root `/`
   redirects to `/login` (a `307`), so point the check at `/login` directly rather
   than `/`, or a strict expect-`200` check fails on the redirect.

Alerting: noodge's alert-on-failure default is fine here. These endpoints are
built to return `503` only on a sustained, real condition (a cron lane well past
its bound, a genuinely empty well-staffed tier), not on momentary flicker, so a
first-failure alert will not be noisy, and a server-side debounce could not smooth
a network blip between noodge and Slate anyway (it never reaches the endpoint). If
noodge offers a "retry once before alerting" option, turn it on to trim those
transport blips. Verify each check actually fails when it should: point it at a
deliberately bad path once, confirm the Slack alert fires, then point it back. A
check that can only ever pass is worse than no check.

The availability canary's paging rule (tunable constants in
`src/lib/monitor/availability-canary.ts`): a single broken tier with at least 3
present agents pages on its own; otherwise it pages only when at least 3 staffed
tiers, and at least half of them, are empty at once, or the slot cache is entirely
absent. The horizon is the 4 days of Slate's precomputed slot cache; a stalled
recompute (a stale cache) is caught by check 1, not check 2.

## Rollback
Both the app and its crons run on the single **main** Worker, so a rollback is one
command. Redeploys are versioned by Cloudflare; roll back to the previous good
version when a deploy breaks production.

Find the last-known-good version id:

<!-- runbook-verified: 2026-08-03 (b2d44552) run by an operator against the live Worker on
     wrangler 4.65.0; listed ten uploaded versions with the active one at 100%, so there
     are real rollback targets rather than an empty list. -->

```bash
wrangler deployments list
```

Then roll back to it (omit the id to roll back to the immediately prior version):

<!-- runbook-unverified: re-points production traffic, so it cannot be rehearsed against
     the live Worker. The paragraph below says to dry-run the whole flow deliberately
     before you need it in anger; that rehearsal is the only real proof of this step. -->

```bash
wrangler rollback [<version-id>]
```

`wrangler rollback` re-points traffic to an already-uploaded version; it does not
rebuild. It restores code and bindings only (**it does not revert secrets, `vars`,
or the database**). If a bad deploy shipped alongside a DB migration, roll the code
back first (above), then decide separately whether the schema change is
backward-compatible or also needs reverting (see Backup below). Never roll code
back to a version that predates a migration its predecessor depends on.

Dry-run the flow in a non-prod context before you need it in anger: deploy a
trivial change, `wrangler deployments list`, `wrangler rollback`, then re-hit
`/api/health` to confirm `200`.

## Backup & Point-in-Time Recovery (PITR)
The Postgres database is managed by Supabase (project **`slate`**, ref
`drukfvgaynzrralbzkzj`,
[dashboard](https://supabase.com/dashboard/project/drukfvgaynzrralbzkzj)).

- **Daily backups** are taken automatically by Supabase; restore from
  Dashboard → Database → Backups. Restores are destructive (they replace the
  current database), so take a fresh backup or snapshot first.
- **Point-in-Time Recovery** (add-on, enable under Database → Backups) lets you
  restore to any second within the retention window, which is what you want after
  a bad migration or a data-corrupting write. Enable it before you need it: PITR
  only covers the period after it is turned on.
- **Before any manual migration, backfill, or destructive SQL**, note the current
  UTC timestamp so PITR has a clean restore target, and prefer running changes
  through `supabase db push` (versioned migrations in `supabase/migrations/`) over
  ad-hoc SQL.
- After any restore, re-hit `/api/health` and run the post-deploy verify steps
  above to confirm the app and crons reconnected.

**Recovery objectives: RPO 24 hours, RTO same business day.** PITR is not
enabled, so a restore loses everything written since the most recent nightly
backup. A database-only restore is guaranteed to leave Slate disagreeing with
Google Calendar, with the leads' inboxes and with Regal, because a booking is
four writes and only one of them rolls back. **`docs/dr-runbook.md`** is the
step by step: the restore, the reconciliation order (re-register the push
channels FIRST, they fail silently otherwise), the bookings that have to be
reconstructed by hand, and what to do about the downstream systems that cannot
be rolled back at all. Read it before starting a restore, not during one.

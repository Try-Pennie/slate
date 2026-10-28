# Deploying Slate to Cloudflare (slate.trypennie.app)

The app runs on Cloudflare Workers via `@opennextjs/cloudflare`. Run these in a
**real Terminal** (not the `!` prefix — wrangler needs a TTY for login + secret
prompts, so values never land in a transcript).

## Prerequisites
- The canonical production host is **`slate.trypennie.app`**, and it is the only
  one: `wrangler.jsonc`'s `routes` bind that single host as a `custom_domain`, which
  auto-creates the DNS record and the TLS cert. Its apex zone must exist in the
  target Cloudflare account; if it is not there, add it to Cloudflare first, or drop
  the `routes` entry and bind the domain in the dashboard later.
- The checkout you deploy from holds **no** `.env*` file. `pnpm cf:deploy` builds
  through `pnpm cf:build`, which refuses a bundle carrying the values of any `.env`
  file in the tree (#2335, #3078), because the adapter would ship them inside the
  Worker. Deploy from a clean worktree, and pass the `NEXT_PUBLIC_*` build values in
  the shell environment (2a), as the CI deploy job does.

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

### 2a. Build-time public values (the build's environment, inlined into the client bundle)
Set these in the environment of `pnpm run cf:deploy`: they are baked in at build,
not read at runtime. Not in `.env.local`: a deploy from a tree holding any `.env*`
file is refused, since every value in it would ship inside the Worker (#3078).
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
# wrangler secret put CRON_SECRET_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put GOOGLE_CHANNEL_TOKEN    # required; signs/verifies Google calendar push pings. Unset = real-time push verification fails.
# wrangler secret put GOOGLE_CHANNEL_TOKEN_PREVIOUS # optional; the token a rotation REPLACED, accepted on pushes from channels registered before it (#3110). Set only during a rotation, then deleted; see "Rotating a credential".
wrangler secret put MAIN_OOO_CAL_ID         # required; the OOO approval calendar + default impersonation actor for manager-calendar writes. Unset = OOO approval throws.
wrangler secret put SLACK_BOT_TOKEN         # optional; ops alerts + OOO DMs/digest. Empty = Slack is a no-op.
wrangler secret put SLACK_ALERTS_CHANNEL    # optional; default alert channel id. Empty = alerts have nowhere to post. (Channel id, not sensitive; may live in wrangler.jsonc vars instead.)
wrangler secret put SLACK_INFO_CHANNEL      # optional; quieter info-only channel (#567). Empty = falls back to SLACK_ALERTS_CHANNEL.
wrangler secret put SLACK_SIGNING_SECRET    # optional; verifies inbound Slack Approve/Decline requests. Empty = /api/slack/interactions rejects everything.
wrangler secret put CALCOM_API_KEY          # optional; cal.com dual-write during cutover (needs OOO_CALCOM_DUAL_WRITE). Empty = dual-write no-op.
wrangler secret put TWILIO_API_KEY_SID      # required; TaskRouter-scoped API key SID. The hourly roster sync reads Twilio for the Redistribute tag (#2097). Empty (any of the three) = the Twilio half REFUSES by name and pages on twilio_sync_failures from the second consecutive hourly run (#2774); nobody is taken out of the bookable pool for the tag.
wrangler secret put TWILIO_API_KEY_SECRET   # required; the matching API key secret.
wrangler secret put TWILIO_WORKSPACE_SID    # required; the TaskRouter workspace holding the workers. Not really a secret, but set here so all three live in one place rather than split with wrangler.jsonc.
wrangler secret put AUTOMATIONS_API_URL     # optional; Pennie's automations service, the same address trypennie.com uses, asked for the texting line the inline card's Call me now confirmation offers (#3718). Unset, the card shows no Text us and no error.
wrangler secret put SENDBLUE_API_KEY_ID     # optional; Sendblue's API key id, used only to ask whether a lead's saved texting line is still alive (#3718). Unset, a saved line is always kept.
wrangler secret put SENDBLUE_API_SECRET_KEY # optional; the secret paired with SENDBLUE_API_KEY_ID. Both or neither.
wrangler secret put REASSIGN_API_KEY        # optional; bearer for the reassign API. Empty = POST /api/bookings/reassign returns 503.
# wrangler secret put REASSIGN_API_KEY_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put DUPLICATE_CANCEL_API_KEY # optional; bearer for the duplicate-cancel API (#2369). Empty = POST /api/bookings/cancel-duplicate returns 503.
# wrangler secret put DUPLICATE_CANCEL_API_KEY_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put OFFBOARDING_API_KEY     # optional; bearer for deactivate/reactivate. Empty = offboarding endpoints return 503.
# wrangler secret put OFFBOARDING_API_KEY_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put BOOKABLE_API_KEY        # optional; bearer for the bookable-toggle API. Empty = POST /api/users/bookable returns 503.
# wrangler secret put BOOKABLE_API_KEY_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put REGAL_INBOUND_KEY       # optional; bearer Regal's reporting webhook sends to POST /api/regal/calls (#2090). Its own secret, never the outbound Regal key. Empty = that endpoint returns 503 naming it.
# wrangler secret put REGAL_INBOUND_KEY_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put REGAL_WEBHOOK_KEY       # the OUTBOUND Regal API key, sent as the Authorization header on every Regal webhook delivery (#3091). Moved out of webhook_endpoints.auth_header so only the Worker can read it; the admin webhooks page shows whether it is set and cannot edit it, so changing it is this command. The column was nulled by migration 0163 and is never read. Empty = every Regal delivery is refused and recorded as failed (#600), and the dead letter alert pages. Never the same value as REGAL_INBOUND_KEY.
wrangler secret put WEBHOOK_SIGNING_SECRET  # the HMAC secret a generic format endpoint's x-slate-signature is made with (#3091). Moved out of webhook_endpoints.secret like the key above, and nulled by 0163 and never read. NOT SET today, on purpose: the only endpoint is Regal format, which never signs. Empty = generic deliveries are refused rather than sent unsigned. Rotating it means telling the subscriber the new value in the same change.
wrangler secret put BOOKING_API_KEY_REGAL   # optional; Regal's own booking API key (its journeys cancel through it, as the SLATE_BOOKING_API_KEY brand secret). Logs and the rate ceiling name the caller "regal". One key per caller (#2645): the shared BOOKING_API_KEY pair is retired and read by nothing (#2865). Every booking key empty = POST /api/bookings returns 503.
# wrangler secret put BOOKING_API_KEY_REGAL_2   # optional; Regal's rotation slot, set only when rotating.
wrangler secret put BOOKING_API_KEY_TRYPENNIE # optional; trypennie's own booking API key (the booking confirmed page's lookup, #2643).
wrangler secret put BOOKING_API_KEY_TRYPENNIE_2 # trypennie's rotation slot. SET since 2026-09-28 (#2865): it holds the value trypennie's Vercel SLATE_BOOKING_API_KEY was given, the old shared key, kept rather than rotated so trypennie changes nothing.
wrangler secret put BOOKING_API_KEY_CANARY  # required for the smoke canary (#2822); its own key, recorded as "canary". The GitHub repo secret of the SAME NAME must hold the SAME value: every canary lane, the deploy probe and every heartbeat stamp send it, and a value the Worker does not hold fails them with a 401 and an alert. Empty here = every canary lane fails loudly.
# wrangler secret put BOOKING_API_KEY_CANARY_2  # optional; the canary's rotation slot, set only when rotating.
wrangler secret put BOOKING_API_KEY_MARCIA  # optional; Marcia's own booking API key (#2940), held by the Marcia 5.0 Pipedream workflow as its slate_api_key step prop. It opens POST /api/bookings/cancel (and its DELETE twin) and NOTHING else: every other route refuses it 401. Logs and the rate ceiling name the caller "marcia". Empty = Marcia's cancels are refused 401 and no other caller is affected.
# wrangler secret put BOOKING_API_KEY_MARCIA_2  # optional; Marcia's rotation slot, set only when rotating.
# wrangler secret put MARCIA_TOKEN_KEY_A  # optional; SET 2026-10-20 (#3541): the secret Marcia signs her HS256 lead tokens with, shared with Marcia's signer and held by no other Worker. At least 32 characters; the public fixture key in src/lib/mcp-booking/machine-token-fixtures.json is refused as a key. Empty in both slots = every lead token is refused (token_keys_unconfigured) and each refusal pages marcia_token_refused:token_keys_unconfigured.
# wrangler secret put MARCIA_TOKEN_KEY_B  # optional, not set: the rotation slot. Rotate by filling the empty slot, moving Marcia's signer to it, then emptying the old one; either slot verifies.
# openssl rand -hex 32 | wrangler secret put MCP_BOOKING_GATEWAY_SECRET  # optional; SET 2026-10-20 (#3541): the secret McpBookingGateway puts on its in process request to /api/internal/mcp-booking/*, which that route compares before anything else. Never leaves this Worker. Empty = the gateway hands each Marcia call on with no secret, and the route refuses it (gateway_unconfigured) and pages marcia_gateway_refused.
# wrangler secret put BOOKING_API_RETIRED_KEY_HASHES # optional, and NOT SET today (#2879): hashes of RETIRED booking keys, never the keys, as label:sha256:<hash> entries, comma separated (an entry without the sha256: part is refused as unreadable, so a raw key pasted by mistake is caught). A refused request presenting one pages retired_booking_key naming its host and route. Empty = inert. Nothing is retired yet: the old shared key's value is still LIVE as BOOKING_API_KEY_TRYPENNIE_2, and a key in a live slot authenticates, so its hash would never fire (the hash command and the Worker both refuse one). Arm it at the NEXT rotation, once the old value is out of its slot: put it in .env.local as RETIRED_BOOKING_API_KEY, run `pnpm -s hash:retired-key <label> | npx wrangler secret put BOOKING_API_RETIRED_KEY_HASHES`, and once that succeeds run `pnpm -s hash:retired-key --record <label>`, commit docs/retired-booking-key-hashes.txt, then delete the .env.local line. The secret is REPLACED whole and cannot be read back, so the first step prints the whole list from that committed file (hashes, not keys) plus the new entry and writes nothing, and the second adds the entry to the file. A failed put is simply run again, both steps are safe to repeat for the same key, and a missing list file is refused rather than read as empty.
openssl rand -hex 32 | wrangler secret put EMBED_TEST_PASS_SECRET  # required for partner testing (#2666); signs the short lived pass /book hands a page on an EMBED_TEST_ORIGINS website. Piped so the value never appears. Empty = the public test bucket is OFF: /book says so, the routes answer 403 TEST_PASS_OFF, and the canary's gate read pages. Rotating it ends every open test page's pass (a reload fixes it).
wrangler secret put GITHUB_CANARY_TOKEN     # optional; fine-grained GitHub token (Actions read/write on Try-Pennie/slate) so the monitor lane can re-fire the smoke-canary workflow when GitHub drops a scheduled run. Empty = gap-filler is a no-op (GitHub's schedule alone runs the canary).
wrangler secret put UPTIME_HEARTBEAT_KEY    # required; the bearer noodge sends on its /api/health and /api/health/availability checks (#1228), so each stamps its own uptime heartbeat. The same value is SLATE_UPTIME_HEARTBEAT_KEY when noodge applies monitors/slate.sql. Empty = the endpoints never stamp, so both uptime heartbeats go stale and the lane watchdog pages every hour; the health answers themselves are unaffected.
# wrangler secret put UPTIME_HEARTBEAT_KEY_2 # optional; the rotation slot (#3110), set only when rotating. See "Rotating a credential".
wrangler secret put SNOWFLAKE_PRIVATE_KEY   # optional; RSA private key (PKCS#8 PEM) for the Snowflake archival mirror export lane. Empty = the export lane is a safe no-op (logs "not configured" and skips). See docs/snowflake-setup.md.
pbpaste | npx wrangler secret put CF_ANALYTICS_TOKEN  # optional; a Cloudflare ACCOUNT API token on the whole Pennie account carrying the Workers role Metadata Read-only (Developer Platform, Workers), which is all the check needs (#3141; added on 2026-10-18 when the check moved to the Worker logs, and the dashboard's name since 2026-09-15 for what was Workers Observability Read). The existing token also still holds Account Analytics Read from before the move, which nothing reads any more. Dan holds it (create it under Manage Account, Account API Tokens, Custom token), copy it, then run this line so it never appears on screen. The hourly cron CPU check reads every scheduled invocation's CPU time from the Worker logs with it and pages cron_budget_headroom when a schedule passes half limits.cpu_ms. Empty = cron CPU is not watched at all: a daily cron_cpu_not_configured info line says so, nothing pages, and an open cron_budget_headroom page stays open. A token that is revoked or expires reads as unmeasured, and verdict:cron-budget goes stale and pages after 6 hours.
```

**Which of these are actually set (measured 2026-08-03, #1200).** A
`wrangler secret list` against the live Worker returned 20 secrets. Every name in
this file is either set or deliberately not, and nothing is set that this file
does not document. The three not set:

1. `BOOKING_API_KEY_2` was correctly absent then, and the shared pair it belonged to
   is retired now (#2865).
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
  `trypennie.com`). It fails CLOSED (#3083): unset or empty refuses every sign-in
  with "Sign in is unavailable right now", rather than letting any Google account
  in. Allowing any account takes an explicit `ALLOW_ANY_GOOGLE_DOMAIN=1`, which
  production must never carry; `scripts/test-hosted-domain-required.ts` pins both
  for every environment in `wrangler.jsonc`. Its build-time
  `NEXT_PUBLIC_GOOGLE_HOSTED_DOMAIN` twin is set in 2a.
- `SLATE_DEV_PREVIEW`: never set in a deployment. It is a local `.env.local`
  opt-in for `/dev/preview`, which acts as any user with no sign-in, and is only
  honoured under `pnpm dev` (NODE_ENV `development`) on a loopback host (#3086).
- `SLATE_DESIGN_FIXTURES`: never set in a deployment. The e2e run (`e2e/env.ts`) sets it so
  `/admin/team-capacity?frame=<id>` renders a frame of the settled design from its fixture, for
  the design match score (#3936). Honoured only on a loopback host, so even a deployment that
  carried it would never serve the invented numbers.
- `AGENT_SCHEDULING_LIVE`: launch flag over the CONSOLE. `"false"` = only super
  admins reach `/admin`; `"true"` opens it to the managers and admins whose roles
  already allow it. The committed production value is `"true"` (changed 2026-10-02), pinned by
  `scripts/test-console-open.ts`. It does NOT gate an agent's own hours: `/me` (My Availability)
  and `/me/time-off` are unconditional, since 2026-09-08. It used to hide both,
  which left the working hours form built and unreachable for 112 agents.
- `OOO_CALENDAR_ACTOR_EMAIL` (optional): impersonation actor for OOO calendar writes.
  Unset = defaults to `MAIN_OOO_CAL_ID`.
- `DIRECTORY_ADMIN_SUBJECT` (#3027): the Google Workspace account the advisor photo
  refresh reads the directory as, through the service account's domain wide
  delegation (scope `admin.directory.user.readonly`). It must hold an admin role:
  as an agent, `photos.get` answers 403. A committed wrangler var, not a secret.
  Missing or blank, the lane refuses by name and pages `advisor_photos_unread`.
- `SHARED_CONFIRM_LINE_DEFAULT` (#3325): whether the shared confirm line is on in an
  isolate that has not yet managed to read the stored switch
  (`booking_settings.shared_confirm_line`, flipped on the admin Hours page with no
  deploy). It only matters on a cold isolate whose read failed: a failed read is never
  cached, the isolate answers this default and reads again five seconds later, and a
  run of three failed reads inside a minute on one isolate pages
  `shared_line_switch_unreadable` naming this default's value (#3339). Exactly
  `"on"` or `"off"`; anything else, or unset, is read as off and logged once per
  isolate. Production commits `"on"` since #3339, so a cold isolate that cannot read
  the switch takes the shared line; the stored switch still decides for every isolate
  that has read it. `env.loadtest` commits `"on"` too, held there whatever production
  says, and `scripts/test-wrangler-loadtest-env.ts` pins both.
- `OOO_APPROVALS_TO` / `OOO_APPROVALS_BCC` / `OOO_APPROVALS_REPLY_TO`: recipients of
  the daily OOO-approvals digest email. Empty `TO` = the digest no-ops.
- `EMBED_TEST_ORIGINS` (#2666): the websites allowed to open the public test bucket,
  as a comma list of exact origins (`https://host`, no path, no trailing slash).
  Today `https://dev.trypennie.com,https://trypennie.com`. `/book` compares the
  iframe request's Referer origin against it with exact equality and, on a match,
  hands the Booker a pass signed with `EMBED_TEST_PASS_SECRET` (2b). **The Referer
  check is a convenience gate, not authentication**: anything that is not a
  browser can send any Referer, so it keeps the test path off websites nobody
  approved rather than proving who is asking. Never add `localhost`: that would
  approve every developer machine. Empty = the test path is OFF and `/book` says
  so. `scripts/test-embed-test-pass.ts` refuses an entry that is not exactly an
  https origin, or that names a developer machine.
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

Production is deployed by CI on every merge to `main`, gradually (#3095, below). By
hand, the build and an instant deploy to 100% is:

<!-- runbook-verified: 2026-08-03 (e753ab99) this exact command was what CI ran on every
     push to main until the gradual deploy replaced it on 2026-10-03 (#3095), so it was
     executed several times a week against the real target. Most recent success under CI
     2026-08-03 for PR #1221, followed by a green post-deploy probe. It remains the hand
     path, and the only path for a release that changes a Durable Object class. -->

```bash
pnpm run cf:deploy   # build + deploy (NOT `pnpm deploy` — that's a pnpm builtin)
```

It goes to 100% of traffic at once with no probe. Prefer `pnpm cf:deploy:verified`
(below), which at least confirms what went live.

### `pnpm cf:build` refuses a bundle carrying your `.env` files (#2335)

The Cloudflare adapter reads every `.env*` file in the build tree and writes their
VALUES into `.open-next/cloudflare/next-env.mjs`, which ships inside the Worker
bundle; at runtime the wrapper fills in every name the Worker's own bindings did
not set. So a build run in a checkout holding `.env.local` deploys those
credentials, to whatever environment it is deployed to. On 2026-09-14 that put
production's Slack token on the load test Worker and paged the real alerts channel
for six minutes about a roster that did not exist.

`cf:build` now runs `scripts/check-bundle-env.ts` after the build and fails on any
name in that file that is not `NEXT_PUBLIC_*`, naming the offenders and the `.env`
file they came from, never their values. Wrangler has no predeploy hook, so it guards
only a deploy that builds through `cf:build`; `cf:deploy` did not until #3078, and
`scripts/test-bundle-env-guard.ts` now fails any package.json script that deploys
without it. CI and the pre-push gate build from the committed tree, which holds no
`.env*`; **a build in your own checkout is the case this fails**, so a hand deploy
passes `NEXT_PUBLIC_*` in the shell environment (section 2a above).
`ALLOW_ENV_IN_BUNDLE=1` lets one local build through, never one to deploy.

It asks a SECOND question in the same step: whether the CLIENT chunks NAME any
deployment setting. That is not the same fault (a name is not a credential; what
leaks is the inventory of what Slate integrates with) and only a real build can
answer it, since the names are in the source either way and nothing but the build
says which bundle a module landed in. It exists because the first version of the
#2335 runtime refusal put the whole list into `publicSupabaseUrl()`, and all
twenty three names shipped in a public chunk.

The decisions are in `scripts/lib/scan-bundle-env.ts`, driven by fixtures in
`scripts/test-bundle-env-guard.ts` (which deliberately does not read the real
`.open-next`: the gate runs the suite alongside the build that writes it, L461).
The load run's own three layers are in `scripts/loadtest/RUNBOOK.md`.

**`pnpm cf:preview` refuses to start in a checkout holding any `.env*` file (other
than the committed `.env.example`) or `.dev.vars*` file (#3694).** It builds without
the bundle check above and runs the Worker locally on the Workers runtime, which
`mayWriteAlerts` treats as production, and wrangler also loads `.dev.vars`. In the
main checkout that would send any alert it raised to the real Slack channel and
write production's alert state. `scripts/cf-preview-guard.ts` runs first and names
the files it found; run the preview from a git worktree. The rule for which files
count is shared with the browser checks runner (`scripts/lib/live-env-files.ts`).

Moved out of `AGENTS.md` on 2026-10-15, where every character was loaded into
every session (#2393). `AGENTS.md` keeps the rule and points here; this is the
full text as it stood, with the reasoning, the incidents and the measurements
behind it.

### What CI does: a gradual deploy (#3095)
The `deploy` job in `.github/workflows/ci.yml` does not deploy straight to 100%. Dan
decided the shape on 2026-10-03: upload the new version, send 10% of real traffic to it,
probe it, then promote it to 100% if the probes pass, or leave the old version serving and
page if they fail. In order:

1. **Stamp.** `scripts/stamp-build-info.ts` writes the deploying commit into
   `src/lib/build-info.ts`, which is compiled into the bundle (#1037). The committed
   value is the placeholder `"dev"` and is *expected* to be stale in git.
2. **Build.** `pnpm cf:build`, which carries the bundle env guard (#3078).
3. **Read what is serving** (`wrangler deployments status`). It must be one version at
   100%; that version is what every failure restores. A split left behind by a run that
   died is settled on its larger share first.
4. **Upload the build twice** (`opennextjs-cloudflare upload`, which is `wrangler versions
   upload`): a **canary** carrying `SLATE_CRON_STANDBY=1`, and the **release**, the same
   build without it. Both are tagged with the commit (the rollback reads the tag).
   Uploading changes nothing anybody is served.
5. **Wait for a clear cron window** (see "What the split looks like").
6. **Split**: `wrangler versions deploy <canary>@10% <old>@90%`.
7. **Probe the canary** through `Cloudflare-Workers-Version-Overrides: slate="<canary id>"`
   on every request, with the post-deploy probe (#1037): it polls `/api/smoke/version`
   until the canary's commit answers **five times in a row**, then judges `/api/health`
   and the availability read for the `SMOKE` bucket. Five in a row because an override
   Cloudflare does not apply is silently routed by the split, and at 10% one matching
   answer proves nothing.
8. **Promote the release** to 100% (`wrangler versions deploy <release>@100%`), and probe
   again, without the override, five in a row.
9. **Apply the cron triggers** (`wrangler triggers deploy`). Triggers are not part of a
   version, so `versions upload` and `versions deploy` never touch them; this is what a
   plain `wrangler deploy` used to do implicitly. Only after the promotion probe, so a
   restore never leaves new triggers driving old code.
10. **Deploy the log tail worker** (`slate-log-tail`, #3160) whole: `wrangler deploy -c
   wrangler.log-tail.jsonc`. It is not split. It goes LAST because it binds to an
   entrypoint of Slate's (`LogShippingReceipt`, through a service binding, #3191), which
   has to be serving 100% before the tail worker that calls it is deployed. A change to
   its redaction (`src/lib/log-shipping/`, `src/lib/api/client-error-scrub.ts`) ships
   with the merge. If it fails (exit 23), Slate is NOT rolled back: it has already
   passed its probes, and the tail worker deploy is safe to re-run. It is never deployed
   when Slate did not reach a healthy 100%.

Every failure path ends at **100% old or 100% new, decided explicitly**, before the step
exits, and the exit code says which (`EXIT` in `scripts/lib/gradual-deploy.ts`, pinned by
`scripts/test-gradual-deploy.ts`, which drives every combination of outcomes):

| exit | what happened | production ends on |
|---|---|---|
| 0 | passed at 10% and at 100% | new |
| 10 | could not read what is serving, the cron schedule, or the canary key | unchanged |
| 11 | an upload failed for a reason the run cannot name (a Durable Object class change wrangler did not report as one reads like this too) | unchanged |
| 12 | the split call failed | old (restored) |
| 13 | **the canary failed its probe at 10%** | old (restored) |
| 14 | the promotion call failed | old (restored) |
| 15 | the release failed its probe at 100% | old (restored) |
| 16 | promoted, and health reports a stale cron lane | new |
| 17 | promoted, and `wrangler triggers deploy` failed (safe to re-run) | new |
| 18 | an error was thrown after the split opened | old (restored) |
| 19 | an error was thrown before the split opened (an upload, the cron window, a read); caught by the run | unchanged |
| 20 | **a restore failed 3 times: production may still be split** | unknown: run the Rollback workflow |
| 21 | a split left by an earlier run is led by a cron standby canary, or its larger share cannot be read | unchanged: end the split by hand |
| 22 | production was changed by something else mid-run (a rollback, a hand deploy); this run stopped and touched nothing more | unknown: whatever that change left, which this run does not undo |
| 23 | promoted and healthy, and the log tail worker (`slate-log-tail`) could not be deployed after it; Slate is not rolled back | new |
| 24 | the deploy script itself failed outside its own handling | unknown: the settle step reads what the run recorded |
| 25 | the release changes a Durable Object class, which Cloudflare refuses to upload as a version (#3352); ship it by hand, and until then every later deploy ends here too | unchanged |
| 26 | an object worker (`slate-confirm-line`, #3500, `slate-burst-limiter`, #3555, or `slate-token-holder`, #3512) could not be deployed; Slate's bindings name them, so nothing of Slate's was uploaded. Only a Worker that changed is deployed (#3561), so this fires only on a deploy that needed one. The message names the config and why; deploy them with `node --experimental-strip-types scripts/deploy-object-workers.ts` and re-run | unchanged |
| 27 | the confirm line build speaks an older `CONFIRM_LINE_PROTOCOL` than the app serving now (#3560), so deploying it would put a line object older than the app in front of it, where a crowd books one advisor or none. Nothing was deployed. Read from the built bundle and from the source at the serving app's commit tag. For a revert that lowers the protocol on purpose, deploy the app alone first (`pnpm cf:deploy`), then re-run | unchanged |

Any non-zero exit fails the job, and a failed job on a push to `main` posts a Slack alert
(`.github/workflows/deploy-alert.yml`). A job cancelled or timed out mid-run cannot end the
split itself, so its last step, `deploy-gradual.ts --settle` (`if: failure() ||
cancelled()`), reads what is serving and puts a leftover split's larger share, the old
version, back at 100%.

**A deploy and a rollback never wait for each other, and neither is ever dropped.** GitHub
keeps only one PENDING run per concurrency group and cancels the older pending one with no
alert, so a group shared by the two would let a merge silently drop an emergency rollback
queued behind a running deploy, or the reverse. Instead:

- The Rollback workflow has a group of its own per run, so it starts at once, every time.
  Cloudflare can roll back from a split, so it never needs the deploy to finish.
- The deploy re-reads what is serving before opening the split, before promoting, and
  before every restore. If production is no longer a state this run produced, it stops
  and leaves it exactly as it is (exit 22), so a rollback that landed mid-deploy stands.
  The window left is the seconds between that read and the call; a rollback that loses
  that race is overwritten by the promotion, and its own probe then fails and pages.
- Deploys themselves stay serialised by the workflow's group on `main`. A pending main
  run superseded by a newer merge never deploys, which drops nothing: `main` is linear, so
  the newer commit contains it, and its own deploy pages if it fails.

**A stale cron lane is not the release's fault.** Health answers 503 when a lane heartbeat
is stale, which is read from the shared database and reads the same from either version.
Restoring the old version would change nothing, and refusing to ship would block the fix
for that very lane (the canary runs no lanes). So a stale lane alone neither holds back the
canary nor restores the old version; at 100% it fails the job (exit 16) so somebody looks.
Every other probe failure is the release's.

### What the split looks like
For the length of the canary probe (about 30 seconds when healthy, at most about six
minutes), production is a deployment of two versions: the canary at 10% and the version
that was serving at 90%. Each request is routed independently by those percentages, so a
lead can meet both versions across page loads. Then it is one version at 100% again.

- **Cron lanes run only on the old version.** Cloudflare does not document which version a
  scheduled event is handed to while two serve, so nothing relies on it: the canary's
  `scheduled()` sees `SLATE_CRON_STANDBY=1` and runs no lane (`worker/cron-standby.ts`),
  so nothing runs twice and unproven code never runs a lane. A tick handed to the canary is
  dropped, which is why the split only opens when no hourly or daily cron instant falls
  inside it (the deploy waits, at most 12.5 minutes): only the every 1, 5, 10 and 15 minute
  lanes can lose a tick, and their next tick catches up. The release, promoted at the end,
  is the same build without the standby variable.
- **Durable Objects** (`BURST_LIMITER`): Cloudflare assigns each object ONE version per
  deployment by the same percentages, so about one in ten burst counters runs the canary's
  `BurstLimiter` for the split, whichever version called it. An object is reset once when
  its version changes; the count lives in storage, so nothing is lost. Keep the
  BurstLimiter request shape compatible across one release, because old Worker code can
  call a new object and the other way round. A change to a Durable Object CLASS (a
  `migrations` entry) cannot ship gradually at all: the upload refuses (exit 25, nothing
  changed, recognised from the `command-failed` record wrangler writes), and that release
  ships by hand with `pnpm cf:deploy:verified`. Until it does, every later merge's deploy
  stops at exit 25 too, so it is planned at PR time (#3352): the
  `do-migration-plan` workflow fails a pull request that adds a top level `migrations`
  entry unless it carries the `deploy/hand` label, which says its merge is planned with
  the hand deploy. Merge it, then run the hand deploy straight away. It also refuses, with
  no label able to pass it, a pull request that edits or removes an existing `migrations`
  entry: Cloudflare never applies a tag twice, so the change belongs in a new tag.
- **The token holder** (`TOKEN_HOLDER`, #3512) is a class of its own small Worker
  (`slate-token-holder`), never Slate's, so it adds no `migrations` entry to
  `wrangler.jsonc` and ships through this pipeline: its Worker is deployed whole before
  the uploads, from `OBJECT_WORKER_CONFIGS`, whenever its bundle or config changed (next
  bullet), and its own `v1` migration is applied by that plain `wrangler deploy`. It holds tokens in memory only, so every deploy of its Worker
  empties it; the next reads of each advisor mint as they did before the holder existed
  and put the token back, which costs a few mints after a deploy and fails nothing. It
  holds no secret: it never mints.
- **An object Worker is deployed only when it changed** (#3561). A Worker deploy restarts
  its Durable Objects, which drops whatever a line object holds in memory (a crowd's
  waiting turns) and empties the token holder, so redeploying all three on every Slate
  deploy undid most of what moving them out of Slate's Worker bought.
  `scripts/deploy-object-workers.ts` (and the gradual deploy, in process, through the same
  code) builds each bundle with `wrangler deploy --dry-run`, hashes it with the wrangler
  config text, the environment and the wrangler version, and skips the Worker only when
  the version serving carries that exact hash as its message (`object-bundle sha256:...`),
  which every deploy it makes writes. Anything else deploys: a bundle that would not
  build, a deployment it could not read, a split, a version with no stamp (one deployed by
  hand with plain `wrangler deploy -c`, one made by a secret change, anything from before
  #3561), a different hash. The run log says, per Worker, `skipped` or `deploying` and
  why, and after each stamped deploy whether the stamp read back from the serving version
  (`stamp confirmed`, or `the next deploy will redeploy it`): the skip depends on
  Cloudflare keeping the message, which nothing offline can prove, so the first deploy
  after #3561 should say `stamp confirmed` three times and the one after it `skipped` for
  any Worker it did not change. A hand deploy of an object Worker should go through that script too, or the next
  pipeline deploy redeploys it once to stamp it. The decision is driven offline by
  `scripts/test-object-worker-skip.ts`.
- **A confirm line build older than the live app is refused** (#3560, exit 27, and exit 3
  from `scripts/deploy-object-workers.ts`). A line object refuses a client newer than
  itself, and the app then uses its isolate's own line, where a crowd for one slot books
  one advisor or none. Every pipeline deploy makes the safe order (the line first, at the
  same commit as the app that follows), so this only fires on a line only rollback or a
  revert that lowers `CONFIRM_LINE_PROTOCOL`. It compares the protocol declared in the
  built bundle (`var CONFIRM_LINE_PROTOCOL = N;`) with the one in
  `src/lib/booking/confirm-line-object.ts` at the serving app's commit tag, fetched if
  the checkout lacks it. The tag is a 12 character abbreviation and a git server only
  fetches a full commit id, so in CI's one commit checkout an abbreviated tag unshallows
  the checkout and resolves it locally (#3854: until then the fetch failed on every
  deploy and the check never ran). A run that compared says `the line build speaks
  protocol N, the live app protocol M` in the deploy step's log. It is asked on EVERY
  deploy, not only one that changes the line: an unchanged line logs `object worker
  wrangler.confirm-line.jsonc: unchanged, the line build speaks protocol N, the live app
  protocol M` and refuses nothing (#3854: asked only on a line change, the read ran on
  one deploy in thirty and had never once succeeded in CI, so a broken read would show
  only when the refusal was needed; asking every time costs two wrangler reads and one
  fetch, about 3 seconds for the unshallow measured on 2026-10-18). If either side cannot
  be read, the line is deployed anyway, the log says the check could not be made and why,
  and the job carries a `confirm line protocol not checked` warning annotation and a
  **Warning** line in its summary saying the same (for an unchanged line, that it could
  not be compared and nothing went out unchecked), so a check skipped on every deploy is
  seen: an untagged app version is
  ordinary (every secret change makes one), so refusing on it would stop normal deploys,
  and #3560's client already falls back and pages `confirm_line_unreachable` in that
  order. For a deliberate protocol lowering, deploy the app alone first
  (`pnpm cf:deploy`), then re-run.
- **Cost.** Two uploads, a split and a second probe add roughly a minute to each deploy,
  plus the cron window wait when a merge lands just before the hour (about one deploy in
  ten). At the 530 deploys of the 30 days to 2026-10-03, that is an estimated 500 to 600
  extra billed minutes a month on the standard Linux runner, not yet measured.
- **Rehearsal.** Not yet run against a real deployment; see "Rehearsing on the load test
  Worker" under Rollback.

### The test buckets are seeded by hand, after the deploy (#396, #2660)

Deploys create no rows. The canary's hidden `SMOKE` and `SMOKE2` buckets and the
PUBLIC `PARTNER` bucket a partner tests the embed with (#2660) all come from
`scripts/seed-smoke-test.ts`, run from a checkout holding `.env.local`. The order
matters, because until the seed has run and the recompute has published its
slots, `PARTNER` answers the same 404 a typo does:

1. Merge and deploy as usual.
2. **A few minutes past the hour or half hour**, never on one (the canary fires
   at :00 and :30 and the seed rewrites the smoke agents' working hours in
   place), write the rows:

   <!-- runbook-verified: 2026-09-24 (a117b686) run against the live project a few minutes past the half hour, once the 16:00Z canary tick had completed; exit 0, printed Done with smoketest@ seeded into SMOKE, SMOKE2 and PARTNER; the keyless availability read for PARTNER answered 200 with 175 times and SMOKE still 404. -->

   ```
   APPLY=1 node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/seed-smoke-test.ts
   ```

3. Wait one recompute cycle (about a minute), then MEASURE rather than assume:

   <!-- runbook-verified: 2026-09-24 (bfff44b0) run against the live project after the #2660 merge: before the seed it measured SMOKE and SMOKE2 ready and PARTNER no-bucket and exited non zero writing nothing; one recompute cycle after APPLY=1 it reported all three ready (PARTNER slots published 16:04:37Z) and exited 0. -->

   ```
   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/seed-smoke-test.ts
   ```

   It writes nothing and exits 0 only when every test bucket exists, is flagged
   `is_test`, has a member and has published slots. Any other state exits on its
   own code (2 no row, 3 no member, 4 not published yet, 5 not flagged) and says
   what to do. From then on the canary's 30 minute tick reads
   `GET /api/availability?bucket=PARTNER` twice: with its own key, paging if it
   stops being served, and with no key and no pass, paging if it is not refused
   for want of a pass (#2666). The second read is also what notices a deployment
   missing `EMBED_TEST_PASS_SECRET`.

4. Make one booking through the embed from a host page on a website listed in
   `EMBED_TEST_ORIGINS` (2c; any other website is refused, by design) with a test address, and
   confirm the redirect, the confirmed page, the invite, the "Test" mark in the
   admin lookup, and that `webhook_deliveries` reads suppressed for it. Only then
   tell the partner it is ready.

### Deploying by hand, verified (#1190)

`pnpm cf:deploy` on its own skips the stamp and the probe, so the live site reports
commit `dev` and the next CI deploy is the first thing to confirm a version again. The
occasion for a hand deploy is an urgent fix when the pipeline is unavailable or too slow,
or a release that changes a Durable Object class (which cannot ship gradually, and whose
pull request carries the `deploy/hand` label, #3352), which is exactly when an unverified
release is most expensive, so use:

<!-- runbook-unverified: it deploys production, so running it to prove the command
     would ship whatever happened to be checked out. What IS proven offline is every
     decision it makes before deploying, and that it drives CI's own two scripts in
     CI's own order rather than a second implementation:
     scripts/test-deploy-verified.ts. The deploy and probe SCRIPTS are the ones the
     deploy job runs several times a week, but CI hands the probe its commit through
     GITHUB_SHA and this command must hand it PROBE_COMMIT itself. Its first real run
     (2026-10-05, #3344's Durable Object class) deployed correctly and then its probe
     refused, because it was never told the commit (#3363). The plan now hands it
     PROBE_COMMIT, and the same test drives the step helper to prove it reaches the
     probe's environment. -->

```bash
BOOKING_API_KEY_CANARY=<the key the deployment holds> pnpm cf:deploy:verified
```

**It is NOT gradual**: it goes to 100% at once and then probes, the way CI did before
#3095. It also applies the cron triggers, as `wrangler deploy` always does.

It runs the stamp, a deploy and the probe, through the same stamp script and the same
probe CI uses (the probe's reads are shared, `scripts/lib/post-deploy-probe-http.ts`), so
the two paths cannot drift into verifying different things: stamp the commit from `git
rev-parse HEAD`, deploy, then poll the live version and judge health. `APP_URL` targets
something other than production.

The version it deploys is tagged with that commit and carries the release message
the gradual deploy writes (`slate-release-<commit>`, #3178), so the Rollback
workflow can confirm a rollback to a hand deployed version without
`expected_commit`. It still goes straight to 100%: the hand path is for when the
pipeline is unavailable, and a canary stage needs that same pipeline's probe. A
deploy made under `ALLOW_DIRTY_DEPLOY=1` is deliberately NOT tagged, because its
stamp does not describe what shipped and a tag repeating it would let a rollback
confirm a commit the version does not hold.

Four things it refuses to do, each with its own exit code so a script can tell them
apart:

| exit | what it met | what to do |
|---|---|---|
| 1 | no commit to stamp, or a target that is not an https origin | run it inside the repo, on a real commit |
| 2 | the working tree has uncommitted changes | commit first; locally is enough, an emergency does not require pushing |
| 3 | `BOOKING_API_KEY_CANARY` is unset | set it; without it nothing can confirm the deploy, which is the whole point |
| 4 | it could not tell whether the tree is clean (`git status` did not answer) | fix git; this is not the same as a dirty tree, and "commit first" would be advice that cannot help |

The dirty-tree refusal is the one that matters. The stamp writes a commit into the
bundle and the probe then confirms that commit is serving, so with uncommitted changes
the pair is a lie in its most convincing form: the probe passes, the version endpoint
reports a real sha, and the code running exists nowhere in git. `ALLOW_DIRTY_DEPLOY=1`
overrides it, because refusing outright would make the one command with a safety net
unusable in the emergency it was built for, and it warns that the reported version
does not describe what shipped. Say that wherever the deploy is recorded.

It restores `src/lib/build-info.ts` on every path, including a failed deploy, so a
stamped source file is never left behind for the next commit to carry.

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
- **Direct booking API (optional):** each integrator gets its OWN key
  (`BOOKING_API_KEY_REGAL`, `_TRYPENNIE`, `_CANARY`, `_MARCIA`, above), never a shared one, so
  every call is attributed to its caller and one can be revoked alone (#2645,
  #2865). A new integrator is a new caller in `BOOKING_API_CALLERS`; one that only
  cancels also goes in `CANCEL_ONLY_CALLERS`, as Marcia does (#2940). Every key
  unset ⇒ `POST /api/bookings` returns 503. Rotate through the caller's `_2` slot
  (both are accepted at once). Full request/response/error contract:
  `docs/booking-api.md`.
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

## Staff sign in: Google only (#3082, #3085)
Slate staff sign in with **Google only**, and only with a `trypennie.com` Workspace
account. Three things hold that, and two of them live in the Supabase dashboard
rather than in a deploy, so a rebuilt project needs them set by hand:

- **Supabase Auth providers** (dashboard, Authentication, Sign In / Providers):
  **Google on, Email off, every other provider off.** Signup stays enabled, because
  a new hire's first Google sign in is what creates their account. Email off closes
  the password, magic link, signup and recovery routes that are otherwise reachable
  with the public key. Nothing in Slate signs in by email (checked 2026-10-03: no
  smoke script, load test, dev preview or test uses a password or magic link; the
  dev preview sets a cookie and never touches Supabase Auth).
- **The `before_user_created` hook** (dashboard, Authentication, Hooks): a Postgres
  hook pointing at `public.before_user_created_domain_gate`, defined by migration
  0159. Supabase Auth calls it before it creates ANY account, by any provider, and
  it refuses every email whose domain is not exactly `trypennie.com`, so an outside
  Google account is turned away **before an account or a session exists**. The app's
  own check in the OAuth callback (`src/lib/auth/domain.ts`) stays as the second
  line. The local stack registers the same hook in `supabase/config.toml`;
  `pnpm verify:auth-domain-hook` proves it against the real auth server in Docker.
- **`GOOGLE_HOSTED_DOMAIN`** in `wrangler.jsonc` (section 2c), which the hook's
  domain must match; `scripts/test-auth-domain-hook.ts` fails the build if they
  differ.

**In front of those, Google itself refuses an outside account.** Slate's Google
OAuth client is configured as **Internal** to the Pennie Workspace, so Google turns
away any account that is not `trypennie.com` before Supabase is ever asked ("Access
blocked: Slate can only be used within its organization", `Error 403: org_internal`).
Verified live on 2026-10-03 by Dan with a personal Google account: Google refused it,
and `auth.users` still held only the 86 `trypennie.com` accounts afterwards. So there
are three layers in order: the Google Internal app, the Supabase
`before_user_created` hook (0159), and the app's own domain check. Because Google
refused first, that live test **never reached the Supabase hook**, which remains
verified only by `pnpm verify:auth-domain-hook`. The Internal setting lives in the
Google Cloud console (APIs and Services, OAuth consent screen, User type) and nothing
in this repository can see it change.

The monitor lane reads the live `/auth/v1/settings` every tick and pages
`auth_sign_in_beyond_google` while email is on or another provider can create an
account, with an all clear once it is off.

**There is no enforced second factor for Slate staff accounts (as of 2026-10-03).**
Slate has no MFA of its own and relies on Google for the second factor, and **Google
2-Step Verification is NOT enforced for Pennie staff** (Dan, 2026-10-03: "2SV not
required"). So a Slate staff account is protected by its Google password alone,
unless that person has turned 2-Step Verification on for themselves. Enforcing it is
a Google Workspace admin setting (Admin console, Security, Authentication, 2-Step
Verification, for every organizational unit that holds Slate staff), outside this
repository; update this paragraph the day it is enforced.

**How long a staff sign in lasts (#3084).** Dan, 2026-10-03: at most **30 days** in
total, and it ends after **7 days** without use. Two layers hold it, and the first is
set by hand in the dashboard:

- **Supabase Auth sessions** (dashboard, Authentication, Sessions; a Pro plan
  setting): **Time-box user sessions = 30 days (720h)** and **Inactivity timeout =
  7 days (168h)**. These end the refresh token itself, so they are the stronger of
  the two. `supabase/config.toml` carries the same values under `[auth.sessions]`
  for the local stack. Leave the JWT expiry at its default (3600 seconds) and
  refresh token rotation on; the 7 day idle limit relies on a token refresh about
  hourly while a page is in use.
- **In code**, because the Worker cannot read the dashboard values back, so a
  setting never made or later cleared would be invisible from here. The sign in
  callback stamps the sign in time in an httpOnly cookie, middleware restamps the
  last use on every staff page request, and `src/lib/auth/session-age.ts` refuses a
  session 30 days after sign in or 7 days after last use, both in middleware (which
  revokes the refresh token and sends the person to `/login` with a sentence saying
  which limit ended it) and in `realCurrentUser` (which covers the `/api` routes the
  middleware does not run on). A session with no sign in stamp is refused rather
  than stamped now, so every staff session that predates this signs in once more.
  The stamps are not signed: somebody already holding the device who edits its
  cookies by hand can extend them, which is the case the dashboard setting covers.

## Cron
Cron runs entirely on the **main** Worker: `worker/index.ts` `scheduled()`
dispatches each Cloudflare trigger through `worker/cron-routes.ts` to the app's
cron endpoints (`Authorization: Bearer $CRON_SECRET`). Triggers live in
`wrangler.jsonc`; `scripts/test-cron-routes.ts` pins them in lockstep. A single
trigger may drive more than one independent lane (each guards itself with its
own lock). This table mirrors `worker/cron-routes.ts` exactly (the full lane set,
not a subset; `scripts/test-cron-routes.ts` fails CI if any lane below drifts):
- `* * * * *`   → `/api/cron/sync` (backstop calendar sync) **+** `/api/cron/recompute` (bucket_slots freshness) **+** `/api/cron/outbox` (booking-outbox drain, #429) **+** `/api/cron/selfheal` (deletion drain + cancelled/missing reconcile sweeps, #433)
- `*/5 * * * *` → `/api/cron/complete` (mark-complete sweep + webhook retries) **+** `/api/cron/watch` (calendar watch renewal) **+** `/api/cron/monitor` (availability-health probe, #371) **+** `/api/cron/bulk-reassign` (bulk coverage-reassign drain, #973) **+** `/api/cron/booking-reminders` (each lead's stored reminder emails, #2359, #4298)
- `0 * * * *`   → `/api/cron/agents` (hourly Salesforce roster reconcile + default hours, single locked path) **+** `/api/cron/bulk-reassign-retry` (hourly coverage-reassign retry: re-arm still-upcoming unplaceable calls so the */5 drain re-attempts them, #3485)
- `0 13 * * MON-FRI` **and** `0 14 * * MON-FRI` → `/api/cron/ooo-digest` (pending-OOO morning digest; the two UTC slots straddle DST and the route's time gate lets exactly one fire at 9am ET)
- `0 11 * * *` **and** `0 12 * * *` → `/api/cron/ooo-approvals` (7am ET email of yesterday's OOO approvals; two DST slots, one fires)
- `0 3 * * *`   → `/api/cron/prune-routing` (daily prune of routing_decisions rows older than 12 months) **+** `/api/cron/prune-webhook-payloads` (blank webhook_deliveries payload PII on terminal deliveries older than 90 days, #1073) **+** `/api/cron/prune-bookings-pii` (redact consumer PII on bookings whose appointment is past the 24-month window, enqueue gcal-event deletion, prune delivered outbox rows, #1071) **+** `/api/cron/prune-busy-blocks` (delete cached gcal busy_blocks whose `ends_at` is more than 36 hours past, #1252; that table had no retention and reached 403k rows / 247 MB while only ~3.6k sat inside the readable window. Past rows only: every reader requires `ends_at > now`, so a finished block is unreadable and can never re-enter a window. NOT mirror-gated, unlike its three neighbours, because busy_blocks is a rebuildable cache rather than a mirrored table. Bounded to 30k rows per run, and the run logs `capped` when prunable rows remain) **+** `/api/cron/prune-warehouse-pii` (clear consumer contact data from the SNOWFLAKE mirror for bookings whose appointment is past the same 24-month window, #1180. The mirror half of `prune-bookings-pii`: redacting in Supabase stamps `pii_redacted_at`, which freezes the row from re-export, so the redaction never propagates and only this lane clears the warehouse copy. Not export-gated, since nothing needs archiving before it runs, and it shares its statements with the deletion-request purge so the two cannot clear different field sets. Bounded to 500 bookings per run; the predicate is self-limiting, so a re-run finds strictly less. Fails loud: an unreadable select, an unreadable row count, or a verify that still finds contact data all 500 and withhold the heartbeat) **+** `/api/cron/prune-regal-calls` (delete inbound Regal call events received more than three days ago, #2090. One range delete on an indexed column; not mirror-gated, since the table is not mirrored and holds no lead data) **+** `/api/cron/prune-booking-alert-state` (delete the `alert_state` cooldown rows and firing markers of alerts keyed by booking once that booking both started and was made more than a week ago, #2726. Incidents never resolve, so without it those rows only ever accumulated. The family list is derived from the alert catalog's `suffix: "booking"` declarations; not mirror-gated, since the table is not mirrored)
- `*/15 * * * *` → `/api/cron/hydrate-calendars` (re-bootstraps a slice of the agent calendars over the cached window, #1261; the batch is DERIVED from the live calendar count so every calendar is refreshed at least once a day at any roster size, rather than a fixed number that is right today and halves the refresh rate as the roster grows. Its own expression, never co-scheduled: the every-minute invocation is the one already short of CPU headroom, and this lane makes a real Google call per calendar. Needed because Google's incremental delta is not scoped to the bootstrap window and delivers an unchanged event exactly once, so without a periodic re-bootstrap a far-future event would be dropped by any window filter and never re-added. Stamps `hydrate-calendars` with a matching bound in `LANE_STALE_BOUNDS_MS`, because this lane going quiet means coverage expiring everywhere)
- `14,44 * * * *` → `/api/cron/snowflake-export` (archival-mirror export to Snowflake, #1099, every 30 minutes since #4349; its own expression so it gets its own CPU budget, resumable via export_cursor, no-op until SNOWFLAKE_PRIVATE_KEY is set)
- `17 4 * * *` **and** `17 10 * * *` → `/api/cron/advisor-photos` (daily advisor photo refresh from the Google directory, #3027; the 10:17 run stands down when the 04:17 run already reached a verdict, so it is the automatic re attempt; held back on the load test Worker)
- `41 5 * * *` **and** `41 9 * * *` → `/api/cron/busy-minutes` (the daily check on the booking load run's bar, #3124: has a minute of more than a tenth of `LOAD_RUN_BOOKINGS_PER_MINUTE` happened on 3 of the last 7 UTC days? Until cal.com is marked retired it adds cal.com's routed responses to Slate's routed bookings minute by minute, reading about 25 cal.com pages paced 550ms apart with `CALCOM_API_KEY`; Slate's half is one call to the `routed_bookings_per_minute` RPC, migration 0193. Night ET because cal.com meters the key the working day's time off writes also use. The 09:41 run stands down when the 05:41 run reached a verdict, and only it pages `load_bar_unread` when a half could not be read. Its only heartbeat is `verdict:busy-minutes`, 30 hours in `VERDICT_STALE_BOUNDS_MS`, kept out of `LANE_STALE_BOUNDS_MS` because a capacity check that did not run is not the site being down. Stands down on the load test Worker)
- `13,43 * * * *` → `/api/cron/capacity-fill` (booking pace readings, #4102: at the half hour it falls in, saves each page day's calls open and how many were taken since the last reading, judged at the earlier reading's instant against the calendar as it is now, and a snapshot per day of each counted advisor for the next. Taken is null with its reason, never 0, when under `COMPARABLE_SHARE_FLOOR` of the team's capacity can be compared. A second run in one half hour writes nothing (`record_capacity_fill`, migration 0198); a missed run is measured by the next over the longer interval, up to a day. Kept for good, no prune. Stamps `capacity-fill` with a 90 minute bound in `LANE_STALE_BOUNDS_MS`)
- `23,53 * * * *` → `/api/cron/capacity-history` (Team capacity history, #3940: saves each advisor's calls still open when they stopped being bookable, with the day's shift, time off and capacity, so a past day shows how it ended. Its own expression; a cursor catches a missed tick up, at most a day back, inside the 36 hours past busy time is kept. Kept for good, no prune. Stamps `capacity-history` with a 90 minute bound in `LANE_STALE_BOUNDS_MS`)
- `0 */6 * * *` → `/api/cron/snowflake-reconcile` (counts Supabase vs Snowflake per mirrored table + a positive control, Slack-alerts on drift, #1101; the precondition future deletion must pass) **+** `/api/cron/erasure-audit` (reads the pii.erasure audit trail and Slack-alerts if Snowflake still holds contact PII for an erased booking, i.e. the warehouse purge is incomplete, #1103; also executes the purge SQL itself against the warehouse with an id that cannot match, so a statement that stops compiling pages on `snowflake_purge_sql_broken` instead of being discovered during a real deletion request, #1128)

No secret beyond `CRON_SECRET` (already set on the app) is needed. The trigger
schedule is NOT part of a Worker version: `pnpm cf:deploy` (a plain `wrangler deploy`)
applies it, and the gradual deploy applies it with `wrangler triggers deploy` once the
release is at 100% (#3095). A rollback does not revert it. During a gradual deploy's split
only the version that was already serving runs lanes (see "What the split looks like").
Until the domain is Google-verified,
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

## Log shipping to Better Stack (#3105, #3138)

Cloudflare keeps Slate's logs for 7 days. A second Worker, **`slate-log-tail`**
(`worker/log-tail/index.ts`, its own config `wrangler.log-tail.jsonc`), is named in
Slate's `tail_consumers`, so Cloudflare invokes it after every Slate invocation with
that invocation's console lines, uncaught exceptions and outcome. It redacts them
(query strings cut whole, manage and advisor link tokens replaced in every path,
`scrubContactData` over every message and string field, no request headers; the
detail is in `docs/pii.md` §5) and POSTs them to a Better Stack HTTP source in at most
two requests per invocation. It runs after Slate's invocation and in its own, so
nothing it does can slow or fail a request.

What it adds for #3138: every record carries `version_id` (the deployed Slate
version), uncaught exceptions arrive as their own `kind=exception` records, and the
cron `lane timings` line arrives with its fields parsed into numbers (`total_ms`, one
`<lane>_ms` per lane, `lanes_ok`, `lanes_failed`), so a lane can be charted against
itself for as long as the plan keeps it.

It works unchanged on any Better Stack plan: the free tier (3 GB a month, 3 days) it
starts on to measure volume, or a paid retention plan (30 to 90 days). Only the
source token and host couple it to Better Stack.

### First setup, in this order

The order is the point. `tail_consumers` is not checked by wrangler locally (it
passes the list to the API as is), and Cloudflare's documentation does not say
whether a deploy naming a Worker that does not exist is refused or accepted; this was
not measured, because measuring it means deploying production. Treat it as refused:
a merge to main deploys Slate, so if the tail worker does not exist yet, assume that
deploy fails. **The tail worker and its secret go first, then the change that
references it merges.**

1. **Create the Better Stack source**: Logs, Sources, Connect source, platform
   "HTTP", data region **US**. Its page shows a source token and an ingesting host
   (a bare hostname ending `betterstackdata.com`).
2. **Commit the host** as `BETTERSTACK_INGEST_HOST` in `wrangler.log-tail.jsonc`
   (it is not a secret). Done for the current source (US, 2026-10-03); repeat only
   when the source is replaced. Empty, the worker drops every record and counts it.
3. **Deploy the tail worker**, from a checkout holding step 2:

<!-- runbook-unverified: deploys a live Worker to the production account, so it cannot be
     executed by a check. Its bundle is proven by `wrangler deploy --dry-run -c
     wrangler.log-tail.jsonc`, and the resolved config by scripts/test-log-tail-config.ts. -->

```bash
npx wrangler deploy -c wrangler.log-tail.jsonc
```

4. **Put its secret**, on the tail worker only (Slate holds no Better Stack setting):

<!-- runbook-unverified: writes a live Worker secret. The worker reads it as
     env.BETTERSTACK_SOURCE_TOKEN in worker/log-tail/index.ts. -->

```bash
npx wrangler secret put BETTERSTACK_SOURCE_TOKEN -c wrangler.log-tail.jsonc
```

5. **Then merge** the change carrying `tail_consumers` in `wrangler.jsonc`; CI's
   deploy of Slate attaches the tail worker.

### Redeploying it

CI deploys it on every production deploy, whole, LAST: after Slate is promoted and has
passed its probe (#3165; "What CI does: a gradual deploy", step 10), because it binds to
an entrypoint of Slate's (#3191). So a change to the redaction (`src/lib/log-shipping/`,
or `src/lib/api/client-error-scrub.ts`, which it imports) is live with the merge. A
failed tail worker deploy fails the job (exit 23) without rolling Slate back. By hand,
step 3 above still works. The secret survives a redeploy.

**Since #3182 the dependency runs both ways.** The tail worker binds Slate's
`LogShippingReceipt` entrypoint, so for any change that ADDS, renames or removes that
entrypoint, **Slate deploys first and the tail worker second**: the reverse of first
setup. For every other change either order works, because both Workers already exist
and the entrypoint name is unchanged. Whether Cloudflare refuses a deploy whose
binding names an entrypoint the target does not yet export, or accepts it and fails
each call, was not measured (it means deploying production); in the second case the
receipts fail, are logged as `receipt=failed`, and the watchdog pages until Slate
catches up, so nothing is lost but a page. The CI deploy follows that order for EVERY
change, not only those: the tail worker goes last, after Slate is promoted and healthy
(step 10 of "What CI does: a gradual deploy").

### When records stop arriving

The tail worker never throws. Every record it could not send is counted and written
to ITS OWN Cloudflare logs under `tag=log-tail`, by reason: `no-token`, `no-host`,
`bad-host` (a scheme or path pasted into the host), `refused` (with the status, for
example 401 for a wrong token), `unreachable`, `timeout` (a POST with no answer
inside 5 seconds, abandoned so the invocation is not held), `over-budget` (a log storm past two
1 MB requests in one invocation) and `too-large` (a single record over 1 MB). Read
them live with `npx wrangler tail slate-log-tail`.

**Nobody has to be reading those for a stop to be noticed (#3182).** Each time Better
Stack accepts every record of a cron tick (the invocation carrying the `lane timings`
line, once a minute), the tail worker calls Slate's `LogShippingReceipt` entrypoint
over its `SLATE` service binding (`wrangler.log-tail.jsonc`), and Slate stamps the
`log-shipping` heartbeat. The lane watchdog pages `cron_lane_stale:log-shipping` when
no receipt has arrived for 15 minutes, and all-clears when one does. Detection is by
absence, so a revoked token, a Better Stack outage, a missing secret, a tail worker
Cloudflare stopped invoking and a binding that is gone all page the same way; the
tail worker's own log above says which it was, and a receipt that did not land is
logged there as `log shipping receipt did not land` with its reason (`no-binding`,
`refused`, `failed`, `timeout`). The named entrypoint is reachable only through a
binding in this account, never over HTTP, so the receipt carries no key.

What it cannot see: Better Stack answering 2xx and then not keeping what it took (a
plan quota, for instance). Only an alert inside Better Stack can see that.

**Order when the receipt first ships, or the binding changes.** Slate must export
`LogShippingReceipt` before the tail worker that binds to it is deployed, so: merge
the change (CI deploys Slate), confirm the deploy landed (`GET /api/smoke/version`),
then redeploy the tail worker (step 3 above). Until that redeploy the old tail worker
sends no receipts, and about 15 minutes after Slate's deploy (the grace window a
heartbeat that has never stamped is owed) the watchdog pages that shipping has never
been confirmed. That page
is true, and the redeploy is what clears it.

### Volume, and measuring it

Estimated from the code paths, not measured: one `invocation` record (about 400
bytes) per Slate invocation, plus one record (400 to 900 bytes, the parsed fields
roughly doubling a `slate` line) per console line and per exception.

| Source | Invocations a month | Records each | Approx. a month |
|---|---|---|---|
| `* * * * *` tick (four lanes) | 43,200 | 4 to 6 | 100 to 150 MB |
| `*/5` tick (monitor plus four lanes; the monitor logs most) | 8,640 | 10 to 20 | 50 to 100 MB |
| every other cron expression | about 8,000 | 2 to 5 | under 15 MB |
| requests (availability reads, booker and manage pages, Google push pings, admin) | 0.5 to 1.5 million at pilot traffic, assumed | 1 to 3 | 0.3 to 1.2 GB |

So roughly **0.5 to 1.5 GB a month**, inside the free tier's 3 GB, with requests
dominating and growing with traffic at cutover. To measure the real number: after
two full days live, read the source's ingested volume per day in Better Stack (or its
usage page) and multiply by 30. The request count behind it is on the Cloudflare
dashboard, Workers, `slate`, Metrics. Quote that daily figure, not this table, when
choosing a paid plan.

## Marcia's booking MCP server (#3541): deployed 2026-10-20

`worker/mcp-booking`, configured by `wrangler.mcp-booking.jsonc`, was first deployed
on 2026-10-20 (#3541): both Slate secrets are put, the Worker is live, and
`slate-booking-mcp.trypennie.dev` answers an unsigned call with a 401 from the Worker.
Marcia does not call it yet. To deploy it again, or anew, the order matters, because
the server binds an entrypoint of Slate's:

1. Slate, carrying `McpBookingGateway`, deployed as usual, with
   `MCP_BOOKING_GATEWAY_SECRET` and `MARCIA_TOKEN_KEY_A` put (section 2b). Marcia's
   signer gets the same token key.
2. `npx wrangler deploy -c wrangler.mcp-booking.jsonc`, which holds no secret.
3. The custom domain `slate-booking-mcp.trypennie.dev` attached by hand in the
   dashboard (CI's token cannot manage zone routes).

Until step 2 nothing can reach the gateway, and until step 1's secrets exist its
internal routes refuse every call and page (`marcia_gateway_refused`,
`marcia_token_refused:token_keys_unconfigured`). Wiring it into the gradual deploy
is #3539.

Marcia's overall limit (`MARCIA_LIMITER`, 60 a minute) is bound on this Worker but
charged only for a call whose token Slate verified (#3879): the gateway verifies with
the same token keys, then calls this Worker back over the binding before anything
runs. So a forged token never spends it, and **a measurement of the limit (the
#3541 step that drives it from more than one location) must use correctly signed
test tokens**: forged or unsigned calls are refused by Slate without touching the
count, so counting them measures nothing. Nothing runs unmetered: a call with no
callback, or whose limiter is missing or throws, is refused; and without the token
keys the gateway charges nothing only because the route then refuses the same token
for the same reason.

## Verify after deploy
1. Hit `https://slate.trypennie.app/api/health` → expect HTTP `200` with
   `{"status":"ok",...}`. A `503` `{"status":"degraded",...}` means the DB is
   unreachable (`db:"unreachable"`) or a cron lane heartbeat is stale
   (`reason:"heartbeat_stale"`, with the offending `staleLane`). This endpoint is
   unauthenticated and safe to point an uptime monitor at.
2. Visit `https://slate.trypennie.app/login` → sign in with Google → land on `/admin`.
3. Configure event type + working hours + bucket `411` + webhook URL.
4. Load `/booking/SF_TEST?xbc=411&...` → book → check calendar invite + webhook.

## External uptime monitoring (noodge, #749, #1228)
Slate's internal cron monitor only alerts while the Worker is alive. An external
monitor is what catches a dead Worker, a broken deploy, or a DNS failure. noodge
(https://noodge.trypennie.dev/) runs four checks against
`https://slate.trypennie.app`, alerting to #statuspage (`C08A3BYMB29`), which is
NOT the channel Slate's own cron monitor posts to. (Cloudflare's native Health
Checks were considered but need a paid plan; the `trypennie.app` zone is on Free,
so noodge is the free choice.)

**The checks are code, not dashboard rows.** They live in `monitors/slate.sql` in
Try-Pennie/noodge, which is idempotent, keyed on stable keys, adopts rows that were
first created by hand in the dashboard, and repairs drift on every apply. Apply it
from the noodge repo with the heartbeat key in the environment (below):

<!-- runbook-unverified: both run in the noodge repo, not this one, and the second writes noodge's production D1 with a Cloudflare write token -->
```sh
npm run test:monitors:slate   # local D1: adoption, idempotence, drift repair, refusal
npm run monitors:sync:slate   # apply to production D1; refuses without SLATE_UPTIME_HEARTBEAT_KEY
```

1. `GET /api/health` expects `200`. Covers liveness, DB reachability, and cron lane
   freshness (a stalled recompute lane surfaces here). Interval: 5 min.
2. `GET /api/health/availability` expects `200`. The availability canary (#749):
   `200` when the booker is genuinely offering times, `503` when a well-staffed tier
   or the whole fleet is silently empty (which check 1 cannot see, the DB is up and
   the crons tick while the booker offers nothing). It is PTO-aware, so a tier that
   is empty only because its agents are all off does not page. Interval: 5 min.
   Because the verdict rides on the status code, noodge needs no body assertion.
3. `GET /widget.js` expects `200`. The embed script; if it stops serving, every
   landing page that embeds Slate loses its booker. This check is status only:
   noodge cannot assert a content type, so it does not prove the body is JavaScript.
4. `GET /login` expects `200`. Cheap catch for a broken deploy: it proves the
   Next.js page-rendering path serves (not just the API routes). The root `/`
   redirects to `/login` (a `307`), so point the check at `/login` directly rather
   than `/`, or a strict expect-`200` check fails on the redirect.

Alerting: every check makes up to two attempts per run (`max_attempts` 2) and
alerts after two consecutive failed runs (`alert_after` 2), so a transport blip
between noodge and Slate, which never reaches the endpoint and which no server
side debounce could smooth, does not page. These endpoints return `503` only on a
sustained, real condition (a cron lane well past its bound, a genuinely empty
well-staffed tier), so the ten minutes that costs is not hiding flicker. Verify each
check actually fails when it should: point it at a deliberately bad path once,
confirm the Slack alert fires, then point it back. A check that can only ever pass
is worse than no check. noodge's bot has to be in #statuspage (`/invite @Noodge`)
for its alert to arrive; it is.

**Watching the watcher (#1228).** Checks 1 and 2 send `Authorization: Bearer` with
a dedicated key, `UPTIME_HEARTBEAT_KEY` here and `SLATE_UPTIME_HEARTBEAT_KEY` when
noodge applies `monitors/slate.sql`. A request carrying it stamps
`uptime:api-health` or `uptime:availability-canary` in `lane_heartbeats`, whatever
the endpoint answers, and the lane watchdog pages (`cron_lane_stale:uptime:*`, with
an all-clear) when either goes quiet for longer than `UPTIME_STALE_BOUNDS_MS`
(16m40s, derived in `src/lib/monitor/health.ts` from the cadence above). So a check
that is deleted, paused or stops firing, or noodge itself stopping, now pages. The
key never changes the health answer: a wrong or missing key simply does not stamp.
**A deployment with no `UPTIME_HEARTBEAT_KEY` never stamps at all**, so both
heartbeats go stale and page, once per hour, one bound after the watchdog first sees
them missing.

What it cannot see, so a quiet channel is never read as more than it is:

- **A dead Worker cannot receive a stamp, and cannot run the watchdog that would
  notice one missing.** A total outage is caught by noodge's OWN alert on checks 1
  to 4, in #statuspage. The uptime heartbeat pages above arrive in Slate's own
  alerts channel instead, so the two halves land in different places.
- **`/widget.js` and `/login` cannot stamp**, because no app code runs for them.
  Their only coverage against being deleted or paused is the registration file:
  re-applying `monitors/slate.sql` restores them, and nothing pages if one is
  paused in the dashboard between applies.

The availability canary's paging rule (tunable constants in
`src/lib/monitor/availability-canary.ts`): a single broken tier with at least 3
present agents pages on its own; otherwise it pages only when at least 3 staffed
tiers, and at least half of them, are empty at once, or the slot cache is entirely
absent. The horizon is the 4 days of Slate's precomputed slot cache; a stalled
recompute (a stale cache) is caught by check 1, not check 2.

## Feature flags and the kill switch (#1052)

The launch flags (`AGENT_SCHEDULING_LIVE`, `OOO_CALCOM_DUAL_WRITE`) are wrangler
`vars`, so flipping one is a config edit plus a redeploy, about two minutes. That is
**accepted rather than overlooked**: both govern a cutover step somebody decides on
purpose, not an incident somebody reacts to, so neither wants an instant switch, and
a var in `wrangler.jsonc` survives every deploy where a dashboard-only value would be
wiped.

Those two flags still cannot be turned off without shipping. **Public booking can**,
and that is the switch to reach for in an incident (#2297):

- **Where.** Admin, **Hours** (`/admin/business-hours`), the **Stop online booking**
  button, which asks for confirmation first. **Start online booking** on the same
  screen turns it back on. The admin Overview carries an **Online booking** row
  saying which state it is in. It writes `booking_settings.public_booking_paused`,
  which the public booker's route (`src/app/booking/route.ts`) reads on every
  request, so it takes effect on the next lead with no deploy. It gates that route
  only: the key authed booking API (`/api/bookings`) does not read it.
- **What a paused lead sees.** The booking request is refused with a 503 carrying
  `BOOKING_ERROR_COPY.bookingsPaused` (`src/lib/booking/booker-copy.ts`): "We are not
  taking bookings online right now. Please try again a little later." Availability
  keeps computing, calendars keep syncing, and anybody who already has a call can
  still move or cancel it. A flag the route cannot READ refuses too, with a
  different sentence (`bookingPauseUnreadable`), because the gate fails closed.
- **The alert.** A switch left stopped pages `public_booking_stopped` once it has
  stood for `PAUSE_NOTICE_AFTER_MS` (the low booking volume alarm's long window, two
  hours), timed from `booking_settings.public_booking_paused_at` rather than from
  when the monitor noticed, and it clears on the first tick that reads the switch
  back on (`src/lib/monitor/booking-pause.ts`, #2366).
- **It is proven nightly.** `.github/workflows/kill-switch.yml` runs
  `pnpm verify:kill-switch`, which stops public booking for about two seconds
  outside advertised hours, sends one booking that must be refused, and starts it
  again (`docs/verify-commands.md`, #2493).

If a launch flag ever gates something that has to be turnable off in seconds under
load, do not add another var: back it with a database row read per request or per
tick and changed from the admin UI, which is the pattern this switch and the
`monitor_settings` alert cooldowns use. That reversal is per flag rather than a
general mechanism, deliberately: a general flag system nobody needs yet is a second
source of truth for behaviour.

## Spend and usage alerts (#1052)

Cost posture is cheap and documented (`docs/cloudflare-platform-notes.md`), but the
alerts that would tell somebody it stopped being cheap live only in provider
dashboards. Recorded here so the configuration is discoverable and survives a change
of ownership:

**Cloudflare.** What is configured, measured through the API on 2026-09-16 against
the account Slate actually runs on (`3e7f907a9c19e51417873e2cce4fbc5c`, the Pennie
account named in `wrangler.jsonc`): exactly ONE alert policy, the auto-created
"Default budget alert" at 500 dollars of total spend, emailing
`bnelms@trypennie.com`.

There is no Workers USAGE notification, and Dan decided on 2026-09-16 not to add one
(#1702): the budget alert going to one person is accepted as the cover. Recorded as a
decision rather than left as a gap, so the next person does not re-derive it. What it
costs is stated plainly: the alert is on SPEND, so a runaway loop is noticed once it
has already cost money rather than when the request or CPU count moves. That is
tolerable because a Cloudflare request that costs anything is a lead booking and the
four cron lanes are bounded, which is the same argument the rest of this section
makes.

If that is ever revisited, the thing to create is a **Billing Usage Alert**
(`billing_usage_alert`, Dashboard > Notifications > Add > Billing), which takes a
product and a usage limit, rather than a second budget alert.

**Supabase (spend cap).** Organization > Billing > Cost control: leave the **spend
cap enabled**, which is the default and means the project throttles rather than bills
over. Verify it after any plan change, since the cap is per organization and a plan
change is when it moves. The organization is on the **Pro** plan (read 2026-09-16);
the cap itself is not exposed by the management API, so this one genuinely cannot be
checked from here.

**Snowflake (warehouse guard, #3125).** Decided by Dan on 2026-10-03: the `SLATE_WH`
warehouse carries a **monthly resource monitor that warns only**, never suspending,
plus **`STATEMENT_TIMEOUT_IN_SECONDS = 600`**. Never suspend, because suspending the warehouse stops the 30 minute booking
mirror (`/api/cron/snowflake-export`), and that mirror is the booking backup: a spend
cap must not be able to switch the backup off. The statements are in
`docs/snowflake-setup.sql` under "Spend guard". Slate has no local Snowflake access,
so they are run by hand in a Snowsight worksheet as `ACCOUNTADMIN`.

Cap: **`RM_SLATE`, 100 credits a month**, notifying at 75% and 100%, never
suspending. The data team attached it in place of the 49 credit `SLATE_WH_MONITOR` set
on 2026-10-03, and Dan kept it on 2026-10-28: by `RM_SLATE`'s own count the warehouse
used 67.65 credits between 2026-10-09 and 2026-10-28, already past 49. The 49 had come
from 24.37 credits over the 30 days before 2026-10-03, most of which preceded a step up
in daily spend around 2026-10-01, so it measured a quieter warehouse. The same day the
warehouse moved from Gen2 to Gen1 (`GENERATION = '1'`), which bills short statements
like Slate's about a quarter less.

To see what the warehouse uses now, run this read-only query in Snowsight (it reads
`SNOWFLAKE.ACCOUNT_USAGE`, which lags up to three hours, and writes nothing):

<!-- runbook-unverified: Slate has no local Snowflake access, so this cannot be run
     from here. It is read-only (a SELECT over ACCOUNT_USAGE) and is run by hand in
     Snowsight to size the resource monitor. -->

```sql
SELECT warehouse_name,
       SUM(credits_used) AS credits_last_30_days
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
 WHERE warehouse_name = 'SLATE_WH'
   AND start_time >= DATEADD(day, -30, CURRENT_TIMESTAMP())
 GROUP BY warehouse_name;
```

To change the cap, use the `ALTER RESOURCE MONITOR RM_SLATE` line near the top of
`docs/snowflake-setup.sql`, then update the number, the date and the reason here. No
row back means the warehouse used no credits in 30 days, which is not a normal reading
for a mirror that runs every 30 minutes: check the export lane first.

Neither is verifiable from this repo, which is the honest limitation of writing them
down here: nothing fails when somebody deletes the notification. What compensates is
that both providers are cheap by architecture rather than by policing (a request
that costs money is a lead booking, and the crons are bounded), and that the
observability notes carry the real headroom numbers to compare against.

## Capacity: the database and the Google quota (#3124)

The Worker's own ceilings (CPU, subrequests, the shared every minute invocation) are
measured and live in `docs/cloudflare-platform-notes.md`. This section records the
two shared resources OUTSIDE Cloudflare: what was read, when, where to read it again,
and what is still not known, so the next capacity question starts from a recorded
state rather than a guess. Every dashboard figure below is a reading on one day, not
a guarantee; re-read it before any capacity decision and after cutover (#65).

**The load premise.** How busy Slate really gets is the peak query in
`scripts/loadtest/RUNBOOK.md` ("The peak the load run's bar rests on"), re-runnable
against production. Re-run it before any capacity decision and after cutover (#65),
when Slate stops carrying only the pilot's share. Its first production reading,
2026-10-16: a busiest minute of 5 and a busiest day of 512 routed bookings, 12 times
under the bar of 60 that stood then. That was the pilot's half of tiers 1 to 5; the
whole traffic peak, cal.com's routed responses and Slate's bookings added minute by
minute, read 7 on 2026-10-20, so Dan raised the bar to **70 a minute**
(`LOAD_RUN_BOOKINGS_PER_MINUTE` in `src/lib/load-bar.ts`, the one place it lives),
ten times that peak.

**The premise is now re-read every day** (#3124). The `busy-minutes` lane
(05:41 UTC, retried at 09:41) counts the last 7 whole UTC days of routed bookings per
minute, cal.com's routed responses plus Slate's routed real bookings until cal.com is
marked retired, and pages `load_bar_outgrown` when a minute of more than a tenth of
`LOAD_RUN_BOOKINGS_PER_MINUTE` (`src/lib/load-bar.ts`, 70, so 8 or more) happened on 3
or more of those days. A half it could not read pages `load_bar_unread` instead,
never a quiet week. Its cost: one Supabase RPC returning one row, and about 25 paced
cal.com reads (one for the forms, one per 250 responses of each, at about 4,500
responses a week), on its own expression so it shares no invocation's CPU or
subrequest budget; no new secret, since it reads with `CALCOM_API_KEY`.

**Supabase.** What is known:

- The organization is on the **Pro** plan (read 2026-09-16, above) with the spend cap
  on, so going over a quota THROTTLES the project rather than billing for it. A
  throttled database is an outage that reads as a slow one, which is why the size of
  the headroom matters more here than its price.
- **The Worker holds no database connections of its own.** Every read and write goes
  through PostgREST over HTTPS (`@supabase/supabase-js`); nothing under `src/` or
  `worker/` imports a Postgres driver (`scripts/test-ops-doc-claims.ts` keeps that
  true). So the connection limit that matters is Supabase's PostgREST pool for the
  project, not anything a Worker isolate opens, and a burst of isolates does not
  multiply connections.

- **The compute size is Large.** Read from the database itself (#3751):
  `select name, setting from pg_settings where name in ('max_connections',
  'shared_buffers')` returned 160 and 262144 (2GB in 8kB pages) on 2026-10-14 and
  again on 2026-10-16, after 60 and 32768 (256MB, micro) on 2026-10-07. Both
  settings follow the compute size by default and either can be overridden, so the
  dashboard's Compute and Disk page is the tie breaker if they ever disagree. The
  load run's branch must match it; the RUNBOOK's step 1 says how to check both.

- **Disk: 0.75 GB used of 8 GB** (about 9 percent), the plan's included 8 GB of
  gp3, read on 2026-10-18 at about 9 PM ET (Dashboard > Project Settings > Compute
  and Disk). Most of it is the database itself, then WAL, then system.
- **Connections: about 20 at the 7 day peak against a maximum of 160** (about 12
  percent), 17 at the time of reading, read on 2026-10-18 at about 9 PM ET over the
  7 days from 2026-10-11 (Dashboard > Reports > Database). The bars are mostly
  PostgREST with small Postgres, reserved, auth and storage shares, and they stay
  level through day and night, so the load is the steady cron lanes rather than
  bookings, and cutover volume should move it little.

Neither figure can be read from this repo, so a change to either is only seen on
the dashboard. Growth is driven by the
append only tables (`booking_events`, `audit_log`, `webhook_deliveries`) and by
bookings, and retention is the only thing that bounds them (`docs/pii-retention.md`).

**Google Calendar API.** What is known: every calendar read and write is made by one
service account through domain wide delegation, so every call Slate makes counts
against the ONE Google Cloud project that owns that service account's OAuth client.
The calls are the every minute sync backstop, Google push channel renewals, the live
`freeBusy` at confirm (batched at Google's 20 calendars a call, #2412), event writes
on book, reschedule and cancel, and the verify commands run by hand.

Read in the Google Cloud console on 2026-10-18 at about 8:57 PM ET (APIs and
Services > Google Calendar API, Quotas and Metrics tabs, for the project that owns
`GOOGLE_SA_CLIENT_EMAIL`):

- **Quotas:** 10,000 queries a minute for the project, and 600 a minute per user.
  There is no per day cap.
- **Traffic over the 30 days before:** the highest point was about 1.85 requests a
  second (about 110 a minute) around 2026-10-04, and since about 2026-10-11 it sits
  flat near 1.7 a second around the clock. So the peak is about 1.1 percent of the
  project limit, roughly 90 times headroom. The chart averages over its interval, so
  a single minute can run higher; ten times the reading is still about 11 percent.
  Like the database, the load is near constant day and night, which says it is the
  sync lanes rather than bookings.
- **Per user:** a delegated call is made as the user its token impersonates
  (`signJwt` in `src/lib/google/dwd.ts`), normally the advisor whose calendar it
  touches, so the 600 a minute per user limit applies per advisor rather than to
  Slate as a whole. No usage against it was shown.

A quota refusal (a 429, or a 403 whose reason is
`quotaExceeded` or a rate limit) is classified `transient` by
`src/lib/google/reachability-classify.ts`, so running out reads as a run of
transient calendar failures rather than under a quota name of its own.

## Rotating a credential (#3110)

Every secret Slate holds, with where a new value is minted, how it reaches the Worker,
who else holds a copy, and what breaks between the steps. Rotate on a leak, on a
holder leaving, or on a schedule if one is ever set; nothing here runs on a timer.

**Three rules hold for all of them.**

- **Never put a value in shell history or a command argument.** Paste it only at
  the hidden prompt `wrangler secret put` shows, or pipe it in from a file
  (`... < file`), never as `echo value |` or an argument. Keep the new value in
  `.env.local` (never committed) while the rotation is in progress, then delete the
  old line.
- **A `wrangler secret put` deploys at once**: it creates a new version of the live
  Worker with the new value, so each put below takes effect in seconds, and a put
  with the wrong value breaks its feature in seconds too. A Worker secret cannot be
  read back, so the copy in `.env.local` is the only record of what was put.
- **Put the new value where it is ACCEPTED before giving it to the caller that SENDS
  it.** Every rotation below is ordered that way where the provider allows it, and
  says plainly where it does not and what is down in the gap.

### Keys with a `_2` slot: zero downtime

`CRON_SECRET`, `REASSIGN_API_KEY`, `DUPLICATE_CANCEL_API_KEY`, `OFFBOARDING_API_KEY`,
`BOOKABLE_API_KEY`, `REGAL_INBOUND_KEY` and `UPTIME_HEARTBEAT_KEY` are each checked
against the key AND its `_2` slot, either of which authenticates (the booking API
keys' pattern, #2645). The primary alone decides whether the endpoint is configured,
so an unset `_2` is inert. `scripts/test-bearer-rotation-slots.ts` refuses a bearer
check written against one value, so a new key gets a slot on arrival.

1. Mint the new value with `openssl rand -hex 32` redirected into `.env.local` under
   its own name, so it is never printed.
2. Put the new value in the `_2` slot (`wrangler secret put`, the key name plus
   `_2`). Both values now authenticate.
3. Give the new value to every holder named below. Each can move whenever it likes;
   nothing breaks while some hold the old value and some the new.
4. Put the new value in the key itself (`wrangler secret put`, the key name).
5. Delete the `_2` slot (`wrangler secret delete`, the key name plus `_2`). The
   old value now authenticates nothing.

What breaks between steps: nothing, in that order. Skipping step 3 and going
straight to step 4 is the one mistake: every holder still on the old value is
refused with a 401 from step 5 on. Who else holds each one:

| Secret | Who else holds it | If a holder is missed |
|---|---|---|
| `CRON_SECRET` | the Worker's own crons (they send the primary, and change with step 4); operators' `.env.local` for the reschedule smoke, the erasure purge and `docs/dr-runbook.md`'s recovery commands. The load test uses its own `LOADTEST_CRON_SECRET`. | the lane or command answers 401; the crons are never affected |
| `REASSIGN_API_KEY` | the upstream reassign automation; the `REASSIGN_API_KEY` GitHub repo secret (the full canary pass's reschedule smoke) | the automation's reassigns 401; the 6 hourly full canary fails and alerts |
| `DUPLICATE_CANCEL_API_KEY` | Regal's double booking journeys | duplicate cancels 401 and the duplicate stays booked |
| `OFFBOARDING_API_KEY` | the offboarding automation | deactivations 401, so a departed agent stays bookable |
| `BOOKABLE_API_KEY` | the roster and onboarding automation; NOT SET in production today (see 2b) | promotions 401 |
| `REGAL_INBOUND_KEY` | Regal, Settings > Integrations, the reporting webhook's `Authorization` header | Regal does not retry, so every call event in the gap is lost and the call feed monitor pages. A delivery repeated across the change is harmless: both tables are unique on Regal's event id, so it lands as one row (`scripts/test-regal-call-store-idempotent.ts`) |
| `UPTIME_HEARTBEAT_KEY` | noodge, as `SLATE_UPTIME_HEARTBEAT_KEY` when it applies `monitors/slate.sql` | both uptime heartbeats go stale and the lane watchdog pages within the hour; the health answers themselves are unaffected |

### `GOOGLE_CHANNEL_TOKEN`: a previous slot, for a window

Every Google watch channel carries the token it was REGISTERED with, and Google goes
on sending that token until the channel expires; the watch lane renews a channel only
in its last three days. So a plain put used to turn every push into a 403 until each
channel renewed. The push route now also accepts `GOOGLE_CHANNEL_TOKEN_PREVIOUS`,
and logs `push accepted on the previous channel token` (tag `google-push`) on every
push that used it.

1. Note the instant the window ends: the latest `agent_calendars.watch_expiration`
   (read-only, in the Supabase SQL editor:
   `select max(watch_expiration) from agent_calendars;`). Every channel carrying the
   old token has expired by then.
2. `wrangler secret put GOOGLE_CHANNEL_TOKEN_PREVIOUS` with the CURRENT value, from
   `.env.local`.
3. `wrangler secret put GOOGLE_CHANNEL_TOKEN` with a new value
   (`openssl rand -hex 32`). New and renewed channels carry it from here.
4. After the instant from step 1, and once `npx wrangler tail` shows no
   `push accepted on the previous channel token` line for a full day,
   `wrangler secret delete GOOGLE_CHANNEL_TOKEN_PREVIOUS`.

What breaks between steps: nothing. If the current value is lost and step 2 cannot
be done, the rotation still works, degraded: pushes from old channels answer 403
until each renews (at most a few days), and in that time calendar changes reach the
cache through the 1 minute sync backstop instead of in seconds. Nothing goes stale;
it is slower. Nobody outside the Worker holds this token.

### Secrets minted by a provider

- **`SUPABASE_SECRET_KEY`.** Minted in the Supabase dashboard, Project Settings > API
  Keys > Secret keys > create a new one. Several secret keys can be live at once, so
  create the new one, put it (`wrangler secret put SUPABASE_SECRET_KEY`), update the
  `SUPABASE_SECRET_KEY` GitHub repo secret (the canary, the kill switch, the router
  replay and the schedule parity workflows read it) and operators' `.env.local`,
  THEN delete the old key in the dashboard. Deleting it first takes down every
  server route and cron at once. Side effect worth knowing: it also signs the admin
  "view as" cookie (`impersonationSigningSecret`), so an admin mid impersonation is
  returned to their own view and starts again.
- **`GOOGLE_SA_PRIVATE_KEY`.** Rotated **only if leaked** (Dan, 2026-10-03): no
  schedule. Minted in the Google Cloud console, IAM > Service Accounts > the account
  named by `GOOGLE_SA_CLIENT_EMAIL` > Keys > Add key (JSON). Domain wide delegation
  is granted to the service account's client id, not to a key, so a new key needs no
  Workspace admin change. Put the JSON's `private_key` as it appears there (literal
  `\n` newlines), run `pnpm verify:availability-truth` against a real agent, then
  delete the old key in the console. Operators' `.env.local` / `.dev.vars` hold it
  for the verify commands. A gap only exists if the old key is deleted before the
  put lands: every calendar read and write fails meanwhile.
- **`GOOGLE_CLIENT_SECRET`.** Minted in the Google Cloud console, APIs and Services >
  Credentials > the OAuth client > Add secret (two can be live while you move). Sign
  in runs through Supabase Auth, so the value that matters is the one in the
  Supabase dashboard, Authentication > Providers > Google; update it there, put the
  Worker copy to match, then disable and delete the old secret in Google. Existing
  sessions are unaffected; between deleting the old secret and saving the new one
  in Supabase, nobody can sign in.
- **`SF_CLIENT_SECRET`.** Minted in Salesforce Setup, External Client App Manager >
  the Slate app > its OAuth consumer secret. Put it straight away: Salesforce can
  stop honouring the old secret as soon as the new one exists, and the hourly roster
  sync fails until the put lands. One missed hour is recoverable (the next run
  catches up); a longer gap pages on the sync's own failure alert.
- **`SLACK_BOT_TOKEN`.** Minted by reinstalling the Slack app (api.slack.com, the
  app > OAuth and Permissions); revoking the old token is a separate step. Two
  holders: the Worker (`wrangler secret put SLACK_BOT_TOKEN`) and the
  `SLACK_BOT_TOKEN` GitHub repo secret every alerting workflow posts with. Update
  both before revoking the old one: in any gap, alerts go nowhere, which is the one
  state nothing else will tell you about.
- **`SLACK_SIGNING_SECRET`.** Minted in the Slack app, Basic Information > App
  Credentials > Signing Secret > Regenerate. The old one stops at once, so put the
  new one immediately; between the two, the Approve and Decline buttons on time off
  requests are refused (the request itself is untouched and can be approved in the
  app). Only the Worker holds it.
- **Booking API keys** (`BOOKING_API_KEY_REGAL`, `BOOKING_API_KEY_TRYPENNIE`,
  `BOOKING_API_KEY_CANARY`, `BOOKING_API_KEY_MARCIA`). Per caller `_2` slots, same order as above; the slot lines and the
  retired key hash step are in 2b. The canary key is ALSO the
  `BOOKING_API_KEY_CANARY` GitHub repo secret and must match.
- **`SNOWFLAKE_PRIVATE_KEY`.** Generate the new pair per `docs/snowflake-setup.md`
  Step 1, register the new PUBLIC key as `RSA_PUBLIC_KEY_2` on `SLATE_SERVICE` (so
  both keys log in), put the private key, wait for one clean export run, then unset
  the old public key. Done in that order nothing breaks; replacing `RSA_PUBLIC_KEY`
  before the put stops the mirror until it lands.
- **`REGAL_WEBHOOK_KEY` and `WEBHOOK_SIGNING_SECRET`** (what Slate SENDS on outbound
  webhooks, not `REGAL_INBOUND_KEY`) are Worker secrets since #3091; how each is
  changed, and what an empty one does, is on its own line in 2b.
- **`BETTERSTACK_SOURCE_TOKEN`** belongs to the separate log tail Worker, never to
  Slate; see "Log shipping to Better Stack".

## Rollback
Both the app and its crons run on the single **main** Worker, so a rollback re-points
one Worker. Every deploy leaves its versions uploaded at Cloudflare, so going back is a
re-point rather than a rebuild.

**What a rollback does NOT revert.** The database, or any data a bound store holds
(Cloudflare: "resources connected to your Worker will not be changed during a rollback").
The cron trigger schedule, which is not part of a version. And do not count on it
reverting a secret or var changed since the target version was uploaded: assume any such
change is still in force and set it back by hand. If a bad deploy shipped alongside a DB
migration, roll the code back first, then decide separately whether the schema change is
backward-compatible or also needs reverting (see Backup below). Never roll code back to a
version that predates a migration its successor depends on. `wrangler rollback` refuses
to cross a Durable Object class change.

**Which version.** Since #3095 every release leaves three deployments behind: the old
version at 100%, the 10/90 split, and the new version at 100%. So "the previous
deployment" is the split, and the version beside the old one in it is a canary uploaded
in cron standby: serving it at 100% would restore the code and switch every cron lane
off. The default target is therefore the newest version that served 100% ON ITS OWN,
and a canary is refused even when named (`scripts/lib/rollback-plan.ts`, pinned by
`scripts/test-rollback-plan.ts`). Among those it takes the newest that carries a commit
tag, so the probe can confirm what serves: `wrangler secret put` makes an untagged version
at 100% for every secret, and those are skipped and named in the result. With nothing
tagged at all (history from before the gradual deploy) it falls back to the newest
untagged version and reports the rollback as unconfirmed (exit 34). A NAMED version is
honoured as is.

### The Rollback workflow (#3094)
Actions > **Rollback** > Run workflow. Leave `version_id` empty for the newest known good
version, or name one; give a reason. It runs `wrangler rollback <id> -y`, then the same
post-deploy probe the deploy runs, against the commit the target was tagged with, five
answers in a row before health is judged. Anything other than a confirmed, healthy
rollback posts to the alerts channel. It never waits for a deploy and is never queued
behind one (see "A deploy and a rollback never wait for each other" above): a deploy that
finds production changed under it stops and leaves the rollback standing.

<!-- runbook-unverified: dispatching it re-points production traffic, and it has not yet
     been dispatched. Its decisions (target choice, the canary refusal, every ending and
     its alert) are proven offline by scripts/test-rollback-plan.ts and
     scripts/test-notify-rollback.ts; the rehearsal below is what proves the commands. -->

```bash
gh workflow run rollback.yml -f reason="<why>"
```

A version deployed before #3095 carries no commit tag, so the workflow cannot know what
it should report: it still rolls back (an emergency must not wait), then exits 34 and
says so. Pass `expected_commit` to have it confirmed.

| exit | what happened |
|---|---|
| 0 | rolled back; the target serves its commit and passed the probe |
| 30 | could not read the deployments or the target; nothing changed |
| 31 | refused (no known good version, the current version named, or a canary named); nothing changed |
| 32 | `wrangler rollback` failed; production is most likely unchanged |
| 33 | rolled back, and the target FAILED its probe |
| 34 | rolled back, and which commit serves could not be confirmed (no tag, none supplied) |
| 35 | rolled back, and health reports a stale cron lane |

### By hand
From a checkout with wrangler logged in. List the deployments to find a version id:

<!-- runbook-verified: 2026-08-03 (b2d44552) run by an operator against the live Worker on
     wrangler 4.65.0; listed ten uploaded versions with the active one at 100%, so there
     are real rollback targets rather than an empty list. -->

```bash
wrangler deployments list
```

Then the same rollback and probe the workflow runs (`ROLLBACK_VERSION_ID` is optional):

<!-- runbook-unverified: re-points production traffic, so it cannot be rehearsed against
     the live Worker; the rehearsal on the load test Worker below is its proof. -->

```bash
BOOKING_API_KEY_CANARY=<the key the deployment holds> ROLLBACK_REASON="<why>" pnpm cf:rollback
```

Or the bare command, which probes nothing (omit the id to go to the immediately prior
VERSION, which after a gradual deploy can be a canary: name the id):

<!-- runbook-unverified: re-points production traffic, so it cannot be rehearsed against
     the live Worker. -->

```bash
wrangler rollback <version-id>
```

To END a split by hand (a gradual deploy that died and whose settle step failed), put the
version that should serve back at 100%:

<!-- runbook-unverified: re-points production traffic; it is the command the gradual
     deploy's own restore and settle steps run, which are proven offline by
     scripts/test-gradual-deploy.ts. -->

```bash
wrangler versions deploy <version-id>@100% -y
```

### Rehearsing on the load test Worker
The rehearsal is against `env.loadtest` in `wrangler.jsonc`, the load test Worker
(`slate-loadtest`, no route, workers.dev only), never production. Both commands below
print the Worker they resolved through wrangler's own config reader before touching
anything (`target: the slate-loadtest Worker, routes []`), refuse when `WRANGLER_ENV` is
set and the resolved Worker is not that environment's or holds a route, and under an
environment every message names that Worker instead of saying "production" (#3165). So a
rehearsal that loses `WRANGLER_ENV` does not reach production silently: it prints
`target: production (the slate Worker)` first, and that line is the one to read.

In order, which matters:

1. **A Supabase branch to point at.** A branch made through the connector hands out only
   a publishable key. Read the branch's real SECRET key with the Supabase CLI under your
   own login (`supabase projects api-keys --project-ref <branch ref> --reveal -o json`; no
   grants are needed), never through a tool that echoes it, and seed the branch per
   `scripts/loadtest/RUNBOOK.md`.
2. **Each build stamps the commit first, with the same sha the deploy is told.**
   `node --experimental-strip-types scripts/stamp-build-info.ts <sha>`, then `pnpm
   cf:build` from a tree with no `.env*` file, with the load test `NEXT_PUBLIC_*` values
   (the runbook's "Build" section). Pass that same `<sha>` as `GITHUB_SHA` below, or the
   probe waits for a commit the build does not report.
3. **A baseline, the runbook's way:** `npx wrangler deploy --env loadtest`, so there is a
   version serving 100% to restore to.
4. **Then the secrets** (`SUPABASE_SECRET_KEY` from step 1, `BOOKING_API_KEY_CANARY`,
   `CRON_SECRET`, each by `wrangler secret put --env loadtest`, value on stdin). After the
   baseline, because a put needs the Worker to exist, and BEFORE the gradual deploys,
   because every put makes a new untagged version at 100%. The rollback skips untagged
   versions in favour of the newest tagged one and says which it skipped, so puts made
   between the two gradual deploys move the rollback target nowhere surprising, but
   they clutter what the rehearsal is meant to show.
5. **Two gradual deploys**, on two different commits, each built as in step 2.
   `SMOKE_BUCKET` must name a bucket the seeded branch holds and publishes slots for
   (`112` worked), or the probe's availability read answers 404 and every run restores:

<!-- runbook-verified: 2026-10-03 (935050a6) run against slate-loadtest (workers.dev only, never production) from a local build of PR #3165 head 505ce1ec; two gradual deploys exited 0 with both probes passing. Cron standby on a canary was NOT observed: no cron tick fell inside the roughly 30 second split. -->

```bash
WRANGLER_ENV=loadtest APP_URL=<the load test workers.dev URL> BOOKING_API_KEY_CANARY=<its key> SMOKE_BUCKET=<a seeded bucket> GITHUB_SHA=<the sha stamped into this build> pnpm cf:deploy:gradual
```

6. **Roll back** to the first, and let the probe confirm it:

<!-- runbook-verified: 2026-10-03 (4da3dd89) run against slate-loadtest from a local build of PR #3165 head 505ce1ec; exit 0, the rollback restored version ed9902a0 (commit 505ce1ec2bb1), its probe passed, and /api/health answered 200 afterwards. -->

```bash
WRANGLER_ENV=loadtest APP_URL=<the load test workers.dev URL> BOOKING_API_KEY_CANARY=<its key> SMOKE_BUCKET=<a seeded bucket> ROLLBACK_REASON="rehearsal" pnpm cf:rollback
```

**Watching cron standby.** `npx wrangler tail --env loadtest --format json` shows which
version each cron tick reached, and a tick on the canary logs `canary in cron standby`.
Two things make that hard to catch. At 10% for a split of about 30 seconds, a tick reaching
the canary at all is luck: the first rehearsal saw none. And a tail started before a
deploy goes silent once the deployment changes, so restart it after every split,
promotion and rollback. Exit 0 from both commands, and a `/api/health` 200 from the load
test address afterwards, is the pass.

## Backup & recovery
The Postgres database is managed by Supabase (project **`slate`**, ref
`drukfvgaynzrralbzkzj`,
[dashboard](https://supabase.com/dashboard/project/drukfvgaynzrralbzkzj)).

- **Daily backups** are taken automatically by Supabase; restore from
  Dashboard → Database → Backups. They live in the same account as production.
- **A daily off platform dump** (#3076): `.github/workflows/db-backup.yml` takes a
  full logical dump (roles, schema, data, migration history) at 07:40 UTC, refuses it
  if it is empty or cut short (`scripts/check-db-dump.ts`), uploads it to Cloudflare
  R2, reads it back, and only then stamps the `db-backup` heartbeat. The lane watchdog
  pages in Slack when the newest dump is older than 26 hours, or when none has ever
  landed. It needs the `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`,
  `R2_BACKUP_ENDPOINT` and `R2_BACKUP_BUCKET` repo secrets (an R2 API token scoped to
  Object Read and Write on the one backup bucket, the account's
  `https://<account id>.r2.cloudflarestorage.com` endpoint, and the bucket name),
  beside the `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` and
  `BOOKING_API_KEY_CANARY` it shares with CI and the canary. A missing one fails the
  run red. About 2 to 4 billed Linux minutes a day. The bucket is `slate-db-backups`,
  whose lifecycle rule expires each dump after 30 days; the dump is not encrypted on
  the runner, by decision (R2 encrypts it at rest).
- **The Snowflake mirror** holds bookings and the five tables around them within about
  thirty minutes of each write (#4349), and `pnpm restore:from-snowflake` writes them back after a
  restore (`docs/dr-runbook.md` section 4).
- **Point-in-Time Recovery is not enabled, by decision** (2026-10-03): about $100 a
  month for 7 days plus at least the Small compute add-on, against a ten minute RPO the
  mirror gave on the tables where minutes matter. Since 2026-10-28 (#4349) the mirror
  gives about thirty, so weigh PITR against that when it is revisited; the runbook
  records the booking volume at which to do so.
- **Before any manual migration, backfill, or destructive SQL, take the pre-change
  dump** in `docs/dr-runbook.md` Step 0. It is required: with PITR off there is no
  restore target between two daily backups, so noting the time gives no protection,
  and the dump is the only copy of what the change is about to alter. Prefer running
  changes through `supabase db push` (versioned migrations in `supabase/migrations/`)
  over ad-hoc SQL.
- After any restore, re-hit `/api/health` and run the post-deploy verify steps
  above to confirm the app and crons reconnected.

**Recovery objectives: RPO about 30 minutes for bookings and the other mirrored
tables, 24 hours for everything else, RTO same business day.** A database-only
restore is guaranteed to leave Slate disagreeing with Google Calendar, with the
leads' inboxes and with Regal, because a booking is four writes and only one of them
rolls back. **`docs/dr-runbook.md`** is the step by step: the pre-change dump, the
restore (including from the R2 dump when Supabase's own backups are gone), the
reconciliation order (re-register the push channels FIRST, they fail silently
otherwise), writing the bookings back from Snowflake, and what to do about the
downstream systems that cannot be rolled back at all. Read it before starting a
restore, not during one.

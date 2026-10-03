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
wrangler secret put GOOGLE_CHANNEL_TOKEN    # required; signs/verifies Google calendar push pings. Unset = real-time push verification fails.
wrangler secret put MAIN_OOO_CAL_ID         # required; the OOO approval calendar + default impersonation actor for manager-calendar writes. Unset = OOO approval throws.
wrangler secret put SLACK_BOT_TOKEN         # optional; ops alerts + OOO DMs/digest. Empty = Slack is a no-op.
wrangler secret put SLACK_ALERTS_CHANNEL    # optional; default alert channel id. Empty = alerts have nowhere to post. (Channel id, not sensitive; may live in wrangler.jsonc vars instead.)
wrangler secret put SLACK_INFO_CHANNEL      # optional; quieter info-only channel (#567). Empty = falls back to SLACK_ALERTS_CHANNEL.
wrangler secret put SLACK_SIGNING_SECRET    # optional; verifies inbound Slack Approve/Decline requests. Empty = /api/slack/interactions rejects everything.
wrangler secret put CALCOM_API_KEY          # optional; cal.com dual-write during cutover (needs OOO_CALCOM_DUAL_WRITE). Empty = dual-write no-op.
wrangler secret put TWILIO_API_KEY_SID      # required; TaskRouter-scoped API key SID. The hourly roster sync reads Twilio for the Redistribute tag (#2097). Empty (any of the three) = the Twilio half REFUSES by name and pages on twilio_sync_failures from the second consecutive hourly run (#2774); nobody is taken out of the bookable pool for the tag.
wrangler secret put TWILIO_API_KEY_SECRET   # required; the matching API key secret.
wrangler secret put TWILIO_WORKSPACE_SID    # required; the TaskRouter workspace holding the workers. Not really a secret, but set here so all three live in one place rather than split with wrangler.jsonc.
wrangler secret put REASSIGN_API_KEY        # optional; bearer for the reassign API. Empty = POST /api/bookings/reassign returns 503.
wrangler secret put DUPLICATE_CANCEL_API_KEY # optional; bearer for the duplicate-cancel API (#2369). Empty = POST /api/bookings/cancel-duplicate returns 503.
wrangler secret put OFFBOARDING_API_KEY     # optional; bearer for deactivate/reactivate. Empty = offboarding endpoints return 503.
wrangler secret put BOOKABLE_API_KEY        # optional; bearer for the bookable-toggle API. Empty = POST /api/users/bookable returns 503.
wrangler secret put REGAL_INBOUND_KEY       # optional; bearer Regal's reporting webhook sends to POST /api/regal/calls (#2090). Its own secret, never the outbound Regal key. Empty = that endpoint returns 503 naming it.
wrangler secret put BOOKING_API_KEY_REGAL   # optional; Regal's own booking API key (its journeys cancel through it, as the SLATE_BOOKING_API_KEY brand secret). Logs and the rate ceiling name the caller "regal". One key per caller (#2645): the shared BOOKING_API_KEY pair is retired and read by nothing (#2865). Every booking key empty = POST /api/bookings returns 503.
# wrangler secret put BOOKING_API_KEY_REGAL_2   # optional; Regal's rotation slot, set only when rotating.
wrangler secret put BOOKING_API_KEY_TRYPENNIE # optional; trypennie's own booking API key (the booking confirmed page's lookup, #2643).
wrangler secret put BOOKING_API_KEY_TRYPENNIE_2 # trypennie's rotation slot. SET since 2026-09-28 (#2865): it holds the value trypennie's Vercel SLATE_BOOKING_API_KEY was given, the old shared key, kept rather than rotated so trypennie changes nothing.
wrangler secret put BOOKING_API_KEY_CANARY  # required for the smoke canary (#2822); its own key, recorded as "canary". The GitHub repo secret of the SAME NAME must hold the SAME value: every canary lane, the deploy probe and every heartbeat stamp send it, and a value the Worker does not hold fails them with a 401 and an alert. Empty here = every canary lane fails loudly.
# wrangler secret put BOOKING_API_KEY_CANARY_2  # optional; the canary's rotation slot, set only when rotating.
wrangler secret put BOOKING_API_KEY_MARCIA  # optional; Marcia's own booking API key (#2940), held by the Marcia 5.0 Pipedream workflow as its slate_api_key step prop. It opens POST /api/bookings/cancel (and its DELETE twin) and NOTHING else: every other route refuses it 401. Logs and the rate ceiling name the caller "marcia". Empty = Marcia's cancels are refused 401 and no other caller is affected.
# wrangler secret put BOOKING_API_KEY_MARCIA_2  # optional; Marcia's rotation slot, set only when rotating.
# wrangler secret put BOOKING_API_RETIRED_KEY_HASHES # optional, and NOT SET today (#2879): hashes of RETIRED booking keys, never the keys, as label:sha256:<hash> entries, comma separated (an entry without the sha256: part is refused as unreadable, so a raw key pasted by mistake is caught). A refused request presenting one pages retired_booking_key naming its host and route. Empty = inert. Nothing is retired yet: the old shared key's value is still LIVE as BOOKING_API_KEY_TRYPENNIE_2, and a key in a live slot authenticates, so its hash would never fire (the hash command and the Worker both refuse one). Arm it at the NEXT rotation, once the old value is out of its slot: put it in .env.local as RETIRED_BOOKING_API_KEY, run `pnpm -s hash:retired-key <label> | npx wrangler secret put BOOKING_API_RETIRED_KEY_HASHES`, and once that succeeds run `pnpm -s hash:retired-key --record <label>`, commit docs/retired-booking-key-hashes.txt, then delete the .env.local line. The secret is REPLACED whole and cannot be read back, so the first step prints the whole list from that committed file (hashes, not keys) plus the new entry and writes nothing, and the second adds the entry to the file. A failed put is simply run again, both steps are safe to repeat for the same key, and a missing list file is refused rather than read as empty.
openssl rand -hex 32 | wrangler secret put EMBED_TEST_PASS_SECRET  # required for partner testing (#2666); signs the short lived pass /book hands a page on an EMBED_TEST_ORIGINS website. Piped so the value never appears. Empty = the public test bucket is OFF: /book says so, the routes answer 403 TEST_PASS_OFF, and the canary's gate read pages. Rotating it ends every open test page's pass (a reload fixes it).
wrangler secret put GITHUB_CANARY_TOKEN     # optional; fine-grained GitHub token (Actions read/write on Try-Pennie/slate) so the monitor lane can re-fire the smoke-canary workflow when GitHub drops a scheduled run. Empty = gap-filler is a no-op (GitHub's schedule alone runs the canary).
wrangler secret put UPTIME_HEARTBEAT_KEY    # required; the bearer noodge sends on its /api/health and /api/health/availability checks (#1228), so each stamps its own uptime heartbeat. The same value is SLATE_UPTIME_HEARTBEAT_KEY when noodge applies monitors/slate.sql. Empty = the endpoints never stamp, so both uptime heartbeats go stale and the lane watchdog pages every hour; the health answers themselves are unaffected.
wrangler secret put SNOWFLAKE_PRIVATE_KEY   # optional; RSA private key (PKCS#8 PEM) for the Snowflake archival mirror export lane. Empty = the export lane is a safe no-op (logs "not configured" and skips). See docs/snowflake-setup.md.
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
   `GET /api/smoke/version` (key-authed with `BOOKING_API_KEY_CANARY`) until the live site
   reports that commit, and only then checks `/api/health` and the availability read
   path for the isolated `SMOKE` bucket.

The order is the point. Checking health without first confirming the new version is
live gets a 200 from the *previous* version during Cloudflare's propagation window,
so a completely broken deploy would report healthy. The probe **does not roll back**:
it fails the job, and a failed job on a push to `main` posts a Slack alert
(`.github/workflows/deploy-alert.yml`), which turns "broken until the scheduled
canary notices, up to 30 minutes" into "broken and someone is told in about a
minute".

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

`pnpm cf:deploy` on its own skips both steps, so the live site reports commit `dev`
and the next CI deploy is the first thing to confirm a version again. The occasion for
a hand deploy is an urgent fix when the pipeline is unavailable or too slow, which is
exactly when an unverified release is most expensive, so use:

<!-- runbook-unverified: it deploys production, so running it to prove the command
     would ship whatever happened to be checked out. What IS proven offline is every
     decision it makes before deploying, and that it drives CI's own two scripts in
     CI's own order rather than a second implementation:
     scripts/test-deploy-verified.ts. The deploy and probe steps themselves are the
     same ones the deploy job executes several times a week. -->

```bash
BOOKING_API_KEY_CANARY=<the key the deployment holds> pnpm cf:deploy:verified
```

It runs the same three steps as CI, calling the same two scripts, so the two paths
cannot drift into verifying different things: stamp the commit from `git rev-parse
HEAD`, deploy, then poll the live version and judge health. `APP_URL` targets
something other than production.

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

## Cron
Cron runs entirely on the **main** Worker: `worker/index.ts` `scheduled()`
dispatches each Cloudflare trigger through `worker/cron-routes.ts` to the app's
cron endpoints (`Authorization: Bearer $CRON_SECRET`). Triggers live in
`wrangler.jsonc`; `scripts/test-cron-routes.ts` pins them in lockstep. A single
trigger may drive more than one independent lane (each guards itself with its
own lock). This table mirrors `worker/cron-routes.ts` exactly (the full lane set,
not a subset; `scripts/test-cron-routes.ts` fails CI if any lane below drifts):
- `* * * * *`   → `/api/cron/sync` (backstop calendar sync) **+** `/api/cron/recompute` (bucket_slots freshness) **+** `/api/cron/outbox` (booking-outbox drain, #429) **+** `/api/cron/selfheal` (deletion drain + cancelled/missing reconcile sweeps, #433)
- `*/5 * * * *` → `/api/cron/complete` (mark-complete sweep + webhook retries) **+** `/api/cron/watch` (calendar watch renewal) **+** `/api/cron/monitor` (availability-health probe, #371) **+** `/api/cron/bulk-reassign` (bulk coverage-reassign drain, #973) **+** `/api/cron/booking-reminders` (the 24 hour reminder email to each lead, #2359)
- `0 * * * *`   → `/api/cron/agents` (hourly Salesforce roster reconcile + default hours, single locked path)
- `0 13 * * MON-FRI` **and** `0 14 * * MON-FRI` → `/api/cron/ooo-digest` (pending-OOO morning digest; the two UTC slots straddle DST and the route's time gate lets exactly one fire at 9am ET)
- `0 11 * * *` **and** `0 12 * * *` → `/api/cron/ooo-approvals` (7am ET email of yesterday's OOO approvals; two DST slots, one fires)
- `0 3 * * *`   → `/api/cron/prune-routing` (daily prune of routing_decisions rows older than 12 months) **+** `/api/cron/prune-webhook-payloads` (blank webhook_deliveries payload PII on terminal deliveries older than 90 days, #1073) **+** `/api/cron/prune-bookings-pii` (redact consumer PII on bookings whose appointment is past the 24-month window, enqueue gcal-event deletion, prune delivered outbox rows, #1071) **+** `/api/cron/prune-busy-blocks` (delete cached gcal busy_blocks whose `ends_at` is more than 36 hours past, #1252; that table had no retention and reached 403k rows / 247 MB while only ~3.6k sat inside the readable window. Past rows only: every reader requires `ends_at > now`, so a finished block is unreadable and can never re-enter a window. NOT mirror-gated, unlike its three neighbours, because busy_blocks is a rebuildable cache rather than a mirrored table. Bounded to 30k rows per run, and the run logs `capped` when prunable rows remain) **+** `/api/cron/prune-warehouse-pii` (clear consumer contact data from the SNOWFLAKE mirror for bookings whose appointment is past the same 24-month window, #1180. The mirror half of `prune-bookings-pii`: redacting in Supabase stamps `pii_redacted_at`, which freezes the row from re-export, so the redaction never propagates and only this lane clears the warehouse copy. Not export-gated, since nothing needs archiving before it runs, and it shares its statements with the deletion-request purge so the two cannot clear different field sets. Bounded to 500 bookings per run; the predicate is self-limiting, so a re-run finds strictly less. Fails loud: an unreadable select, an unreadable row count, or a verify that still finds contact data all 500 and withhold the heartbeat) **+** `/api/cron/prune-regal-calls` (delete inbound Regal call events received more than three days ago, #2090. One range delete on an indexed column; not mirror-gated, since the table is not mirrored and holds no lead data) **+** `/api/cron/prune-booking-alert-state` (delete the `alert_state` cooldown rows and firing markers of alerts keyed by booking once that booking both started and was made more than a week ago, #2726. Incidents never resolve, so without it those rows only ever accumulated. The family list is derived from the alert catalog's `suffix: "booking"` declarations; not mirror-gated, since the table is not mirrored)
- `*/15 * * * *` → `/api/cron/hydrate-calendars` (re-bootstraps a slice of the agent calendars over the cached window, #1261; the batch is DERIVED from the live calendar count so every calendar is refreshed at least once a day at any roster size, rather than a fixed number that is right today and halves the refresh rate as the roster grows. Its own expression, never co-scheduled: the every-minute invocation is the one already short of CPU headroom, and this lane makes a real Google call per calendar. Needed because Google's incremental delta is not scoped to the bootstrap window and delivers an unchanged event exactly once, so without a periodic re-bootstrap a far-future event would be dropped by any window filter and never re-added. Stamps `hydrate-calendars` with a matching bound in `LANE_STALE_BOUNDS_MS`, because this lane going quiet means coverage expiring everywhere)
- `*/10 * * * *` → `/api/cron/snowflake-export` (archival-mirror export to Snowflake, #1099; its own expression so it gets its own CPU budget, resumable via export_cursor, no-op until SNOWFLAKE_PRIVATE_KEY is set)
- `17 4 * * *` **and** `17 10 * * *` → `/api/cron/advisor-photos` (daily advisor photo refresh from the Google directory, #3027; the 10:17 run stands down when the 04:17 run already reached a verdict, so it is the automatic re attempt; held back on the load test Worker)
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

Neither is verifiable from this repo, which is the honest limitation of writing them
down here: nothing fails when somebody deletes the notification. What compensates is
that both providers are cheap by architecture rather than by policing (a request
that costs money is a lead booking, and the crons are bounded), and that the
observability notes carry the real headroom numbers to compare against.

## Capacity: the database and the Google quota (#3124)

The Worker's own ceilings (CPU, subrequests, the shared every minute invocation) are
measured and live in `docs/cloudflare-platform-notes.md`. The two shared resources
OUTSIDE Cloudflare are not measured anywhere yet, and this section says what is known
about each, what is not, and how to read the missing half, so the next capacity
question starts from a recorded state rather than a guess.

**The load premise.** How busy Slate really gets is the peak query in
`scripts/loadtest/RUNBOOK.md` ("The peak the 60 a minute bar rests on"), re-runnable
against production. Re-run it before any capacity decision and after cutover (#65),
when Slate stops carrying only the pilot's share.

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

What is not known, and where to read it: the project's **compute size** and the
**database size against its disk** (Dashboard > Project Settings > Compute and Disk),
and the **PostgREST pool size and its saturation** (Dashboard > Reports > Database).
None has been recorded, and none can be read from this repo. Growth is driven by the
append only tables (`booking_events`, `audit_log`, `webhook_deliveries`) and by
bookings, and retention is the only thing that bounds them (`docs/pii-retention.md`).

**Google Calendar API.** What is known: every calendar read and write is made by one
service account through domain wide delegation, so every call Slate makes counts
against the ONE Google Cloud project that owns that service account's OAuth client.
The calls are the every minute sync backstop, Google push channel renewals, the live
`freeBusy` at confirm (batched at Google's 20 calendars a call, #2412), event writes
on book, reschedule and cancel, and the verify commands run by hand. What is not
known: that project's per day and per minute quota for the Calendar API, and how near
Slate runs to it. Read both in the Google Cloud console (APIs and Services > Google
Calendar API > Quotas, and its Metrics tab for the traffic) for the project that owns
`GOOGLE_SA_CLIENT_EMAIL`. A quota refusal (a 429, or a 403 whose reason is
`quotaExceeded` or a rate limit) is classified `transient` by
`src/lib/google/reachability-classify.ts`, so running out reads as a run of
transient calendar failures rather than under a quota name of its own.

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

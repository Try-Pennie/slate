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
   whole migration set with `supabase db push`. Applying only `0001_init.sql`
   leaves a broken schema (missing `bucket_slots`, the booking outbox,
   `monitor_settings`, `is_test`, and more), so it is the whole set or nothing.
   `SHIPPED_MIGRATION_VERSION` (`src/lib/db/migration-version.ts`) is the one place
   that names the current tail, and a guard keeps it equal to the highest file.
2. **Google Cloud** — create an OAuth client (Web). Authorized redirect URIs
   must include your Supabase auth callback **and** `${APP_URL}/api/auth/callback`.
   Enable the Calendar API.
3. **Supabase Auth** enable the Google provider with the same client
   id/secret. No Calendar scopes: sign-in asks for identity only, and calendar
   access is domain-wide delegation through the service account (#1046).
4. **Env:** copy `.env.example` to `.env.local` and fill it in. Beyond Supabase
   and the Google OAuth client, a working instance now also needs the Google
   **service account** for domain-wide delegation (`GOOGLE_SA_CLIENT_EMAIL` /
   `GOOGLE_SA_PRIVATE_KEY`, which drive all calendar reads/writes and
   availability) and **Salesforce** roster sync (`SF_CLIENT_ID` /
   `SF_CLIENT_SECRET` / `SF_INSTANCE_URL`).

   > [!WARNING]
   > **`pnpm dev` talks to whatever `.env.local` names, and there is no staging
   > (docs/adr/0007-no-staging-environment.md).** With production's Supabase URL and
   > secret key in `.env.local`, every row a local run writes is a production row,
   > and with a real `SLACK_BOT_TOKEN` every alert it raises posts to the real
   > alerts channel. For local work, point `NEXT_PUBLIC_SUPABASE_URL` and
   > `SUPABASE_SECRET_KEY` at a separate Supabase project of your own (apply the
   > whole migration set to it as in step 1), and leave `SLACK_BOT_TOKEN` empty,
   > which makes every Slack send a no-op.
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
/booking/{salesforceId}?xbc={bucketCode}&name=&email=&phone=&attendeePhoneNumber=&smsReminderNumber=&loanPurpose=&loanRequest=&estimatedPmt=&active=&submissionId=&regalProfileId=&source=
```

- `{salesforceId}` — opaque, stored and echoed in webhooks (no Salesforce calls).
- `xbc` — resolves to the bucket / round-robin pool.
- `submissionId` and `regalProfileId` (#2659): the partner join keys, the lead's
  Salesforce submission and the Regal contact. Pass each when the page has it and
  leave it off otherwise. They ride in `prefill`, come back on every booking view
  and in the `bookingSuccessful` payload as `submissionId` / `regalProfileId`, and
  reach Regal as `sfdc_submission_id` / `regal_profile_id`.
- `source` (#2072): the page the lead is booking from, one of the values below.
  cal.com told these apart by which event type took the booking; Slate books them
  all through one flow, so the page says where it is instead. The booking records
  it in `bookings.source` (and the Snowflake mirror), and the admin booking page
  shows it with the cal.com event type it replaces. A link with no `source` is
  recorded as `not-given`, and one naming a value not in this list is still booked
  and recorded as `unrecognised`, with the raw value logged under
  `tag=booking-source` so the link can be found and fixed. The same key works on
  `/book` and through `widget.js` (put it on the `data-cal-link` query string).
  A booking API call (`POST /api/bookings`) may send one of these in `prefill.source`
  too; one that sends none is recorded as its caller, `api-regal`, `api-trypennie` or
  `api-canary` (#2876), never `not-given`, so it is not mistaken for a landing page
  booking. Those values are set from the key that authenticated the call and are
  refused (recorded `unrecognised`) on a link.

  | `source` | page | cal.com event type |
  |---|---|---|
  | `my-offers-result` | `/my-offers/result` | review |
  | `booking` | `/booking`, not eligible for the AI agent | review |
  | `booking-agent-eligible` | `/booking`, eligible for the AI agent | connect |
  | `booking-portal` | `/booking/portal` | call |
  | `offerhub` | `/offerportal`, from its Income Verification pop ups | call |
  | `rml-portal` | `/rml/portal` | income |
  | `email-booking` | the email booking link | terms |
  | `guided-app` | guided application completion | apply |
  | `agent-direct` | an advisor's direct link | meet |
  | `pennie` | `/pennie` | review |
  | `review-terms` | `/review-terms` | terms |
  | `my-offers-result-2` | `/my-offers/result-2` | review |
  | `income-landing` | the `/portal-2` or `/portal-3` calendar | call |

  The list and the mapping live in `src/lib/booking/booking-source.ts`, and
  `scripts/test-booking-source.ts` holds this table, the code and the database
  constraint to one another.
- Everything else prefills the form and is forwarded in the webhook payload.

### An agent's own booking link (#2073)

```
/book/advisor/{token}?external_id=&name=&email=&phone=
```

The link an agent sends a lead for a later call with them, replacing their personal
cal.com link. It books THAT agent and nobody else: no bucket resolution, no round
robin, no tier ladder, no fallback. Every availability gate still runs for them
(the org's hours, their working hours, their calendar, the daily cap), and verify on
book asks live Google about them alone.

- `{token}` is 64 hex characters, random, one per user (`agent_links`, migration
  0144), never the email. The agent sees it on `/me/my-availability`; an admin
  replaces it from the agent's console page, which stops the old link at once.
- The one call per person rule (#1337) does not apply: a later call with a lead who
  already has one is what the link is for. An exact double submit still collapses.
- The booking records `kind = 'agent_link'`, and every monitor, rate and routing
  reader filters to `kind = 'routed'` (`scripts/test-routed-booking-reads.ts`).
  Webhooks fire as for any booking and carry `booking_kind`. Regal gets what
  cal.com's personal links send, so journey 304 keeps working: a create, move
  or cancel arrives as `Client Sync Action` with `action` (`BOOKING_CREATED`,
  `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`), `scheduled_at` (the call start,
  ISO UTC) and `agent_email`, never as a `Slate Booking ...` event. A reassign
  or completion sends Regal nothing (recorded as suppressed), since the personal
  link had no equivalent.
- A link that books nobody (unknown, replaced, departed, not bookable) draws one
  sentence whatever the cause. `source` defaults to `agent-direct`.

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

`public/widget.js` is a drop in for cal.com's `embed.js`: the same loader
snippet, the same `Cal()` API, the same `data-cal-link` trigger. Swapping a
cal.com page to Slate is the script src plus the `origin` (`public/embed-example.html`
is the working copy).

```html
<script>
  /* the standard cal.com loader snippet, pointed at Slate */
  (function (C, A, L) { /* ... as in public/embed-example.html ... */ })(window, "https://YOUR-SLATE/widget.js", "init");
  Cal("init", "review", { origin: "https://YOUR-SLATE" });
  Cal.ns.review("on", { action: "bookingSuccessfulV2", callback: (e) => console.log(e.detail.data) });
</script>
<button data-cal-link="router?xbc=411&external_id=00Q..." data-cal-namespace="review">Book a call</button>
```

The widget announces the booker lifecycle under cal.com's own event names
(#2658), so a host's GTM listener needs no Slate branch: `navigatedToBooker`,
`bookerViewed`, `bookerReady`, `bookerReopened`, `bookerReloaded`, `linkFailed`,
`bookingSuccessfulV2`, `rescheduleBookingSuccessfulV2`, `bookingCancelled`, plus
`*` for all of them and the original `bookingSuccessful`, kept unchanged. Record
a booking from `bookingSuccessfulV2` or from `bookingSuccessful`, never both.
No event carries the lead's contact. The full table, the raw `slate:*` messages
behind each event and the payload shapes are in the `slate-embed-contract`
skill, section 4.

To test the embed end to end without booking a real advisor, use `xbc=PARTNER`
(#2660) from a host page on a website listed in `EMBED_TEST_ORIGINS` (#2666;
any other website is refused and told why): a public test bucket on the smoke
test agent's calendar, marked as a test on every screen, with no webhook and no
text. What a
tester will see is in the `slate-embed-contract` skill; seeding it is in
`DEPLOY.md`, beside the canary's hidden `SMOKE` buckets.

To show the booker to somebody outside Pennie, send `https://slate.trypennie.app/demo`
(#3424). It opens the booker directly on a second public test bucket, `DEMO`, on the
same test agent, prefilled with a made up person per visit (`demo+<code>@trypennie.com`
and a 555-01xx number, so two visitors never read as one person). Every screen shows a
Demo band, and each booking cancels itself 30 minutes after it is made, on the complete
lane (`src/lib/booking/demo-auto-cancel.ts`). `/book` refuses the `DEMO` code from every
website, so the demo page is the only way in. The seed that creates `PARTNER` creates it too.

## Layout

```
src/lib/availability   slot computation (compute.ts) + cache-first loading (service.ts)
src/lib/booking        create / reschedule / cancel + round-robin + verify-on-book + reservations/outbox (crash-safety)
src/lib/agent-link     an agent's own booking link (#2073): the token, who it books, and that one agent's times
src/lib/busy           retention for the cached busy_blocks index (past-row prune)
src/lib/routing        bucket resolution + equal-share ranking + tier fallback + routing-decision log
src/lib/google         OAuth, calendar ops, push/incremental sync, freeBusy
src/lib/monitor        availability-health probe + booking-volume alert + tunable settings
src/lib/handoffs       bookings waiting on a person in sales: the record, its Slack notice, its delivery
src/lib/webhooks       HMAC-signed delivery + retry
src/lib/salesforce     hourly roster sync (agents, teams, attributes)
src/lib/ooo            out-of-office requests, approvals, digests
src/lib/slack          ops alerts + OOO DMs + Approve/Decline interactions
src/lib/notify         throttled alert dispatch (shared by monitor/booking/routing)
src/lib/snowflake      archival mirror exporter (key-pair JWT client + MERGE builder)
src/lib/offboarding    deactivate / reactivate departed agents
src/lib/bookable       move an agent in/out of the booking pool (bookable flag) + activation guard
src/lib/auth           login provisioning + role/RBAC + admin impersonation
src/lib/automations    Pennie's automations service: the texting line after Call me now (#3718)
src/lib/http           edge-level request handling (http->https redirect, served by worker/index.ts)
src/lib/platform       which runtime we are on, so a dev machine never pages about production
src/lib/errors         what an error boundary says when a page could not finish
src/lib/cloudflare     reading Cloudflare's GraphQL Analytics answers (the load run judge)
src/lib/theme          one rule for which theme a person gets: the pre-hydration boot script and its runtime half
src/lib/twilio         the TaskRouter read: who carries the Redistribute tag, and the flip out of the pool it decides
src/lib/regal          the inbound Regal call feed: what each call.completed body means, and its retention
src/lib/mcp-booking    Marcia's booking MCP endpoint (#3541 to #3545): her lead token check, the five booking operations behind McpBookingGateway, and their audit rows
src/lib/log-shipping   what the slate-log-tail Worker ships to Better Stack: the redaction, the line parser, the bounded POST
src/lib/advisor-photos advisor photos from the Google directory: the daily refresh, its guards, and the one resolver every face goes through
src/lib/advisors       the one real advisor rule: which users rows (not test, not the placeholder, not a coordinator) any advisor surface lists (#4201, #4205)
src/lib/coordinator    the coordinator booking page's operations: find the customer by Salesforce Lead id, their call and the day's hours, the placeholder count, placing a call, and every sentence (#4205)
src/lib/program-leads  registering a program lead (#4388): Bidspoke's Lead id read, checked and marked for 30 days
src/lib/zip-zones      a customer's time zone from their Lead's zip, then state, through a table generated from GeoNames (scripts/generate-zip-zones.ts)
src/lib/{calcom,date,db,embed,supabase}   cal.com dual-write, Luxon helpers, hand-written DB types, embed origin, Supabase clients
src/app/api            availability, bookings, auth callback, google push, cron/* lanes, keyed reassign/booking/offboarding APIs
src/app/admin          admin: agents, hours, event types, buckets, webhook, settings, monitor tuning
src/app/booking        public booking page + self-serve manage page
src/app/book           short-code booking entry
src/app/demo           the demo link for outside viewers (DEMO test bucket, auto cancelled after 30 min)
src/app/advisor-photo  the public, content addressed advisor photo route
src/app/me             agent self-serve (hours, calendar, OOO)
src/app/coordinator    the scheduling coordinators' booking page: its server functions, role checked (#4205)
src/app/login          Google SSO
src/app/partner        the partner sign in page: invited coordinators, Microsoft only (#4379)
worker/                Cloudflare Worker entry (index.ts) + cron dispatch (cron-routes.ts) + the log tail Worker (log-tail/, config wrangler.log-tail.jsonc)
scripts/               node-native tests (test-*.ts) + migration / env / doc drift guards
public/widget.js       embed SDK (inline + popup)
supabase/migrations    schema (apply the whole set; see SHIPPED_MIGRATION_VERSION)
```

Deeper context: `docs/architecture.md` (two diagrams: the booking path, and the
three writers that keep availability fresh), `CONTEXT.md` (domain glossary),
`DEPLOY.md` (deploy + cron runbook), `docs/api.md` (full HTTP API reference),
`docs/booking-api.md` (Direct Booking API integrator guide), and `docs/adr/`
(architecture decisions, indexed in `docs/adr/README.md`).

Process: `docs/review-process.md` (how code gets reviewed here, and what the
automated gates provably cannot do).

Targets and alerting: `docs/slo.md` (what Slate promises and what watches each
promise), `docs/alerts-runbook.md` (you were paged, what now).

Runbooks: `docs/migrations-runbook.md` (applying a schema change),
`docs/smoke-test-runbook.md`, `docs/dr-runbook.md`,
`docs/pii-erasure-runbook.md`, and `docs/admin-lockout-runbook.md` (nobody can
reach `/admin`).

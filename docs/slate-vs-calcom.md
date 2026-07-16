# Slate vs Cal.com (internal comparison)

Audience: this document has two readers in mind. The first section is a plain
language summary for leadership (no engineering background assumed). The
sections after it go deeper for the technical staff who will maintain Slate.

Status of the numbers: the performance figures below were measured during the
build of the precomputed availability work (PR #256 and the validation spike
that preceded it, June 2026). Where a number comes from that work it is labelled
with its source. A fresh production benchmark was **not** re-run at the time this
document was written, so before any figure is quoted outside the company it
should be re-measured against production (issue #246 tracks turning the one-off
spike into a committed, repeatable benchmark; until that lands nothing automated
protects these numbers from regression).

---

## 1. Executive summary (for leadership)

**What Slate is.** Slate is our own booking tool that replaces Cal.com for the
one job Pennie actually needs: a lead lands on a Pennie page, picks a time, and
gets routed to the right debt agent automatically. It is built to fit Pennie
(our routing rules, our brand, our downstream systems) rather than being a
general purpose product we bend to fit.

**Why we built it instead of staying on Cal.com.** Three reasons.

1. **Speed.** Cal.com computes availability live across the whole pool of agents
   every time a lead opens the booking window. With our roster that took
   **roughly 8 to 9 seconds** on a typical load, and as long as **21 seconds** on
   a bad one, before a single time slot appeared. Slate serves the same list of
   times from a prepared cache, so the common case is measured in **tens of
   milliseconds** and the worst case we observed was still a fraction of a second.
   In plain terms: leads see times almost instantly instead of watching a spinner
   for several seconds, which directly protects booking conversion.

2. **Control.** Our routing is specific to Pennie (the XBC code system, the debt
   bucket pools, keeping a lead with the agent who already owns the relationship).
   Owning the code means we can change routing, branding, and downstream behaviour
   on our own schedule instead of working around a third party product's limits.

3. **Fit.** Slate speaks directly to our downstream systems (Regal and Cadence)
   through webhooks, syncs to each agent's Google Calendar, and carries the Pennie
   brand end to end. It runs on infrastructure we already pay for.

**What we give up.** Cal.com is a mature product with a large feature surface
(many calendar integrations, payment collection, a marketplace of app
integrations, public per user booking pages, and so on). Slate deliberately does
**not** try to match all of that. It does the Pennie booking flow very well and
leaves the rest out. If Pennie's needs broaden into general purpose scheduling,
that gap is the thing to revisit.

**Cost posture.** Slate runs on infrastructure we already operate (Cloudflare
Workers, Supabase, our existing Google and Salesforce integrations). It adds no
per seat licensing and, by design, no expensive always on services. See the cost
section for the honest caveats.

---

## 2. Feature comparison

The table separates three things: where Slate matches Cal.com, where Slate is
**intentionally different** (a deliberate design choice for Pennie), and where
Slate is **deliberately narrower** (we chose not to build it).

| Capability | Cal.com | Slate | Notes |
|---|---|---|---|
| Lead picks a time and books | Yes | Yes | Core flow, matched. |
| Availability across a pool of agents | Yes (live compute) | Yes (precomputed cache) | Same outcome, very different mechanism. See speed section. |
| Round robin assignment | Yes (generic round robin) | Yes, Pennie specific | Slate routes into debt bucket pools keyed by XBC code. Intentionally different. |
| Routing by form answers | Yes (routing forms) | Yes, via XBC code | Slate uses a 3 digit XBC contract to resolve the correct bucket. Intentionally different. |
| Keep a lead with their existing agent | Limited | Yes (contact owner stickiness) | If a lead already has an owning agent, Slate prefers that agent. Intentionally different. |
| Google Calendar sync | Yes | Yes | Two way: reads busy times, writes the booked event. |
| Prevent double booking | Yes | Yes (verify on book) | Slate does one live free/busy check of the round robin candidates at confirm time plus a unique index guard. |
| Embed anywhere | Yes | Yes (widget.js) | Slate's embed mirrors the Cal.com embed contract so it is a drop in swap on trypennie.com. |
| Webhooks to downstream systems | Yes | Yes (Regal / Cadence) | Slate emits booking events with retry and a dead letter path. |
| Brand / design control | Themeable | Full (Pennie Design System) | Slate is built in Pennie's design system, both light and dark. |
| Role based admin (agent / manager / admin) | Yes | Yes | Server side enforced; admin can impersonate for support. |
| Out of office / time off handling | Yes | Yes | Time off updates availability immediately. |
| Reschedule and cancel | Yes | Yes | In place reschedule runs the same slot rules as the booker. |
| Many third party calendar providers (Office 365, CalDAV, etc.) | Yes | **No** | Deliberately narrower: Google Calendar only. |
| Payment collection at booking | Yes | **No** | Deliberately narrower: not part of the Pennie flow. |
| App / integration marketplace | Yes | **No** | Deliberately narrower. |
| Public per user booking pages | Yes | **No** | Deliberately narrower: Slate is a routed pool, not personal pages. |
| Self serve multi tenant / multiple organizations | Yes | **No** (single org) | Slate is built for one organization (Pennie). Bucket codes are resolved globally, which is fine for a single org and would collide across orgs. |

**The three intentional differences worth understanding:**

- **XBC routing.** A short (3 digit) code carried on the booking URL maps a lead
  to exactly one debt bucket. This encodes Pennie's routing policy (including the
  legal filter deviation from plain cal.com parity) rather than a generic form.
- **Round robin debt bucket pool.** Instead of Cal.com's generic round robin
  across a team, Slate routes into a pool of agents that serve a given bucket and
  balances across them, with a fairness ranker so no agent is starved or
  overloaded.
- **Contact owner stickiness.** When a lead already has an owning agent (decided
  upstream in the contact center, not by Slate), Slate prefers routing the
  booking back to that agent so the relationship stays intact.

---

## 3. Speed and performance

This is the headline reason Slate exists, so the numbers matter and their origin
is stated explicitly.

### The Cal.com bottleneck

When a lead opens the Cal.com booking window, Cal.com computes availability
**live**, across the entire routed roster, before it can show any times. Measured
against the trypennie.cal.com routing flow (Playwright, June 2026), the routed
event carried **72 team member IDs**, and the availability call that fans out
across all of them took roughly **8.2 to 8.5 seconds** on cold loads, with first
usable slots appearing around **9 to 15 seconds**. The fuller distribution
captured for the internal writeup was a **median of about 8.8 seconds, a best of
about 6.3 seconds, and a worst of about 21 seconds**. The bottleneck is the
synchronous multi agent compute on the request path, not the front end.

Source: live measurement of trypennie.cal.com, June 2026 (recorded in the
availability speed initiative and in PR #256's description).

### The Slate approach and its numbers

Slate flips the model from **compute on request** to **compute on change**. It
keeps a prepared, pre unioned list of open slots per bucket and serves it with a
single indexed lookup behind Cloudflare's Cache API. The expensive multi agent
compute never runs on the lead's path.

Measured on the real default booker path (PR #256, deployed to production and
re-measured):

| Path | Slate median | For comparison |
|---|---|---|
| Warm (cache hit, the common case for a lead) | **about 39 ms** | roughly 225x faster than Cal.com's median |
| Cold (cache miss, reads the precomputed row) | **about 148 ms** | faster than Cal.com's *best* case (about 6.3 s) by a wide margin |
| Cal.com baseline | about 8.8 s median (best 6.3 s, worst 21 s) | measured live |

Source for the 39 ms / 148 ms figures: PR #256 ("Precompute availability")
description, which records them as measured on the live default path after
deploy. The validation spike that preceded PR #256 swept all 60 XBC buckets and
saw cold single row reads in the range of roughly 99 to 278 ms with zero
failures, and warm cache hits around 23 to 35 ms. A key finding from that spike:
the cold path is **compute bound, not connection bound**, which is why a
connection accelerator (Hyperdrive) was judged unnecessary and no expensive
infrastructure was added.

### Verification status (read before quoting these)

- The **39 ms warm / 148 ms cold** and the **8.8 s Cal.com median** figures are
  real measurements from the June 2026 work, sourced as above. They are **not**
  freshly re-measured as of this document's writing.
- Before quoting any of these outside the company, **re-run the benchmark against
  current production**. Issue #246 tracks committing a repeatable cold plus warm
  benchmark (against a Cal.com baseline) so this stops being a one off spike;
  until it lands, no automated test guards the win and a regression to per request
  compute would pass every current test (noted in #246 and #240).
- Treat any figure not labelled with a source above as **unverified**.

---

## 4. Architecture and maintainability (for technical staff)

The one sentence model: **availability is cache first, correctness is held by one
targeted live check at booking time.** Everything below serves that.

### Availability is a cache, not a live computation

- `busy_blocks` is the cached busy index. `bucket_slots` holds the pre unioned
  open slots per bucket that the booker actually reads.
- The embed reads availability through `/api/availability`, which serves the
  cached rows behind the Cloudflare Cache API. **It never calls Google live on
  the read path.**
- Three things keep the cache fresh:
  1. **Write through.** Slate's own bookings, time off changes, and Google push
     events update the affected buckets synchronously (debounced per bucket), so
     the common changes are reflected in seconds.
  2. **Push sync.** `/api/google/push` receives Google Calendar change
     notifications so externally made calendar edits refresh quickly.
  3. **Cron backstop.** A one minute cron (`/api/cron/sync` and the recompute
     lane) recomputes changed buckets first, then rotates the least recently
     computed, and alerts if any row goes stale beyond its budget.

### The one live Google call: verify on book

The only live Google call on the hot path happens at confirm time in
`src/lib/booking/service.ts`. It checks the round robin candidates in batched
waves (one Google call per wave, #167) and takes the first agent who is actually
free. A briefly stale displayed slot degrades safely to a 409 at this step. The
two double book guards are this verify on book check and the active slot unique
index; the availability optimization never weakens them (it only changes which
slots are *displayed*).

### Sync model

- Each agent's Google Calendar is the source of truth for their busy time.
- Domain wide delegation (a Google service account) drives calendar reads and
  writes; freeBusy calls are batched because Google caps a freeBusy request at 20
  calendars, and the roster is designed for 100 to 200 agents (see the scale
  assumption).
- Calendar watch channels are renewed on a schedule; failures alert to Slack.

### Downstream webhooks

- Booking events are emitted to Regal and Cadence through
  `src/lib/webhooks/emit.ts`. Delivery is recorded, retried on failure, and dead
  lettered with an alert after repeated failures.
- Test bookings are suppressed at the emission choke point so a smoke test never
  leaks a fake booking into Regal.
- There is currently no HMAC signing on the Regal side (tracked separately); one
  Regal side configuration step is owed.

### Deploy and platform

- Slate deploys to **Cloudflare Workers** via OpenNext (`pnpm cf:build` /
  `pnpm cf:deploy`). It is not on Vercel.
- Crons run as Cloudflare Worker triggers declared in `wrangler.jsonc`; a single
  every minute trigger fans out to independent lanes (sync, recompute, outbox,
  self heal), each under its own lock, sharing one invocation budget. There are
  real CPU and subrequest ceilings per invocation; see
  `docs/cloudflare-platform-notes.md` before touching cron work.
- **Migrations are deliberate.** Deploys do not apply Supabase migrations. Every
  schema change is a `supabase db push` before the matching PR merges, with
  `SHIPPED_MIGRATION_VERSION` bumped in the same commit. Follow
  `docs/migrations-runbook.md` rather than reasoning out the order per PR.
- Server code uses the Supabase **secret key** client (bypasses RLS); RLS is
  default deny and the only client readable row is a user reading itself.

### What technical staff need to watch

- **Cache freshness.** If the recompute lane stalls, the booker shows stale
  slots. The staleness alert and the verify on book fallback are the safety nets.
- **Migration lag.** Shipping code ahead of its schema pages the on call monitor.
  Never apply migrations through the Supabase MCP tool (it disables the lag
  monitor).
- **Reading production logs.** Every server log line goes through
  `src/lib/log.ts` with a searchable `tag=`. There are several Cloudflare log
  query gotchas that produce convincing false negatives; read the Cloudflare
  platform notes before concluding the logs are broken.

### Tests

Two harnesses on purpose: Vitest for code that needs module mocking, and node
scripts (`scripts/test-*.ts`) for pure logic and repo invariant guards. A pre
push hook runs the CI checks locally (typecheck, lint, unit tests, and the full
Cloudflare build).

---

## 5. Cost

**Slate.** Runs on infrastructure Pennie already operates: Cloudflare Workers,
Supabase, the existing Google Calendar integration, and the Salesforce roster
sync. There is no per seat license. The precompute design was chosen
specifically to avoid a large recurring bill: the spike proved the cold path is
compute bound, so no always on accelerator (Hyperdrive, read replica, persistent
cluster) was added, and the new storage (`bucket_slots`) is additive and small.

**Honest caveats.** "No new licensing" is not "free." Slate consumes Cloudflare
Worker invocations and Supabase capacity, and it carries an ongoing engineering
maintenance cost that a bought product would absorb for us (sync reliability,
calendar watch renewal, monitoring, the migration discipline above). The trade is
deliberate: we pay in owned maintenance to gain speed, control, and fit.

**Cal.com.** A hosted Cal.com plan bills per seat, which at a 100 to 200 agent
roster is the larger and more variable line item, and it would still leave us
working around the routing and speed limits described above. Self hosting Cal.com
would remove the per seat cost but hand us the same maintenance burden as Slate
**plus** a much larger codebase we did not write.

---

## 6. Other points for leadership

- **Control and ownership.** We own the code, the routing policy, and the release
  schedule. Changes to how leads are routed or how the booker looks do not depend
  on a vendor.
- **Brand and UX fit.** Slate is built in the Pennie Design System (the sky action
  color, PP Mori type, warm partner voice), light and dark, with accessibility
  held to WCAG 2.1 AA. The confirmation screen carries one branded delight moment.
  Cal.com is themeable but was never going to feel first party.
- **Security and RBAC.** Roles are agent, manager, and admin, enforced server
  side. Admin impersonation ("view as") is gated and time limited. API routes are
  built with authentication and single org data scoping as a requirement, not a
  later pass.
- **Reliability posture.** Bookings are crash safe (an outbox pattern for
  webhooks), the availability cache self heals, and a set of monitors page on
  problems (stale availability, low booking volume, schedule less agents, sync
  failures). Log retention is 7 days and is for forensics; anything that must page
  someone uses a real alert sink.

---

## 7. Summary trade-off

Slate trades **breadth** for **fit and speed**. We gave up Cal.com's large
general purpose feature surface and took on the maintenance of our own service.
In return we got booking that is roughly two orders of magnitude faster on the
lead's path, routing that encodes Pennie's actual policy, a first party brand
experience, direct webhooks to our downstream systems, and no per seat license.
For Pennie's single, well defined booking flow that is the right trade. The point
to revisit it is if Pennie's scheduling needs broaden into the general purpose
territory Cal.com already covers.

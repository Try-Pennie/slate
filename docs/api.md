# Slate HTTP API reference

The single authoritative reference for every HTTP endpoint Slate exposes, read
from the route handlers under `src/app/api/`. For a deeper, task-oriented
integrator guide to the key-authed booking flow (worked examples, dedupe and
rebook semantics, the read to book race), see `docs/booking-api.md`. This file is
the flat reference: method, path, who may call it, request shape, response shape,
status and error codes, and idempotency, for the whole surface.

## Contents

- [Credentials and auth models](#credentials-and-auth-models)
- [Booking API (key-authed, machine caller)](#booking-api-key-authed-machine-caller)
  - [POST /api/bookings (create, rebook, dry run)](#post-apibookings)
  - [GET /api/bookings (lookup and list)](#get-apibookings)
  - [DELETE /api/bookings (cancel)](#delete-apibookings)
- [GET /api/availability (public cached read)](#get-apiavailability)
- [POST /api/routing (public routing resolve)](#post-apirouting)
- [POST /api/bookings/reassign (key-authed contact-owner reassign)](#post-apibookingsreassign)
- [Offboarding lifecycle (key-authed)](#offboarding-lifecycle-key-authed)
- [Bookable toggle (key-authed)](#bookable-toggle-key-authed)
- [Webhooks emitted to Regal and Cadence](#webhooks-emitted-to-regal-and-cadence)
- [Customer self-serve manage routes (token-authed)](#customer-self-serve-manage-routes-token-authed)
- [Admin routes (session-authed, internal)](#admin-routes-session-authed-internal)
- [Platform and infrastructure routes](#platform-and-infrastructure-routes)
- [Environment variables that gate the API](#environment-variables-that-gate-the-api)

---

## Credentials and auth models

Slate uses four distinct credential types across its routes. Each route below
names which one it requires.

| Auth model | Header | Backing secret(s) | Used by |
|---|---|---|---|
| Booking API key | `Authorization: Bearer <key>` | `BOOKING_API_KEY`, `BOOKING_API_KEY_2` | `POST/GET/DELETE /api/bookings`, and (for hidden test buckets only) `GET /api/availability` |
| Reassign API key | `Authorization: Bearer <key>` | `REASSIGN_API_KEY` | `POST /api/bookings/reassign` |
| Offboarding API key | `Authorization: Bearer <key>` | `OFFBOARDING_API_KEY` | `POST /api/users/lifecycle`, `POST /api/users/deactivate`, `POST /api/users/reactivate` |
| Bookable API key | `Authorization: Bearer <key>` | `BOOKABLE_API_KEY` | `POST /api/users/bookable` |
| Cron secret | `Authorization: Bearer <secret>` | `CRON_SECRET` | every `GET /api/cron/*` lane |
| Google channel token | `X-Goog-Channel-Token` header | `GOOGLE_CHANNEL_TOKEN` | `POST /api/google/push` |
| Slack signature | `X-Slack-Signature` + `X-Slack-Request-Timestamp` | Slack signing secret | `POST /api/slack/interactions` |
| Supabase session (staff) | session cookie | Supabase Auth | `/api/admin/*`, `/api/users` reads |
| Manage token | in the URL path | per-booking `manage_token` | `POST /api/bookings/[token]/cancel`, `.../reschedule` |
| None (public) | n/a | n/a | `GET /api/availability`, `POST /api/routing`, `GET /api/health`, `GET /api/auth/callback` |

Every Bearer credential is compared in constant time (`src/lib/bearer-auth.ts`).
For the booking API, two keys are accepted at once (primary plus secondary) so
the secret rotates with zero downtime: add the new value as the secondary, point
the caller at it, then retire the old primary. A route whose backing secret is
unset fails closed with `503` (the endpoint is effectively disabled), which is
distinct from `401` for a present but wrong credential.

---

## Booking API (key-authed, machine caller)

Source: `src/app/api/bookings/route.ts`. A key-authed endpoint the external
booking automation calls to create a fully routed booking server-side, applying
the same XBC bucket routing, round-robin assignment, and verify-on-book as the
embed. Refs #253 and #250. All three methods share one auth plus rate-limit gate
(`authorize`).

**Auth (all methods):** `Authorization: Bearer <BOOKING_API_KEY>` (or
`BOOKING_API_KEY_2`). Missing or wrong key: `401`. No key configured: `503`.

**Rate limits:** per key, with separate ceilings for writes and reads so status
polling cannot starve the booking path (#393). A coarse per-IP backstop also
applies to writes (not reads) so a single leaked-key host cannot spend the whole
budget (#597). Over a ceiling returns `429`.

### POST /api/bookings

Create a booking, or (by re-submitting the same person) move an existing one.

**Request body** (validated by `src/lib/booking/api-request.ts`, strict):

```jsonc
{
  "bucketCode": "411",                 // required, XBC bucket code
  "start": "2026-07-01T15:00:00Z",     // required, ISO 8601 instant WITH an explicit
                                       //   offset (Z or +/-HH:MM); a bare local time is rejected
  "timezone": "America/New_York",      // required, a real IANA zone (not "EST"/"")
  "attendee": {                        // required, all three fields validated
    "name": "Dana Lee",
    "email": "dana@example.com",
    "phone": "+12155550100"
  },
  "externalId": "00Q5x000001abcEAA",   // required, the lead's stable per-person id
  "salesforceId": "00Q5x000001abcEAA", // optional, defaults to externalId
  "prefill": { "utm_source": "regal" },// optional, string map, forwarded in webhooks
  "confirmReschedule": false,          // optional, allows a weak-match move (see below)
  "dryRun": false                      // optional, preview without side effects
}
```

**Dedupe and rebook.** Before creating, the service looks the person up across
active bookings (by `externalId`, then `salesforceId`, then attendee email or
phone). The result is reported as an `outcome`:

| Situation | `outcome` | HTTP |
|---|---|---|
| No existing appointment | `created` | 200 |
| Same person, same slot, same bucket | `deduped` | 200 |
| Same person, same slot, different bucket | `rescheduled` | 200 |
| Same person, different time, confident match | `rescheduled` | 200 |
| Same person, different time, weak match (email or phone only) | `confirm_required` | 409 |

A `confirm_required` makes no change and returns the existing booking; the caller
confirms with the lead and retries with `confirmReschedule: true`. A `deduped`
may carry a `bucketChangeDeclined` object when a requested bucket change could
not be made; see `docs/booking-api.md` for the full rebook and cross-bucket-move
semantics.

**Success response** (`200`, or `409` for `confirm_required`):

```jsonc
{
  "outcome": "created",
  "booking": {
    "id": "…",
    "externalId": "lead-abc-123",
    "startsAt": "2026-07-01T15:00:00.000Z",
    "endsAt": "2026-07-01T15:30:00.000Z",
    "status": "confirmed",
    "agent": { "name": "…", "email": "…" },
    "manageUrl": "https://…/booking/manage/<token>"
  },
  // #1515: which team owns the lead. `code` is the bucket they are ACTUALLY in,
  // which a cross bucket rebook or a tier drop can move away from the one asked
  // for. Null when the booking predates the routing trace, never the requested
  // code standing in. See docs/booking-api.md for the full field table.
  "bucket": { "code": "421", "requestedCode": "411", "tierFallback": true, "rungsDropped": 1 }
}
```

**Dry run** (`"dryRun": true`): runs the real routing but creates no calendar
event, no booking, and no webhook. Returns:

```jsonc
{ "dryRun": true, "outcome": "created",
  "wouldAssign": { "id": "…", "name": "…", "email": "…" }, // null unless outcome is "created"
  "existingBookingId": null }                              // set for deduped/rescheduled/confirm_required
```

**Error contract.** Every failure returns `{ "error": "<message>", "code":
"<CODE>" }` (plus `fieldErrors` for `VALIDATION`). Branch on `code`, never on the
message. An `INTERNAL` returns a generic message and logs the real detail
server-side (#707), and routes through the same alerting chokepoint as every
other unexpected fault (#802).

| `code` | HTTP | Meaning | Caller action |
|---|---|---|---|
| `VALIDATION` | 400 | Bad request body | Fix the request, do not retry as-is |
| `UNKNOWN_BUCKET` | 422 | Bucket code resolves to nothing | Config error, stop and escalate |
| `NO_ELIGIBLE_AGENTS` | 409 | Bucket has zero eligible agents | Config error, stop and escalate |
| `SLOT_TAKEN` | 409 | Slot filled before booking | Re-query availability, pick another slot |
| `VERIFY_UNAVAILABLE` | 503 | Could not confirm calendars (transient) | Retry shortly |
| `INTERNAL` | 500 | Unexpected | Retry once, then escalate |

**Idempotency.** Re-submitting the same `externalId` plus slot is safe: it
dedupes to the existing booking (`deduped`) rather than creating a second one.
The create path is itself crash-safe (reservation-backed, #429), so a retried or
mid-flight create resolves to a single booking and a single set of side effects.

### GET /api/bookings

Two modes, chosen by whether the `externalId` query key is present. Uses the
read rate ceiling and opts out of the per-IP write backstop.

**Lookup mode** (`externalId` present), read one person's bookings:

```
GET /api/bookings?externalId=<id>                                  # active bookings for the person
GET /api/bookings?externalId=<id>&bookingId=<uuid>                 # one booking, any status
GET /api/bookings?externalId=<id>&bookingId=<uuid>&status=confirmed # assert a status, else 404
```

- `externalId` (required, strong id). Optional `salesforceId` narrows further.
- `status` (by-id only): one of `confirmed`, `rescheduled`, `cancelled`,
  `completed`. An unrecognized value is `400 VALIDATION`.
- Response (list): `{ "bookings": [ <view>, … ] }` (empty array if none).
- Response (by id): `{ "booking": <view> }`.
- Not found, not owned, or status mismatch: `404 { "code": "NOT_FOUND" }`.

**List mode** (`externalId` key absent), cross-person paginated list for ops and
reporting. All filters optional:

| Parameter | Type | Notes |
|---|---|---|
| `bucket` | string | Single XBC bucket code |
| `agentEmail` | string | Single agent |
| `status` | string | `confirmed` \| `rescheduled` \| `cancelled` \| `completed` |
| `afterStart` | ISO instant with offset | `starts_at` at or after |
| `beforeEnd` | ISO instant with offset | `starts_at` at or before |
| `updatedSince` | ISO instant with offset | Updated at or after; switches ordering to `updated_at` ascending, for incremental polling |
| `limit` | integer | Default 50, capped at 100 |
| `cursor` | string | Opaque offset cursor from the prior page's `nextCursor` |

Response: `{ "bookings": [ <view + bucketCode>, … ], "nextCursor": "<opaque>" | null }`.
`nextCursor` is present only when the page came back full. The offset is capped at
10000 rows; beyond it returns `VALIDATION` (narrow the date range instead).

Passing `externalId=` blank, or mixing list-only filters into a lookup request,
returns `400 VALIDATION`.

The `<view>` shape (both modes):

```jsonc
{
  "id": "…", "externalId": "…", "salesforceId": "…",
  "startsAt": "…", "endsAt": "…", "status": "confirmed",
  "agent": { "name": "…", "email": "…" },
  "manageUrl": "https://…/booking/manage/<token>"
  // list items also carry: "bucketCode": "411"
}
```

### DELETE /api/bookings

Cancel one booking by id.

```
DELETE /api/bookings?bookingId=<uuid>&externalId=<id>
```

- Requires `bookingId` and a strong id (`externalId` or `salesforceId`). The
  booking must be owned by that person and currently active.
- Optional `reason` (a `CANCEL_REASONS` code; the `other` code needs
  `reasonDetail`). Defaults to the service's `api_cancellation` reason. Recorded
  with initiator `customer`.
- Success: `200 { "outcome": "cancelled", "booking": <view> }`. Deletes the
  Google event, frees the slot, and fires the `booking.cancelled` webhook.
- Not found, not owned, or not active: `404 { "code": "NOT_FOUND" }`. A repeat
  cancel of an already cancelled booking therefore returns `404` (the cancel
  claim is atomic, #413, so the side effects fire exactly once).

> There is no separate reschedule endpoint on this API. To move a booking,
> re-submit `POST /api/bookings` with the same `externalId` and a new `start`
> (see `docs/booking-api.md`).

---

## GET /api/availability

Source: `src/app/api/availability/route.ts`. The cache-first read the embed uses
to render slots. Reads precomputed slots from `bucket_slots`, never live Google.

**Auth:** public (no auth). Edge-throttled per datacenter IP (#56), fails open;
over the limit returns `429`. A `Bearer <BOOKING_API_KEY>` is optional and only
matters for reading a hidden `is_test` bucket (#396): without it, a test bucket
code is indistinguishable from an unknown code (#601).

**Request:**

```
GET /api/availability?bucket=411&from=<ISO>&to=<ISO>
```

- `bucket` (required): the XBC bucket code. Missing: `400 { "error": "Missing bucket" }`.
- `from` (optional ISO instant): defaults to now.
- `to` (optional ISO instant): defaults to now plus 4 days.

**Response** (`200`):

```jsonc
{
  "bucket": { "code": "411" },          // the REQUESTED code (never the effective tier, rule #259)
  "orgName": "…",
  "eventType": { "name": "…", "description": "…", "durationMin": 30 },
  "slots": ["2026-07-01T15:00:00.000Z", "…"]  // UTC instants, min-notice filtered
}
```

Unknown code, or an unauthorized hidden test bucket, both return an identical
`404 { "error": "Unknown bucket" }`. Tier-drop routing detail is deliberately
kept server-side and never appears in this payload (rule #259).

**Read to book race:** slots come from a cache that lags real calendars by up to
about a minute, and verify-on-book runs at booking time. A slot read here can be
gone by book time; handle `SLOT_TAKEN` on `POST /api/bookings` by re-querying.

---

## POST /api/routing

Source: `src/app/api/routing/route.ts`. Resolves an XBC code to the agents
eligible for that bucket plus the top round-robin pick.

**Auth:** public (no auth). Per-IP throttled (#596); over the limit returns
`429` (fails open). Read-only, so probes never perturb routing state.

**Request:** `POST { "xbc": "411" }` (other properties currently ignored).
Missing or blank `xbc`: `400 { "error": "xbc is required" }`.

**Response** (`200`):

```jsonc
{
  "bucket": { "code": "411" },        // public code only; the internal bucket NAME is never returned (#351)
  "eligibleAgentIds": ["…", "…"],     // opaque agent ids
  "routedAgentId": "…",               // the least-recently-booked pick
  "fallbackApplied": false
}
```

Unknown bucket: `404 { "error": "unknown bucket" }`. The internal XBC routing
descriptor (the bucket name) is intentionally withheld because this endpoint is
unauthenticated (sibling of #259).

---

## POST /api/bookings/reassign

Source: `src/app/api/bookings/reassign/route.ts`. A key-authed machine endpoint
(#9) that forces a booking onto a specific owning advisor, even if that advisor
is busy (the one place double-booking is deliberately allowed). Used by the
upstream automation that owns the contact-stickiness decision.

**Auth:** `Authorization: Bearer <REASSIGN_API_KEY>`. Wrong key: `401`. No key
configured: `503`.

**Request body:**

```jsonc
{
  "bookingId": "<uuid>",              // required
  "agentEmail": "advisor@trypennie.com", // required, the target owning advisor
  "reasonCode": "owner_reassignment", // optional, defaults to owner_reassignment
  "reasonDetail": "…"                 // optional free text, max 500 chars
}
```

Missing `bookingId` or `agentEmail`: `400`.

**Response** (`200`):

```jsonc
{
  "booking": {
    "id": "…",
    "assignedUserId": "…",
    "agentEmail": "advisor@trypennie.com",
    "startsAt": "…",
    "status": "rescheduled"
  },
  "overCap": false                    // true if the forced move put the agent over their daily cap (logged, not blocked)
}
```

Because the reassign is forced, it does not decline on a busy or at-cap target;
it books through and reports `overCap`. It moves the calendar event and emits a
`booking.rescheduled` webhook (the Regal contract), recorded as a `reassigned`
history event (#326). Error mapping (`src/lib/booking/reassign-http.ts`): a
bad or unbookable target agent is `404`, a terminal (cancelled or completed)
booking that can no longer change is `409`, anything unexpected is a generic
`500` that never leaks internals.

---

## Offboarding lifecycle (key-authed)

Source: `src/app/api/users/lifecycle/route.ts` (#282), plus the original
`src/app/api/users/deactivate/route.ts` and
`src/app/api/users/reactivate/route.ts` (#264 and #265), all built by
`src/lib/offboarding/route-handler.ts`. The existing offboarding automation
POSTs here when someone joins or leaves. Deactivate does not delete (history is
kept, reversible via activate).

**Auth:** `Authorization: Bearer <OFFBOARDING_API_KEY>`. Wrong key: `401`. No key
configured: `503`.

Preferred (one URL, both directions):

- `POST /api/users/lifecycle` body `{ "email": "…", "action": "activate" | "deactivate" }`

An unknown or missing `action` is a `400`. Kept for callers not yet migrated
(same auth, body, and responses):

- `POST /api/users/deactivate` body `{ "email": "…" }`
- `POST /api/users/reactivate` body `{ "email": "…" }`

Missing email: `400`. Response:
`200 { "status", "userId"?, "deactivate"?, "coverageSweep"? }`.
Deactivating an unknown email is an idempotent `200`; activating one is `404`.

**Deactivating also moves the appointments they still hold (#1241).** These
endpoints are the offboarding automation's, with no person in the request, so
there is nobody to ask whether to reassign and the coverage sweep runs on its
own: reason `coverage`, open ended from the moment they were deactivated,
through the same engine the admin coverage panel uses. `coverageSweep` reports
what it did: `queued` (bookings are on their way to a covering agent), `none`
(they held nothing still ahead), or `failed`.

A `failed` sweep does NOT fail the deactivate, because the deactivation is what
stops them being offered for anything new and keeping that is strictly better
than rolling it back. It is not silent either: the reason is logged under
`tag=offboarding`, a repeat call converges onto the same sweep rather than
creating a second, and the `inactive_agent_bookings` monitor pages about an hour
later naming the agent if nothing moved.

Activating does **not** move anything back. Appointments covered while they were
gone stay with the agent now holding them (matching #1219): the customer has
already been told who they are meeting.

The admin UI deactivates through a different path and deliberately keeps its
confirm step, because an admin has the coverage panel one click away and
deactivating from the agent page can mean several things.

---

## Bookable toggle (key-authed)

Source: `src/app/api/users/bookable/route.ts` (#281), over
`src/lib/bookable/service.ts`. The roster/onboarding automation POSTs here to
move an agent in or out of the booking pool. `bookable` is orthogonal to the
offboarding state above: this never touches `deactivated_at`. Agents synced from
Salesforce land `bookable=false` and are promoted through this endpoint.

**Auth:** `Authorization: Bearer <BOOKABLE_API_KEY>`. Wrong key: `401`. No key
configured: `503`.

- `POST /api/users/bookable` body `{ "email": "…", "bookable": true | false }`

Missing email or a non-boolean `bookable`: `400`. Unknown email: `404`.
Idempotent: setting the state the agent already has is a `200` no-op. Success:
`200 { "status": "applied", "userId", "bookable" }`.

**Activation guard.** When `bookable` is `true`, the endpoint first probes the
agent's Google calendar (live, via domain-wide delegation) and classifies the
result (#913):

- **reachable** &rarr; the flip proceeds.
- **gone** (a definitive account/permission failure: removed from the Workspace,
  delegation revoked) &rarr; refused with
  `409 { "status": "blocked", "reason": "google_unreachable" }`.
- **transient** (a timeout or 5xx) &rarr; retried once; if it still fails,
  refused with `409 { "status": "blocked", "reason": "google_unverified" }`.

Either block fires a throttled Slack alert (keyed per agent, and distinct per
reason so they don't throttle each other). The agent stays out of the pool until
the calendar is fixed (or the transient issue clears) and the caller retries.
Deactivation (`bookable: false`) is never blocked.

---

## Webhooks emitted to Regal and Cadence

Slate is the sender for these. Every booking lifecycle change funnels through one
chokepoint, `fire()` in `src/lib/booking/orchestration.ts`, which builds the
canonical payload and calls `emitWebhook` (`src/lib/webhooks/emit.ts`). The wire
format per endpoint is built by `src/lib/webhooks/wire.ts`.

**Event types** (`WebhookEvent`, `src/lib/db/types.ts`):

| Slate event | Fires when |
|---|---|
| `booking.created` | A new booking is confirmed |
| `booking.rescheduled` | A booking moves in place, or is reassigned to another agent, or is moved across buckets |
| `booking.cancelled` | A booking is cancelled |
| `booking.completed` | A past booking is marked completed by the complete lane |

**Canonical payload** (`BookingEventPayload`, `src/lib/webhooks/types.ts`), the
`generic` wire format sends this verbatim as `{ "event", "data": <payload> }`:

```jsonc
{
  "booking_id": "…",
  "salesforce_id": "…",
  "bucket_code": "411",
  "event_type": "Senior Loan Advisor Call",   // display title
  "event_type_slug": "call",                   // Regal `type`
  "event_description": "…",
  "status": "confirmed",
  "starts_at": "…", "ends_at": "…", "timezone": "America/New_York",
  "agent": { "id": "…", "name": "…", "email": "…" },  // read from the booking's snapshot
  "attendee": { "name": "…", "email": "…", "phone": "…" },
  "prefill": { "…": "…" },
  "manage_url": "https://…/booking/manage/<token>",
  "reason": { "code": "…", "detail": "…", "initiator": "customer" }, // null on created/completed
  "routing": {                                  // tier-fallback signal (#492)
    "empty_pool_fallback": false,
    "tier_fallback": false,
    "requested_tier": null,
    "booked_tier": null,
    "rungs_dropped": 0
  }
}
```

**Delivery formats** (`webhook_endpoints.format`):

- `regal`: transformed into the Regal event shape (`name`, `properties`,
  `eventSource: "slate"`, `traits`) by `src/lib/webhooks/regal.ts`. Event names
  are `Slate Booking Created` / `Rescheduled` / `Cancelled` / `Completed`. The
  API key is sent as the `Authorization` header; if the endpoint has no key,
  Slate refuses to send and records the delivery as failed rather than posting an
  unauthenticated event (#600). The `routing.tier_fallback` flag rides through as
  `properties.slateTierFallback` so Regal can suppress its "Non-Ultra High Team
  Booking Detected" alert on an intentional tier-drop (#492). A `booking.created`
  sets voice, SMS, and email opt-in traits.
- `generic` (Cadence and any other subscriber): body `{ "event", "data" }` with
  headers `x-slate-event`, `x-slate-timestamp`, `x-slate-delivery-id`, and an
  HMAC `x-slate-signature` of `sha256=hex(hmac(secret, "<timestamp>.<body>"))`
  over the timestamped body so subscribers can reject replays.

**Delivery semantics.** The first send is inline and bounded by a 5s timeout so a
slow subscriber cannot block the booking; failures are retried with backoff by
the outbox and webhook sweeps up to `WEBHOOK_MAX_ATTEMPTS`, after which a
throttled dead-letter Slack alert fires. Every delivery carries a stable
`x-slate-delivery-id` (the `webhook_deliveries` row id) that is constant across
retries, so receivers can dedupe on it.

**Idempotency (exactly-once).** `fire()` passes a `dedupeKey` derived from the
booking and history event; the delivery row is written under a partial unique
index on `(endpoint_id, event, dedupe_key)`, so a re-enqueue of the same logical
event hits a `23505` and skips both the second row and the second POST (#436). A
null dedupe key opts out (at-least-once).

**Test buckets emit nothing (#459).** A booking on an `is_test` bucket is fully
real everywhere except downstream: the delivery row is still recorded, but the
external POST is skipped, on every event. This is a property of the bucket, not
the caller, so a smoke run never injects a synthetic lead into Regal or Cadence.

> No inbound HMAC verification is performed on what Slate sends (there is no
> shared secret handshake on the Regal path beyond the API key). Configuring the
> matching Regal-side journey and key is a one-time manual step.

---

## Customer self-serve manage routes (token-authed)

Sources: `src/app/api/bookings/[token]/cancel/route.ts`,
`src/app/api/bookings/[token]/reschedule/route.ts`. These back the emailed
`…/booking/manage/<token>` link so a lead can change their own booking without
logging in. Authorization is possession of the per-booking `manage_token` in the
URL; there is no header credential. Intended for humans, not machine callers.

| Method + path | Body | Success | Notable errors |
|---|---|---|---|
| `POST /api/bookings/[token]/cancel` | `{ reason, reasonDetail? }` (reason mandatory, #326) | `200 { "ok": true }` | `400` invalid or missing reason; `409` meeting already completed so not cancellable (#618) |
| `POST /api/bookings/[token]/reschedule` | `{ start, reason, reasonDetail? }` (start a parseable ISO instant, reason mandatory) | `200 { booking, manageUrl }` | `400` invalid start or reason; `409` slot taken or concurrent-change conflict; `503` verify unavailable |

The in-place reschedule enforces the booker's full slot rules (daily cap, buffer,
notice, working hours, #539) and can decline with a `409` when the new time is not
bookable for the current agent.

All three of these routes (cancel, reschedule, and the `POST
/api/bookings/[token]/phone` number correction) are throttled per client address at
20 requests a minute, at the edge, and answer `429` above it (#1046). That is far
above moving one appointment; it exists so a caller guessing manage tokens cannot
buy unmetered database round trips. It fails OPEN, so a limiter fault never stops a
real customer cancelling.

---

## Admin routes (session-authed, internal)

Sources under `src/app/api/admin/` and `src/app/api/users` reads. These are
internal staff endpoints, gated by a Supabase Auth session and role (agent <
manager < admin) via `requireBookingActor` / `requireManager`, not by any API
key. A caller without a session or sufficient role gets a `403` from
`forbiddenResponse`. They are not part of the external integration surface and are
listed here for completeness.

Every MUTATING route here also refuses a request that says it came from another
origin (#1046): `Origin` must match the `Host` the request arrived on, and
`Sec-Fetch-Site`, when the browser sends it, must be `same-origin`. A caller that
sends neither header (a script, `curl`) is unaffected, so this costs machine callers
nothing; it removes the reliance on the session cookie's `SameSite=Lax` default as
the only thing keeping a third-party page from driving these writes. A refused
request gets a `403` and is logged under `tag=same-origin`.

| Method + path | Guard | Purpose |
|---|---|---|
| `GET /api/admin/agents` | manager+ | List agents |
| `POST /api/admin/bookings/[id]/cancel` | booking actor | Staff cancel a booking |
| `POST /api/admin/bookings/[id]/reschedule` | booking actor | Staff reschedule a booking |
| `POST /api/admin/bookings/[id]/reassign` | manager+ | Manager reassign by booking id (#546); at-cap returns a distinct `409` for the two-step "Reassign anyway", not-found `404`, terminal `409` |

---

## Platform and infrastructure routes

Not part of the integration surface; documented so the whole surface is
accounted for.

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness for external uptime checks (#595, #685). One query proves the DB is reachable and ages every cron lane heartbeat against its own bound. `200 { status: "ok", … }` when healthy, `503 { status: "degraded", reason, staleLane, staleAgeMs }` otherwise (fail loud). Body carries no sensitive data. |
| `POST /api/google/push` | `X-Goog-Channel-Token` = `GOOGLE_CHANNEL_TOKEN` | Google Calendar push notifications. Verifies the channel token (`403` on mismatch), then runs an incremental sync for the pinged calendar so the cache reflects external changes within seconds. Returns `200` immediately without blocking on the sync. |
| `GET /api/cron/*` | `Authorization: Bearer <CRON_SECRET>` | Scheduled lanes: `agents`, `complete`, `monitor`, `ooo-approvals`, `ooo-digest`, `outbox`, `prune-routing`, `recompute`, `selfheal`, `sync`, `watch`. Each returns `401` without the secret (the secret is never accepted as a URL query param, #591). Overlapping runs are guarded by DB locks. Internal to the deployment's scheduler. |
| `POST /api/slack/interactions` | Slack request signature (`X-Slack-Signature` + timestamp) | Interactive Slack actions (OOO approvals, decline notes). Every request is signature-verified; `401 invalid signature` otherwise. |
| `GET /api/auth/callback` | none (OAuth code exchange) | Supabase Auth OAuth callback for staff login. |

---

## Environment variables that gate the API

| Variable | Gates | Behavior when unset |
|---|---|---|
| `BOOKING_API_KEY` | Booking API (primary key) | `503` on `/api/bookings` (endpoint disabled) |
| `BOOKING_API_KEY_2` | Booking API (secondary, for zero-downtime rotation) | Ignored; primary still works |
| `REASSIGN_API_KEY` | `POST /api/bookings/reassign` | `503` |
| `OFFBOARDING_API_KEY` | `/api/users/lifecycle`, `/api/users/deactivate`, `/api/users/reactivate` | `503` |
| `BOOKABLE_API_KEY` | `POST /api/users/bookable` | `503` |
| `CRON_SECRET` | every `/api/cron/*` lane | required env; lane returns `401` without a matching Bearer |
| `GOOGLE_CHANNEL_TOKEN` | `POST /api/google/push` | required env; `403` on token mismatch |

See `docs/booking-api.md` for the integrator-facing walkthrough of the booking
flow, and the project `README.md` for the URL contract and embed setup.

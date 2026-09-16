# Slate HTTP API reference

The single authoritative reference for every HTTP endpoint Slate exposes, read
from the route handlers under `src/app/api/`. For a deeper, task-oriented
integrator guide to the key-authed booking flow (worked examples, dedupe and
rebook semantics, the read to book race), see `docs/booking-api.md`. This file is
the flat reference: method, path, who may call it, request shape, response shape,
status and error codes, and idempotency, for the whole surface.

That first sentence is a claim, and `scripts/test-api-doc-coverage.ts` holds the
file to it (#1044): every route under `src/app/api/` must be named here, and every
`/api/...` path named here must exist. It is checked both ways, so a new endpoint
cannot ship undocumented and a deleted one cannot leave an entry behind that reads
as coverage of something real. A document that claims to be complete and is not is
worse than having none, because a reader checks it, does not find an endpoint, and
concludes the endpoint does not exist.

## Versioning and compatibility

There is **no version in any path**, and that is a deliberate consequence of who
the callers are rather than an omission. Slate is an internal service with named
consumers: the Pennie landing pages (through `widget.js`), the direct booking bot,
the offboarding and roster automation, and Regal as the webhook subscriber. There
is no public API and no unknown integrator to keep on an old shape.

So the policy is:

- **Additive changes ship freely.** A new optional request field, a new response
  property, a new endpoint, a new webhook event. Every consumer ignores what it
  does not read.
- **Breaking changes are coordinated with the named consumer before they ship**,
  not announced through a version bump. In practice that means a conversation, then
  both sides deployed close together.
- **Two shapes are frozen and are not ours to change.** The cal.com-compatible
  booking URL contract (`/book?...`, mirrored by `widget.js`) exists so the embed is
  a drop-in replacement, and the webhook payload shape Regal already consumes. Both
  can be EXTENDED; neither can be renamed or narrowed without the coordination above.
- **A key rotates rather than a version.** The booking API accepts a primary and a
  secondary key at once, so a credential change never needs a second endpoint.
- **Nothing here is deprecated on a timer.** A route that stops being needed is
  removed in a change that also removes its caller, and the guard above then
  requires its entry to go with it.

## Contents

- [Versioning and compatibility](#versioning-and-compatibility)
- [Credentials and auth models](#credentials-and-auth-models)
- [Booking API (key-authed, machine caller)](#booking-api-key-authed-machine-caller)
  - [POST /api/bookings (create, rebook, dry run)](#post-apibookings)
  - [GET /api/bookings (lookup and list)](#get-apibookings)
  - [DELETE /api/bookings (cancel)](#delete-apibookings)
- [GET /api/availability (public cached read)](#get-apiavailability)
- [GET /api/availability/next (the next open days)](#get-apiavailabilitynext)
- [POST /api/routing (public routing resolve)](#post-apirouting)
- [POST /api/bookings/reassign (key-authed contact-owner reassign)](#post-apibookingsreassign)
- [POST /api/bookings/cancel-duplicate (key-authed duplicate cancel)](#post-apibookingscancel-duplicate)
- [Offboarding lifecycle (key-authed)](#offboarding-lifecycle-key-authed)
- [Bookable toggle (key-authed)](#bookable-toggle-key-authed)
- [GET /api/bookings/bookable (key-authed validate-only check)](#get-apibookingsbookable)
- [Webhooks emitted to Regal and Cadence](#webhooks-emitted-to-regal-and-cadence)
- [Customer self-serve manage routes (token-authed)](#customer-self-serve-manage-routes-token-authed)
- [Admin routes (session-authed, internal)](#admin-routes-session-authed-internal)
- [Platform and infrastructure routes](#platform-and-infrastructure-routes)
- [Scheduled cron lanes](#scheduled-cron-lanes)
- [Smoke and probe routes (key-authed)](#smoke-and-probe-routes-key-authed)
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
| Supabase session (staff) | session cookie | Supabase Auth | every `/api/admin/*` route |
| Manage token | in the URL path | per-booking `manage_token` | `POST /api/bookings/[token]/cancel`, `POST /api/bookings/[token]/reschedule`, `POST /api/bookings/[token]/phone` |
| Smoke key | `Authorization: Bearer <key>` | `BOOKING_API_KEY` | `GET /api/smoke/version`, `POST /api/smoke/heartbeat`, `POST /api/smoke/burst-counter`, `POST /api/smoke/schedule-parity` |
| None (public) | n/a | n/a | `GET /api/availability`, `GET /api/availability/next`, `POST /api/routing`, `POST /api/client-errors`, `GET /api/health`, `GET /api/health/availability`, `GET /api/auth/callback` |

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
| `LIST_UNAVAILABLE` | 503 | The bookings page could not be read (list mode only) | Retry the SAME cursor; do not advance it |
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

A page that could not be READ returns `503 LIST_UNAVAILABLE`, never an empty page
(#1675). That distinction is the whole contract for a paging caller: an empty page
with a null cursor means "that is everything", so answering one on a failed read
would move your watermark past bookings nobody read and they would never be
offered again. On a `503`, retry the same `cursor` and leave your watermark where
it is.

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

## GET /api/availability/next

Source: `src/app/api/availability/next/route.ts` (#1329, #1339). The first
bookable days on the far side of a closure.

The ordinary availability search is bounded for cost (#1326), so during a long
closure it honestly returns nothing and a lead is left with no idea when to come
back. This runs the longer search, and only for a lead who pressed the button, so
the cost is paid by the few who arrive during a closure rather than by every
booker load.

**Auth:** public (no auth), same edge throttle as `/api/availability`.

**Request:** `GET /api/availability/next?bucket=411`

**Response** (`200`): the same payload shape as `/api/availability`, carrying the
next days that do have times. An unknown bucket returns
`404 { "error": "Unknown bucket" }`, matching the sibling route so a hidden test
bucket stays indistinguishable from a code that does not exist.

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
bad booking id is `404`, a terminal (cancelled or completed) booking that can no
longer change is `409`, anything unexpected is a generic `500` that never leaks
internals.

**Forced does not mean unconditional: three refusals (#2370).** Slate declines to
move a call onto an owner who cannot take it, leaves the booking exactly where it
is, and records a `booking_handoffs` row (`owner-reassign-refused`) so somebody on
the sales side decides what happens next. `handoff` says whether this call opened
that record or found one already open, so a retried call reads as the same refusal
rather than a new one.

| Outcome | Status | `code` | What it means |
|---|---|---|---|
| Moved | `200` | n/a | The body above, with `overCap` |
| Owner not in Slate | `404` | `OWNER_NOT_FOUND` | No user with that address. Bad input: check the address rather than retrying |
| Owner cannot take bookings | `409` | `OWNER_NOT_BOOKABLE` | They exist and are out of the bookable pool, or have been deactivated. Retrying changes nothing until a person acts |
| Owner is away | `409` | `OWNER_ON_TIME_OFF` | Approved time off overlapping `[starts_at, ends_at)`. Half open, so leave that merely abuts the call does not refuse it |
| The check could not be completed | `503` | `OWNER_CHECK_UNAVAILABLE` | A read failed, or the refusal could not be recorded. Nothing was decided and nothing moved: **retry** |

A refusal body carries `{ error, code, refusal, handoff }`, where `refusal` is
`owner-not-found` / `owner-not-bookable` / `owner-on-time-off` and `handoff` is
`"recorded"` or `"already-recorded"`. The `503` body carries
`{ error, code, stage }`, where `stage` is `booking`, `owner`, `time-off` or
`handoff`: a fixed word of Slate's own, never the underlying failure.

A read that FAILED is never reported as a refusal, which is the point of the `503`:
a null owner from a broken read is indistinguishable from "no such owner", and an
empty time off answer from "nobody is away". Moving a call onto the owner who
already holds it stays a `200` no-op and records nothing.

**Only this machine path refuses.** The admin reassign
(`POST /api/admin/bookings/[id]/reassign`) and the bulk redistribute are unchanged:
a manager moving a call onto somebody out of the pool is the deliberate act those
paths exist for.

---

## POST /api/bookings/cancel-duplicate

Source: `src/app/api/bookings/cancel-duplicate/route.ts` (#2369). A key-authed
machine endpoint that cancels a lead's EARLIER call when it really is a duplicate,
and refuses when Slate cannot establish that it is. Called by Regal's two double
booking journeys, which today cancel the named cal.com booking outright with no such
check.

**Auth:** `Authorization: Bearer <DUPLICATE_CANCEL_API_KEY>`. Its own key, not the
reassign one: the journey that may cancel a call is not also handed the ability to
move one. Wrong key: `401`. No key configured: `503`.

**Request body:**

```jsonc
{
  "bookingId": "<uuid>",                            // required, the EARLIER call
  "laterBookingStartsAt": "2026-09-17T15:00:00.000Z" // optional, when the caller says the newer call starts
}
```

Missing or blank `bookingId`: `400`. `laterBookingStartsAt` is never acted on: it is
recorded on the handoff exactly as sent, so a person reading the notice sees what the
caller claimed rather than something Slate derived.

**What it does.** The decision and the cancel are ONE database call,
`cancel_duplicate_booking` (migration 0124). It locks the named booking and the
lead's other upcoming calls, and cancels only when all of these hold:

- the named booking is active and has not started;
- the lead has at least one OTHER upcoming active call, matched the way the booker
  matches a person: the same Salesforce id, the same external id, or the same email
  AND phone together. A single signal (phone only, or email only) never authorises a
  cancel;
- at least one of those was BOOKED AFTER the named one, so naming the middle of three
  calls cancels it and naming the newest refuses;
- no candidate contradicts the named booking's identity (see `IDENTITY_CONFLICT`).

A candidate on a test bucket can never authorise cancelling a real call, and a real
one can never authorise cancelling the smoke canary's.

The flip and the `cancel` outbox row are written in the same transaction, so a crash
can never leave a cancelled booking whose calendar event, slot recompute and
`booking.cancelled` webhook were never enqueued. The route then runs that row inline;
the `/api/cron/outbox` drain covers a crash after commit.

**What it does NOT do.** It never looks outside Slate. A lead whose later call is in
cal.com reads as `NO_OTHER_CALL`, which is a refusal plus a handoff, not a cancel.
It never cancels the LATER call, whichever one the caller names. It never creates,
moves or reassigns anything.

**Outcomes:**

| Outcome | Status | `code` | What it means |
|---|---|---|---|
| Cancelled | `200` | `CANCELLED` | The earlier call is cancelled with reason `double_booking` |
| Already done | `200` | `ALREADY_CANCELLED` | It was already cancelled AS a duplicate, so a retried journey has got what it asked for |
| No such booking | `409` | `BOOKING_NOT_FOUND` | Bad input: check the id rather than retrying |
| Not active | `409` | `BOOKING_NOT_ACTIVE` | Cancelled for another reason, or completed |
| Already started | `409` | `BOOKING_STARTED` | A call in progress is never cancelled |
| Conflicting identity | `409` | `IDENTITY_CONFLICT` | Another upcoming call matches on email and phone while the two carry different strong ids |
| Nothing newer | `409` | `NAMED_IS_NEWEST` | Every other upcoming call was booked BEFORE this one |
| No other call | `409` | `NO_OTHER_CALL` | Nothing matched strongly enough to be the same person |
| Nothing was decided | `503` | `DUPLICATE_CHECK_UNAVAILABLE` | The check could not be run, its reply could not be read, or the finding could not be recorded: **retry** |

Every refusal is a `409`, including a booking Slate cannot find, and that is
deliberate: a `404` from an endpoint addressed by id is indistinguishable from a
`404` for the URL itself, and the caller here is a journey rather than a person
reading a response. The status says the request was understood and declined; the
`code` says which decline it was.

The last three refusals record a `booking_handoffs` row (`duplicate-unresolved`,
#2367) so somebody on the sales side cancels the right call by hand, and their body
carries `{ outcome, code, message, finding, handoff, weakerMatch }`. `handoff` is
`"recorded"` or `"already-recorded"`, so a retried journey reads as the same refusal
rather than a new one; `weakerMatch` is `"phone-only"`, `"email-only"` or `null`,
naming a later call Slate DID find on a single signal, which the notice states as
what it is. The `503` body carries `{ error, code, stage }`, where `stage` is `rpc`,
`result` or `handoff`: a fixed word of Slate's own, never the underlying failure.

**Side effects of a cancel**, stated because they are the same ones cal.com has
today: the lead gets Google's cancellation email for the earlier call, and Regal gets
`booking.cancelled` with `cancellationReason = double_booking`. #2308 adds the branch
that makes Regal's cancel journey say nothing on that reason.

`double_booking` is a **system only** cancel reason (`reason_options.system_only`).
It is a valid code and it renders as a label in booking history, but it is never
offered in a customer or admin picker and never accepted from one, so a lead can
never tell Regal that Slate resolved a duplicate.

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
Salesforce land `bookable=false`. Since #2071 the hourly roster sync promotes them
itself the first time Salesforce moves them to the Sales profile or gives them a
debt team, through the same gated service this endpoint uses; this endpoint remains
the route for a promotion or demotion made by hand or by another automation.

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

## GET /api/bookings/bookable

Source: `src/app/api/bookings/bookable/route.ts` (#541, #1017). A validate-only
"is this time bookable?" check.

The direct-booking bot asks whether a given bucket plus time COULD be booked
before it collects the lead's details, so it never shows a lead a slot that then
fails at confirm. Identity free: no lead, no dedupe, and it books nothing.

It runs the REAL per-slot routing (round robin plus verify-on-book, cascading the
tier ladder), which is the point: a check that consulted the cache instead would
answer differently from the confirm it exists to predict.

**Auth:** the same Bearer keys as `POST /api/bookings` (`BOOKING_API_KEY` or
`BOOKING_API_KEY_2`). Wrong key: `401`. No key configured: `503`.

**Request:** `GET /api/bookings/bookable?bucket=411&start=<ISO>`

**Response** (`200`): whether the time is bookable, and when it is not, the
reason from the shared slot predicate (business hours, working hours, calendar,
daily cap, notice, buffer) rather than a bare false. A malformed `start` or a
missing `bucket` is a `400`; an unknown bucket is a `404`.

Note this is a point-in-time answer over live state, so it carries the same read
to book race as `/api/availability`: handle `SLOT_TAKEN` on the confirm.

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
| `POST /api/bookings/[token]/phone` | `{ phone }` (#1341) | `200 { ok: true, phone }`, carrying the number as STORED, not as typed | `400` a number we cannot call, or a payload over the size ceiling |

The phone edit is authorised by the same manage token, deliberately: it is a
scoped edit of ONE field on a booking that token already governs, not a new
identity surface, and it can reach nothing else on the row. Whether a number is
callable is decided by the shared attendee rule inside the service, so this route
can never become a second, laxer opinion about a phone number.

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
| `GET /api/admin/bookings/search` | manager+ | Booking lookup by attendee email, name or phone, or by booking id (#901). Tenant-scoped; bounded to 20 rows and reports when the bound was filled (#903). A read fault is a `500`, never an empty `200` |
| `POST /api/admin/agents/[id]/bulk-reassign` | booking actor | Start a bulk coverage reassign for one out agent over a date range (#974). The accountable actor is recorded on the job (#549) |
| `GET /api/admin/agents/[id]/bulk-reassign` | booking actor | Progress for that job, so the panel can report what has moved |
| `POST /api/admin/erasure-purge` | admin, **or** `CRON_SECRET` | The warehouse half of a data-subject erasure (#1128). Only touches bookings that already appear in a `pii.erasure` audit row, so an id outside that trail is refused `400` rather than purged; `409` while a run is in flight. `ok` is true ONLY when the post-purge verify measured zero residual, so a run that left data behind reports false rather than success |
| `GET /api/admin/snowflake-check` | admin | Archival-mirror connectivity check (#1110): account, host, key pair and grants, end to end. `200` healthy, `503` when the login or query fails or the mirror is not configured. Read-only |

Every MUTATING admin route also refuses a request that says it came from another
origin (see the note above); the reads do not, because a cross-site GET cannot
have its response read.

---

## Platform and infrastructure routes

Not part of the integration surface; documented so the whole surface is
accounted for.

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness for external uptime checks (#595, #685). One query proves the DB is reachable and ages every cron lane heartbeat against its own bound. `200 { status: "ok", … }` when healthy, `503 { status: "degraded", reason, staleLane, staleAgeMs }` otherwise (fail loud). Body carries no sensitive data. |
| `POST /api/google/push` | `X-Goog-Channel-Token` = `GOOGLE_CHANNEL_TOKEN` | Google Calendar push notifications. Verifies the channel token (`403` on mismatch), then runs an incremental sync for the pinged calendar so the cache reflects external changes within seconds. Returns `200` immediately without blocking on the sync. |
| `GET /api/cron/*` | `Authorization: Bearer <CRON_SECRET>` | The scheduled lanes, each named in its own section below. Each returns `401` without the secret (the secret is never accepted as a URL query param, #591). Overlapping runs are guarded by DB locks. Internal to the deployment's scheduler. |
| `POST /api/client-errors` | none (public) | The client error beacon (#1368). A bundle that throws before the customer can submit produces no request at all, so every server-side detector stays green while nobody can book; this is the only signal for that. Rate limited per address and fails CLOSED on a caller it cannot identify, because an unmetered public path to Slack costs the pager. The report is scrubbed before it is stored. |
| `GET /api/health/availability` | none (public) | Availability canary (#749), safe to expose to an external uptime monitor. `200` when the booker is genuinely offering times, `503` when a well-staffed tier or the whole fleet is silently empty, which `/api/health` cannot see (the database is up and the crons tick while the booker offers nothing). An unreadable tier depth answers `503` with `staffedBuckets: null`, never `0` (#1629). |
| `POST /api/slack/interactions` | Slack request signature (`X-Slack-Signature` + timestamp) | Interactive Slack actions (OOO approvals, decline notes). Every request is signature-verified; `401 invalid signature` otherwise. |
| `GET /api/auth/callback` | none (OAuth code exchange) | Supabase Auth OAuth callback for staff login. |

---

## Scheduled cron lanes

Every lane is `GET /api/cron/<lane>` with `Authorization: Bearer <CRON_SECRET>`,
returns `401` without it, and is guarded by a database lock so two ticks cannot
overlap. They are internal to the deployment's scheduler (`wrangler.jsonc` crons
plus `worker/cron-routes.ts`) and are listed here so the surface is complete.

Four of them (`sync`, `recompute`, `outbox`, `selfheal`) share ONE Worker
invocation budget on the every-minute trigger, which is why per-lane subrequest
cost matters; see `docs/cloudflare-platform-notes.md`.

| Lane | What it does |
|---|---|
| `GET /api/cron/sync` | Google calendar sync backstop: refreshes the cached busy blocks so an externally made calendar change lands within a minute even if its push notification was lost. |
| `GET /api/cron/recompute` | Rebuilds the precomputed `bucket_slots` rows over the current horizon, and pages when rows go stale. |
| `GET /api/cron/outbox` | Drains the booking outbox (#429): resumes any mutation whose side effects are not fully delivered, plus the reservation and abandoned-pin sweeps. |
| `GET /api/cron/selfheal` | The booking-safety sweeps (#433): reconciles missing busy blocks, orphaned calendar events, and the other invariants a crash can break. |
| `GET /api/cron/monitor` | The monitor lane: every health check, each inside its own boundary so one throw cannot take out the rest (#1281). |
| `GET /api/cron/complete` | Flips due appointments to completed and fires `booking.completed`. |
| `GET /api/cron/agents` | Hourly roster sync from Salesforce: agent and team changes, attributes, and departures. |
| `GET /api/cron/watch` | Renews Google calendar push channels before they expire, and names persistently failing agents. |
| `GET /api/cron/hydrate-calendars` | Fills in calendar metadata for agents whose calendars have not been read yet. |
| `GET /api/cron/bulk-reassign` | Drains queued bulk coverage reassign jobs (#973, #562). |
| `GET /api/cron/ooo-approvals` | Moves approved and declined time-off requests through their side effects. |
| `GET /api/cron/ooo-digest` | The daily 7am ET time-off digest, and the record of whether it landed. |
| `GET /api/cron/prune-routing` | Ages out routing decision rows past their retention window. |
| `GET /api/cron/prune-busy-blocks` | Deletes cached busy blocks whose end is far enough in the past to be unreachable (#1252). |
| `GET /api/cron/prune-bookings-pii` | Redacts consumer contact data on bookings past the 24 month window (#1071). |
| `GET /api/cron/prune-webhook-payloads` | Blanks `webhook_deliveries.payload`, which carries attendee PII, once a delivery is settled (#1073). |
| `GET /api/cron/prune-warehouse-pii` | The warehouse half of the same 24 month booking PII window (#1180). |
| `GET /api/cron/snowflake-export` | The archival mirror export (#1099), on its own cron expression and lock. |
| `GET /api/cron/snowflake-reconcile` | Runs the warehouse self-check on a schedule (#1144), including the rows stranded behind the export watermark. |
| `GET /api/cron/erasure-audit` | The Snowflake half of a data-subject erasure audit (#1103). |

---

## Smoke and probe routes (key-authed)

Three endpoints that exist for the deploy probe and the canary rather than for
any integrator. All three take `Authorization: Bearer <BOOKING_API_KEY>` and
answer `503` when no booking API key is configured.

| Method + path | Purpose |
|---|---|
| `GET /api/smoke/version` | Which commit the live Worker is serving (#1037). The post-deploy probe polls this and refuses to judge health until the expected commit answers: without it, a probe hitting `/api/health` during Cloudflare's propagation window gets a `200` from the PREVIOUS version and reports a broken deploy as healthy. Key-authed deliberately, so the deployed commit is not public. |
| `POST /api/smoke/heartbeat` | Liveness stamp for the scheduled booking-smoke canary (#525). The canary calls it on every successful run, so a schedule that silently stops firing goes stale and the lane watchdog pages. |
| `POST /api/smoke/burst-counter` | The one step `pnpm verify:burst-counter` takes into the deployment (#1564): a Durable Object is reachable only through a binding inside the Worker. It reports one request against a FIXED monitor key, which is a constant in the route and never taken from the request, and answers with the count the object now holds. |
| `POST /api/smoke/schedule-parity` | Where the daily Slate against cal.com comparison reports its result (#2031). The sweep runs on a GitHub schedule because it is about one cal.com read per agent, which the shared cron budget cannot hold; it comes back here rather than posting to Slack itself because drift is a condition that needs a cooldown and an all clear, and a runner has no memory. The body carries counts and verdict names only: a verdict outside the fourteen the sweep can produce is refused rather than rendered, and the run link may only point at GitHub, so a key holder cannot put words of their own into an alert. It stamps no heartbeat; the caller does that only after this answers `page` or `all-clear`. |

---

## Environment variables that gate the API

| Variable | Gates | Behavior when unset |
|---|---|---|
| `BOOKING_API_KEY` | Booking API (primary key) | `503` on `/api/bookings` (endpoint disabled) |
| `BOOKING_API_KEY_2` | Booking API (secondary, for zero-downtime rotation) | Ignored; primary still works |
| `REASSIGN_API_KEY` | `POST /api/bookings/reassign` | `503` |
| `DUPLICATE_CANCEL_API_KEY` | `POST /api/bookings/cancel-duplicate` | `503` |
| `OFFBOARDING_API_KEY` | `/api/users/lifecycle`, `/api/users/deactivate`, `/api/users/reactivate` | `503` |
| `BOOKABLE_API_KEY` | `POST /api/users/bookable` | `503` |
| `CRON_SECRET` | every `/api/cron/*` lane | required env; lane returns `401` without a matching Bearer |
| `GOOGLE_CHANNEL_TOKEN` | `POST /api/google/push` | required env; `403` on token mismatch |

See `docs/booking-api.md` for the integrator-facing walkthrough of the booking
flow, and the project `README.md` for the URL contract and embed setup.

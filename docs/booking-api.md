# Booking API

A key-authed HTTP API for programmatic / AI booking. It applies the **same XBC
bucket routing, round-robin assignment, and verify-on-book** as the embed, and
creates the booking server-side in one call — no browser automation. (Replaces
the old headless embed-scraping auto-booker. Refs #253/#250.)

> **Two surfaces:**
> - **Public create** — `POST /booking` (keyless; same as the embed form submit).
> - **Key-authed API** — everything under `POST|GET|DELETE /api/bookings`
>   (requires `Authorization: Bearer <BOOKING_API_KEY>`).

Three calls cover the full flow:

1. **Find slots** — `GET /api/availability` (public, cached).
2. **Book a slot** — `POST /api/bookings` (key-authed).
3. **Look up / list / cancel** — `GET /api/bookings` / `DELETE /api/bookings` (key-authed).

---

## 1. Find slots — `GET /api/availability`

```
GET /api/availability?bucket=411&from=<ISO>&to=<ISO>
```

- `bucket` (required) — the XBC bucket code.
- `from` / `to` (optional ISO instants) — defaults to now → +a few days.
- Public, no auth. Reads the precomputed cache (no live Google), edge-throttled
  ~30/min per datacenter (fails open).

Response:

```json
{ "bucket": { "code": "411" }, "slots": ["2026-07-01T15:00:00.000Z", "..."] }
```

> **Read→book race.** Slots come from a cache that lags real calendars by up to
> ~1 minute, and verify-on-book runs at booking time. A slot you read here can be
> gone by the time you book it — handle a `SLOT_TAKEN` response (below) by
> re-querying and picking another slot. This is expected, not an error in your
> integration.

### The org's own opening hours (#1295)

Every slot passes three gates: the **org's business hours**, then the **agent's**
own working hours, then their calendar. The first is org-wide (Monday to Saturday
08:00 to 20:00 America/New_York as seeded, admin-editable), so a time outside it
is never offered and can never be booked, however the roster is configured.

The window is judged in the org's zone and the agent's in theirs; they are never
intersected, so an agent outside Eastern is treated correctly in both directions.

---

## 1b. Check one time: `GET /api/bookings/bookable` (key-authed)

Ask whether a specific bucket and time **could** be booked, before collecting the
lead's details, so a caller never offers a slot that then fails at confirm. It runs
the real routing pass (round-robin plus verify-on-book, cascading the debt-tier
ladder) with writes disabled, so the answer cannot disagree with an actual book.

```
GET /api/bookings/bookable?bucketCode=411&startIso=<ISO>&timezone=<IANA>
```

- `startIso` (required): the instant to test.
- `bucketCode` (optional): falls back to the admin-configured default bucket;
  with neither, `400 NO_DEFAULT_BUCKET`.

Response `200`:

```jsonc
{ "bookable": true, "reason": "available",
  "effectiveBucketCode": "411", "tierFallback": false, "rungsDropped": 0,
  "wouldAssign": { "id": "…", "name": "…", "email": "…" } }
```

`reason` says **why**, and the causes are deliberately distinct:

| `reason` | `bookable` | Meaning |
|---|---|---|
| `available` | `true` | An agent would take it; `wouldAssign` names who. |
| `closed` | `false` | The **org** is not open at that time. No roster change makes this bookable; the hours themselves have to change. |
| `slot_taken` | `false` | The org is open and the pool is staffed, but every agent down the tier ladder is busy at that instant. Try another time. |
| `no_eligible_agents` | `false` | No agent is eligible for that bucket at all, all the way down the ladder. A configuration problem, not a busy diary. |

`closed` was added in #1295. Before it, a closed hour answered `slot_taken` (that
the times had gone) about times nobody was ever offered.

Other codes: `422` unknown or hidden bucket, `429` over the per-key ceiling
(~200/hr, since each call is a full routing pass), `503` a transient calendar
outage. A `503` is never downgraded to a confident `bookable: false`.

---

## 2. Book a slot — `POST /api/bookings`

### Auth

```
Authorization: Bearer <BOOKING_API_KEY>
```

- **Two keys** are accepted simultaneously (`BOOKING_API_KEY` and
  `BOOKING_API_KEY_2`) so the secret rotates with **zero downtime**: add the new
  key as the secondary, point the caller at it, then retire the old primary.
- `503` if no key is configured (endpoint disabled); `401` on a missing/wrong key.
- **Rate limit:** per-key, generous, a runaway/leaked-key backstop rather than a
  per-request throttle. Writes (`POST`/`DELETE`) and reads (`GET`) draw from
  **separate** ceilings, so frequent status polling can't throttle the booking
  path: writes 120/min · 6000/hr, reads 600/min · 30000/hr. Over a ceiling → `429`.

### Request body

```jsonc
{
  "bucketCode": "411",                       // required — XBC bucket
  "start": "2026-07-01T15:00:00Z",           // required — ISO instant WITH an
                                             //   explicit offset (Z or ±HH:MM)
  "timezone": "America/New_York",            // required — IANA zone (display)
  "attendee": {                              // required — all three fields
    "name": "Dana Lee",
    "email": "dana@example.com",
    "phone": "+12155550100"
  },
  "externalId": "00Q5x000001abcEAA",         // required — the lead's Salesforce id
  "salesforceId": "00Q5x000001abcEAA",       // optional — defaults to external_id
  "prefill": { "utm_source": "regal" },      // optional — forwarded in webhooks
  "confirmReschedule": false                 // optional — see "rebook" below
}
```

Validation is strict (returns `VALIDATION`): name + email + phone all required,
`timezone` must be a real IANA zone, and `start` must carry a timezone offset (a
bare local time is rejected, since it could book the wrong hour).

### One active appointment per person (dedupe + auto-reschedule)

Before creating, the API looks the person up across **active** bookings — by
`externalId`, then `salesforceId`, then email/phone — so a returning lead never
ends up double-booked, even across channels (an embed booking carries no
`externalId`, so it's matched by identity).

| Situation | `outcome` | HTTP | What happened |
|---|---|---|---|
| No existing appointment | `created` | 200 | New booking created. |
| Same person, **same slot**, same bucket | `deduped` | 200 | Existing booking returned; nothing created. |
| Same person, **same slot**, **different bucket** | `rescheduled` | 200 | The lead is **moved to the new team** at the time they already hold (#1465). |
| Same person, **different time**, confident match¹ | `rescheduled` | 200 | Existing booking **moved** to the new time. |
| Same person, **different time**, weak match² | `confirm_required` | 409 | **No change made.** The existing appointment is returned — confirm with the lead, then retry with `confirmReschedule: true`. |

¹ confident = matched by `externalId`/`salesforceId`, **or** by both email **and** phone.
² weak = matched by email **or** phone only. The confirm step guards against
silently moving the wrong person (shared household phone, recycled id).

> A rebook **moves the existing appointment** rather than making a second one. If
> it targets the **same bucket**, the appointment's time is shifted in place. If
> it targets a **different bucket**, the lead is **moved to the new bucket** (a
> fresh booking is created there and the old one is cancelled), so they route to
> the team matching their new request. That holds at a new time (#364) **and at
> the time they already hold** (#1465): a bucket change is a routing request, not
> a time request, and a re-tiered lead confirming their existing slot is the
> ordinary call.
>
> The new booking is created **before** the old one is cancelled, so a bucket with
> nobody free leaves the lead's appointment intact. At the same instant that
> matters most, because the lead's own booking still occupies their current agent
> while the new one is placed. When the move is refused that way, the response is
> `deduped` with a **`bucketChangeDeclined`** object naming the requested bucket
> and the reason (`slot_taken` or `no_eligible_agents`), so the caller can tell
> that the bucket it asked for is not the bucket the lead is in. The field is
> absent whenever nothing was declined.

### Success / confirm response

```json
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
  }
}
```

### Errors

Every failure returns `{ "error": "<message>", "code": "<CODE>" }` (plus
`fieldErrors` for `VALIDATION`). Branch on `code`, never on the message:

| `code` | HTTP | Meaning | What to do |
|---|---|---|---|
| `VALIDATION` | 400 | Bad request body | Fix the request; don't retry as-is. |
| `NOT_FOUND` | 404 | Booking not found / not owned / not active (GET/DELETE only) | Check the booking id and ownership; booking may be cancelled or completed. |
| `UNKNOWN_BUCKET` | 422 | Bucket code resolves to nothing | Config error — stop, escalate. |
| `NO_ELIGIBLE_AGENTS` | 409 | Bucket has zero eligible agents | Config error (e.g. unsynced XBC) — stop, escalate. |
| `SLOT_TAKEN` | 409 | The slot filled before booking | Re-query availability, pick another slot. |
| `VERIFY_UNAVAILABLE` | 503 | Couldn't confirm calendars (transient) | Retry shortly. |
| `INTERNAL` | 500 | Unexpected | Retry once; if it persists, escalate. |

`UNKNOWN_BUCKET` / `NO_ELIGIBLE_AGENTS` are deliberately distinct from
`SLOT_TAKEN` so a misconfigured bucket makes you **stop and escalate** instead of
retrying a never-bookable slot forever.

### Dry run (test mode)

Add `"dryRun": true` to any request to preview **what would happen** without
creating a calendar event, a booking, or firing a webhook. It runs the real
routing — person match, round-robin, and verify-on-book — and returns the
outcome plus, for a would-be create, the agent who **would** be assigned:

```json
{ "dryRun": true, "outcome": "created",
  "wouldAssign": { "id": "…", "name": "…", "email": "…" },
  "existingBookingId": null }
```

For `deduped` / `rescheduled` / `confirm_required`, `wouldAssign` is null and
`existingBookingId` names the matched appointment. Routing failures still surface
as their normal error code (e.g. `NO_ELIGIBLE_AGENTS`), so a dry run is a safe way
to check that a bucket is bookable. A dry run is side-effect-free and does not
alert.

### Test buckets emit no webhooks (#459)

A key-authed caller may book a hidden `is_test` bucket (that is how the smoke test
books a real booking against a real calendar). Those bookings are **fully real
everywhere except downstream**: they create the calendar event, hold the slot, and
record history exactly like a lead's booking, but they emit **no** webhooks at all,
on any event (created, rescheduled, cancelled, completed). So a smoke run never
injects a synthetic lead into Regal or Cadence, and never cancels one there either.

This is a property of the bucket, not of the caller: flag a bucket `is_test` and
nothing booked on it can reach a downstream system.

### Idempotency

Retrying with the same `externalId` + slot is safe: the same call dedupes to the
existing booking (`deduped`) rather than creating a second one.

---

## 3. Look up a booking — `GET /api/bookings` with `externalId` (key-authed)

Resolve a lead's booking(s) by the same `external_id` used to create them — no
need to retain the per-booking manage token.

```
GET /api/bookings?externalId=<id>                 # list active bookings
GET /api/bookings?externalId=<id>&bookingId=<id>  # one booking, any status
GET /api/bookings?externalId=<id>&bookingId=<id>&status=confirmed  # assert state
```

- `externalId` (required) — the lead's stable id (the Salesforce id). Optionally
  pass `salesforceId` too; resolution is by **strong id only**.
- `bookingId` (optional) — return just that booking. Without it, returns the
  person's **active** bookings (`confirmed`/`rescheduled`).
- `status` (optional, by-id only) — `confirmed` | `rescheduled` | `cancelled` |
  `completed`. Returns the booking only if it is in that status, else `404`.

Response (list): `{ "bookings": [ <booking>, ... ] }` — empty array if none.
Response (by id): `{ "booking": <booking> }`.

```jsonc
// <booking>
{
  "id": "…",
  "externalId": "…",
  "salesforceId": "…",
  "startsAt": "2026-07-01T15:00:00.000Z",
  "endsAt":   "2026-07-01T15:30:00.000Z",
  "status":   "confirmed",
  "agent":    { "name": "…", "email": "…" },
  "manageUrl": "https://…/booking/manage/<token>"
}
```

By-id not found / not owned / status mismatch → `404 { "code": "NOT_FOUND" }`.

---

## 4. List bookings — `GET /api/bookings` (no `externalId`)

When `externalId` is absent, the endpoint switches to **cross-person list mode**
(admin / ops / reporting use). All filters are optional.

```
GET /api/bookings?bucket=411&limit=20
GET /api/bookings?status=confirmed&afterStart=2026-07-01T00:00:00Z
GET /api/bookings?updatedSince=2026-07-01T00:00:00Z&cursor=<opaque>
GET /api/bookings?agentEmail=agent@trypennie.com&limit=50
```

### Filters

| Parameter | Type | Notes |
|---|---|---|
| `bucket` | string | Filter to a single XBC bucket code. |
| `agentEmail` | string | Filter to a single agent. |
| `status` | string | `confirmed` \| `rescheduled` \| `cancelled` \| `completed` |
| `afterStart` | ISO instant | Bookings whose `starts_at` is ≥ this value. |
| `beforeEnd` | ISO instant | Bookings whose `starts_at` is ≤ this value. |
| `updatedSince` | ISO instant | Bookings updated at or after this instant; switches ordering to `updated_at ASC` (see below). |
| `limit` | integer | Page size (default 50, max 200). |
| `cursor` | string | Opaque offset cursor from the previous page's `nextCursor`. |

### Ordering

- **Default** (`updatedSince` absent): ordered by `starts_at ASC`.
- **`updatedSince` present**: ordered by `updated_at ASC` — use this for
  incremental polling (you'll see every modified row since the last poll, in
  modification order).

### Pagination

```json
{
  "bookings": [ … ],
  "nextCursor": "<opaque>"
}
```

- `nextCursor` is absent (or `null`) when there are no further pages.
- Pass `cursor=<nextCursor>` to fetch the next page; keep all other filter
  parameters unchanged.
- Cursors are single-use; the offset cap is 10 000 rows (returns `VALIDATION`
  if exceeded — use a tighter date range instead).

### `bucketCode` field

Each item in the returned array includes a `bucketCode` field (the XBC bucket
the booking belongs to) in addition to the standard booking fields.

### 400 cases

| Condition | `code` | Notes |
|---|---|---|
| `externalId` is present but blank (`externalId=`) | `VALIDATION` | An empty string is not a valid id — omit the param entirely to use list mode. |
| `externalId` present **and** list-only filter present (`bucket`, `agentEmail`, `afterStart`, `beforeEnd`, `updatedSince`) | `VALIDATION` | These filter modes are mutually exclusive. |
| `cursor` is malformed / expired | `VALIDATION` | Re-query from page 1. |

---

## 5. Cancel a booking — `DELETE /api/bookings` (key-authed)

```
DELETE /api/bookings?externalId=<id>&bookingId=<uuid>
```

- Requires **`bookingId`** and a strong id (`externalId` **or** `salesforceId`).
  The booking must be owned by that person and currently active.
- Optional `reason` (a `CANCEL_REASONS` code; `other` needs `reasonDetail`);
  defaults to `api_cancellation`. Recorded with initiator `customer`.

Success → `200 { "outcome": "cancelled", "booking": <booking> }`. Deletes the
Google event, frees the slot, and fires the `booking.cancelled` webhook.

Not found / not owned / not active → `404 { "code": "NOT_FOUND" }` (a repeat
cancel of an already-cancelled booking therefore returns `404`).

## 6. Reschedule or move a booking — re-submit `POST /api/bookings`

There is **no separate reschedule endpoint** and you never need the per-booking
manage token. To move a lead's appointment, re-submit the same booking with the
new details: `POST /api/bookings` with the **same `externalId`**, a new
`start`, the same required attendee fields, and optionally a different
`bucketCode`. The "one active appointment per person" engine recognises the
returning lead by strong id and **moves the existing appointment** instead of
creating a second one.

```jsonc
POST /api/bookings
Authorization: Bearer <key>
{
  "externalId": "lead-abc-123",   // same id as the original booking
  "bucketCode": "411",            // same bucket = time change; different = move teams
  "start": "2026-07-03T15:00:00Z",// the new time
  "timezone": "America/New_York",
  "attendee": { "name": "…", "email": "…", "phone": "…" }
}
```

| You send | `outcome` | What happens |
|---|---|---|
| Same `bucketCode`, new `start` | `rescheduled` | The appointment's **time is shifted in place** (same agent/bucket). |
| Different `bucketCode`, new `start` | `rescheduled` | The lead is **moved to the new team**: a fresh booking is created there and the old one cancelled (#364). |
| Same `externalId`, same slot, same bucket | `deduped` | No change: the existing booking is returned. |
| Different `bucketCode`, **same** `start` | `rescheduled` | The lead is **moved to the new team** at the slot they already hold (#1465), or `deduped` with `bucketChangeDeclined` when that team has nobody free. |

Because the bot always carries a strong id (`externalId`/`salesforceId`), a
reschedule is **deterministic** — it never returns `confirm_required` (that
outcome is only for weak email/phone-only matches). The move reuses the full
reschedule path: verify-on-book, a history row, and the `booking.rescheduled`
webhook (a cross-bucket move emits `booking.cancelled` + `booking.created`).
Errors are the same `code`s as a normal create (`SLOT_TAKEN`,
`VERIFY_UNAVAILABLE`, `UNKNOWN_BUCKET`, `NO_ELIGIBLE_AGENTS`, `VALIDATION`).

> **Leads still self-serve via their manage link.** End-users reschedule or
> cancel from the emailed `…/booking/manage/<token>` link without logging in —
> that token-based flow is for humans and is unaffected by (and unnecessary for)
> the key-authed bot, which acts by `externalId` instead.

---

## Ops: Clearing existing orphaned events (#401)

When a booking is cancelled Slate now enqueues the Google Calendar event for
deletion and retries on each sync tick. For bookings that were cancelled
**before** this queue existed, run the following SQL once in Supabase to seed
the retry queue from already-cancelled bookings. The next sync tick(s) will
delete the events idempotently — no local Google credentials required.

```sql
insert into pending_event_deletions (calendar_email, gcal_event_id, booking_id)
select agent_email, gcal_event_id, id
from bookings
where status = 'cancelled' and gcal_event_id is not null and agent_email is not null
  and starts_at > now() - interval '14 days'
on conflict (calendar_email, gcal_event_id) do nothing;
```

This is a queue-seed only (DB write, no Google calls). The deployed drain in the
sync cron handles the actual deletions.

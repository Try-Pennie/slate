# Direct Booking API

A key-authed HTTP API for programmatic / AI booking. It applies the **same XBC
bucket routing, round-robin assignment, and verify-on-book** as the embed, and
creates the booking server-side in one call — no browser automation. (Replaces
the old headless embed-scraping auto-booker. Refs #253/#250.)

Two calls cover the flow:

1. **Find slots** — `GET /api/availability` (public, cached).
2. **Book a slot** — `POST /api/bookings/direct` (key-authed).

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

---

## 2. Book a slot — `POST /api/bookings/direct`

### Auth

```
Authorization: Bearer <BOOKING_API_KEY>
```

- **Two keys** are accepted simultaneously (`BOOKING_API_KEY` and
  `BOOKING_API_KEY_2`) so the secret rotates with **zero downtime**: add the new
  key as the secondary, point the caller at it, then retire the old primary.
- `503` if no key is configured (endpoint disabled); `401` on a missing/wrong key.
- **Rate limit:** per-key, generous (120/min, 6000/hr) — a runaway/leaked-key
  backstop, not a per-request throttle. Over the ceiling → `429`.

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
  "externalId": "lead-abc-123",              // required — your stable per-person id
  "salesforceId": "00Q5x000001abcEAA",       // optional
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
| Same person, **same slot** | `deduped` | 200 | Existing booking returned; nothing created. |
| Same person, **different time**, confident match¹ | `rescheduled` | 200 | Existing booking **moved** to the new time. |
| Same person, **different time**, weak match² | `confirm_required` | 409 | **No change made.** The existing appointment is returned — confirm with the lead, then retry with `confirmReschedule: true`. |

¹ confident = matched by `externalId`/`salesforceId`, **or** by both email **and** phone.
² weak = matched by email **or** phone only. The confirm step guards against
silently moving the wrong person (shared household phone, recycled id).

> A "different time" rebook **moves the existing appointment** rather than making
> a second one. If the rebook targets the **same bucket**, the appointment's time
> is shifted in place. If it targets a **different bucket**, the lead is **moved to
> the new bucket** (a fresh booking is created there and the old one is cancelled),
> so they route to the team matching their new request (#364).

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

### Idempotency

Retrying with the same `externalId` + slot is safe: the same call dedupes to the
existing booking (`deduped`) rather than creating a second one.

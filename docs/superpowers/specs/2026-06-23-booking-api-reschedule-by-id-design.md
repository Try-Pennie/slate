# Reschedule / move a booking via the direct API (#391)

## Problem

The direct booking API has no explicit "reschedule this booking" verb, so #391
asked for a reschedule-by-id endpoint. On investigation, the capability already
exists by composing shipped endpoints — the bot never needed a new bot-only
mutation. The remaining gaps are (a) it isn't documented, so an integrator
wouldn't know the flow, and (b) the surgical path makes the bot string-parse a
URL to get the booking's token.

## Key finding (why no new endpoint)

A booking can already be rescheduled or moved two ways, both with shipped,
tested endpoints:

1. **Re-submit (one call, covers time change AND cross-bucket).**
   `POST /api/bookings/direct` with the same `external_id`, a new `start`, and
   optionally a different `bucketCode`. Because the bot always carries a strong
   id, the person-dedupe engine deterministically **reschedules in place** (same
   bucket) or does the **cross-bucket move** (#364: create-in-new, cancel-old).
   It never returns `confirm_required` for a strong match. Outcome = `rescheduled`.
   Verified live (smoke scenarios 1 and 2).

2. **Lookup → token reschedule (surgical, by exact booking, same-bucket time only).**
   `GET /api/bookings/direct?externalId=…&bookingId=…` (the #386 lookup) returns
   the booking's manage link; the bot then calls the SAME endpoint a human uses,
   `POST /api/bookings/{token}/reschedule` (new `start` + mandatory `reason`).
   Use this when a person has more than one active booking and the bot must move
   one specific appointment. A customer-style move, so it cannot change bucket.

The human token-reschedule is safe to call unauthenticated because the token is
an unguessable per-booking capability; the bot obtains it only through the
key-authed lookup.

## Scope

- **In:**
  1. One additive field on the #386 lookup response (`ApiBookingView`):
     `rescheduleUrl` — the ready-to-POST token reschedule URL — so the bot does
     not string-parse `manageUrl`.
  2. Documentation of both flows in `docs/booking-api.md`.
  3. Close #391 as achievable by composition, referencing the doc.
- **Out:** any new `/api/bookings/direct` mutation verb (PATCH/sub-route); any
  change to booking/routing/reschedule logic; any change to the human
  token-reschedule endpoint; cross-bucket support on the token path (a
  cross-bucket move stays the re-submit path).

## Component changes

### `ApiBookingView` + `toApiBookingView` (`src/lib/booking/orchestration.ts`)

Add `rescheduleUrl: string` to the interface (after `manageUrl`), and populate it
in `toApiBookingView`:

```ts
rescheduleUrl: `${deps.appBaseUrl()}/api/bookings/${b.manage_token}/reschedule`,
```

This mirrors the existing `manageUrl` helper pattern (`appBaseUrl()` + token) and
adds no IO. It surfaces on every lookup response (list items and by-id), which is
correct — the field is only usable by a caller that already proved strong-id
ownership to read the row. It is the POST target a human's reschedule uses.

### Tests

- `scripts/test-booking-orchestration.ts`: extend the existing
  `lookupPersonBookings` / `getPersonBookingById` view assertions to check
  `rescheduleUrl` equals
  `https://slate.test/api/bookings/<manage_token>/reschedule` for the fixture
  booking (the fake `appBaseUrl()` returns `https://slate.test`, token `tok1`).
- `scripts/smoke-booking-api.ts` (optional, manual): assert the by-id GET
  response carries a non-empty `rescheduleUrl`.

### Docs (`docs/booking-api.md`)

Add a section "Reschedule or move an existing booking" after the cancel section:

- Flow 1 (re-submit): show the `POST /api/bookings/direct` body with the same
  `external_id`, new `start`, optional `bucketCode`; note it reschedules in place
  or moves cross-bucket, returns `outcome: "rescheduled"`, and never
  `confirm_required` for the bot's strong id.
- Flow 2 (surgical): show `GET …&bookingId=…` → read `rescheduleUrl` from the
  response → `POST <rescheduleUrl>` with `{ "start", "reason" }` (reason is one
  of the RESCHEDULE_REASONS codes, mandatory; `reasonDetail` required only for
  `other`). Same-bucket time change only.
- State the trade-off: re-submit is per-person and needs the full attendee
  payload; the token path is per-exact-booking but cannot change bucket.
- Add `rescheduleUrl` to the documented lookup response item shape.

## Error / behavior contract (unchanged, documented)

- Re-submit uses the existing direct-API contract (`SLOT_TAKEN`,
  `VERIFY_UNAVAILABLE`, etc.).
- Token reschedule returns the human route's existing responses: `200` with
  `{ id, startsAt, endsAt, manageUrl }`; `409` slot taken; `503` verify outage;
  `400` invalid/zero-reason.

## Deploy

No migration, no new env. Additive response field is backward-compatible. Ships
on `feat/booking-api-reschedule-docs` → PR. `rescheduleUrl` is inert until the
deploy carries it; the documented flows work today regardless (the bot can still
parse `manageUrl`).

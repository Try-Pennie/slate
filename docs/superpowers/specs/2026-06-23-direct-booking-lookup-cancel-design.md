# Direct Booking API — lookup & cancel by external_id (#386)

## Problem

The direct booking API (`POST /api/bookings/direct`, #253/#250) lets the AI
auto-booker create / dedupe / auto-reschedule a booking. But there is **no
key-authed way to read a lead's booking status or cancel it by the bot's own
`external_id`**. Cancelling today needs the per-booking `manage_token` from the
original create response, which the bot may not retain. When a lead backs out,
the bot is stuck. #386 rounds out the integration with key-authed GET (lookup)
and DELETE (cancel) on the same route.

## Scope

- **In:** two new handlers (`GET`, `DELETE`) on
  `src/app/api/bookings/direct/route.ts`; pure query parsers; an
  ownership-check helper; orchestration + service functions; a `NOT_FOUND` error
  code; tests; docs.
- **Out (unchanged):** booking / availability / routing / round-robin logic, the
  `POST` contract, auth scheme, rate-limit rules, webhooks, DB schema. This is an
  additive read/cancel surface over existing primitives — no new booking logic.

## Endpoints

Both reuse the `POST` handler's auth + per-key rate-limit preamble, factored into
one `authorize(req)` helper (returns the authed `keyId` or a `NextResponse`
error) so the three handlers don't duplicate it.

### `GET /api/bookings/direct` — read (two modes)

| Query | Behavior |
|-------|----------|
| `?externalId=<id>` (optionally `&salesforceId=<id>`) | **List** the person's **active** bookings (`confirmed`/`rescheduled`). |
| `?externalId=<id>&bookingId=<uuid>` | Return **that one** booking, **any status** (so the bot can poll a cancelled/completed booking's status). |

**Optional `status` filter** (by-id mode only): an optional `&status=<value>`
query param where value is a real booking status (`confirmed`, `rescheduled`,
`cancelled`, `completed`). It lets the bot *assert* a state — e.g. "is booking
123 still an upcoming `confirmed` appointment?".

- **By-id with `status`:** return the booking only if its status matches;
  otherwise `404 NOT_FOUND` (the answer to "is it still confirmed?" is "no").
- **By-id without `status`:** return the booking at any status.
- An unrecognized `status` value → `400 VALIDATION`.
- The status filter applies to **by-id only**. List mode always returns the
  active set (`confirmed`/`rescheduled`) — broader cross-status / cross-person
  filtering is the separate list-bookings endpoint (#392), out of scope here.
  This keeps by-id on a single `loadBookingById` + in-memory status compare (no
  new query path).

- Person resolution uses `findActiveBookingsForPerson` with **only the strong
  identifiers** (`externalId`, optional `salesforceId`) set — every returned row
  is therefore a strong-id match, so a shared email/phone can never surface
  another person's booking.
- **List** with no matches → `200 { "bookings": [] }` (a read; empty is not an
  error).
- **By-id** not found, or not owned by that person → `404 { code: "NOT_FOUND" }`
  (existence is not leaked). The by-id path loads by id then verifies ownership
  via the strong-id match.
- `externalId` is **required**; a request with neither `externalId` nor
  `salesforceId` → `400 { code: "VALIDATION" }`.

Response item shape (used in both modes):

```jsonc
{
  "id": "uuid",
  "externalId": "sf-id-or-null",
  "salesforceId": "sf-id-or-null",
  "startsAt": "2026-07-01T15:00:00.000Z",
  "endsAt":   "2026-07-01T15:30:00.000Z",
  "status":   "confirmed",
  "agent":    { "name": "...", "email": "..." },
  "manageUrl": "https://.../manage/<token>"  // hands the bot the link it didn't retain
}
```

List mode returns `{ "bookings": [ <item>, ... ] }`; by-id mode returns
`{ "booking": <item> }`.

### `DELETE /api/bookings/direct?externalId=<id>&bookingId=<uuid>` — cancel one

- Requires **`bookingId`** AND a strong id (`externalId` **or** `salesforceId`).
  Requiring the explicit `bookingId` means multiplicity is never ambiguous — the
  bot cancels exactly the booking it looked up, never "the person's booking"
  guessed from among several.
- Loads the booking by id, verifies it **belongs to that person** (strong-id
  match), and that it is **active** (`confirmed`/`rescheduled`). Then cancels via
  the existing `cancelBooking` path: deletes the Google event, clears
  `busy_blocks`, appends the immutable history row, fires `booking.cancelled`.
- Not found / not that person / not active → `404 { code: "NOT_FOUND" }`. A
  repeat DELETE after a successful cancel therefore returns 404 (the booking is
  no longer active) — explicit, not silently idempotent, per the locked decision.
- Success → `200 { "outcome": "cancelled", "booking": <item> }`.
- Optional `reason` query param: if present, validated against `CANCEL_REASONS`
  (invalid → `400 VALIDATION`); absent → default `{ code: "api_cancellation",
  detail: null }`.
- **Initiator = `customer`** on the history row — the lead is the one backing
  out; the bot only relays it, so this is analytically truthful for cancel /
  show-rate analysis (#325).

## Components (all follow existing patterns)

### Pure (testable under `node --experimental-strip-types`)

- `parseLookupQuery(params: URLSearchParams)` in `api-request.ts` — requires
  `externalId` (trim, min 1); optional `salesforceId`, `bookingId`, and `status`
  (must be a valid booking status, else `400 VALIDATION`; only meaningful with
  `bookingId`). Returns `{ ok, value: { externalId, salesforceId, bookingId,
  status } } | { ok:false, status:400, error, code:"VALIDATION" }`.
- `parseCancelQuery(params)` in `api-request.ts` — requires `bookingId` AND at
  least one of `externalId`/`salesforceId`; optional `reason` validated via the
  shared `validateReason("cancel", …)`. Same result union.
- `bookingBelongsToPerson(booking, identity)` in `person-dedupe.ts` — true iff a
  **strong** id matches (reuses the existing strong-match grading). Used by the
  GET-by-id and DELETE ownership checks.

### Orchestration (`orchestration.ts`, pure-deps)

- `class BookingNotFoundError extends Error` — maps to `404 NOT_FOUND`.
- `lookupPersonBookings(identity, deps): Promise<Booking[]>` — thin wrapper over
  `deps.findActiveBookingsForPerson` (list mode).
- `getPersonBookingById({ bookingId, identity, status }, deps): Promise<Booking>`
  — load by id, throw `BookingNotFoundError` if missing, not owned, or (when a
  `status` filter is supplied) status doesn't match (by-id mode).
- `cancelDirectBooking({ bookingId, identity, reason }, deps): Promise<Booking>`
  — load by id; throw `BookingNotFoundError` if missing, not owned, or not
  active; else `cancelBooking(token, reason, "customer", deps)`; return the
  cancelled booking.

### Service (`service.ts`, real deps) + route

- Thin `realDeps()` wrappers re-exporting the three orchestration functions and
  `BookingNotFoundError`.
- Route: `GET` and `DELETE` handlers using `authorize(req)` → parse → orchestrate
  → shape response. Extend `mapBookingError` (or a small cancel-specific map) so
  `BookingNotFoundError → { status:404, code:"NOT_FOUND" }`.

## Error contract (additions)

| Code | Status | When |
|------|--------|------|
| `NOT_FOUND` | 404 | DELETE / GET-by-id: no such active booking for that person |
| `VALIDATION` | 400 | missing/invalid query params (existing code, reused) |

Auth (401/503) and per-key rate limit (429) behave exactly as `POST`.

## Testing

`scripts/test-*.ts` (node-native, per the project convention — one per feature):

- **parsers:** `parseLookupQuery` (missing `externalId` → 400; ok with/without
  `bookingId`), `parseCancelQuery` (missing `bookingId` → 400; missing both ids →
  400; ok; invalid `reason` → 400).
- **ownership:** `bookingBelongsToPerson` strong-match true / weak / none.
- **orchestration with fake deps:** `lookupPersonBookings` returns active;
  `getPersonBookingById` not-found / wrong-person → `BookingNotFoundError`, owned
  → returns; `cancelDirectBooking` not-found / wrong-person / not-active →
  `BookingNotFoundError`, happy path → cancels + returns.
- **smoke:** extend `scripts/smoke-booking-api.ts` to GET (list + by-id) and
  DELETE-by-id (replacing the manage-token cleanup), against prod.
- Run `tsc --noEmit` before pushing (CI type-checks test files).

## Docs

Add GET and DELETE sections to `docs/booking-api.md`, mirroring the POST section,
including the two GET modes, the ownership rule, and the `NOT_FOUND` code.

## Deploy

No migration, no new env. Lands behind the existing `BOOKING_API_KEY` (the route
is already active in prod). Ships on a fresh branch off `origin/main`.

# Bookings API reorg + list endpoint (#392)

## Problem

#392 needs a key-authed, filtered, paginated **list-bookings** endpoint for the
AI booker and ops (reconcile state, pull volume/show-rate). While placing it, we
restructure the booking API so the namespace is clean:

- `/api/bookings/*` becomes the single **key-authed** API surface (create, lookup,
  cancel, list), dropping the `/direct` suffix.
- The **public, keyless** customer create (today `POST /api/bookings`, called only
  by the in-app `Booker`) moves to a friendly `POST /booking`.

Nothing is live on these endpoints yet (the AI booker is not in production), so a
**hard cutover with no alias window** is acceptable per the product owner.

## Target structure

### Public, keyless — the embed create
- `POST /booking` — customer booking create. The current `POST /api/bookings`
  handler moves here **verbatim** (IP rate-limit via `BOOKING_RATE_RULES`,
  `validateAttendee`, `createBooking`). No auth.
- The `Booker` component (`src/components/Booker.tsx:311`) is repointed from
  `/api/bookings` to `/booking`. The `/book` page and `widget.js` iframe are
  unchanged (they never referenced `/api/bookings` directly).
- `src/app/booking/route.ts` is free (`/booking` has no page; only
  `/booking/[id]` exists).

### Key-authed — `/api/bookings` (Bearer key + per-key rate limit)
Move the three handlers from `src/app/api/bookings/direct/route.ts` to
`src/app/api/bookings/route.ts`, keeping behavior identical:
- `POST /api/bookings` — bot create (dedupe / auto-reschedule / dry-run; today's
  `POST /api/bookings/direct`).
- `GET /api/bookings` — **two modes**:
  - `externalId` present → the #386 per-person lookup (list / by-id / status),
    unchanged.
  - `externalId` absent → the new **#392 list** (below).
- `DELETE /api/bookings` — cancel-by-id (today's `DELETE /api/bookings/direct`).
- The shared `authorize()` helper, error maps, and parsers move with them.
- `src/app/api/bookings/direct/` is **deleted** (no alias; nothing live).

### Untouched
`/api/bookings/[token]/*` (human manage links, keyless capability),
`/api/bookings/reassign` (admin/session), `widget.js`, the `/book` page, all
booking/routing/availability logic.

## #392 list mode — `GET /api/bookings` without `externalId`

### Query params (all optional)
| Param | Meaning |
|---|---|
| `status` | one of `confirmed`/`rescheduled`/`cancelled`/`completed`. Default: **all statuses**. |
| `afterStart` | ISO instant (offset required); `starts_at >= afterStart`. |
| `beforeEnd` | ISO instant; `starts_at <= beforeEnd`. |
| `updatedSince` | ISO instant; `updated_at > updatedSince` (incremental reconciliation). |
| `bucket` | XBC bucket code; resolved to `bucket_id`. Unknown code → empty page (a filter, not a routing target). |
| `agentEmail` | resolves to `assigned_user_id`. Unknown email → empty page. |
| `limit` | page size, default 50, clamped 1..100. |
| `cursor` | opaque keyset cursor from a prior page's `nextCursor`. |

A list call with no filters is allowed; it is still bounded by `limit` + cursor
(default order makes it "earliest upcoming first").

### Pagination (keyset, stable)
- Order by `(starts_at ASC, id ASC)`.
- `cursor` encodes the last returned row's `(starts_at, id)`, base64 of
  `"<starts_at>|<id>"`. Next page filter:
  `starts_at > c.starts OR (starts_at = c.starts AND id > c.id)`
  (PostgREST `.or("starts_at.gt.<s>,and(starts_at.eq.<s>,id.gt.<id>)")`).
- Fetch `limit + 1` rows; if the extra exists, drop it and set `nextCursor` to
  the last kept row's cursor, else `nextCursor: null`.

### Response
```jsonc
{
  "bookings": [ { /* #386 item */ , "bucketCode": "411" }, ... ],
  "nextCursor": "<opaque>" | null
}
```
Item = the existing `ApiBookingView` plus `bucketCode`. Buckets are resolved with
one `.in()` query over the page's `bucket_id`s and joined in memory (the
`loadPastBookingsToComplete` pattern), never one query per row.

### Indexes (new migration `0044_bookings_list_indexes.sql`)
At ~2000 bookings/day a filtered, ordered scan needs support:
- `create index bookings_starts_at_id_idx on bookings (starts_at, id);` — default
  order + keyset cursor.
- `create index bookings_updated_at_idx on bookings (updated_at);` — `updatedSince`.
- `create index bookings_bucket_id_idx on bookings (bucket_id);` — `bucket` filter.
- `create index bookings_assigned_user_id_idx on bookings (assigned_user_id);` —
  `agentEmail` filter.
Apply with `supabase db push` (4-digit scheme works, per #365). DEPLOY ORDER: the
index migration is additive and safe to apply before or after the code merges.

## Components

### Pure (testable under `node --experimental-strip-types`)
- `parseListQuery(params: URLSearchParams)` in `api-request.ts` — validates
  status / ISO instants (offset required, reuse the existing start check) /
  limit clamp / cursor decode; returns a `ListQuery` or `{ ok:false, 400 }`.
- `encodeCursor(startsAt, id)` / `decodeCursor(s)` (pure) — base64 round-trip;
  a malformed cursor → 400 `VALIDATION`.

### Orchestration (`orchestration.ts`, pure-deps)
- `interface ListQuery { status; afterStart; beforeEnd; updatedSince; bucketCode;
  agentEmail; limit; cursor }` (nullable fields).
- `listBookings(query, deps): Promise<{ items: ApiBookingView[]; nextCursor: string|null }>`
  — resolve bucket/agent ids, call a new `deps.queryBookings(filter)`, map rows
  to views (+ `bucketCode`), compute `nextCursor`.
- New dep `queryBookings(filter): Promise<{ rows: Booking[]; buckets: Bucket[] }>`
  in `BookingDeps`, implemented in `service.ts` with the parameterized PostgREST
  query above (every filter via `.eq/.gte/.lte/.gt`, never string interpolation).

### Route + service
- `service.ts`: `listBookings(query)` thin wrapper over `orchestration.listBookings`
  with `realDeps()`; `queryBookings` real impl.
- `GET /api/bookings`: `authorize()` → if `externalId` present, existing lookup;
  else `parseListQuery` → `listBookings` → `{ bookings, nextCursor }`. `VALIDATION`
  (400) on bad params.

## Testing
- **Pure:** `parseListQuery` (valid combos, bad status/ISO/limit/cursor → 400),
  cursor encode/decode round-trip + malformed → error.
- **Orchestration (fake deps):** `listBookings` — filters passed through, `bucketCode`
  joined onto items, `nextCursor` set when a full page + 1 exists and null
  otherwise, unknown bucket/agent → empty.
- **Route tests:** update `src/app/api/bookings/route.test.ts` and delete/migrate
  `src/app/api/bookings/direct/route.test.ts` to the new homes (public create →
  `/booking`; authed create/lookup/cancel/list → `/api/bookings`).
- **Smoke:** repoint `scripts/smoke-booking-api.ts` to `/api/bookings` (from
  `/api/bookings/direct`) and add a list-mode leg (book → GET list filtered by the
  test agent / time window → see the booking → paginate). Run `tsc --noEmit`.

## Docs
Rewrite `docs/booking-api.md` for the new paths: public `POST /booking`; authed
`POST/GET/DELETE /api/bookings`; add the "List bookings" section (filters, cursor,
response). Update any `/api/bookings/direct` references in `DEPLOY.md` / `.env.example`.

## Out of scope
Token manage routes, reassign, the embed iframe/widget.js, any booking-logic
change, the read-rate-limit split (#393), and the admin UI list (#344).

## Risks
1. **GET dual-mode** (lookup vs list on one handler) — branch only on
   `externalId` presence; keep the two paths visibly separate in the handler.
2. **External callers of the old paths** — product owner confirms nothing live, so
   no alias. (If an external system POSTs to `/api/bookings` or calls `/direct`,
   it will break; accepted.)
3. **List cost** — mitigated by the index migration; `limit` capped at 100;
   keyset (not offset) pagination stays cheap deep into the result set.

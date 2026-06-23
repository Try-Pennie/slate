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

## #392 list mode — `GET /api/bookings` (no `externalId` key)

### Mode disambiguation (red-team I4/I5)
The handler branches on the **presence** of the `externalId` query KEY, not its
value:
- **`externalId` key absent** → list mode.
- **`externalId` present but blank** (`?externalId=`) → `400 VALIDATION`
  (preserve the existing #386 guard; never fall through to a cross-person dump).
- **`externalId` present + non-empty** → the #386 per-person lookup.
- **`externalId` present together with any list-only param** (`afterStart`,
  `beforeEnd`, `updatedSince`, `bucket`, `agentEmail`, `cursor`) →
  `400 VALIDATION` ("externalId selects per-person lookup; remove list filters").
  This prevents silently ignored filters and the differing default-status
  semantics between modes.

### Query params (all optional)
| Param | Meaning |
|---|---|
| `status` | one of `confirmed`/`rescheduled`/`cancelled`/`completed`. Default: **all statuses**. |
| `afterStart` | ISO instant (explicit offset required); `starts_at >= afterStart`. |
| `beforeEnd` | ISO instant; `starts_at <= beforeEnd`. |
| `updatedSince` | ISO instant; `updated_at > updatedSince` (incremental reconciliation). |
| `bucket` | XBC bucket code; resolved to `bucket_id`. Unknown code → empty page (a filter, not a routing target). |
| `agentEmail` | resolves to `assigned_user_id`. Unknown email → empty page. |
| `limit` | page size, default 50, clamped 1..100. |
| `cursor` | opaque page token from a prior page's `nextCursor`. |

### Pagination — OFFSET, not keyset (red-team C1/C2)
Keyset over a `timestamptz` tie-break via an interpolated PostgREST `.or()` string
is fragile (microsecond round-trip precision, `+` offset encoding, and it
violates this repo's deliberate no-`.or()`-interpolation rule, `service.ts:501`).
Use simple offset pagination instead — correct, no precedent risk:
- supabase-js `.range(offset, offset + limit - 1)` with `.order(...)` (below).
- `cursor` is an **opaque** token that currently encodes the next `offset`
  (base64 of an integer); a malformed cursor → `400 VALIDATION`. Keeping it opaque
  lets us swap to keyset later without an API change.
- `nextCursor` is set when the page came back **full** (`rows.length === limit`),
  else `null`.
- **Max offset cap** of 10000: a request resolving past it → `400 VALIDATION`
  ("narrow your filters — use afterStart/beforeEnd or updatedSince"). Bounds cost
  and nudges callers toward windowed/incremental queries.
- Offset pagination's only caveat (a row inserted/removed mid-paging can shift by
  one) is acceptable for a reconciliation/reporting endpoint and is documented.

### Ordering (red-team M9/M10)
- Default: `order by (starts_at ASC, id ASC)` — deterministic, **oldest
  appointment first** (NOT "upcoming"; callers window with `afterStart`/`beforeEnd`).
- When `updatedSince` is set: `order by (updated_at ASC, id ASC)` so an
  incremental reconciler gets a gap-free change feed (a reschedule bumps
  `updated_at` via the `set_updated_at` trigger; ordering by `starts_at` would let
  such a row re-sort behind the cursor and be missed).

### Response
```jsonc
{
  "bookings": [ { /* #386 item */ , "bucketCode": "411" }, ... ],
  "nextCursor": "<opaque>" | null
}
```
Item = the existing `ApiBookingView` plus `bucketCode`. **`bucketCode` is resolved
by joining `buckets` on `bucket_id`** (one `.in()` query over the page's
`bucket_id`s, the `loadPastBookingsToComplete` pattern) — **never** from
`routing_trace.bucket_code`, which reflects routing and can be stale after a
cross-bucket rebook.

### Indexes (new migration `0044_bookings_list_indexes.sql`)
Verified against the live schema — the `bucket` and `agentEmail` filters are
**already indexed** (`bookings_bucket_idx` on `(bucket_id)`,
`bookings_assigned_idx` on `(assigned_user_id, starts_at)`), so only two new
indexes are needed:
- `create index bookings_starts_at_id_idx on bookings (starts_at, id);` — default
  order + keyset cursor (no existing index on `starts_at` alone).
- `create index bookings_updated_at_idx on bookings (updated_at);` — `updatedSince`
  (no existing `updated_at` index).
Apply with `supabase db push` (4-digit scheme works, per #365). DEPLOY ORDER: the
index migration is additive and safe to apply before or after the code merges.
Existing `bookings_bucket_share_idx` `(bucket_id, starts_at, assigned_user_id)`
(partial: non-cancelled) further helps bucket-scoped, time-ordered queries.

## Components

### Pure (testable under `node --experimental-strip-types`)
- `parseListQuery(params: URLSearchParams)` in `api-request.ts` — validates
  status / ISO instants (explicit offset required, reuse the existing start
  check) / `limit` clamp (1..100) / `cursor` decode to a non-negative integer
  offset (malformed → 400) / max-offset cap; returns a `ListQuery` or
  `{ ok:false, 400 }`.
- `encodeCursor(offset: number)` / `decodeCursor(s: string)` (pure) — base64
  round-trip of the integer offset; malformed → 400 `VALIDATION`.

### Orchestration (`orchestration.ts`, pure-deps)
- `interface ListQuery { status; afterStart; beforeEnd; updatedSince; bucketCode;
  agentEmail; limit; offset }` (nullable fields; `offset` from the decoded cursor).
- `listBookings(query, deps): Promise<{ items: ApiBookingView[]; nextCursor: string|null }>`
  — resolve `bucketCode`→`bucket_id` and `agentEmail`→`assigned_user_id` (unknown
  → return an empty page, no DB scan), call `deps.queryBookings(filter)`, map rows
  to views (+ `bucketCode` from the joined buckets), set `nextCursor =
  rows.length === limit ? encodeCursor(offset + limit) : null`.
- New dep `queryBookings(filter): Promise<{ rows: Booking[]; buckets: Bucket[] }>`
  in `BookingDeps`, implemented in `service.ts` with the parameterized PostgREST
  query (every filter via `.eq/.gte/.lte/.gt`, `.order(...)`, `.range(...)` —
  **never** an interpolated `.or()` string), plus the one `.in()` buckets join.

### Route + service
- `service.ts`: `listBookings(query)` thin wrapper over `orchestration.listBookings`
  with `realDeps()`; `queryBookings` real impl (mode-dependent `.order`: by
  `updated_at` when `updatedSince` set, else `starts_at`; tie-break `id`).
- `GET /api/bookings`: `authorize()` first (key-auth covers the list branch too) →
  mode disambiguation (above) → if lookup, existing path; else `parseListQuery` →
  `listBookings` → `{ bookings, nextCursor }`. `VALIDATION` (400) on bad params.

## Testing
- **Pure:** `parseListQuery` — valid combos; bad status/ISO/limit → 400; `limit`
  clamps to ≤100 (assert, since it's the only cost guard); `cursor` encode/decode
  round-trip + malformed → 400; offset past the 10000 cap → 400. Mode
  disambiguation: `?externalId=` (blank) → 400; `externalId`+`afterStart` → 400.
- **Orchestration (fake deps):** `listBookings` — filters passed through;
  `bucketCode` joined onto items from the buckets join (not `routing_trace`);
  `nextCursor` set when `rows.length === limit`, null otherwise; unknown
  bucket/agent → empty page with no `queryBookings` scan; `updatedSince` selects
  the `updated_at` order.
- **Route tests:** update `src/app/api/bookings/route.test.ts` and
  delete/migrate `src/app/api/bookings/direct/route.test.ts` to the new homes
  (public create → `/booking`; authed create/lookup/cancel/list → `/api/bookings`).
  Include: list branch with no/invalid Bearer → 401 (auth covers list, not just
  lookup); a `limit` clamp assertion at the route level.
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

## Atomic-cutover requirement (red-team I6/I7)
This repo auto-merges-and-deploys, so a follow-up PR cannot patch a half-done
cutover. **One PR** must carry every live reference to the old path (grounded by
grep):
- route moves + `/direct` delete + both new routes' `export const dynamic =
  "force-dynamic"`;
- `src/components/Booker.tsx:311` repoint → `/booking`;
- `src/app/api/bookings/route.test.ts` (rewrite) and
  `src/app/api/bookings/direct/route.test.ts` (move/delete);
- comments in `src/lib/env.ts` and `src/lib/booking/api-request.ts` that name
  `/api/bookings/direct`;
- `scripts/smoke-booking-api.ts` repoint + list leg;
- prose in `docs/booking-api.md`, `DEPLOY.md`, `README.md`.

**Merge gate:** `grep -rn "api/bookings/direct" src scripts docs/booking-api.md
DEPLOY.md README.md` returns **zero** before merge. (The historical
`docs/superpowers/**` specs/plans keep their references — they are accurate
records of past work and are intentionally excluded from the gate.) Do not add a
`/booking/page.tsx` (would collide with the new `route.ts`).

## Risks
1. **GET dual-mode** (lookup vs list on one handler) — disambiguated explicitly
   (absent vs blank vs present-with-filters, above); keep the two paths visibly
   separate in the handler.
2. **External callers of the old paths** — product owner confirms nothing live, so
   no alias. (If an external system POSTs to `/api/bookings` or calls `/direct`,
   it will break; accepted.)
3. **List cost** — `limit` capped at 100, max offset capped at 10000, new
   `starts_at`/`updated_at` indexes; offset pagination is simple and correct (the
   deep-page scan is bounded by the offset cap and by callers windowing with date
   filters).
4. **Offset paging consistency** — a row inserted/removed between pages can shift
   results by one; acceptable for reconciliation/reporting and documented.

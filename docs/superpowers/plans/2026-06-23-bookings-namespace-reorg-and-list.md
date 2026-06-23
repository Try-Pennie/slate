# Bookings API namespace reorg + list endpoint (#392) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/bookings` the single key-authed bot API (create / lookup / cancel / **list**), move the public customer create to a keyless `POST /booking`, and delete `/api/bookings/direct`.

**Architecture:** Pure logic first (query parser + cursor, list orchestration) tested under `node --experimental-strip-types`; then a migration; then the route relocation (public create → `/booking`, authed handlers → `/api/bookings`, add list mode); finally smoke + docs. All on one branch — this is a single atomic cutover PR.

**Tech Stack:** Next.js 16 App Router (TS), Supabase/PostgREST (`supabaseAdmin`), Zod, Luxon, vitest (route tests) + node-native `scripts/test-*.ts` (pure tests), pnpm.

## Global Constraints

- TypeScript, no `any`; 2-space indent; existing Prettier/ESLint.
- Pure booking modules use **relative** value imports + type-only `@/` imports (run under `node --experimental-strip-types`).
- Every pure feature ships a `scripts/test-*.ts`; run `npx tsc --noEmit` before pushing (CI type-checks tests).
- **Pagination is OFFSET, never keyset**; never build an interpolated PostgREST `.or()` string. Every filter via `.eq/.gte/.lte/.gt`.
- **List item shape** = the #386 `ApiBookingView` plus `bucketCode` (resolved by joining `buckets` on `bucket_id`, NEVER `routing_trace.bucket_code`).
- **GET dual-mode** branches on the `externalId` *key*: absent → list; present-blank (`?externalId=`) → 400; present non-empty → lookup; present + any list filter → 400.
- `limit` default 50, clamp ≤100; max offset 10000 → 400.
- Default order `(starts_at ASC, id ASC)`; when `updatedSince` is set, order `(updated_at ASC, id ASC)`.
- **Atomic cutover:** one PR. Merge gate: `grep -rn "api/bookings/direct" src scripts docs/booking-api.md DEPLOY.md README.md` returns zero. `docs/superpowers/**` is excluded (historical).
- Branch `feat/bookings-namespace-reorg` is off `origin/main`. Commit per task.

---

### Task 1: List query parser + cursor (pure)

**Files:**
- Modify: `src/lib/booking/api-request.ts` (add cursor helpers + `parseListQuery`; `BOOKING_STATUSES`, `DateTime`, `BookingStatus` already imported from #386)
- Test: `scripts/test-booking-api-request.ts` (append)

**Interfaces:**
- Produces: `encodeCursor(offset: number): string`, `decodeCursor(s: string): number | null`, `parseListQuery(params: URLSearchParams): { ok:true; value: ListQuery } | { ok:false; status:400; error:string }`, and `interface ListQuery { status: BookingStatus|null; afterStart: string|null; beforeEnd: string|null; updatedSince: string|null; bucketCode: string|null; agentEmail: string|null; limit: number; offset: number }`.

- [ ] **Step 1: Write the failing test** — append to `scripts/test-booking-api-request.ts` (before its final summary), adding `parseListQuery, encodeCursor, decodeCursor` to the existing `from "../src/lib/booking/api-request.ts"` import.

```ts
// --- list query parser (#392) ---
assert(decodeCursor(encodeCursor(150)) === 150, "cursor round-trips an offset");
assert(decodeCursor("!!!not-base64-int") === null, "garbage cursor -> null");

const lOk = parseListQuery(new URLSearchParams("status=confirmed&limit=10"));
assert(lOk.ok && lOk.value.status === "confirmed" && lOk.value.limit === 10 && lOk.value.offset === 0,
  "list: status + limit parsed, offset defaults 0");
const lDefault = parseListQuery(new URLSearchParams(""));
assert(lDefault.ok && lDefault.value.limit === 50 && lDefault.value.status === null,
  "list: empty query is valid, default limit 50, no status");
const lClamp = parseListQuery(new URLSearchParams("limit=10000"));
assert(lClamp.ok && lClamp.value.limit === 100, "list: limit clamps to 100");
const lBadStatus = parseListQuery(new URLSearchParams("status=pending"));
assert(!lBadStatus.ok && lBadStatus.status === 400, "list: bad status -> 400");
const lBadDate = parseListQuery(new URLSearchParams("afterStart=2026-07-01T15:00:00"));
assert(!lBadDate.ok && lBadDate.status === 400, "list: zoneless afterStart -> 400");
const lOkDate = parseListQuery(new URLSearchParams("afterStart=2026-07-01T15:00:00Z&updatedSince=2026-06-01T00:00:00Z"));
assert(lOkDate.ok && lOkDate.value.afterStart === "2026-07-01T15:00:00Z" && lOkDate.value.updatedSince === "2026-06-01T00:00:00Z",
  "list: offset-bearing ISO dates accepted");
const lCursor = parseListQuery(new URLSearchParams(`cursor=${encodeCursor(50)}`));
assert(lCursor.ok && lCursor.value.offset === 50, "list: cursor decodes to offset");
const lBadCursor = parseListQuery(new URLSearchParams("cursor=@@@"));
assert(!lBadCursor.ok && lBadCursor.status === 400, "list: bad cursor -> 400");
const lCap = parseListQuery(new URLSearchParams(`cursor=${encodeCursor(20000)}`));
assert(!lCap.ok && lCap.status === 400, "list: offset past 10000 cap -> 400");
const lBucketAgent = parseListQuery(new URLSearchParams("bucket=411&agentEmail=a@x.com"));
assert(lBucketAgent.ok && lBucketAgent.value.bucketCode === "411" && lBucketAgent.value.agentEmail === "a@x.com",
  "list: bucket + agentEmail parsed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-api-request.ts`
Expected: FAIL — `parseListQuery is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `src/lib/booking/api-request.ts`:

```ts
const MAX_LIST_OFFSET = 10000;

/** Opaque page token (base64 of a non-negative integer offset). btoa/atob are
 *  global in Node and the Worker runtime. */
export function encodeCursor(offset: number): string {
  return btoa(String(offset));
}
export function decodeCursor(s: string): number | null {
  try {
    const n = Number(atob(s));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export interface ListQuery {
  status: BookingStatus | null;
  afterStart: string | null;
  beforeEnd: string | null;
  updatedSince: string | null;
  bucketCode: string | null;
  agentEmail: string | null;
  limit: number;
  offset: number;
}

export type ListParseResult =
  | { ok: true; value: ListQuery }
  | { ok: false; status: 400; error: string };

function isoWithOffset(v: string): boolean {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(v.trim());
  return hasOffset && DateTime.fromISO(v, { setZone: true }).isValid;
}

/**
 * Parse the #392 list query (GET /api/bookings without an externalId key). All
 * filters optional; OFFSET pagination via an opaque cursor; max offset capped.
 * The externalId-vs-list mode decision is the route's job, not this parser's.
 */
export function parseListQuery(params: URLSearchParams): ListParseResult {
  const bad = (error: string): ListParseResult => ({ ok: false, status: 400, error });

  const status = (params.get("status") ?? "").trim();
  if (status && !BOOKING_STATUSES.includes(status as BookingStatus)) {
    return bad("Invalid status filter");
  }
  for (const k of ["afterStart", "beforeEnd", "updatedSince"] as const) {
    const v = (params.get(k) ?? "").trim();
    if (v && !isoWithOffset(v)) {
      return bad(`Invalid ${k} (expected an ISO 8601 instant with a timezone offset)`);
    }
  }

  let limit = 50;
  const limitRaw = (params.get("limit") ?? "").trim();
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) return bad("Invalid limit");
    limit = Math.min(n, 100);
  }

  let offset = 0;
  const cursor = (params.get("cursor") ?? "").trim();
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded === null) return bad("Invalid cursor");
    offset = decoded;
  }
  if (offset > MAX_LIST_OFFSET) {
    return bad("Result window too large — narrow your filters (use afterStart/beforeEnd or updatedSince)");
  }

  return {
    ok: true,
    value: {
      status: status ? (status as BookingStatus) : null,
      afterStart: (params.get("afterStart") ?? "").trim() || null,
      beforeEnd: (params.get("beforeEnd") ?? "").trim() || null,
      updatedSince: (params.get("updatedSince") ?? "").trim() || null,
      bucketCode: (params.get("bucket") ?? "").trim() || null,
      agentEmail: (params.get("agentEmail") ?? "").trim() || null,
      limit,
      offset,
    },
  };
}

/** The list-only query keys; the route 400s if any appear alongside externalId. */
export const LIST_ONLY_PARAMS = [
  "afterStart",
  "beforeEnd",
  "updatedSince",
  "bucket",
  "agentEmail",
  "cursor",
  "limit",
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-booking-api-request.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/api-request.ts scripts/test-booking-api-request.ts
git commit -m "Add list query parser + offset cursor for the bookings API (#392)"
```

---

### Task 2: List orchestration (`listBookings` + `queryBookings` dep)

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (add `ApiBookingListItem`, `ListFilter`, `queryBookings` to `BookingDeps`, `listBookings`; import `encodeCursor` + `ListQuery` from `./api-request.ts`)
- Test: `scripts/test-booking-orchestration.ts` (append; extend `makeDeps`)

**Interfaces:**
- Consumes: existing `BookingDeps` (`resolveBucketByCode`, `getAgentByEmail`), `toApiBookingView`, `ApiBookingView`, `Booking`, `Bucket`, `BookingStatus`; `ListQuery`, `encodeCursor` from `./api-request.ts`.
- Produces:
  - `interface ApiBookingListItem extends ApiBookingView { bucketCode: string | null }`
  - `interface ListFilter { status: BookingStatus|null; afterStart: string|null; beforeEnd: string|null; updatedSince: string|null; bucketId: string|null; assignedUserId: string|null; limit: number; offset: number; orderBy: "starts_at" | "updated_at" }`
  - `BookingDeps.queryBookings(filter: ListFilter): Promise<{ rows: Booking[]; buckets: Bucket[] }>`
  - `listBookings(query: ListQuery, deps: BookingDeps): Promise<{ items: ApiBookingListItem[]; nextCursor: string | null }>`

- [ ] **Step 1: Write the failing test** — append inside `run()` in `scripts/test-booking-orchestration.ts`. Add `listBookings` and `type ApiBookingListItem` to the orchestration import. Then extend `makeDeps`: add to `FakeOpts` a `listResult?: { rows: Booking[]; buckets: Bucket[] }` field, and add this dep inside the returned `deps` object (next to `findActiveBookingsForPerson`):

```ts
    queryBookings: async (filter) => {
      calls.queryBookings.push(filter);
      return opts.listResult ?? { rows: [], buckets: [] };
    },
```

Add `queryBookings: [] as unknown[],` to the `calls` object. Also add a `bucket411` fixture near the top: `const bucket411 = { id: "bkt1", code: "411" } as unknown as Bucket;` (reuse existing `bucket` if it already has `code: "411"` — it is declared `{ id: "bkt1", org_id: "org1", code: "411" }`, so use that existing `bucket`).

Cases:
```ts
  // --- listBookings (#392) ---
  {
    const b1 = makeBooking({ id: "L1", bucket_id: "bkt1", starts_at: "2026-06-08T13:00:00.000Z" });
    const b2 = makeBooking({ id: "L2", bucket_id: "bkt1", starts_at: "2026-06-08T14:00:00.000Z" });
    const { deps, calls } = makeDeps({ listResult: { rows: [b1, b2], buckets: [bucket] } });
    const res = await listBookings(
      { status: "confirmed", afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 2, offset: 0 },
      deps,
    );
    assert(res.items.length === 2 && res.items[0].id === "L1", "list returns the rows as views");
    assert(res.items[0].bucketCode === "411", "list item carries bucketCode from the buckets join");
    assert(res.nextCursor !== null, "full page (rows == limit) sets a nextCursor");
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "starts_at",
      "default order is starts_at");
  }
  {
    const b1 = makeBooking({ id: "L3", bucket_id: "bkt1" });
    const { deps } = makeDeps({ listResult: { rows: [b1], buckets: [bucket] } });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.nextCursor === null, "partial page (rows < limit) -> nextCursor null");
  }
  {
    // updatedSince switches the order key
    const { deps, calls } = makeDeps({ listResult: { rows: [], buckets: [] } });
    await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: "2026-06-01T00:00:00Z",
        bucketCode: null, agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert((calls.queryBookings[0] as { orderBy: string }).orderBy === "updated_at",
      "updatedSince selects updated_at order");
  }
  {
    // unknown bucket -> empty, no queryBookings scan
    const { deps, calls } = makeDeps({ unknownBucket: true });
    const res = await listBookings(
      { status: null, afterStart: null, beforeEnd: null, updatedSince: null,
        bucketCode: "999", agentEmail: null, limit: 50, offset: 0 },
      deps,
    );
    assert(res.items.length === 0 && res.nextCursor === null, "unknown bucket -> empty page");
    assert(calls.queryBookings.length === 0, "unknown bucket -> no DB scan");
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: FAIL — `listBookings is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `src/lib/booking/orchestration.ts`.

Extend the existing `./api-request.ts`… wait, orchestration does not yet import from `api-request`. Add a new import near the other relative imports:
```ts
import { encodeCursor, type ListQuery } from "./api-request.ts";
```
Add to the `BookingDeps` interface (near `findActiveBookingsForPerson`):
```ts
  /** #392 list: filtered, ordered, offset-paginated booking page + the buckets
   *  referenced by that page (for bucketCode), resolved in one .in() query. */
  queryBookings(filter: ListFilter): Promise<{ rows: Booking[]; buckets: Bucket[] }>;
```
Then add, near `ApiBookingView` / `toApiBookingView`:
```ts
/** A list row: the lookup view plus its bucket code (#392). */
export interface ApiBookingListItem extends ApiBookingView {
  bucketCode: string | null;
}

/** Resolved list filter handed to the DB dep (codes already resolved to ids). */
export interface ListFilter {
  status: BookingStatus | null;
  afterStart: string | null;
  beforeEnd: string | null;
  updatedSince: string | null;
  bucketId: string | null;
  assignedUserId: string | null;
  limit: number;
  offset: number;
  orderBy: "starts_at" | "updated_at";
}

/**
 * #392 cross-person list. Resolves the bucket/agent filters to ids (an unknown
 * code/email yields an empty page with no DB scan), queries one offset page, and
 * tags each row with its bucket code from the joined buckets. nextCursor is set
 * only when the page came back full.
 */
export async function listBookings(
  query: ListQuery,
  deps: BookingDeps,
): Promise<{ items: ApiBookingListItem[]; nextCursor: string | null }> {
  let bucketId: string | null = null;
  if (query.bucketCode) {
    const resolved = await deps.resolveBucketByCode(query.bucketCode);
    if (!resolved) return { items: [], nextCursor: null };
    bucketId = resolved.bucket.id;
  }
  let assignedUserId: string | null = null;
  if (query.agentEmail) {
    const agent = await deps.getAgentByEmail(query.agentEmail);
    if (!agent) return { items: [], nextCursor: null };
    assignedUserId = agent.id;
  }

  const { rows, buckets } = await deps.queryBookings({
    status: query.status,
    afterStart: query.afterStart,
    beforeEnd: query.beforeEnd,
    updatedSince: query.updatedSince,
    bucketId,
    assignedUserId,
    limit: query.limit,
    offset: query.offset,
    orderBy: query.updatedSince ? "updated_at" : "starts_at",
  });

  const codeById = new Map(buckets.map((b) => [b.id, b.code]));
  const items: ApiBookingListItem[] = rows.map((b) => ({
    ...toApiBookingView(b, deps),
    bucketCode: codeById.get(b.bucket_id) ?? null,
  }));
  const nextCursor = rows.length === query.limit ? encodeCursor(query.offset + query.limit) : null;
  return { items, nextCursor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/orchestration.ts scripts/test-booking-orchestration.ts
git commit -m "Add listBookings orchestration + queryBookings dep (#392)"
```

---

### Task 3: List indexes migration

**Files:**
- Create: `supabase/migrations/0044_bookings_list_indexes.sql`

**Interfaces:** none (DB only). Verified: `bucket_id` and `assigned_user_id` are already indexed; only `starts_at` and `updated_at` need new indexes.

- [ ] **Step 1: Write the migration**

```sql
-- #392 list endpoint: support the default (starts_at) order + keyset/offset scan
-- and the updatedSince (updated_at) incremental-reconciliation order. The bucket
-- and agent filters are already covered by bookings_bucket_idx (bucket_id) and
-- bookings_assigned_idx (assigned_user_id, starts_at).
create index if not exists bookings_starts_at_id_idx on public.bookings (starts_at, id);
create index if not exists bookings_updated_at_idx on public.bookings (updated_at);
```

- [ ] **Step 2: Apply + verify (operator action)**

Run: `supabase db push`
Then verify: `select indexname from pg_indexes where tablename='bookings' and indexname in ('bookings_starts_at_id_idx','bookings_updated_at_idx');`
Expected: both rows present. (Additive + `if not exists`, so safe to apply before or after code merges.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0044_bookings_list_indexes.sql
git commit -m "Add bookings list indexes (starts_at, updated_at) (#392)"
```

---

### Task 4: Relocate the public create to `POST /booking`

**Files:**
- Create: `src/app/booking/route.ts` (the current public create, verbatim)
- Modify: `src/components/Booker.tsx:311` (fetch target `/api/bookings` → `/booking`)
- Create: `src/app/booking/route.test.ts` (move the public route test)
- Delete: `src/app/api/bookings/route.ts` and `src/app/api/bookings/route.test.ts` (their public-create role moves; `/api/bookings` is recreated authed in Task 5)

**Interfaces:** Consumes `createBooking` + error classes + rate-limit (unchanged). Produces `POST /booking` (public). Verified by `npx tsc --noEmit`, `pnpm build`, and the moved route test.

- [ ] **Step 1: Create `src/app/booking/route.ts`** — copy the ENTIRE current body of `src/app/api/bookings/route.ts` verbatim (the imports, `export const dynamic = "force-dynamic"`, the `schema`, and the `POST` handler shown in the spec). No code changes — only its location moves. Keep `export const dynamic = "force-dynamic"`.

- [ ] **Step 2: Move the route test** — create `src/app/booking/route.test.ts` with the exact contents of `src/app/api/bookings/route.test.ts`, changing only the `new Request("http://localhost/api/bookings", …)` URL to `http://localhost/booking` and the `describe` title to `POST /booking (embed) error mapping`. (The import `from "./route"` resolves to the new file.)

- [ ] **Step 3: Repoint the Booker** — in `src/components/Booker.tsx`, change line 311:

```ts
    const res = await fetch("/booking", {
```

- [ ] **Step 4: Delete the old public route + its test**

```bash
git rm src/app/api/bookings/route.ts src/app/api/bookings/route.test.ts
```

- [ ] **Step 5: Typecheck, build, test**

Run: `npx tsc --noEmit && pnpm vitest run src/app/booking/route.test.ts`
Expected: tsc clean; route test passes (success 200, 409, 503 mapping).
Run: `pnpm build`
Expected: build succeeds; `/booking` appears as a route, `/api/bookings` no longer has the public POST (it will be recreated authed in Task 5; an intermediate build with no `/api/bookings` route is fine).

- [ ] **Step 6: Commit**

```bash
git add src/app/booking/route.ts src/app/booking/route.test.ts src/components/Booker.tsx
git commit -m "Move public booking create to keyless POST /booking (#392)"
```

---

### Task 5: Move authed handlers to `/api/bookings` + add list mode

**Files:**
- Create: `src/app/api/bookings/route.ts` (authed POST/GET/DELETE, moved from `direct/route.ts`, plus list mode)
- Modify: `src/lib/booking/service.ts` (add `listBookings` wrapper + `queryBookings` real dep)
- Modify: `src/lib/env.ts:89` and `src/lib/booking/api-request.ts` doc comments (`/api/bookings/direct` → `/api/bookings`)
- Move: `src/app/api/bookings/direct/route.test.ts` → `src/app/api/bookings/route.test.ts` (re-add as the authed test) + add list-mode cases
- Delete: `src/app/api/bookings/direct/` (route.ts + route.test.ts)

**Interfaces:**
- Consumes: `listBookings`, `ApiBookingListItem`, `ListFilter` (Task 2); `parseListQuery`, `LIST_ONLY_PARAMS` (Task 1); existing `authorize`, `parseLookupQuery`, `parseCancelQuery`, `bookViaApi`, `previewBooking`, lookup/cancel functions, error classes.
- Produces: authed `POST/GET/DELETE /api/bookings`; `service.listBookings(query)`.

- [ ] **Step 1: Add the service wrapper + real dep** — in `src/lib/booking/service.ts`:

Add the wrapper next to the other API wrappers:
```ts
/** #392 list (key-authed): cross-person filtered, paginated bookings. */
export function listBookings(query: import("@/lib/booking/api-request").ListQuery) {
  return orchestration.listBookings(query, realDeps());
}
```
Add the real `queryBookings` inside the object returned by `realDeps()` (next to `findActiveBookingsForPerson`):
```ts
    queryBookings: async (filter) => {
      let q = supabaseAdmin().from("bookings").select("*");
      if (filter.status) q = q.eq("status", filter.status);
      if (filter.afterStart) q = q.gte("starts_at", filter.afterStart);
      if (filter.beforeEnd) q = q.lte("starts_at", filter.beforeEnd);
      if (filter.updatedSince) q = q.gt("updated_at", filter.updatedSince);
      if (filter.bucketId) q = q.eq("bucket_id", filter.bucketId);
      if (filter.assignedUserId) q = q.eq("assigned_user_id", filter.assignedUserId);
      const { data } = await q
        .order(filter.orderBy, { ascending: true })
        .order("id", { ascending: true })
        .range(filter.offset, filter.offset + filter.limit - 1);
      const rows = (data ?? []) as Booking[];
      const bucketIds = [...new Set(rows.map((b) => b.bucket_id))];
      const buckets = bucketIds.length
        ? (((await supabaseAdmin().from("buckets").select("*").in("id", bucketIds)).data ?? []) as Bucket[])
        : [];
      return { rows, buckets };
    },
```
(`Bucket` is already imported in `service.ts` via the db/types import; if not, add it.)

- [ ] **Step 2: Create the authed route** — `src/app/api/bookings/route.ts`. Start from the CURRENT `src/app/api/bookings/direct/route.ts` (which already has `authorize`, `POST`, `GET`, `DELETE`, `mapBookingError`, `mapLookupError`). Keep it identical EXCEPT:
  - add the list-mode imports and branch in `GET`.

Imports to add:
```ts
import { parseDirectBookingRequest, parseLookupQuery, parseCancelQuery, parseListQuery, LIST_ONLY_PARAMS } from "@/lib/booking/api-request";
```
and add `listBookings` to the `@/lib/booking/service` import list.

Replace the `GET` handler with this dual-mode version:
```ts
export async function GET(req: NextRequest) {
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;

  const sp = req.nextUrl.searchParams;
  const externalIdKeyPresent = sp.has("externalId");

  // List mode: the externalId KEY is absent entirely.
  if (!externalIdKeyPresent) {
    const parsed = parseListQuery(sp);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
    }
    const { bookings, nextCursor } = await listBookings(parsed.value).then((r) => ({
      bookings: r.items,
      nextCursor: r.nextCursor,
    }));
    return NextResponse.json({ bookings, nextCursor });
  }

  // Lookup mode: externalId present. Reject blank, and reject list filters mixed in.
  if ((sp.get("externalId") ?? "").trim() === "") {
    return NextResponse.json({ error: "externalId is required", code: "VALIDATION" }, { status: 400 });
  }
  if (LIST_ONLY_PARAMS.some((k) => sp.has(k))) {
    return NextResponse.json(
      { error: "externalId selects per-person lookup; remove list filters or omit externalId", code: "VALIDATION" },
      { status: 400 },
    );
  }

  const parsed = parseLookupQuery(sp);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { externalId, salesforceId, bookingId, status } = parsed.value;
  try {
    if (bookingId) {
      const booking = await getPersonBookingById({ bookingId, identity: { externalId, salesforceId }, status });
      return NextResponse.json({ booking });
    }
    const list = await lookupPersonBookings({ externalId, salesforceId });
    return NextResponse.json({ bookings: list });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed", code },
      { status: httpStatus },
    );
  }
}
```
Keep `export const dynamic = "force-dynamic"`, `authorize`, `POST`, `DELETE`, `mapBookingError`, `mapLookupError` exactly as they are in `direct/route.ts`.

- [ ] **Step 3: Move the route test + add list cases** — move `src/app/api/bookings/direct/route.test.ts` to `src/app/api/bookings/route.test.ts`. In it, change the request URL host path `http://localhost/api/bookings/direct` → `http://localhost/api/bookings`, add `listBookings: vi.fn()` to the hoisted `service` mock, import `GET` from `./route`, and add:
```ts
it("GET list mode (no externalId) returns the list payload", async () => {
  service.listBookings.mockResolvedValue({ items: [{ id: "bk-1", bucketCode: "411" }], nextCursor: null });
  const res = await GET(new Request("http://localhost/api/bookings?status=confirmed") as never);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ bookings: [{ id: "bk-1" }], nextCursor: null });
});
it("GET with blank externalId -> 400", async () => {
  const res = await GET(new Request("http://localhost/api/bookings?externalId=") as never);
  expect(res.status).toBe(400);
});
it("GET with externalId + a list filter -> 400", async () => {
  const res = await GET(new Request("http://localhost/api/bookings?externalId=x&afterStart=2026-07-01T00:00:00Z") as never);
  expect(res.status).toBe(400);
});
it("GET list mode requires auth (no key -> 401/503)", async () => {
  env.bookingApiKeyPrimary.mockReturnValue("");
  const res = await GET(new Request("http://localhost/api/bookings") as never);
  expect([401, 503]).toContain(res.status);
});
```
(Mirror the existing mock setup — `env`, `rateLimit`, `service` hoisted mocks; ensure `allowRequest` returns true and a valid key is configured for the non-auth tests, per the existing `beforeEach`.)

- [ ] **Step 4: Update doc comments + delete `/direct`**

In `src/lib/env.ts:89` change `POST /api/bookings/direct` → `POST /api/bookings`. In `src/lib/booking/api-request.ts`, change the two doc-comment mentions of `/api/bookings/direct` to `/api/bookings`. Then:
```bash
git rm src/app/api/bookings/direct/route.ts src/app/api/bookings/direct/route.test.ts
```

- [ ] **Step 5: Typecheck, build, route tests**

Run: `npx tsc --noEmit && pnpm vitest run src/app/api/bookings/route.test.ts`
Expected: tsc clean; route tests pass (POST outcomes, GET lookup + list + 400s + auth, DELETE).
Run: `pnpm build`
Expected: succeeds; `/api/bookings` shows GET/POST/DELETE; no `/api/bookings/direct`.

- [ ] **Step 6: Commit**

```bash
git add -A src/app/api/bookings src/lib/booking/service.ts src/lib/env.ts src/lib/booking/api-request.ts
git commit -m "Move bot API to /api/bookings + add list mode; delete /direct (#392)"
```

---

### Task 6: Smoke + docs + merge gate

**Files:**
- Modify: `scripts/smoke-booking-api.ts` (repoint to `/api/bookings`, add a list leg)
- Modify: `docs/booking-api.md`, `DEPLOY.md`, `README.md`

**Interfaces:** none. Verified by `npx tsc --noEmit` and the zero-result merge-gate grep.

- [ ] **Step 1: Repoint + extend the smoke script** — read `scripts/smoke-booking-api.ts`, replace every `/api/bookings/direct` with `/api/bookings` (the `book()` POST target and the GET/DELETE legs), and after the existing checks add a list leg using the script's `req`/`check` helpers:

```ts
// [5] list mode (cross-person)
const listRes = await req("GET", `/api/bookings?bucket=${BUCKET_A}&limit=5`);
check(listRes.status === 200 && Array.isArray(listRes.body.bookings),
  "GET list (no externalId) returns a bookings array");
check(listRes.body.bookings.every((b) => b.bucketCode === BUCKET_A),
  "list rows are tagged with the filtered bucketCode");
const blankExt = await req("GET", `/api/bookings?externalId=`);
check(blankExt.status === 400, "blank externalId -> 400 (not a cross-person dump)");
```

- [ ] **Step 2: Rewrite the docs** — in `docs/booking-api.md` replace all `/api/bookings/direct` with `/api/bookings`; add a top note that the public customer create is `POST /booking` (keyless) and everything under `/api/bookings` is key-authed; add a "List bookings — `GET /api/bookings` (no externalId)" section documenting the filters, offset cursor (`limit`, `cursor`/`nextCursor`), default vs `updatedSince` ordering, the `bucketCode` field, and the 400 cases (blank externalId, externalId+filter, bad cursor, offset cap). In `DEPLOY.md:51` and `README.md:82`, change `/api/bookings/direct` → `/api/bookings`.

- [ ] **Step 3: Merge gate**

Run: `grep -rn "api/bookings/direct" src scripts docs/booking-api.md DEPLOY.md README.md`
Expected: **no output** (zero matches). If any remain, fix them.
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-booking-api.ts docs/booking-api.md DEPLOY.md README.md
git commit -m "Repoint smoke + docs to /api/bookings; document list endpoint (#392)"
```

---

## Self-Review

**Spec coverage:**
- Public create → `/booking` keyless, Booker repointed → Task 4. ✓
- `/api/bookings` authed POST/GET/DELETE, `/direct` deleted → Task 5. ✓
- List filters + offset pagination + ordering (updatedSince) + bucketCode → Tasks 1, 2, 5. ✓
- Mode disambiguation (absent / blank / present+filter) → Task 1 (`LIST_ONLY_PARAMS`) + Task 5 (GET branch). ✓
- Indexes (only starts_at + updated_at) → Task 3. ✓
- Tests (pure parser, orchestration, route, smoke) → Tasks 1, 2, 5, 6. ✓
- Atomic cutover + merge gate → Task 6 Step 3 (and constraints). ✓

**Placeholder scan:** none — every step carries complete code.

**Type consistency:** `ListQuery` (api-request) → consumed by `listBookings` (orchestration) and `service.listBookings`; `ListFilter` (resolved ids) is the `queryBookings` dep param in both the fake (Task 2) and real (Task 5) impls; `ApiBookingListItem` returned by `listBookings`, mocked in the route test. `encodeCursor`/`decodeCursor` names match across Tasks 1–2. `orderBy` union `"starts_at"|"updated_at"` consistent. The route reads `r.items`→`bookings` and `r.nextCursor` matching `listBookings`'s return.

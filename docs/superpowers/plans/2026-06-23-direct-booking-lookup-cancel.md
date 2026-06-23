# Direct Booking API — lookup & cancel by external_id (#386) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add key-authed `GET` (lookup a person's bookings by `external_id`, optionally one by id with a status filter) and `DELETE` (cancel one booking by id, ownership-verified) handlers to the existing `/api/bookings/direct` route.

**Architecture:** Additive read/cancel surface over existing primitives. Pure helpers (`bookingBelongsToPerson`, query parsers) are unit-tested under `node --experimental-strip-types`; orchestration functions (`lookupPersonBookings` / `getPersonBookingById` / `cancelDirectBooking`) run against the existing in-memory fake `BookingDeps`; the route + thin `service.ts` wrappers are typecheck/build/smoke-verified. No new booking logic, no migration, no new env.

**Tech Stack:** Next.js 16 App Router (TS), Zod, Luxon, node-native test scripts (`scripts/test-*.ts`). Package manager: pnpm.

## Global Constraints

- TypeScript everywhere; avoid `any`. 2-space indent, existing Prettier/ESLint.
- Pure booking modules use **relative** value imports (`../`, `./`) and type-only `@/` imports, so they run under `node --experimental-strip-types`.
- Every new feature ships with a `scripts/test-*.ts` node-native test. Run `npx tsc --noEmit` before pushing (CI type-checks test files; local build/vitest do not).
- Weekday convention is Luxon's (1=Mon..7=Sun) — not relevant here but project-wide.
- Person resolution for these endpoints uses **strong ids only** (`external_id` / `salesforce_id`); never email/phone, to avoid acting on the wrong person.
- Booking statuses: `confirmed`, `rescheduled`, `cancelled`, `completed`. Active = `confirmed` + `rescheduled`.
- Branch `feat/booking-api-lookup-cancel` is already off `origin/main`. Commit frequently.

---

### Task 1: `bookingBelongsToPerson` ownership helper

**Files:**
- Modify: `src/lib/booking/person-dedupe.ts` (add one exported function near `findPersonMatch`)
- Test: `scripts/test-person-dedupe.ts` (append cases)

**Interfaces:**
- Consumes: existing `PersonIdentity`, `Booking`.
- Produces: `bookingBelongsToPerson(booking: Booking, identity: Pick<PersonIdentity, "externalId" | "salesforceId">): boolean` — true iff a strong id matches.

- [ ] **Step 1: Write the failing test** — append to `scripts/test-person-dedupe.ts` (before the final `console.log(failures === 0 ...)` line). It imports `bookingBelongsToPerson` from the module under test. If the file's existing import is `import { findPersonMatch, decidePersonBooking } from "../src/lib/booking/person-dedupe.ts";`, add `bookingBelongsToPerson` to that import list. Reuse the file's existing `assert` helper and any `makeBooking`-style factory; if none exists, inline booking literals as below.

```ts
// --- bookingBelongsToPerson (strong-id ownership, #386) ---
const ownExt = { external_id: "ext-1", salesforce_id: null } as unknown as import("../src/lib/db/types.ts").Booking;
const ownSf = { external_id: null, salesforce_id: "sf-9" } as unknown as import("../src/lib/db/types.ts").Booking;
const stranger = { external_id: "other", salesforce_id: "other-sf" } as unknown as import("../src/lib/db/types.ts").Booking;

assert(bookingBelongsToPerson(ownExt, { externalId: "ext-1", salesforceId: null }) === true,
  "owns by external_id");
assert(bookingBelongsToPerson(ownSf, { externalId: null, salesforceId: "sf-9" }) === true,
  "owns by salesforce_id");
assert(bookingBelongsToPerson(stranger, { externalId: "ext-1", salesforceId: "sf-9" }) === false,
  "different person on both ids = not owned");
assert(bookingBelongsToPerson(ownExt, { externalId: null, salesforceId: null }) === false,
  "no ids supplied = not owned");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-person-dedupe.ts`
Expected: FAIL — `bookingBelongsToPerson is not a function` / import error.

- [ ] **Step 3: Write minimal implementation** — add to `src/lib/booking/person-dedupe.ts`, just after the `findPersonMatch` function:

```ts
/**
 * Does `booking` belong to the person, judged by a STRONG id only (external_id
 * or salesforce_id)? Used by the #386 lookup-by-id / cancel paths: a key-authed
 * caller may only read or cancel a booking it can prove ownership of by id, so a
 * shared email/phone can never reach another person's appointment.
 */
export function bookingBelongsToPerson(
  booking: Booking,
  identity: Pick<PersonIdentity, "externalId" | "salesforceId">,
): boolean {
  if (identity.externalId && booking.external_id === identity.externalId) return true;
  if (identity.salesforceId && booking.salesforce_id === identity.salesforceId) return true;
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-person-dedupe.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/person-dedupe.ts scripts/test-person-dedupe.ts
git commit -m "Add bookingBelongsToPerson strong-id ownership check (#386)"
```

---

### Task 2: Query parsers `parseLookupQuery` + `parseCancelQuery`

**Files:**
- Modify: `src/lib/booking/api-request.ts` (add types, a status list, and two parsers)
- Test: `scripts/test-booking-api-request.ts` (append cases)

**Interfaces:**
- Consumes: `validateReason`, `ValidatedReason` from `./core.ts`; `BookingStatus` from `../db/types.ts`.
- Produces:
  - `parseLookupQuery(params: URLSearchParams): { ok: true; value: LookupQuery } | { ok: false; status: 400; error: string }`
  - `parseCancelQuery(params: URLSearchParams): { ok: true; value: CancelQuery } | { ok: false; status: 400; error: string }`
  - `interface LookupQuery { externalId: string; salesforceId: string | null; bookingId: string | null; status: BookingStatus | null }`
  - `interface CancelQuery { bookingId: string; externalId: string | null; salesforceId: string | null; reason: ValidatedReason | null }`

- [ ] **Step 1: Write the failing test** — append to `scripts/test-booking-api-request.ts` (before its final summary line), reusing its `assert` helper. Add imports `parseLookupQuery, parseCancelQuery` to the existing `from "../src/lib/booking/api-request.ts"` import.

```ts
// --- parseLookupQuery (#386) ---
const lqOk = parseLookupQuery(new URLSearchParams("externalId=ext-1"));
assert(lqOk.ok && lqOk.value.externalId === "ext-1" && lqOk.value.bookingId === null && lqOk.value.status === null,
  "lookup: externalId only is valid, no bookingId/status");
const lqMiss = parseLookupQuery(new URLSearchParams(""));
assert(!lqMiss.ok && lqMiss.status === 400, "lookup: missing externalId = 400");
const lqId = parseLookupQuery(new URLSearchParams("externalId=ext-1&bookingId=bk-7&status=confirmed"));
assert(lqId.ok && lqId.value.bookingId === "bk-7" && lqId.value.status === "confirmed",
  "lookup: bookingId + valid status parsed");
const lqBadStatus = parseLookupQuery(new URLSearchParams("externalId=ext-1&status=pending"));
assert(!lqBadStatus.ok && lqBadStatus.status === 400, "lookup: unknown status = 400");

// --- parseCancelQuery (#386) ---
const cqOk = parseCancelQuery(new URLSearchParams("bookingId=bk-7&externalId=ext-1"));
assert(cqOk.ok && cqOk.value.bookingId === "bk-7" && cqOk.value.externalId === "ext-1" && cqOk.value.reason === null,
  "cancel: bookingId + externalId valid, reason defaults null");
const cqNoBooking = parseCancelQuery(new URLSearchParams("externalId=ext-1"));
assert(!cqNoBooking.ok && cqNoBooking.status === 400, "cancel: missing bookingId = 400");
const cqNoId = parseCancelQuery(new URLSearchParams("bookingId=bk-7"));
assert(!cqNoId.ok && cqNoId.status === 400, "cancel: missing both ids = 400");
const cqReason = parseCancelQuery(new URLSearchParams("bookingId=bk-7&salesforceId=sf-9&reason=no_longer_interested"));
assert(cqReason.ok && cqReason.value.reason?.code === "no_longer_interested",
  "cancel: valid reason code accepted");
const cqBadReason = parseCancelQuery(new URLSearchParams("bookingId=bk-7&externalId=ext-1&reason=not_a_reason"));
assert(!cqBadReason.ok && cqBadReason.status === 400, "cancel: invalid reason = 400");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-api-request.ts`
Expected: FAIL — `parseLookupQuery is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `src/lib/booking/api-request.ts`:

First extend the imports at the top:

```ts
import { validateAttendee, type AttendeeErrors } from "../attendee.ts";
import { validateReason, type ValidatedReason } from "./core.ts";
import type { BookingStatus } from "../db/types.ts";
```

Then append at the end of the file:

```ts
const BOOKING_STATUSES: readonly BookingStatus[] = [
  "confirmed",
  "rescheduled",
  "cancelled",
  "completed",
];

export interface LookupQuery {
  externalId: string;
  salesforceId: string | null;
  bookingId: string | null;
  status: BookingStatus | null;
}

export type LookupParseResult =
  | { ok: true; value: LookupQuery }
  | { ok: false; status: 400; error: string };

/**
 * Parse a GET /api/bookings/direct lookup query (#386). `externalId` is required
 * (the bot's stable per-person id). `bookingId` selects one booking; `status` is
 * an optional assertion meaningful only with `bookingId` (the by-id handler
 * applies it). An unrecognized `status` is a 400.
 */
export function parseLookupQuery(params: URLSearchParams): LookupParseResult {
  const externalId = (params.get("externalId") ?? "").trim();
  if (!externalId) {
    return { ok: false, status: 400, error: "externalId is required" };
  }
  const salesforceId = (params.get("salesforceId") ?? "").trim() || null;
  const bookingId = (params.get("bookingId") ?? "").trim() || null;

  let status: BookingStatus | null = null;
  const statusRaw = (params.get("status") ?? "").trim();
  if (statusRaw) {
    if (!BOOKING_STATUSES.includes(statusRaw as BookingStatus)) {
      return { ok: false, status: 400, error: "Invalid status filter" };
    }
    status = statusRaw as BookingStatus;
  }
  return { ok: true, value: { externalId, salesforceId, bookingId, status } };
}

export interface CancelQuery {
  bookingId: string;
  externalId: string | null;
  salesforceId: string | null;
  reason: ValidatedReason | null;
}

export type CancelParseResult =
  | { ok: true; value: CancelQuery }
  | { ok: false; status: 400; error: string };

/**
 * Parse a DELETE /api/bookings/direct cancel query (#386). Requires an explicit
 * `bookingId` AND a strong id (`externalId` or `salesforceId`) so the caller
 * targets exactly one ownership-checked booking. Optional `reason` (+
 * `reasonDetail` for the "other" code) is validated against CANCEL_REASONS;
 * absent → null (the service substitutes the default api_cancellation reason).
 */
export function parseCancelQuery(params: URLSearchParams): CancelParseResult {
  const bookingId = (params.get("bookingId") ?? "").trim();
  if (!bookingId) {
    return { ok: false, status: 400, error: "bookingId is required" };
  }
  const externalId = (params.get("externalId") ?? "").trim() || null;
  const salesforceId = (params.get("salesforceId") ?? "").trim() || null;
  if (!externalId && !salesforceId) {
    return { ok: false, status: 400, error: "externalId or salesforceId is required" };
  }

  let reason: ValidatedReason | null = null;
  const reasonCode = (params.get("reason") ?? "").trim();
  if (reasonCode) {
    const v = validateReason("cancel", { code: reasonCode, detail: params.get("reasonDetail") });
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    reason = v.reason;
  }
  return { ok: true, value: { bookingId, externalId, salesforceId, reason } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-booking-api-request.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/api-request.ts scripts/test-booking-api-request.ts
git commit -m "Add lookup/cancel query parsers for the direct booking API (#386)"
```

---

### Task 3: Orchestration — lookup, get-by-id, cancel-by-id

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (add error class, view type + builder, three functions)
- Test: `scripts/test-booking-orchestration.ts` (append cases, reusing `makeDeps` / `makeBooking`)

**Interfaces:**
- Consumes: existing `BookingDeps` (`findActiveBookingsForPerson`, `loadBookingById`, `cancelBooking`), private `manageUrl(deps, token)`, `bookingBelongsToPerson` (Task 1), `PersonIdentity`, `Booking`, `BookingStatus`, `ValidatedReason`.
- Produces:
  - `class BookingNotFoundError extends Error`
  - `interface ApiBookingView { id; externalId; salesforceId; startsAt; endsAt; status; agent:{name;email}; manageUrl }`
  - `lookupPersonBookings(identity: PersonIdentity, deps: BookingDeps): Promise<ApiBookingView[]>`
  - `getPersonBookingById(input: { bookingId: string; identity: Pick<PersonIdentity,"externalId"|"salesforceId">; status: BookingStatus | null }, deps: BookingDeps): Promise<ApiBookingView>`
  - `cancelDirectBooking(input: { bookingId: string; identity: Pick<PersonIdentity,"externalId"|"salesforceId">; reason: ValidatedReason }, deps: BookingDeps): Promise<ApiBookingView>`

- [ ] **Step 1: Write the failing test** — append to `scripts/test-booking-orchestration.ts` inside the `run()` function (before the final summary), adding the new symbols to the existing orchestration import block. The file already has `makeDeps`, `makeBooking`, and `assert`.

Add to imports (the `from "../src/lib/booking/orchestration.ts"` list):
```ts
  lookupPersonBookings,
  getPersonBookingById,
  cancelDirectBooking,
  BookingNotFoundError,
```

Add cases in `run()`:
```ts
  // --- lookupPersonBookings (#386): maps active rows to API views ---
  {
    const bk = makeBooking({ id: "bkL", external_id: "ext-1", salesforce_id: "sf-9" });
    const { deps } = makeDeps({ personBookings: [bk] });
    const views = await lookupPersonBookings(
      { externalId: "ext-1", salesforceId: null, email: null, phone: null },
      deps,
    );
    assert(views.length === 1 && views[0].id === "bkL", "lookup returns one view");
    assert(views[0].manageUrl === "https://slate.test/booking/manage/tok1", "lookup view has manageUrl");
    assert(views[0].externalId === "ext-1" && views[0].status === "confirmed", "lookup view fields mapped");
  }

  // --- getPersonBookingById (#386) ---
  {
    const bk = makeBooking({ id: "bkG", external_id: "ext-1", status: "cancelled" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    const view = await getPersonBookingById(
      { bookingId: "bkG", identity: { externalId: "ext-1", salesforceId: null }, status: null },
      deps,
    );
    assert(view.id === "bkG" && view.status === "cancelled", "get-by-id returns any status when no filter");

    let threw = false;
    try {
      await getPersonBookingById(
        { bookingId: "bkG", identity: { externalId: "ext-1", salesforceId: null }, status: "confirmed" },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "get-by-id status filter mismatch → BookingNotFoundError");

    let threwOwner = false;
    try {
      await getPersonBookingById(
        { bookingId: "bkG", identity: { externalId: "stranger", salesforceId: null }, status: null },
        deps,
      );
    } catch (e) { threwOwner = e instanceof BookingNotFoundError; }
    assert(threwOwner, "get-by-id wrong owner → BookingNotFoundError");
  }
  {
    const { deps } = makeDeps({ bookingById: null });
    let threw = false;
    try {
      await getPersonBookingById(
        { bookingId: "nope", identity: { externalId: "ext-1", salesforceId: null }, status: null },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "get-by-id missing booking → BookingNotFoundError");
  }

  // --- cancelDirectBooking (#386) ---
  {
    const bk = makeBooking({ id: "bkC", external_id: "ext-1", status: "confirmed", gcal_event_id: "g1" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ bookingById: ctx, existing: ctx });
    const view = await cancelDirectBooking(
      { bookingId: "bkC", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
      deps,
    );
    assert(view.status === "cancelled", "cancel returns the cancelled view");
    assert(calls.webhooks.some((w) => w.event === "booking.cancelled"), "cancel fires booking.cancelled");
    assert(calls.bookingEvents.some((e) => e.action === "cancelled" && e.initiator === "customer"),
      "cancel records a customer-initiated history row");
  }
  {
    const bk = makeBooking({ id: "bkD", external_id: "ext-1", status: "completed" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps } = makeDeps({ bookingById: ctx });
    let threw = false;
    try {
      await cancelDirectBooking(
        { bookingId: "bkD", identity: { externalId: "ext-1", salesforceId: null }, reason: { code: "api_cancellation", detail: null } },
        deps,
      );
    } catch (e) { threw = e instanceof BookingNotFoundError; }
    assert(threw, "cancel of a non-active booking → BookingNotFoundError");
  }
```

Note: `cancelBooking` (which `cancelDirectBooking` calls) uses `deps.loadBookingContext(token)`, so the cancel happy-path fake sets BOTH `bookingById` and `existing` to the same context.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: FAIL — `lookupPersonBookings is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `src/lib/booking/orchestration.ts`:

Add `bookingBelongsToPerson` to the existing `./person-dedupe.ts` import block:
```ts
import {
  findPersonMatch,
  decidePersonBooking,
  bookingBelongsToPerson,
  type PersonIdentity,
} from "./person-dedupe.ts";
```

Add `BookingStatus` to the `@/lib/db/types` type import block (alongside `Booking`):
```ts
  Booking,
  BookingStatus,
```

Then add, after the `UnknownBucketError` class (around line 88):
```ts
/** Thrown when a lookup/cancel can't resolve an owned booking by id (#386). */
export class BookingNotFoundError extends Error {
  constructor() {
    super("Booking not found");
    this.name = "BookingNotFoundError";
  }
}
```

And add this block near the other API functions (e.g. just after `bookViaApi`, around line 643):
```ts
/** Active statuses a person can still cancel (#386). */
const CANCELLABLE_STATUSES: readonly BookingStatus[] = ["confirmed", "rescheduled"];

/** Outward-facing view of a booking for the lookup/cancel API (#386). */
export interface ApiBookingView {
  id: string;
  externalId: string | null;
  salesforceId: string | null;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  agent: { name: string | null; email: string | null };
  manageUrl: string;
}

function toApiBookingView(b: Booking, deps: BookingDeps): ApiBookingView {
  return {
    id: b.id,
    externalId: b.external_id,
    salesforceId: b.salesforce_id,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    status: b.status,
    agent: { name: b.agent_name, email: b.agent_email },
    manageUrl: manageUrl(deps, b.manage_token),
  };
}

/** List a person's ACTIVE bookings for the lookup API (#386). Strong-id only:
 *  the identity passed in carries no email/phone, so every match is strong. */
export async function lookupPersonBookings(
  identity: PersonIdentity,
  deps: BookingDeps,
): Promise<ApiBookingView[]> {
  const bookings = await deps.findActiveBookingsForPerson(identity);
  return bookings.map((b) => toApiBookingView(b, deps));
}

/** Read ONE booking by id for the lookup API (#386), at any status (so the bot
 *  can poll a cancelled/completed one). Throws BookingNotFoundError if missing,
 *  not owned by the caller, or (when `status` is set) not in that status. */
export async function getPersonBookingById(
  input: {
    bookingId: string;
    identity: Pick<PersonIdentity, "externalId" | "salesforceId">;
    status: BookingStatus | null;
  },
  deps: BookingDeps,
): Promise<ApiBookingView> {
  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx || !bookingBelongsToPerson(ctx.booking, input.identity)) {
    throw new BookingNotFoundError();
  }
  if (input.status && ctx.booking.status !== input.status) {
    throw new BookingNotFoundError();
  }
  return toApiBookingView(ctx.booking, deps);
}

/** Cancel ONE booking by id for the cancel API (#386). Requires the booking to
 *  exist, be owned by the caller (strong id), and be active; else
 *  BookingNotFoundError. Reuses the standard cancel path (gcal delete, busy-block
 *  clear, history row, booking.cancelled webhook), stamped initiator=customer. */
export async function cancelDirectBooking(
  input: {
    bookingId: string;
    identity: Pick<PersonIdentity, "externalId" | "salesforceId">;
    reason: ValidatedReason;
  },
  deps: BookingDeps,
): Promise<ApiBookingView> {
  const ctx = await deps.loadBookingById(input.bookingId);
  if (!ctx || !bookingBelongsToPerson(ctx.booking, input.identity)) {
    throw new BookingNotFoundError();
  }
  if (!CANCELLABLE_STATUSES.includes(ctx.booking.status)) {
    throw new BookingNotFoundError();
  }
  await cancelBooking(ctx.booking.manage_token, input.reason, "customer", deps);
  return toApiBookingView({ ...ctx.booking, status: "cancelled" }, deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: PASS — `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/orchestration.ts scripts/test-booking-orchestration.ts
git commit -m "Add lookup/get-by-id/cancel-by-id orchestration for the direct booking API (#386)"
```

---

### Task 4: Service wrappers + GET/DELETE route handlers

**Files:**
- Modify: `src/lib/booking/service.ts` (three real-deps wrappers, default cancel reason, re-export `BookingNotFoundError` + `ApiBookingView`)
- Modify: `src/app/api/bookings/direct/route.ts` (extract `authorize`, add `GET` + `DELETE`, extend error map)

**Interfaces:**
- Consumes: `orchestration.lookupPersonBookings` / `getPersonBookingById` / `cancelDirectBooking` / `BookingNotFoundError` / `ApiBookingView`; `parseLookupQuery` / `parseCancelQuery`; existing `parseApiKeys` / `authenticateBearer` / `allowRequest` / `DIRECT_BOOKING_API_RATE_RULES`.
- Produces: HTTP `GET` and `DELETE` on `/api/bookings/direct`. No unit test (route/IO layer); verified by `npx tsc --noEmit` + `pnpm build`, then the live smoke test in Task 5.

- [ ] **Step 1: Add the service wrappers** — in `src/lib/booking/service.ts`, append next to `bookViaApi`/`previewBooking`:

```ts
/** Default reason stamped on an API cancel when the bot supplies none (#386). */
const API_CANCEL_REASON: ValidatedReason = { code: "api_cancellation", detail: null };

/** Lookup API (#386): a person's active bookings by strong id (email/phone null
 *  so only strong matches surface). */
export function lookupPersonBookings(identity: {
  externalId: string;
  salesforceId: string | null;
}): Promise<orchestration.ApiBookingView[]> {
  return orchestration.lookupPersonBookings(
    { externalId: identity.externalId, salesforceId: identity.salesforceId, email: null, phone: null },
    realDeps(),
  );
}

/** Lookup API (#386): one booking by id (any status, or asserted `status`). */
export function getPersonBookingById(input: {
  bookingId: string;
  identity: { externalId: string | null; salesforceId: string | null };
  status: BookingStatus | null;
}): Promise<orchestration.ApiBookingView> {
  return orchestration.getPersonBookingById(input, realDeps());
}

/** Cancel API (#386): cancel one owned booking by id. */
export function cancelDirectBooking(input: {
  bookingId: string;
  identity: { externalId: string | null; salesforceId: string | null };
  reason: ValidatedReason | null;
}): Promise<orchestration.ApiBookingView> {
  return orchestration.cancelDirectBooking(
    { bookingId: input.bookingId, identity: input.identity, reason: input.reason ?? API_CANCEL_REASON },
    realDeps(),
  );
}
```

Then extend the existing error re-export block to include the new class, and confirm `ValidatedReason` + `BookingStatus` are imported in `service.ts` (add them to the existing `@/lib/db/types` / `@/lib/booking/core` type imports if missing — `BookingStatus` from `@/lib/db/types`, `ValidatedReason` from the core import block):

```ts
export {
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  BookingNotFoundError,
} from "@/lib/booking/orchestration";
```

- [ ] **Step 2: Refactor the POST preamble into `authorize` and add the handlers** — in `src/app/api/bookings/direct/route.ts`. Update the service import to add the three functions + `BookingNotFoundError`, and the api-request import to add the parsers:

```ts
import { parseDirectBookingRequest, parseLookupQuery, parseCancelQuery } from "@/lib/booking/api-request";
import {
  bookViaApi,
  previewBooking,
  lookupPersonBookings,
  getPersonBookingById,
  cancelDirectBooking,
  SlotUnavailableError,
  VerifyUnavailableError,
  NoEligibleAgentsError,
  UnknownBucketError,
  BookingNotFoundError,
} from "@/lib/booking/service";
```

Add the shared authorize helper (above `POST`):

```ts
type AuthOutcome =
  | { ok: true; keyId: "primary" | "secondary" }
  | { ok: false; response: NextResponse };

/** Shared auth + per-key rate-limit gate for every method on this route (#386). */
async function authorize(req: NextRequest): Promise<AuthOutcome> {
  const keys = parseApiKeys(bookingApiKeyPrimary(), bookingApiKeySecondary());
  const auth = authenticateBearer(req.headers.get("authorization"), keys);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  if (!(await allowRequest(`key:${auth.keyId}`, DIRECT_BOOKING_API_RATE_RULES))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Rate limit exceeded for this API key." },
        { status: 429 },
      ),
    };
  }
  return { ok: true, keyId: auth.keyId };
}
```

Replace the auth+rate-limit preamble at the top of `POST` with:

```ts
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;
  console.log(`booking-api: authenticated request via key '${authd.keyId}'`);
```

(Delete the now-duplicated `parseApiKeys`/`authenticateBearer`/`allowRequest` lines from `POST`; keep everything from `const parsed = parseDirectBookingRequest(...)` onward unchanged.)

Add the two handlers (after `POST`):

```ts
/**
 * Lookup (#386). `?externalId=` lists the person's active bookings;
 * `&bookingId=` returns that one (any status, or asserted `&status=`). Strong-id
 * resolution only — a shared email/phone never surfaces another person's booking.
 */
export async function GET(req: NextRequest) {
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;

  const parsed = parseLookupQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { externalId, salesforceId, bookingId, status } = parsed.value;

  try {
    if (bookingId) {
      const booking = await getPersonBookingById({
        bookingId,
        identity: { externalId, salesforceId },
        status,
      });
      return NextResponse.json({ booking });
    }
    const bookings = await lookupPersonBookings({ externalId, salesforceId });
    return NextResponse.json({ bookings });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed", code },
      { status: httpStatus },
    );
  }
}

/**
 * Cancel one booking by id (#386). Requires `bookingId` + a strong id; cancels
 * only if the booking is owned and active, else 404 NOT_FOUND.
 */
export async function DELETE(req: NextRequest) {
  const authd = await authorize(req);
  if (!authd.ok) return authd.response;

  const parsed = parseCancelQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: "VALIDATION" }, { status: 400 });
  }
  const { bookingId, externalId, salesforceId, reason } = parsed.value;

  try {
    const booking = await cancelDirectBooking({
      bookingId,
      identity: { externalId, salesforceId },
      reason,
    });
    return NextResponse.json({ outcome: "cancelled", booking });
  } catch (err) {
    const { httpStatus, code } = mapLookupError(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed", code },
      { status: httpStatus },
    );
  }
}

/** Error→code map for the lookup/cancel paths (#386): a missing/unowned booking
 *  is NOT_FOUND; anything else is an unexpected INTERNAL. */
function mapLookupError(err: unknown): {
  httpStatus: number;
  code: "NOT_FOUND" | "INTERNAL";
} {
  if (err instanceof BookingNotFoundError) return { httpStatus: 404, code: "NOT_FOUND" };
  return { httpStatus: 500, code: "INTERNAL" };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: build succeeds; `/api/bookings/direct` compiles with GET/POST/DELETE.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/service.ts src/app/api/bookings/direct/route.ts
git commit -m "Add GET (lookup) + DELETE (cancel) handlers to the direct booking API (#386)"
```

---

### Task 5: Extend the live smoke test

**Files:**
- Modify: `scripts/smoke-booking-api.ts` (add a GET-list, GET-by-id, and DELETE-by-id leg; use DELETE-by-id for cleanup)

**Interfaces:**
- Consumes: the live `GET` / `DELETE` endpoints; existing `BOOKING_API_KEY` + `SLATE_BASE_URL` env the script already reads.
- Produces: nothing importable — a manual prod check.

- [ ] **Step 1: Read the current smoke script** to match its fetch/assert helpers and the create-response shape (it already books then cancels via the manage token).

Run: `sed -n '1,200p' scripts/smoke-booking-api.ts`

- [ ] **Step 2: Add a lookup + cancel-by-id leg** after the create/dedupe/reschedule checks, using the same `externalId` the script booked with and the `booking.id` from the create response. Follow the file's existing helper style; the new leg asserts:

```ts
// GET list — the booked person has at least one active booking.
const listRes = await api("GET", `/api/bookings/direct?externalId=${encodeURIComponent(externalId)}`);
assert(listRes.status === 200 && Array.isArray(listRes.body.bookings) && listRes.body.bookings.length >= 1,
  "GET list returns the person's active booking(s)");

// GET by id — returns that one booking with a manageUrl.
const oneRes = await api("GET", `/api/bookings/direct?externalId=${encodeURIComponent(externalId)}&bookingId=${bookingId}`);
assert(oneRes.status === 200 && oneRes.body.booking?.id === bookingId && !!oneRes.body.booking?.manageUrl,
  "GET by id returns the booking + manageUrl");

// GET by id with a non-matching status assertion → 404.
const missRes = await api("GET", `/api/bookings/direct?externalId=${encodeURIComponent(externalId)}&bookingId=${bookingId}&status=cancelled`);
assert(missRes.status === 404 && missRes.body.code === "NOT_FOUND",
  "GET by id with mismatched status filter → 404 NOT_FOUND");

// DELETE by id — cancels (replaces the manage-token cleanup).
const delRes = await api("DELETE", `/api/bookings/direct?externalId=${encodeURIComponent(externalId)}&bookingId=${bookingId}`);
assert(delRes.status === 200 && delRes.body.outcome === "cancelled",
  "DELETE by id cancels the booking");

// Repeat DELETE → 404 (no longer active).
const delAgain = await api("DELETE", `/api/bookings/direct?externalId=${encodeURIComponent(externalId)}&bookingId=${bookingId}`);
assert(delAgain.status === 404 && delAgain.body.code === "NOT_FOUND",
  "second DELETE → 404 NOT_FOUND (already cancelled)");
```

Adapt variable names (`api`, `assert`, `externalId`, `bookingId`) to the script's actual helpers found in Step 1. If the script previously cancelled via the manage token at the end, remove that now-redundant cleanup.

- [ ] **Step 3: Typecheck the script**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: (Optional, requires prod creds) run the smoke test**

Run: `BOOKING_API_KEY=<key> SLATE_BASE_URL=https://slate.trypennie.app node --experimental-strip-types scripts/smoke-booking-api.ts`
Expected: `ALL CHECKS PASSED`. (Hits prod — only run with a real key. Safe to skip in CI; the pure tests cover the logic.)

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-booking-api.ts
git commit -m "Smoke-test GET lookup + DELETE-by-id on the direct booking API (#386)"
```

---

### Task 6: Document the new endpoints

**Files:**
- Modify: `docs/booking-api.md` (add GET + DELETE sections after the POST section)

**Interfaces:**
- Consumes: nothing. Produces: integration docs for the bot author.

- [ ] **Step 1: Add the sections** to `docs/booking-api.md` after the `POST /api/bookings/direct` section, mirroring its style:

````markdown
## 3. Look up a booking — `GET /api/bookings/direct` (key-authed)

Resolve a lead's booking(s) by the same `external_id` used to create them — no
need to retain the per-booking manage token.

```
GET /api/bookings/direct?externalId=<id>                 # list active bookings
GET /api/bookings/direct?externalId=<id>&bookingId=<id>  # one booking, any status
GET /api/bookings/direct?externalId=<id>&bookingId=<id>&status=confirmed  # assert state
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

## 4. Cancel a booking — `DELETE /api/bookings/direct` (key-authed)

```
DELETE /api/bookings/direct?externalId=<id>&bookingId=<uuid>
```

- Requires **`bookingId`** and a strong id (`externalId` **or** `salesforceId`).
  The booking must be owned by that person and currently active.
- Optional `reason` (a `CANCEL_REASONS` code; `other` needs `reasonDetail`);
  defaults to `api_cancellation`. Recorded with initiator `customer`.

Success → `200 { "outcome": "cancelled", "booking": <booking> }`. Deletes the
Google event, frees the slot, and fires the `booking.cancelled` webhook.

Not found / not owned / not active → `404 { "code": "NOT_FOUND" }` (a repeat
cancel of an already-cancelled booking therefore returns `404`).
````

Also add `NOT_FOUND` to the error-code table elsewhere in the doc if one exists.

- [ ] **Step 2: Commit**

```bash
git add docs/booking-api.md
git commit -m "Document GET lookup + DELETE cancel on the direct booking API (#386)"
```

---

## Self-Review

**Spec coverage:**
- GET list (active) → Task 3 `lookupPersonBookings` + Task 4 GET. ✓
- GET by id (any status) + optional `status` filter → Task 3 `getPersonBookingById` + Task 2 parser. ✓
- DELETE by id + strong-id ownership + active-only + 404 → Task 1 + Task 3 `cancelDirectBooking` + Task 4 DELETE. ✓
- Initiator `customer`, default `api_cancellation` reason, optional reason → Task 3 + Task 4 service wrapper. ✓
- Strong-id-only resolution / no weak leak → Task 1 helper + service passing email/phone null. ✓
- `NOT_FOUND` + `VALIDATION` error contract → Task 4 `mapLookupError` + parser 400s. ✓
- Auth + per-key rate limit reused → Task 4 `authorize`. ✓
- Tests, smoke, docs → Tasks 1-3 (unit), 5 (smoke), 6 (docs). ✓
- No migration / no new env → confirmed; nothing in any task adds DB columns or env.

**Placeholder scan:** none — every code/test step is complete and concrete.

**Type consistency:** `ApiBookingView` shape, `BookingNotFoundError`, `lookupPersonBookings` / `getPersonBookingById` / `cancelDirectBooking` signatures, and `LookupQuery` / `CancelQuery` are identical across the Interfaces blocks, the implementations, and the consuming route. `mapLookupError` returns `{ httpStatus, code }` (named to avoid colliding with the parser's `status` field).

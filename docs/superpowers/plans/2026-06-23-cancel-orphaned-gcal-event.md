# Cancel/reassign orphaned calendar event — retry queue (#401) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silently dropping failed Google Calendar event deletions — record them to a durable queue and retry on the sync cron until they succeed, covering cancel/reassign/rollback uniformly.

**Architecture:** A `pending_event_deletions` table; a `deleteEventBestEffort` helper that enqueues on failure (wired into the 4 swallowed-delete sites); a `processPendingEventDeletions` drain folded into the 1-minute sync lane; a one-off queue-seed SQL to clear existing orphans. `deleteEvent` already treats 404/410 as success, so retries are idempotent.

**Tech Stack:** Next.js 16 (App Router, TS), Supabase (`supabaseAdmin`), node-native `scripts/test-*.ts`, pnpm.

## Global Constraints

- TypeScript, no `any`; 2-space indent; existing Prettier/ESLint.
- `orchestration.ts` is a PURE module (relative value imports, type-only `@/`, runs under `node --experimental-strip-types`).
- Never silently swallow a `deleteEvent` failure — enqueue it. `deleteEvent` already returns success on 404/410 (already-gone), so re-deleting is a safe no-op.
- Keep the branch BUILDABLE per task: any task that adds a `BookingDeps` method also adds its `realDeps()` implementation in the same task.
- Migration number is **0044** on this branch (off `origin/main`). The parked #392 branch also used 0044 → #392 renumbers to 0045 when it resumes (not this plan's concern).
- node-native test per feature; `npx tsc --noEmit` before pushing.
- Branch `fix/cancel-orphaned-gcal-event` is off `origin/main`. Commit per task.

---

### Task 1: `pending_event_deletions` migration

**Files:**
- Create: `supabase/migrations/0044_pending_event_deletions.sql`

**Interfaces:** none (DB). Produces the table later tasks read/write.

- [ ] **Step 1: Write the migration** (match the style of `supabase/migrations/0043_bookings_person_lookup_idx.sql`):

```sql
-- #401: durable retry queue for Google Calendar event deletions that fail
-- during cancel/reassign/create-rollback. A cron drains it; deleting an
-- already-gone event is a no-op, so retries are idempotent.
create table if not exists public.pending_event_deletions (
  id uuid primary key default gen_random_uuid(),
  calendar_email text not null,
  gcal_event_id  text not null,
  booking_id     uuid null references public.bookings(id) on delete set null,
  attempts       int  not null default 0,
  last_error     text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists pending_event_deletions_uniq
  on public.pending_event_deletions (calendar_email, gcal_event_id);

create trigger set_updated_at before update on public.pending_event_deletions
  for each row execute function public.set_updated_at();
```
(Confirm `public.set_updated_at()` exists — it is used by other tables, e.g. `bookings`. If the trigger function name differs in `0001_init.sql`, use that exact name.)

- [ ] **Step 2: Apply + verify (operator action)**

Run: `supabase db push`
Verify: `select to_regclass('public.pending_event_deletions');` → non-null.
(Additive; safe to apply any time.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0044_pending_event_deletions.sql
git commit -m "Add pending_event_deletions retry queue table (#401)"
```

---

### Task 2: Enqueue on delete failure (the 4 sites)

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (add `enqueueEventDeletion` to `BookingDeps`, the `deleteEventBestEffort` helper, wire the 4 sites)
- Modify: `src/lib/booking/service.ts` (real `enqueueEventDeletion` in `realDeps()`)
- Test: `scripts/test-booking-orchestration.ts` (extend `makeDeps`, add cases)

**Interfaces:**
- Produces: `BookingDeps.enqueueEventDeletion(calendarEmail: string, gcalEventId: string, bookingId: string | null): Promise<void>`; module-private `deleteEventBestEffort(deps, email, eventId, bookingId)`.

- [ ] **Step 1: Write the failing test** — in `scripts/test-booking-orchestration.ts`. Extend `makeDeps`: add `enqueueEventDeletion: [] as { email: string; eventId: string; bookingId: string | null }[]` to `calls`, and this dep to the returned `deps` (next to `deleteEvent`):
```ts
    enqueueEventDeletion: async (email, eventId, bookingId) => {
      calls.enqueueEventDeletion.push({ email, eventId, bookingId });
    },
```
Also add to `FakeOpts`: `deleteEventThrows?: boolean;` and make the fake `deleteEvent` throw when set:
```ts
    deleteEvent: async (_email, id) => {
      if (opts.deleteEventThrows) throw new Error("google 503");
      calls.deleteEvent.push({ id });
    },
```
Add cases in `run()` (the cancel path is the clearest to assert; a confirmed booking with a gcal event, cancelled):
```ts
  // --- #401: cancel enqueues the event deletion when Google delete fails ---
  {
    const bk = makeBooking({ id: "bkX", status: "confirmed", gcal_event_id: "gE", agent_email: "a@x.com" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx, deleteEventThrows: true });
    await cancelBooking("tok1", CR, "customer", deps);
    assert(calls.enqueueEventDeletion.length === 1, "cancel enqueues a deletion when deleteEvent fails");
    assert(calls.enqueueEventDeletion[0].eventId === "gE" && calls.enqueueEventDeletion[0].bookingId === "bkX",
      "enqueue carries the event id + booking id");
  }
  {
    // success path: no enqueue
    const bk = makeBooking({ id: "bkY", status: "confirmed", gcal_event_id: "gE2", agent_email: "a@x.com" });
    const ctx = { booking: bk, bucket, eventType };
    const { deps, calls } = makeDeps({ existing: ctx });
    await cancelBooking("tok1", CR, "customer", deps);
    assert(calls.enqueueEventDeletion.length === 0, "cancel does NOT enqueue when deleteEvent succeeds");
  }
```
(`CR` is the cancel reason already defined in the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: FAIL — `enqueueEventDeletion` not called (cancel still swallows).

- [ ] **Step 3: Implement** — in `src/lib/booking/orchestration.ts`:

Add to the `BookingDeps` interface (near `deleteEvent`):
```ts
  /** #401: record a Google event deletion that failed, for the retry drain. */
  enqueueEventDeletion(calendarEmail: string, gcalEventId: string, bookingId: string | null): Promise<void>;
```
Add the helper (near the top of the functions, after the error classes):
```ts
/** Delete a calendar event, and if the delete FAILS, enqueue it for the retry
 *  drain (#401) instead of silently dropping it. Never throws to the caller —
 *  the booking flow proceeds; the queue is the durable net. */
async function deleteEventBestEffort(
  deps: BookingDeps,
  email: string,
  eventId: string,
  bookingId: string | null,
): Promise<void> {
  try {
    await deps.deleteEvent(email, eventId);
  } catch {
    await deps.enqueueEventDeletion(email, eventId, bookingId).catch(() => {});
  }
}
```
Replace the 4 swallowed calls:
- create-rollback (was `await deps.deleteEvent(email, gcalEventId).catch(() => {});`):
  `await deleteEventBestEffort(deps, email, gcalEventId, null);`
- reassign round-robin (was `await deps.deleteEvent(currentEmail, booking.gcal_event_id).catch(() => {});`):
  `await deleteEventBestEffort(deps, currentEmail, booking.gcal_event_id, booking.id);`
- reassign owning-agent (was `await deps.deleteEvent(booking.agent_email, booking.gcal_event_id).catch(() => {});`):
  `await deleteEventBestEffort(deps, booking.agent_email, booking.gcal_event_id, booking.id);`
- cancel (was `await deps.deleteEvent(booking.agent_email, booking.gcal_event_id).catch(() => {});`):
  `await deleteEventBestEffort(deps, booking.agent_email, booking.gcal_event_id, booking.id);`

In `src/lib/booking/service.ts`, add to the object returned by `realDeps()` (next to the other deps):
```ts
    enqueueEventDeletion: async (calendarEmail, gcalEventId, bookingId) => {
      await supabaseAdmin()
        .from("pending_event_deletions")
        .upsert(
          { calendar_email: calendarEmail, gcal_event_id: gcalEventId, booking_id: bookingId },
          { onConflict: "calendar_email,gcal_event_id", ignoreDuplicates: true },
        );
    },
```

- [ ] **Step 4: Run test + full suite + tsc**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: PASS — `ALL PASSED` (existing cases still green).
Run: `npx tsc --noEmit`
Expected: clean (realDeps satisfies the new interface method).

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/orchestration.ts src/lib/booking/service.ts scripts/test-booking-orchestration.ts
git commit -m "Enqueue failed calendar-event deletions instead of swallowing them (#401)"
```

---

### Task 3: The retry drain (`processPendingEventDeletions`)

**Files:**
- Modify: `src/lib/booking/orchestration.ts` (add `PendingEventDeletion` type, 3 deps, `processPendingEventDeletions`, `PENDING_DELETION_ALERT_AFTER`)
- Modify: `src/lib/booking/service.ts` (real `loadPendingEventDeletions`/`removePendingEventDeletion`/`bumpPendingEventDeletion` in `realDeps()`)
- Test: `scripts/test-booking-orchestration.ts`

**Interfaces:**
- Produces:
  - `interface PendingEventDeletion { id: string; calendar_email: string; gcal_event_id: string; booking_id: string | null; attempts: number; last_error: string | null }`
  - `BookingDeps.loadPendingEventDeletions(limit: number): Promise<PendingEventDeletion[]>`, `.removePendingEventDeletion(id: string): Promise<void>`, `.bumpPendingEventDeletion(id: string, attempts: number, error: string): Promise<void>`
  - `const PENDING_DELETION_ALERT_AFTER = 5`
  - `processPendingEventDeletions(deps: BookingDeps, limit: number): Promise<{ deleted: number; failed: number; stuck: PendingEventDeletion[] }>`

- [ ] **Step 1: Write the failing test** — extend `makeDeps`: add `removePendingEventDeletion: [] as string[]` and `bumpPendingEventDeletion: [] as { id: string; attempts: number }[]` to `calls`, a `pending?: PendingEventDeletion[]` field to `FakeOpts`, and these deps:
```ts
    loadPendingEventDeletions: async (_limit) => opts.pending ?? [],
    removePendingEventDeletion: async (id) => { calls.removePendingEventDeletion.push(id); },
    bumpPendingEventDeletion: async (id, attempts) => { calls.bumpPendingEventDeletion.push({ id, attempts }); },
```
Add `processPendingEventDeletions, PENDING_DELETION_ALERT_AFTER, type PendingEventDeletion` to the orchestration import in the test. Cases:
```ts
  // --- #401 drain ---
  {
    const rows = [
      { id: "p1", calendar_email: "a@x.com", gcal_event_id: "e1", booking_id: null, attempts: 0, last_error: null },
      { id: "p2", calendar_email: "b@x.com", gcal_event_id: "e2", booking_id: null, attempts: 0, last_error: null },
    ];
    const { deps, calls } = makeDeps({ pending: rows }); // deleteEvent succeeds
    const res = await processPendingEventDeletions(deps, 50);
    assert(res.deleted === 2 && res.failed === 0, "drain deletes all and removes them");
    assert(calls.removePendingEventDeletion.length === 2, "successful deletes remove the rows");
  }
  {
    const rows = [{ id: "p3", calendar_email: "a@x.com", gcal_event_id: "e3", booking_id: null, attempts: PENDING_DELETION_ALERT_AFTER - 1, last_error: "x" }];
    const { deps, calls } = makeDeps({ pending: rows, deleteEventThrows: true });
    const res = await processPendingEventDeletions(deps, 50);
    assert(res.failed === 1 && res.deleted === 0, "a failing delete is counted, not removed");
    assert(calls.bumpPendingEventDeletion[0].attempts === PENDING_DELETION_ALERT_AFTER, "bump records attempts+1");
    assert(res.stuck.length === 1, "a row crossing the alert threshold is reported as stuck");
    assert(calls.removePendingEventDeletion.length === 0, "a failing delete is NOT removed");
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts`
Expected: FAIL — `processPendingEventDeletions is not a function`.

- [ ] **Step 3: Implement** — in `orchestration.ts` add to `BookingDeps`:
```ts
  loadPendingEventDeletions(limit: number): Promise<PendingEventDeletion[]>;
  removePendingEventDeletion(id: string): Promise<void>;
  bumpPendingEventDeletion(id: string, attempts: number, error: string): Promise<void>;
```
Add near the other types/functions:
```ts
/** A queued Google-event deletion awaiting retry (#401). */
export interface PendingEventDeletion {
  id: string;
  calendar_email: string;
  gcal_event_id: string;
  booking_id: string | null;
  attempts: number;
  last_error: string | null;
}

/** Alert once a queued deletion has failed this many times. */
export const PENDING_DELETION_ALERT_AFTER = 5;

/**
 * Drain a batch of the deletion retry queue (#401): re-attempt each delete;
 * remove on success (404/410 already-gone counts as success); on failure bump
 * the attempt count and report rows that crossed the alert threshold. Pure —
 * the caller (sync lane) sends the throttled alert for `stuck`.
 */
export async function processPendingEventDeletions(
  deps: BookingDeps,
  limit: number,
): Promise<{ deleted: number; failed: number; stuck: PendingEventDeletion[] }> {
  const rows = await deps.loadPendingEventDeletions(limit);
  let deleted = 0;
  let failed = 0;
  const stuck: PendingEventDeletion[] = [];
  for (const row of rows) {
    try {
      await deps.deleteEvent(row.calendar_email, row.gcal_event_id);
      await deps.removePendingEventDeletion(row.id);
      deleted++;
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.bumpPendingEventDeletion(row.id, attempts, err instanceof Error ? err.message : String(err));
      failed++;
      if (attempts >= PENDING_DELETION_ALERT_AFTER) stuck.push(row);
    }
  }
  return { deleted, failed, stuck };
}
```
In `service.ts` `realDeps()` add:
```ts
    loadPendingEventDeletions: async (limit) => {
      const { data } = await supabaseAdmin()
        .from("pending_event_deletions")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(limit);
      return (data ?? []) as orchestration.PendingEventDeletion[];
    },
    removePendingEventDeletion: async (id) => {
      await supabaseAdmin().from("pending_event_deletions").delete().eq("id", id);
    },
    bumpPendingEventDeletion: async (id, attempts, error) => {
      await supabaseAdmin()
        .from("pending_event_deletions")
        .update({ attempts, last_error: error })
        .eq("id", id);
    },
```
(If `realDeps` references orchestration types via a different alias, match it; `orchestration.PendingEventDeletion` assumes `import * as orchestration`.)

- [ ] **Step 4: Run test + tsc**

Run: `node --experimental-strip-types scripts/test-booking-orchestration.ts` → `ALL PASSED`.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/orchestration.ts src/lib/booking/service.ts scripts/test-booking-orchestration.ts
git commit -m "Add the pending-event-deletion retry drain (#401)"
```

---

### Task 4: Wire the drain into the sync cron + alert + cleanup doc

**Files:**
- Modify: `src/lib/booking/service.ts` (add the `processPendingEventDeletions` wrapper with the throttled alert)
- Modify: `src/app/api/cron/sync/route.ts` (call the drain best-effort)
- Modify: `docs/booking-api.md` or a short ops note (document the one-off cleanup SQL)

**Interfaces:**
- Consumes: `orchestration.processPendingEventDeletions`, `sendThrottledAlert`.
- Produces: `service.processPendingEventDeletions(limit): Promise<{deleted; failed; stuck}>`. Verified by `npx tsc --noEmit` + `pnpm build` (route/cron has no pure unit test; the drain logic is tested in Task 3).

- [ ] **Step 1: Service wrapper with alert** — in `service.ts` (it already imports `sendThrottledAlert`):
```ts
const PENDING_DELETION_ALERT_KEY = "pending_event_deletions";
const PENDING_DELETION_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** #401: drain the deletion retry queue and alert if any deletion is stuck. */
export async function processPendingEventDeletions(limit: number) {
  const res = await orchestration.processPendingEventDeletions(realDeps(), limit);
  if (res.stuck.length > 0) {
    await sendThrottledAlert(
      PENDING_DELETION_ALERT_KEY,
      PENDING_DELETION_ALERT_COOLDOWN_MS,
      `Slate: ${res.stuck.length} calendar event deletion(s) have failed ${orchestration.PENDING_DELETION_ALERT_AFTER}+ times and may be firing orphaned reminders. Check Google Calendar API health. Event ids: ${res.stuck.slice(0, 5).map((r) => r.gcal_event_id).join(", ")}`,
    ).catch(() => {});
  }
  return res;
}
```

- [ ] **Step 2: Fold the drain into the sync lane** — in `src/app/api/cron/sync/route.ts`, add the import:
```ts
import { processPendingEventDeletions } from "@/lib/booking/service";
```
and, inside the `try` block just before the `return NextResponse.json({...})`, add a best-effort drain (small batch to stay under the Worker subrequest ceiling alongside the sync calls):
```ts
    // Drain a small batch of failed-event-deletion retries (#401). Best-effort:
    // a failure here must never break the sync lane.
    await processPendingEventDeletions(20).catch(() => {});
```

- [ ] **Step 3: Document the one-off cleanup** — add a short "Clearing existing orphaned events (#401)" note (in `docs/booking-api.md` or `DEPLOY.md`) with the operator SQL that seeds the queue from already-cancelled bookings; the deployed drain then deletes them:
```sql
insert into pending_event_deletions (calendar_email, gcal_event_id, booking_id)
select agent_email, gcal_event_id, id
from bookings
where status = 'cancelled' and gcal_event_id is not null and agent_email is not null
  and starts_at > now() - interval '14 days'
on conflict (calendar_email, gcal_event_id) do nothing;
```
Note: seeds the retry queue (DB-only, no Google creds); the next sync ticks delete the events idempotently.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && pnpm build`
Expected: clean; the sync route compiles with the drain.

- [ ] **Step 5: Commit**

```bash
git add src/lib/booking/service.ts src/app/api/cron/sync/route.ts docs/booking-api.md DEPLOY.md
git commit -m "Drain the event-deletion queue on the sync cron + alert; document cleanup (#401)"
```

---

## Self-Review

**Spec coverage:**
- Queue table → Task 1. ✓
- `enqueueEventDeletion` dep + `deleteEventBestEffort` wired to all 4 sites → Task 2. ✓
- `processPendingEventDeletions` drain + load/remove/bump deps + alert threshold → Task 3 (+ alert in Task 4). ✓
- Cron drain (no new trigger) → Task 4 (sync lane). ✓
- One-off cleanup → Task 4 Step 3 (queue-seed SQL — an improvement over the spec's standalone Google-calling script: reuses the drain, needs no local Google creds). ✓
- `deleteEvent` idempotency relied on (404/410 = success) → confirmed in spec; the drain treats a successful/no-op delete as removal. ✓
- Branch buildable per task (realDeps wired alongside each interface addition) → Tasks 2 & 3 each include realDeps. ✓

**Placeholder scan:** none — every step carries complete code or exact SQL/commands.

**Type consistency:** `PendingEventDeletion` shape identical across the type def, the fake `pending` rows, the real `loadPendingEventDeletions` cast, and the drain. `bumpPendingEventDeletion(id, attempts, error)` arity matches between interface, fake, real impl, and the drain call (`row.attempts + 1`). `enqueueEventDeletion(calendarEmail, gcalEventId, bookingId)` arity matches across helper, interface, fake, real impl. `processPendingEventDeletions` return `{deleted, failed, stuck}` consumed by the service wrapper.

**Deviation from spec (noted):** cleanup is a queue-seed SQL, not `scripts/cleanup-orphaned-events.ts` — reuses the drain and avoids local Google credentials. Better; documented in Task 4.

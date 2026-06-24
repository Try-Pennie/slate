# Fix: cancelling/reassigning a booking can orphan its Google Calendar event (#401)

## Problem

Four sites delete a Google Calendar event "best-effort" and **silently swallow
any failure** (`orchestration.ts`):
- `:1048` cancel (the reported bug — orphaned event keeps firing reminders),
- `:830` / `:928` reassign (orphans the OLD agent's event),
- `:487` create-rollback (orphans the event when the DB insert fails — no booking
  row exists afterward).

A failed delete leaves the event on the agent's calendar forever, firing
reminders, with no retry, no alert, and no reconciliation. The reassign/rollback
orphans are not even discoverable from a booking row (the row points at the new
event, or there is no row).

## Approach (owner-approved): a durable deletion-retry queue (uniform, all 4 sites)

When any `deleteEvent` fails, **record the (calendar, event id) to a queue** and
a cron **retries until it succeeds**. Deleting an already-gone event is a no-op
(`deleteEvent` treats 404/410 as success — verified `calendar.ts:312`), so
retries are safe and idempotent. This covers cancel, reassign, AND rollback
uniformly, self-heals transient and persistent failures, and surfaces an alert
when a deletion keeps failing. Plus a one-off cleanup of current orphans.

## Schema — migration `0044_pending_event_deletions.sql`

```sql
create table public.pending_event_deletions (
  id uuid primary key default gen_random_uuid(),
  calendar_email text not null,         -- the agent calendar to delete from
  gcal_event_id  text not null,
  booking_id     uuid null references public.bookings(id) on delete set null,
  attempts       int not null default 0,
  last_error     text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index pending_event_deletions_uniq
  on public.pending_event_deletions (calendar_email, gcal_event_id);
```
- Unique `(calendar_email, gcal_event_id)` so re-enqueuing the same orphan is a
  no-op (`on conflict do nothing`).
- `booking_id` nullable + `on delete set null` — the rollback site has no row,
  and a booking row may be purged independently.
- Migration numbering: this branch (off `origin/main`) uses **0044**. The parked
  #392 branch also created a 0044 — whichever merges second must renumber to 0045
  (tracked in the #392 ledger/memory).
- Server-only table; RLS default-deny (no client access needed). Add the standard
  `set_updated_at` trigger if the table is expected to be UPDATEd (it is — on
  retry).

## Components

### Pure / orchestration (`orchestration.ts`)
- New `BookingDeps` method: `enqueueEventDeletion(calendarEmail: string,
  gcalEventId: string, bookingId: string | null): Promise<void>`.
- New helper replacing the 4 swallowed catches:
  ```ts
  async function deleteEventBestEffort(deps, email, eventId, bookingId) {
    try { await deps.deleteEvent(email, eventId); }
    catch { await deps.enqueueEventDeletion(email, eventId, bookingId).catch(() => {}); }
  }
  ```
  Wire all four sites to it (still non-blocking to the main flow; the queue is the
  durable net). `bookingId`: cancel/reassign pass `booking.id`; rollback passes
  `null`. Reassign passes the OLD calendar (`currentEmail` / `booking.agent_email`)
  and `booking.gcal_event_id`.
- `processPendingEventDeletions(deps, limit): Promise<{ deleted: number; failed: number }>`
  — load up to `limit` pending rows; for each, `await deps.deleteEvent(...)`; on
  success delete the row; on failure increment `attempts` + set `last_error`;
  when `attempts >= PENDING_DELETION_ALERT_AFTER` (e.g. 5) emit a throttled alert.
  New deps: `loadPendingEventDeletions(limit)`, `removePendingEventDeletion(id)`,
  `bumpPendingEventDeletion(id, error)`.

### Service (`service.ts`, real deps)
- `enqueueEventDeletion` → `insert ... on conflict do nothing`.
- `loadPendingEventDeletions` / `removePendingEventDeletion` /
  `bumpPendingEventDeletion` → parameterized Supabase queries.
- `processPendingEventDeletions(limit)` wrapper over the orchestration fn.

### Cron drain (no new trigger)
Fold the drain into an existing lane — the `sync` cron
(`src/app/api/cron/sync/route.ts`, the calendar-freshness backstop): add a
best-effort `await processPendingEventDeletions(BATCH)` so a failed alert/drain
never breaks the lane. (A dedicated cron lane would need new schedule config;
folding avoids that.)

### One-off cleanup
`scripts/cleanup-orphaned-events.ts` (node-native, reads prod creds from env like
the smoke script): iterate `cancelled` bookings that still carry a
`gcal_event_id` (recent window, e.g. starts_at in the future or last N days), call
`deleteEvent(agent_email, gcal_event_id)` idempotently for each, log
deleted/already-gone/failed counts. The owner runs it once to clear current
orphans (e.g. from today's smoke runs). Read-mostly + idempotent — safe to re-run.

## Testing
- **Pure / orchestration (fake deps):**
  - `deleteEventBestEffort`: `deleteEvent` succeeds → no enqueue; `deleteEvent`
    throws → `enqueueEventDeletion` called with the right (email, eventId,
    bookingId).
  - Each of the 4 sites: when `deleteEvent` throws, the cancel/reassign/rollback
    path still completes AND enqueues (assert via the fake's call log).
  - `processPendingEventDeletions`: a row whose delete succeeds is removed; a row
    whose delete throws is bumped (attempts+1, last_error) and NOT removed; at the
    alert threshold the throttled alert fires.
- node-native `scripts/test-*.ts` per the convention; run `tsc --noEmit`.
- `cleanup-orphaned-events.ts` has no unit test (manual prod script); tsc only.

## Out of scope
- Changing the create/reschedule/booking logic itself.
- Nulling `gcal_event_id` on cancel (kept for history; the queue carries the
  event id it needs).
- The #392 reorg (separate parked branch).

## Deploy
Migration 0044 (apply via `supabase db push`). No new env, no new cron trigger.
Ships on `fix/cancel-orphaned-gcal-event` → PR. After deploy, the owner runs the
one-off cleanup script with prod creds.

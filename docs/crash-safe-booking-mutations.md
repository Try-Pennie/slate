# The crash-safe booking-mutation pattern

Slate mutates a booking against two systems that can never be updated in one
transaction: its own Postgres (Supabase) and Google Calendar. A create, a
reschedule, and a reassign each write a Postgres row AND create or move a Google
event. The Worker can crash between those two writes, the caller can double
submit, and two requests can race for the same booking. Left naive, each of
those produces the same family of damage: a duplicate calendar event (a second
attendee invite goes out), an orphaned event nobody deletes, or a mutation that
is silently lost.

All three mutations avoid that damage with one shared primitive: an
**intent-first, deterministic-id, 409-as-success** design. This document explains
the primitive, then shows how create, reschedule, and reassign each apply it.

The code lives in `src/lib/booking/orchestration.ts` (pure, dependency injected),
`src/lib/booking/service.ts` (the real Supabase / Google / webhook wiring), and
`src/lib/google/calendar.ts` (the Google client). The durable tables are
migrations `0052` (create), `0053` (reschedule), and `0065` (reassign).

## The three moving parts

### 1. A deterministic Google client event id makes a create idempotent

Google Calendar lets the caller supply the event id on insert. Slate always does,
and computes it deterministically so that a retry of the same intent produces the
**same** id.

`deterministicEventId(idempotencyKey, agentUserId)` (`core.ts`) is
`SHA-256(idempotencyKey + ":" + agentUserId)`, hex encoded behind a `slate`
prefix (hex is a subset of Google's base32hex id alphabet, so the result is a
valid client id).

The id is keyed on the **assigned agent**, not only the booking. A Google client
id is unique **per calendar**, so keying on the agent is what stops the "same id
written to two different calendars = two events" failure. A retry that lands on
the same agent recomputes the same id and reuses the event; a move to a different
agent deliberately gets a different id (a fresh event on that agent's calendar).

Because the id is a pure function of stable inputs, the code can compute it once,
store it as the booking's `gcal_event_id` **before** the event exists, and hand
the same id to Google on every retry.

### 2. 409-as-success: reuse the event a retry re-creates

`createEvent(email, input, clientId)` (`calendar.ts`) sends the deterministic id
as the event's `id`. Two outcomes matter:

- **First time:** Google inserts the event and returns its id.
- **Retry (same id already on that calendar):** Google returns **HTTP 409**.
  Rather than treating that as an error, the client GETs the event by that id and
  returns it. No second insert happens, so **no second attendee invite** is sent.

```
// 409-as-success: a duplicate client id means THIS event already exists (a
// retry of the same intent on the same agent). GET it and return it (no
// second insert, so no second attendee invite).
if (clientId && res.status === 409) { ... GET the event ... return reused.id }
```

This is the load-bearing idempotency guarantee: any number of retries of the same
create, on the same agent, converge on exactly one calendar event.

### 3. A durable reservation / lease provides crash safety across the gap

Idempotency handles retries, but a crash can happen **before** the caller knows
the event or the booking exists. To survive that, each mutation writes a durable
Postgres row as its **first** act, before the Google call, pinning everything a
resumer needs to finish (or clean up) the mutation without re-deciding anything.

The rule is the same in all three paths: **write the intent, pin the chosen agent
and the deterministic event id, THEN call Google.** A resumer (a user re-submit or
a background drain) reads the pinned values verbatim and repeats the exact same
Google call, which 409-reuses the event instead of duplicating it. Recomputing the
agent or the id on resume is a bug, not a nicety: it would reopen the duplicate
window the pin exists to close.

Each mutation's durable row is deleted (or released) once the mutation completes,
so these are ephemeral, not history. Append-only history lives separately in
`booking_events` (see ADR 0001).

## Create: `booking_reservations` (migration 0052)

`createBooking` (`orchestration.ts`) resolves an idempotency key first. A caller
may supply one; otherwise it is derived from the lead's identity as
`bucketCode|slot|email|phone|salesforceId` (`idempotencyKeyFor`). A truly
anonymous booking with no identity gets a fresh synthetic key per request
(`newIdempotencyKey`), so it still gets the durable net even though it has nothing
to dedupe a re-submit against.

The flow:

1. **Fast paths.** If a booking already exists for a stable key, return it. If an
   in-flight **reservation** already exists for that key, resume it (below).
2. **Assign.** `assignAgentWithTierFallback` picks the agent via round-robin +
   verify-on-book, cascading down the debt-tier ladder if the requested bucket has
   no free agent. This is the only non-deterministic step, which is exactly why
   its result must be pinned.
3. **Pin the event id.** `gcalClientId = deterministicEventId(idempotencyKey,
   userId)`. This value is stored as the booking's `gcal_event_id` up front: the
   pinned client id **is** the stored event id.
4. **Write the reservation.** `insertReservation` writes a `booking_reservations`
   row holding the pinned agent, the pinned `gcal_client_id`, and the **full
   booking payload** (times, attendee, manage token, routing trace, everything
   `insertBooking` needs), so a resume never re-runs the non-deterministic assign.
5. **Complete** via `completeReservation`.

`idempotency_key` on `booking_reservations` is `UNIQUE`, and that constraint is
the **concurrency arbiter**. Two concurrent same-key creates both attempt the
insert; one wins, and `insertReservation` returns the winner's existing row to the
loser, which then adopts the winner's pin. The loser never creates a second event.

`completeReservation` is the shared tail run by the fresh create, a re-submit
resume, and the drain, so a crash anywhere converges on the same end state:

- If the booking was already inserted (a crash after insert, before cleanup),
  re-run the idempotent post-insert side effects (so a possibly-lost
  `booking.created` webhook is still delivered exactly once), then delete the
  reservation.
- Otherwise `createEvent(pinned_agent_email, ..., gcal_client_id)` creates **or**
  409-reuses the event.
- `insertBooking` persists the row. A `23505` conflict from the active-slot unique
  index means either a same-key winner exists (return it) or the slot was genuinely
  taken (roll back the event + reservation, throw `SlotUnavailableError`). A
  generic failure rolls back the event but **leaves the reservation pending** so
  the drain retries.
- Deliver the busy-block write-through, cache invalidation, and `booking.created`
  webhook (all idempotent), then delete the reservation.

**Resume after a crash:** `processBookingReservations` runs on the
`/api/cron/outbox` lane. It loads pending reservations, leases each one
(`leaseReservation` is a gated claim, so an inline re-submit and the drain can
never both run the same row), and calls `completeReservation`. A transient failure
bumps `attempts` with exponential backoff and alerts past `DRAIN_ALERT_AFTER`; a
`SlotUnavailableError` is terminal (the row is already deleted). Abandoned
reservations whose booking never completed are pruned by `deleteExpiredReservations`.

## Reschedule: the per-booking lease-pin in `reschedule_locks` (migration 0053)

`rescheduleBooking` -> `applyReschedule` moves a booking to a new time in place
(ADR 0001: the booking keeps its identity). Migration 0053 re-keys
`reschedule_locks` from a per-`(booking, target)` mutex into a **per-booking
lease-pin**: at most one in-flight reschedule per booking. That single lease is
both the concurrency arbiter and the crash-resume record.

`claimReschedule` returns a discriminated outcome:

- `won` / `fresh-after-abandon`: this call owns a fresh attempt; compute the pin.
- `resume`: a crashed holder's expired lease is taken over, so **read its pin
  verbatim**.
- `idempotent` / `noop`: a same-target no-op; return without touching Google.
- `conflict`: a different-target holder still holds a fresh lease; throw
  `RescheduleConflictError` (a 409) rather than silently no-op.

On a fresh attempt the pin (agent, branch, deterministic event id, target time,
and a monotonic `reschedule_seq`) is written with `writeReschedulePin` **before**
any Google call. A resume reuses that pin exactly, so a poisoned availability read
can never flip a same-agent move onto a different agent on retry.

Two branches, both idempotent:

- **`in_place`** (keep the current agent): PATCH the existing event to the new
  time (`updateEventTime`). A resume simply re-PATCHes to the same time. If the
  event was deleted on Google (`EventGone`, HTTP 404/410), recreate it on the same
  agent with a deterministic recreate id so the resume still 409-reuses it.
- **`reassign`** (re-route to a new agent): the pinned id is
  `deterministicEventId("reschedule:" + bookingId + ":" + seq, next.userId)`.
  **Create the new event first**; delete the old event only **after** the durable
  commit, so a crash never strands the booking on a deleted event.

The commit itself, `commitReschedule`, is a **gated update**: it applies only
while the booking is still the one we started moving (status still active, and the
assignee + event id unchanged since we read them). A concurrent cancel (status
flip) or reassign (assignee + event swap) makes it touch 0 rows, so the reschedule
rolls back instead of resurrecting a cancelled booking or clobbering the reassign.
It advances `reschedule_seq` only on success.

`reschedule_seq` is a monotonic ordinal on `bookings`, mixed into the
deterministic id, so an oscillation (A to T1 to T2 back to T1) never reuses a
tombstoned Google id. Post-commit side effects (slot move, recompute, the
`booking.rescheduled` webhook) run through the idempotent outbox executor (see
below). Abandoned lease-pins are swept by `processAbandonedReschedulePins`, which
enqueues any orphaned event for deletion and alerts when a reschedule was
genuinely lost.

## Reassign: `reassign_intents` (migration 0065)

`reassignBooking` is the contact-owner override (#9): an upstream automation has
decided a lead must stick to a specific agent, so the move is forced (it is the
one path that may double-book, via `allow_double_book`). Unlike reschedule, it is
deliberately **lock-free / last-write-wins** (#449): two concurrent distinct-target
reassigns should both proceed, with the last swap winning, never one rejected.

The intent-first primitive still applies:

1. **Pin the event id.** `gcalClientId = deterministicEventId("reassign:" +
   bookingId + ":" + reassignOrdinal, agent.id)`. The **target agent id** is mixed
   in (a cross-agent move can't collide on the target calendar), and
   `reassignOrdinal` (the count of prior reassignments) prevents an A to B to A
   move from reusing a tombstoned id.
2. **Write the intent first.** `writeReassignIntent` writes a `reassign_intents`
   row (target agent + pinned new-event id) **before** `createEvent`. It is
   `UNIQUE(booking_id, gcal_client_id)`, so a same-target retry upserts (refreshes
   the lease) instead of failing, preserving the idempotent-retry behavior. This
   is not a per-booking mutex (that is what makes it last-write-wins).
3. **Create first, then swap.** `createEvent` on the target agent with the pinned
   id (409-reuses on retry). Then `reassignSwap` (migration 0058, refined by
   0069): under `SELECT ... FOR UPDATE` it moves the booking to the new agent and
   **returns the event it replaced** so the caller deletes exactly that (never a
   stale read), and stamps the intent with the replaced event + `swapped_at` **in
   the same transaction** (#759), so a crash can't lose the old event id or make a
   committed swap look never-adopted.
4. **Delete the replaced event** (skipped when a same-target re-submit 409-reused
   the same id, which would delete the live event), then delete the intent.

A terminal booking makes the swap a no-op (`updated = false`), so the caller
cleans up the event it optimistically created. Post-commit side effects run
through the outbox. Abandoned intents are swept by
`processAbandonedReassignIntents`, which deletes whichever recorded event is not
the booking's live one and **alerts** on a genuinely-lost reassign (the machine
caller has no human retry loop).

## The outbox lease is a token, not a flag (#1048)

Post-commit side effects are delivered by the outbox executor, and a row is
**leased** before its steps run so only one holder acts on it at a time. That is what
lets the executor persist the WHOLE `steps` array after each step: a single holder
cannot race itself.

Holding the lease is therefore an invariant other code relies on, and every write on
a leased row is a compare and swap on the **token** the holder wrote
(`src/lib/booking/outbox-lease.ts`):

- `leaseOutbox` claims a free or expired lease and returns the token, read back from
  the row rather than from the ISO string we sent, so a store that renders a
  timestamp its own way cannot make every later comparison quietly false.
- `saveOutboxSteps` and `markOutboxDelivered` are gated on that token and report
  `written`, `lease-lost` or `failed`. A run STOPS on either of the last two.
- `releaseOutboxLease` is gated too, which is the point: a holder that overran the
  two minute TTL must not free the lease a second holder now legitimately owns. An
  ungated release let a third holder start while the second was mid flight, and two
  live holders writing whole `steps` arrays re-open a step that already ran and erase
  the recorded failure text of one that did not.

A row that stands down is counted as `handedOff` by the drain, separately from a row
it never leased, and is charged **no** failed attempt: bumping attempts there would
walk a healthy row toward the give-up cap on the strength of somebody else holding
it. The inline path (straight after a booking mutation) honours a null lease the same
way: a drain already holds the row and is running those very steps, so it leaves it
alone.

## How the three share one pattern

| | Create | Reschedule | Reassign |
|---|---|---|---|
| Durable intent row | `booking_reservations` (0052) | `reschedule_locks` lease-pin (0053) | `reassign_intents` (0065) |
| Written before the Google call | yes | yes | yes |
| Deterministic id keyed on | `idempotencyKey` + agent | `booking:seq` + agent | `booking:ordinal` + target agent |
| Concurrency arbiter | `UNIQUE(idempotency_key)` | per-booking lease | lock-free, last-write-wins |
| Retry / resume behavior | drain re-runs `completeReservation` | claim returns `resume`, pin read verbatim | same-id upsert refreshes lease |
| Google duplicate defense | 409-as-success reuse | 409-as-success reuse (reassign branch) | 409-as-success reuse |
| Commit safety | active-slot unique index | gated `commitReschedule` | `FOR UPDATE` swap |
| Resume / cleanup owner | `processBookingReservations` | `processAbandonedReschedulePins` | `processAbandonedReassignIntents` |

The common shape, in order, is:

1. Decide the non-deterministic parts (which agent) exactly once.
2. Compute a **deterministic** Google event id from stable inputs plus the agent.
3. Write a **durable intent row** pinning that agent and id, before touching Google.
4. **Create the event first**, letting a retry 409-reuse it; commit the Postgres
   change under a guard (unique index, gated update, or row lock); delete the old
   event only after the commit is durable.
5. Deliver post-commit side effects through the **idempotent outbox**, so a crash
   after commit resumes without dropping a webhook or stranding a slot.
6. Delete / release the intent row on success; a background **drain or sweep** on
   `/api/cron/outbox` resumes crashed work or cleans orphans, and **alerts loudly**
   when a mutation was genuinely lost.

## Why it is built this way (the failure it prevents)

Each piece closes a specific hole that a naive "write the row, then call Google"
ordering leaves open:

- **Double submit / retry** would create a second calendar event (and a second
  invite). The deterministic id + 409-as-success collapse every retry onto one
  event.
- **A crash between the Google call and the Postgres commit** would either orphan
  the event or lose the mutation. The intent row, written first, gives a drain the
  pinned agent + id needed to finish or clean up.
- **Concurrent requests for the same booking** would race to duplicate or clobber.
  The per-path arbiter (unique key, lease, or `FOR UPDATE`) makes exactly one win,
  and the loser adopts the winner's result instead of acting independently.
- **A silently lost mutation** would go unnoticed. The sweeps alert when they find
  work that was genuinely dropped, in keeping with the fail-loud rule.

If you are changing any of these paths, keep the invariant: pin the agent and the
deterministic id in the durable row **before** the first Google call, and never
recompute either value on a resume.

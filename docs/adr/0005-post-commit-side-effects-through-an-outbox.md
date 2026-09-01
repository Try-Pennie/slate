# Post-commit side effects go through a durable outbox

Every side effect of a booking mutation (the calendar event, the busy-block write,
the cache invalidation, the webhook) is recorded as a durable `booking_outbox` row at
the mutation's commit point and delivered by an idempotent executor, rather than
being fired inline and hoped for.

## Status

Accepted, shipped as the #429 epic. Recorded here because the mechanics are
documented in `docs/crash-safe-booking-mutations.md` but the DECISION was not
findable anywhere (#1053).

## Why

A booking is a database write plus several external side effects, and a crash between
them leaves a state nobody can see: an appointment in Postgres with no calendar
invite, or a lead who booked and whose Regal journey never started. Retrying inline
does not fix it, because the process that would retry is the one that died.

## How it holds

- The row is written at the commit point, so a crash after commit leaves a record of
  what still owes delivery.
- Each step is independently idempotent and marked `done` on success, so a resume
  re-runs only what is outstanding.
- Both the inline happy path and the `/api/cron/outbox` drain call the same executor,
  so a step runs at most once to completion regardless of which gets there first.
- A row is leased before its steps run, and every write on it is gated on the lease
  token, so two holders cannot write over each other (#1048).
- A row past the attempt cap stops being retried and pages, so a permanently failing
  side effect is a named condition rather than an infinite loop.

## Consequences

- A mutation's side effects may lag its response by up to a drain interval. Anything
  that must be true before the response returns cannot live in the outbox.
- Adding a step means making it idempotent first. A step that is not safe to re-run
  breaks the whole model, because resume is the mechanism.
- The drain's own health needs watching, and an exemption from the attempt counter
  needs its own alarm, which is the trap #1048 fell into.

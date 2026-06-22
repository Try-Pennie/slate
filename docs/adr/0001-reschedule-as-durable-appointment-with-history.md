# Reschedule as a durable appointment with append-only history

A reschedule moves a Booking to a new time **in place** — the Booking keeps its
stable identity and we record the move as an immutable history event (from-time,
to-time, initiator, reason, when, and the new Agent if it changed), preserving the
original scheduled time. We deliberately do **not** cancel the original Booking and
create a new one.

## Why

The goal is to raise the show rate to appointments at their originally scheduled
time, which requires reporting on how often appointments are rescheduled and the
drivers behind it. A durable identity plus append-only history gives richer driver
data (reason, initiator, lead time, agent change) than a chain of cancelled rows,
and lets show-rate be measured against one continuous appointment.

Decisively, Slate already emits a single `booking.rescheduled` webhook event
(Regal "Slate Booking Rescheduled"), and Pennie's Regal journeys are built around
that flow. Cancel + recreate would instead emit `booking.cancelled` +
`booking.created`, which downstream reads as a real cancellation — risking
"you cancelled" win-back comms that work against the show-rate goal — and would
force a rework of the Regal journeys. The durable model preserves the existing
single-event contract; no new event types are needed.

## Agent policy on reschedule

Prefer the original Agent if they are free at the new time; otherwise re-route via
the Bucket's round-robin. The original Agent may be busy at the new time, so a
reschedule may legitimately reassign — the `booking.rescheduled` payload carries
the (possibly new) Agent.

## Consequences

- The `bookings` model must gain a preserved original scheduled time and an
  append-only reschedule history (today `starts_at`/`ends_at` are overwritten, so
  this history is currently destroyed).
- A future engineer must not "simplify" reschedule into cancel + recreate without
  re-coordinating the Regal journey contract.
- Measuring show rate additionally requires an attendance / no-show outcome, which
  does not yet exist (`completed` means time elapsed, not attended) — tracked
  separately, and is a customer concept distinct from PET's rep attendance.

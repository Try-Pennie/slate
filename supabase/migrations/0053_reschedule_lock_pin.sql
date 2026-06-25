-- #439 (milestone #7, Phase 1): crash-safe & concurrency-safe reschedule.
-- Re-key `reschedule_locks` from a per-(booking, target) mutex into a per-BOOKING
-- lease-pin: at most one in-flight reschedule per booking (this is what closes the
-- concurrent different-target orphan window), carrying the pinned target agent + a
-- deterministic Google client event id + branch + a lease, so a crashed holder is
-- RESUMED (the retry adopts the pin and 409-reuses the event) rather than
-- duplicating it. Plus a monotonic per-booking reschedule ordinal on `bookings`
-- so a re-reschedule (A->T1->T2->T1) can never recompute a tombstoned event id.
--
-- Both tables already enable RLS (reschedule_locks in 0033, bookings earlier), so
-- this ALTER-only migration adds no new RLS surface.

-- reschedule_locks rows are 2-min-TTL ephemeral. A blanket delete before the PK
-- swap is REQUIRED: two in-flight different-target rows for the same booking would
-- make `add primary key (booking_id)` fail on a duplicate key. An in-flight holder
-- at deploy time loses its lock and its caller re-claims on retry (no data loss,
-- one extra retry).
delete from reschedule_locks;

alter table reschedule_locks drop constraint if exists reschedule_locks_pkey;
alter table reschedule_locks add primary key (booking_id);

alter table reschedule_locks
  add column pinned_user_id uuid references users(id),
  add column pinned_agent_email text,
  add column gcal_client_id text,
  add column branch text check (branch in ('in_place', 'reassign')),
  add column reschedule_seq int,
  add column lease_until timestamptz;

-- Authoritative monotonic ordinal for COMMITTED reschedules of a booking, mixed
-- into the deterministic reschedule event id so an oscillating reschedule never
-- reuses a tombstoned Google id. Additive + safe (default 0 for existing rows).
alter table bookings
  add column reschedule_seq int not null default 0;

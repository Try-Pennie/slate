-- #2367: a durable record of a booking that is waiting on a PERSON.
--
-- Two situations Slate cannot finish on its own both need somebody on the sales side
-- to act: a duplicate booking Slate cannot safely cancel (#2307 phase 3), and an
-- owner reassign Slate refuses (#2307 phase 4). A throttled Slack line cannot carry
-- either. It is transient, a concurrent retry can post it twice, it says nothing
-- while Slack is down, and keeping it in alert_state would grow a table the capped
-- read guard treats as roster bounded. So each is a row here, written once, posted by
-- the monitor lane, retried until a post lands, and resolved only from measured state.
--
-- Nothing in production writes a row yet: #2369 and #2370 are the writers. Shipping
-- the table and its delivery first is deliberate, so each writer lands on a path that
-- is already watched.
--
-- ON DELETE CASCADE, matching reassign_intents and reschedule_locks, the other rows
-- that exist only to describe work on one booking. Bookings are redacted in place and
-- never deleted by retention, so the only deletes are test fixture cleanups, and a
-- handoff about a booking that no longer exists has nothing left to ask anybody. A
-- RESTRICT key would turn that cleanup into a failure on a side table.
--
-- The row carries NO lead contact data: `detail` holds enums, booking ids, the time
-- a caller reported and, for an owner refusal, the requested owner's user id and work
-- email. The lead's name is read from the booking at delivery time. So the table sits
-- outside the erasure function and the Snowflake mirror, like reassign_intents: an
-- erasure redacting the booking leaves nothing personal behind here.
create table booking_handoffs (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references bookings(id) on delete cascade,
  kind              text not null check (kind in ('duplicate-unresolved', 'owner-reassign-refused')),
  detail            jsonb not null default '{}',
  status            text not null default 'open' check (status in ('open', 'resolved')),
  resolved_reason   text,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  notified_at       timestamptz,
  notify_attempts   integer not null default 0,
  last_notify_error text,
  -- A retried caller records once. This is the constraint that makes a second write
  -- impossible, rather than a read that two concurrent callers can both pass.
  unique (booking_id, kind)
);

-- The monitor lane reads OPEN rows oldest first, bounded, every tick. A partial index
-- on the open rows serves that read and the "open and unnotified, oldest first"
-- delivery order inside it, and stays the size of the worklist rather than the size
-- of the history.
create index booking_handoffs_open_oldest_idx
  on booking_handoffs (created_at)
  where status = 'open';

-- Server reads and writes through the secret key client only; no client access.
alter table booking_handoffs enable row level security;

-- The Slack channel the sales side reads, where each handoff is posted. Nullable with
-- NO fallback to the alerts or info channel: those are read by engineering, and a
-- handoff posted there reaches nobody who can act on it while reading as delivered.
-- Unset while rows are open pages the alerts channel instead.
alter table monitor_alert_config
  add column handoff_channel text;

comment on column monitor_alert_config.handoff_channel is
  'The #2367 handoff channel: where booking handoffs (booking_handoffs) are posted for the sales side. Null means unset, which pages the alerts channel while any handoff is open.';

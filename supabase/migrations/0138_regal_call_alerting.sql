-- #2090, the second half: who a Regal call alert may speak about, how the feed is
-- counted, and the switch that arms it.
--
-- 1. regal_call_ignores: people an admin has decided should NOT be reported for
--    placing calls while Slate does not route to them. The detector already
--    exempts every non agent ROLE and every test user in code (derived from the
--    Role union, so the manager promoted next month is covered without a row); this
--    list is for the named exceptions that rule gets wrong. Keyed on the user, not
--    the address, because an address can change and a user id cannot (L15), and
--    shown on /admin/alerts by name.
--
--    Every entry carries a REASON, who added it and when. A suppression set by
--    hand with no reason beside neighbours that have one is evidence it was never
--    reasoned about (L233), and one that is not visible somewhere is how a check
--    quietly stops covering anybody (L523). Roster bounded: at most one row per
--    user, which the primary key enforces.
create table regal_call_ignores (
  user_id   uuid primary key references users(id) on delete cascade,
  reason    text not null check (length(btrim(reason)) > 0),
  added_by  uuid references users(id) on delete set null,
  added_at  timestamptz not null default now()
);

-- Server reads and writes through the secret key client only; no client access.
alter table regal_call_ignores enable row level security;

comment on table regal_call_ignores is
  'The #2090 ignore list: people whose Regal calls are not reported while Slate does not route to them, each with the reason, who added it and when. Managed on /admin/alerts.';

-- 2. The per reason counts over a window, in ONE subrequest. The monitor lane asks
--    two questions of the feed each tick (did anything from a Slate user arrive
--    during the last business day, and did anything unreadable arrive in the last
--    day) and a head count per reason would be eleven reads a question on a lane
--    that shares its budget. Windowed on ARRIVAL, like every other reader of the
--    table. Security invoker: the server calls it with the secret key, and nothing
--    else may call it at all.
create or replace function regal_call_reason_counts(p_since timestamptz)
returns table (reason text, events bigint)
language sql
stable
set search_path = public
as $$
  select e.reason, count(*)::bigint
  from regal_call_events e
  where e.received_at >= p_since
  group by e.reason
$$;

revoke execute on function regal_call_reason_counts(timestamptz) from public, anon, authenticated;

-- 3. Arm or disarm every Regal call alert. Same single row config table, same
--    precedence (store > coded default) and same admin form as its siblings, so
--    there is one way to arm an alert. Nullable, and the coded default is
--    DISARMED, for the observe first reason (L56): nobody can say from a desk how
--    many people are in this state on an ordinary day, and the feed carries
--    nothing at all until Regal is pointed at Slate. It measures and logs every
--    tick either way. #2695 is the issue that arms it, filed with this change
--    (L65).
alter table monitor_alert_config
  add column regal_calls_armed boolean;

-- #990/#989: how often each reschedule/cancel/reassign reason has been picked
-- recently. Powers the "Used N times in the last 90 days" hint on the reason-options
-- editor (#990, warn before retiring a still-used reason) and the reason-usage
-- report (#989), which share this one aggregation.
--
-- Returns a SINGLE jsonb object keyed "<action>|<reason_code>" -> count over
-- booking_events since p_since. A jsonb scalar is one row, so it never hits
-- PostgREST's 1,000-row cap the way a SETOF would (mirrors count_bookings_per_local_day,
-- #832): the distinct (action, reason_code) set is small, but returning a map keeps it
-- cap-proof by construction rather than by relying on the set staying small.
--
-- created_at (not the appointment time) is the axis: "recently picked" means the
-- action happened in the window, regardless of when the appointment was.
--
-- search_path is pinned so a search_path attack cannot shadow booking_events.
create or replace function reason_usage_counts(p_since timestamptz)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_object_agg(key, n), '{}'::jsonb)
  from (
    select e.action::text || '|' || e.reason_code as key,
           count(*)::int as n
    from booking_events e
    where e.created_at >= p_since
    group by 1
  ) q;
$$;

-- Deny-all by default; only the secret-key server client (which runs as the function
-- owner) may call it. A SECURITY DEFINER function bypasses RLS on booking_events, so
-- exposing it to authenticated would leak the reason-usage aggregate to any client.
revoke execute on function reason_usage_counts(timestamptz)
  from public, anon, authenticated;

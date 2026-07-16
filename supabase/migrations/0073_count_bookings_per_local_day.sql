-- #832: server-side per-agent, per-LOCAL-day booking count for the daily cap.
-- Replaces a multi-page bookings row-read on the availability hot path
-- (loadMembersAvailability). At the 200-agent target that read pulled low-thousands
-- of rows over a ~6-day window purely to count each agent's bookings per local day.
--
-- Returns a SINGLE jsonb object keyed "<user_id>|<YYYY-MM-DD>" -> count. A jsonb scalar
-- is one row, so it never hits PostgREST's 1,000-row cap the way a SETOF would: at 200
-- agents x ~8 local days the grouped result exceeds 1,000 and a SETOF would truncate,
-- re-introducing the under-count this replaces.
--
-- The caller SUPPLIES each agent's timezone (p_tz_by_user) rather than the function
-- resolving it. The cap uses one tz per agent for BOTH bucketing bookings into local
-- days AND computing a candidate slot's local day; those live in app code
-- (src/lib/availability/compute.ts), so the count must bucket with the exact same tz or
-- the cap miscounts and overbooks. Passing the tz in also avoids joining
-- availability_schedules here (an agent can have >1 schedule today, #532/#533, which a
-- join would fan-out, double-counting the bookings).
--
-- `at time zone <tz>` is DST-correct via the IANA tz database, matching Luxon's
-- DateTime.fromMillis(ms,{zone}).toISODate() on the app side. Missing/absent tz falls
-- back to America/New_York, matching assembleMemberAvailability's default.
--
-- search_path is pinned so a search_path attack cannot shadow the referenced tables.
create or replace function count_bookings_per_local_day(
  p_user_ids uuid[],
  p_tz_by_user jsonb,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_object_agg(key, n), '{}'::jsonb)
  from (
    select b.assigned_user_id::text || '|' ||
           to_char(
             (b.starts_at at time zone coalesce(p_tz_by_user ->> b.assigned_user_id::text,
                                                'America/New_York'))::date,
             'YYYY-MM-DD'
           ) as key,
           count(*)::int as n
    from bookings b
    where b.assigned_user_id = any(p_user_ids)
      and b.status in ('confirmed', 'rescheduled')
      and b.starts_at >= p_from
      and b.starts_at <= p_to
    group by 1
  ) q;
$$;

-- Deny-all by default; only the secret-key server client (which runs as the function
-- owner) may call it. A SECURITY DEFINER function bypasses RLS on bookings, so exposing
-- it to authenticated would leak every agent's per-day booking counts.
revoke execute on function count_bookings_per_local_day(uuid[], jsonb, timestamptz, timestamptz)
  from public, anon, authenticated;

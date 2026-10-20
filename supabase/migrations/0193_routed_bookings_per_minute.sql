-- #3124: Slate's routed real bookings per minute over [p_from, p_to), for the daily
-- check that says when the booking load run's bar needs raising again.
--
-- "Routed real bookings" is the RUNBOOK's real_bookings definition (scripts/loadtest/
-- RUNBOOK.md, "The peak the 60 a minute bar rests on"): a booking on a bucket that is
-- not is_test, of kind 'routed', so agent link bookings (migration 0144) are left out.
-- Counted by created_at, the moment the booking was made, which is what a busy minute
-- of load is.
--
-- The minute is the whole minutes since the Unix epoch rather than date_trunc, so the
-- answer cannot depend on the session's time zone. The Worker adds cal.com's routed
-- responses to it minute by minute (src/lib/monitor/busy-minutes.ts).
--
-- One jsonb array back, [[minute, bookings], ...] for every minute holding at least one
-- booking, so the read never meets PostgREST's 1000 row cap however busy the week. On
-- 2026-10-20 a week held 2,517 such minutes, about 38 KB, read in about 20 ms.
create or replace function routed_bookings_per_minute(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_array(m.minute, m.bookings) order by m.minute), '[]'::jsonb)
  from (
    select floor(extract(epoch from b.created_at) / 60)::bigint as minute, count(*)::int as bookings
    from bookings b
    join buckets k on k.id = b.bucket_id
    where not k.is_test
      and b.kind = 'routed'
      and b.created_at >= p_from
      and b.created_at < p_to
    group by 1
  ) m;
$$;

comment on function routed_bookings_per_minute(timestamptz, timestamptz) is
  'Routed real bookings (not is_test, kind routed) per minute since the epoch over [p_from, p_to), as one jsonb array of [minute, bookings] (#3124). Read daily by /api/cron/busy-minutes.';

-- Server only, through the secret key client.
revoke execute on function routed_bookings_per_minute(timestamptz, timestamptz) from public, anon, authenticated;

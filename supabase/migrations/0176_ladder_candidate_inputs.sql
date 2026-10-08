-- Everything a confirm's candidate read needs, for every rung of its ladder, in ONE
-- request (#3489).
--
-- A confirm read each rung's candidates with seven to nine PostgREST requests (the
-- pool's members and the org roster, the schedules, a busy page, the daily counts, the
-- business hours twice over, the live holds, the share rows) and read each lower rung's
-- bucket on the way down. Request COUNT is what queues a crowd (#3492): Postgres spent
-- 0.4% of its time executing statements while each call took 90 to 200ms. So a walk
-- down a four rung ladder cost about thirty requests, and a crowd's walkers queued the
-- database past everybody's budget.
--
-- This answers all of them, for every code on the ladder, in one. It decides NOTHING:
-- which advisors make a pool (the criteria), who is free (the shared predicate), who a
-- hold blocks and how the share orders them all stay in TypeScript, unchanged, judging
-- these rows exactly as they judged the separate reads' (`ladderInputsFrom` in
-- src/lib/availability/ladder-inputs.ts). That is also why it reads every BOOKABLE
-- advisor of the ladder's orgs rather than one rung's pool, which only the criteria can
-- work out, and reads busy time, counts and holds over windows the caller makes a
-- SUPERSET of every rung's: a block or hold outside a rung's own window is one the
-- predicate never counts, and a count over more days than the slot's leaves the slot's
-- day's count unchanged. The caller checks each rung's window is inside the one it sent
-- before it judges from these rows, and reads that rung the old way when it is not.
--
-- Each section is the read it replaces, with the same filters:
--
--   buckets         the bucket row with its event type nested, by code
--   agents          the orgs' bookable advisors who have not left (`resolveBucketPool`),
--                   each the whole row, which is what the advisor read returns
--                   (`getUser`) and where the advisor emails come from (`loadEmails`)
--   members         the ladder buckets' ACTIVE manual members
--   schedules       each advisor's schedule (one per advisor, 0074) with its rules
--   busy            busy blocks overlapping [p_busy_from, p_busy_to), hold blocks
--                   included (the caller drops them, as `excludeHoldBlocks` does)
--   day_counts      count_bookings_per_local_day over [p_cap_from, p_cap_to), each
--                   advisor in their schedule's zone
--   holds           live_reroute_holds over the busy window
--   shares          routed confirmed, rescheduled and completed bookings in the ladder
--                   buckets starting in [p_share_from, p_share_to)
--   business_hours  the stored week
--   exceptions      the date exceptions from p_exceptions_from, in date order, 400 at most
--
-- Proved against each of those reads, section by section, in a real Postgres by
-- scripts/verify-ladder-candidate-inputs-sql.ts.
--
-- SECURITY INVOKER: it reads with the caller's own rights, so it grants nothing the
-- caller could not already read. The server calls it with the secret key; execute is
-- still revoked from the web roles, so it is not a public endpoint at all.
create or replace function ladder_candidate_inputs(
  p_codes           text[],
  p_busy_from       timestamptz,
  p_busy_to         timestamptz,
  p_cap_from        timestamptz,
  p_cap_to          timestamptz,
  p_share_from      timestamptz,
  p_share_to        timestamptz,
  p_exceptions_from date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_bucket_ids uuid[];
  v_orgs       uuid[];
  v_agents     uuid[];
  v_tz         jsonb;
begin
  -- Every bound is NAMED: a missing one must not read as an empty ladder or an
  -- unbounded window (L168).
  if p_codes is null or p_busy_from is null or p_busy_to is null or p_cap_from is null or p_cap_to is null
     or p_share_from is null or p_share_to is null or p_exceptions_from is null then
    raise exception 'ladder_candidate_inputs needs the codes and every window bound' using errcode = '22023';
  end if;

  select coalesce(array_agg(b.id), '{}'), coalesce(array_agg(distinct b.org_id), '{}')
    into v_bucket_ids, v_orgs
    from buckets b
   where b.code = any(p_codes);

  select coalesce(array_agg(u.id), '{}')
    into v_agents
    from users u
   where u.org_id = any(v_orgs)
     and u.bookable
     and u.deactivated_at is null;

  -- The zone the daily count buckets each advisor's bookings by, the SAME one their
  -- schedule carries, as the separate read passed it (#832); one with no schedule is
  -- counted in the function's own default, as before.
  select coalesce(jsonb_object_agg(s.user_id, s.timezone), '{}'::jsonb)
    into v_tz
    from availability_schedules s
   where s.user_id = any(v_agents);

  return jsonb_build_object(
    'buckets', (
      select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('event_types', to_jsonb(e)) order by b.code), '[]'::jsonb)
        from buckets b
        left join event_types e on e.id = b.event_type_id
       where b.id = any(v_bucket_ids)
    ),
    'agents', (
      select coalesce(jsonb_agg(to_jsonb(u) order by u.id), '[]'::jsonb)
        from users u
       where u.id = any(v_agents)
    ),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object('bucket_id', m.bucket_id, 'user_id', m.user_id) order by m.bucket_id, m.user_id), '[]'::jsonb)
        from bucket_members m
       where m.bucket_id = any(v_bucket_ids)
         and m.active
    ),
    'schedules', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'user_id', s.user_id,
               'timezone', s.timezone,
               'availability_rules', (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'schedule_id', r.schedule_id, 'weekday', r.weekday,
                          'start_minute', r.start_minute, 'end_minute', r.end_minute)
                        order by r.weekday, r.start_minute, r.id), '[]'::jsonb)
                   from availability_rules r
                  where r.schedule_id = s.id)
             ) order by s.user_id), '[]'::jsonb)
        from availability_schedules s
       where s.user_id = any(v_agents)
    ),
    'busy', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'user_id', x.user_id, 'starts_at', x.starts_at, 'ends_at', x.ends_at, 'source', x.source)
             order by x.id), '[]'::jsonb)
        from busy_blocks x
       where x.user_id = any(v_agents)
         and x.starts_at < p_busy_to
         and x.ends_at > p_busy_from
    ),
    'day_counts', count_bookings_per_local_day(v_agents, v_tz, p_cap_from, p_cap_to),
    'holds', (
      select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb)
        from live_reroute_holds(v_agents, p_busy_from, p_busy_to) h
    ),
    'shares', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'bucket_id', k.bucket_id, 'assigned_user_id', k.assigned_user_id,
               'starts_at', k.starts_at, 'created_at', k.created_at)
             order by k.id), '[]'::jsonb)
        from bookings k
       where k.bucket_id = any(v_bucket_ids)
         and k.kind = 'routed'
         and k.starts_at >= p_share_from
         and k.starts_at < p_share_to
         and k.assigned_user_id = any(v_agents)
         and k.status in ('confirmed', 'rescheduled', 'completed')
    ),
    'business_hours', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'weekday', h.weekday, 'is_open', h.is_open, 'start_minute', h.start_minute, 'end_minute', h.end_minute)
             order by h.weekday), '[]'::jsonb)
        from business_hours h
    ),
    'exceptions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'on_date', x.on_date, 'is_open', x.is_open, 'start_minute', x.start_minute,
               'end_minute', x.end_minute, 'note', x.note)
             order by x.on_date), '[]'::jsonb)
        from (
          select * from business_hours_exceptions
           where on_date >= p_exceptions_from
           order by on_date
           limit 400
        ) x
    )
  );
end;
$$;

comment on function ladder_candidate_inputs(text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, date) is
  'Everything a confirm''s candidate read needs for every rung of its ladder in one request (#3489): the buckets with their event types, the bookable roster, active members, schedules, busy time, daily counts and live holds over the caller''s superset windows, the share rows and the business hours. Decides nothing; the TypeScript judge reads these rows as it read the separate reads''.';

revoke execute on function ladder_candidate_inputs(text[], timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, date)
  from public, anon, authenticated;

-- #2752: keep test attempts made in REAL buckets from off site hosts out of the
-- booking failure rate and its un-park watch.
--
-- The failure rate (#1313) and its verdict watch (#2513) read this tally, and the
-- tally knew only whether the BUCKET was a test one (0108). A tester on a real Low
-- code (100, 112, the codes every trypennie test lead carries) was a lead to it, so
-- ten test attempts in four hours reached the attempt floor that un-parks the watch,
-- and a testing session that tripped the booker's refusals (a slot race, a duplicate,
-- the honeypot) moved the failure share and could page as if leads were failing.
--
-- So the tally carries the host page class, decided at the point of recording by
-- bookingHostClass (src/lib/monitor/offsite-origin.ts), which is the verdict the off
-- site page (#2715) and the below tier exclusion (#2737) reach: 'production' for the
-- production site, 'offsite' for any other recorded host, 'none' where no host was
-- recorded (the booking API, the standalone page, admin). Only 'offsite' is left out;
-- 'none' keeps counting, as #2737 decided for its own check.
--
-- Every existing row predates the marker. Defaulting them to 'none' says "no host
-- was identified", which is true of what was recorded, and keeps them counting,
-- which is the direction that cannot hide a real failure. They age out of the
-- failure rate window within a day on their own.
alter table booking_api_outcome_daily
  add column host_class text not null default 'none'
  check (host_class in ('production', 'offsite', 'none'));

-- The unique key is what the increment's ON CONFLICT targets, so the class must be
-- part of it or an off site attempt and a production one collapse onto one row and
-- the split is unrecoverable. A FULL constraint, never a partial index: a partial
-- unique index cannot back an upsert conflict target (42P10, #35). Dropped by its
-- exact name, read off production on 2026-09-25, WITHOUT `if exists`, so a name
-- that is not there fails the push loudly rather than leaving the old key in place.
alter table booking_api_outcome_daily
  drop constraint booking_api_outcome_daily_key;

alter table booking_api_outcome_daily
  add constraint booking_api_outcome_daily_key
  unique (day, outcome, bucket_code, error_code, is_test, host_class);

-- Both functions gain a parameter, which Postgres treats as a new signature rather
-- than a replacement, so the old ones are dropped first: leaving them would give
-- PostgREST two candidates under one name.
--
-- Both new parameters DEFAULT, and that is deploy ordering rather than convenience:
-- this is applied before the matching code merges, so between the push and the
-- deploy the live Worker still calls these with the old argument lists, and without
-- a default every tally increment in that window would fail.
drop function if exists bump_booking_api_outcome(date, text, text, text, boolean);
drop function if exists booking_api_outcome_mix(date, boolean);

create or replace function bump_booking_api_outcome(
  p_day date,
  p_outcome text,
  p_bucket text,
  p_error_code text,
  p_is_test boolean default false,
  p_host_class text default 'none'
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into booking_api_outcome_daily (day, outcome, bucket_code, error_code, is_test, host_class, count)
  values (p_day, p_outcome, coalesce(p_bucket, ''), coalesce(p_error_code, ''),
          coalesce(p_is_test, false), coalesce(p_host_class, 'none'), 1)
  on conflict (day, outcome, bucket_code, error_code, is_test, host_class)
  do update set count = booking_api_outcome_daily.count + 1,
               updated_at = now();
$$;

-- The mix over [p_since, today], still ONE jsonb row, so it can never hit PostgREST's
-- 1000 row SETOF cap.
--
-- p_include_offsite defaults to FALSE, the same way p_include_test does (0108): a
-- caller that forgets gets the population the failure rate measures. An explicit
-- NULL behaves like false (`null or host_class <> 'offsite'` is null, so not true,
-- for an off site row).
--
-- `offsite_total` counts the window's off site attempts on REAL buckets whichever way
-- p_include_offsite is set, so a reader that leaves them out can say how many it left
-- out rather than showing a silently smaller number. Test bucket attempts are
-- already counted by `test_total` and are not counted twice.
create or replace function booking_api_outcome_mix(
  p_since date,
  p_include_test boolean default false,
  p_include_offsite boolean default false
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'by_outcome', coalesce((
      select jsonb_object_agg(outcome, total)
      from (
        select outcome, sum(count)::int as total
        from booking_api_outcome_daily
        where day >= p_since
          and (p_include_test or not is_test)
          and (p_include_offsite or host_class <> 'offsite')
        group by outcome
      ) o
    ), '{}'::jsonb),
    'by_error', coalesce((
      select jsonb_object_agg(error_code, total)
      from (
        select error_code, sum(count)::int as total
        from booking_api_outcome_daily
        where day >= p_since and outcome = 'error' and error_code <> ''
          and (p_include_test or not is_test)
          and (p_include_offsite or host_class <> 'offsite')
        group by error_code
      ) e
    ), '{}'::jsonb),
    'test_total', coalesce((
      select sum(count)::int
      from booking_api_outcome_daily
      where day >= p_since and is_test
    ), 0),
    'offsite_total', coalesce((
      select sum(count)::int
      from booking_api_outcome_daily
      where day >= p_since and not is_test and host_class = 'offsite'
    ), 0)
  );
$$;

revoke execute on function bump_booking_api_outcome(date, text, text, text, boolean, text)
  from public, anon, authenticated;
revoke execute on function booking_api_outcome_mix(date, boolean, boolean)
  from public, anon, authenticated;

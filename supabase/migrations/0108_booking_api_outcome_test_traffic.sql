-- #1616: stop counting the smoke canary in the booking failure rate.
--
-- The failure-rate page (#1313) reads booking_api_outcome_daily, and before
-- cutover every row in it is the smoke canary's. One full canary pass records 16
-- attempts inside about two minutes, exactly one of which is a
-- `reschedule_conflict` the canary raises ON PURPOSE, so the check's measured
-- failure share is 100 percent synthetic and the only failure in it is deliberate.
--
-- bucket_code cannot separate them. Measured 2026-08-31 on production, one pass
-- writes 12 rows carrying SMOKE / SMOKE2 and 4 carrying an EMPTY bucket_code (the
-- manage-token reschedule path, which records no bucket), and the deliberate
-- conflict is one of the empty ones. Filtering on bucket code would therefore
-- take the canary's successes out and leave its errors in, which is worse than
-- not filtering at all.
--
-- So the tally carries a real marker instead, decided at the point of recording
-- from the BUCKET the attempt belongs to (buckets.is_test), server-side. Nothing
-- a caller sends can set it: a request header would let anyone hide a real
-- failure from the monitor, which is the one thing this check exists to see.

-- Every existing row predates the marker and every one of them is canary traffic,
-- but backfilling them to true would be a claim about rows nobody measured one at
-- a time. They age out of the failure-rate window in an hour and out of the admin
-- panel's 30-day window on their own, so the default is the honest one: false
-- means "not identified as test", not "proven to be a customer".
alter table booking_api_outcome_daily
  add column is_test boolean not null default false;

-- The unique key is what the increment RPC's ON CONFLICT targets, so the marker
-- has to be part of it or a test attempt and a real one collapse onto one row and
-- the split is unrecoverable. Dropped by its exact generated name (read off
-- production, not guessed) and WITHOUT `if exists`, so a name that is not there
-- fails the push loudly rather than silently leaving the 4-column key in place.
alter table booking_api_outcome_daily
  drop constraint booking_api_outcome_daily_day_outcome_bucket_code_error_cod_key;

alter table booking_api_outcome_daily
  add constraint booking_api_outcome_daily_key
  unique (day, outcome, bucket_code, error_code, is_test);

-- Both functions gain a parameter, which Postgres treats as a new signature
-- rather than a replacement, so the old ones are dropped first: leaving them
-- would give PostgREST two candidates under one name.
--
-- Both new parameters carry a DEFAULT, and that is deploy ordering rather than
-- convenience. Migrations are applied BEFORE the matching code merges, so between
-- the push and the deploy the live Worker is still calling these with the old
-- argument lists. Without a default, every tally increment in that window would
-- fail.
drop function if exists bump_booking_api_outcome(date, text, text, text);
drop function if exists booking_api_outcome_mix(date);

create or replace function bump_booking_api_outcome(
  p_day date,
  p_outcome text,
  p_bucket text,
  p_error_code text,
  p_is_test boolean default false
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into booking_api_outcome_daily (day, outcome, bucket_code, error_code, is_test, count)
  values (p_day, p_outcome, coalesce(p_bucket, ''), coalesce(p_error_code, ''),
          coalesce(p_is_test, false), 1)
  on conflict (day, outcome, bucket_code, error_code, is_test)
  do update set count = booking_api_outcome_daily.count + 1,
               updated_at = now();
$$;

-- The mix over [p_since, today], still a SINGLE jsonb row so it can never hit
-- PostgREST's 1000-row SETOF cap.
--
-- p_include_test defaults to FALSE, so the safe direction is what a caller gets
-- by forgetting: a reading that counts the canary is the defect this migration
-- exists to remove. A NULL passed explicitly behaves like false for the same
-- reason (`null or not is_test` is null, and so not true, for a test row).
--
-- `test_total` is always present and always counts the TEST attempts in the
-- window, whichever way p_include_test is set. That is what stops the admin panel
-- showing a silently smaller number: the panel hides test traffic and says how
-- much it hid, so a reader can tell an excluded canary pass from a quiet week.
create or replace function booking_api_outcome_mix(p_since date, p_include_test boolean default false)
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
        where day >= p_since and (p_include_test or not is_test)
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
        group by error_code
      ) e
    ), '{}'::jsonb),
    'test_total', coalesce((
      select sum(count)::int
      from booking_api_outcome_daily
      where day >= p_since and is_test
    ), 0)
  );
$$;

revoke execute on function bump_booking_api_outcome(date, text, text, text, boolean)
  from public, anon, authenticated;
revoke execute on function booking_api_outcome_mix(date, boolean)
  from public, anon, authenticated;

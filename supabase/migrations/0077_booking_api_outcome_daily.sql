-- #418: surface the direct-booking-API outcome mix (visibility, not an alert).
--
-- #375 emits a per-call outcome log line (created/deduped/rescheduled/
-- confirm_required/error, with bucket + error code) to Cloudflare, but nothing
-- consumed it, so there was no in-app way to SEE whether person-dedupe,
-- cross-bucket moves, and no-eligible-agents behave once the bot is live. This
-- persists a lightweight daily tally the admin panel aggregates. Server-only
-- (RLS default-deny; written and read via supabaseAdmin).
--
-- The row is keyed by (day, outcome, bucket_code, error_code): the day bucketed in
-- the roster's ET zone by the caller (matching the daily-cap convention, #832),
-- and error_code stored '' for non-error outcomes so the key is never NULL-distinct
-- (which would let duplicate rows accumulate under a partial-null unique index).
create table booking_api_outcome_daily (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  outcome     text not null,
  bucket_code text not null default '',
  error_code  text not null default '',
  count       integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A FULL (non-partial) unique constraint so the increment RPC's ON CONFLICT can
  -- target it (a partial unique index cannot back an upsert conflict target, #35).
  unique (day, outcome, bucket_code, error_code)
);

-- Read pattern is a windowed aggregate by day; index the window column.
create index booking_api_outcome_daily_day_idx on booking_api_outcome_daily (day);

alter table booking_api_outcome_daily enable row level security;
-- No policies: default-deny. Only the secret-key server client (which bypasses
-- RLS) writes and reads this monitoring aggregate.

-- Atomic per-call increment. INSERT ... ON CONFLICT DO UPDATE count + 1 is a single
-- statement, so concurrent calls and retries never lose a bump or race a
-- read-modify-write ("assume it runs twice"). search_path pinned against a
-- search_path attack; SECURITY DEFINER so the deny-all RLS does not block the write.
create or replace function bump_booking_api_outcome(
  p_day date,
  p_outcome text,
  p_bucket text,
  p_error_code text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into booking_api_outcome_daily (day, outcome, bucket_code, error_code, count)
  values (p_day, p_outcome, coalesce(p_bucket, ''), coalesce(p_error_code, ''), 1)
  on conflict (day, outcome, bucket_code, error_code)
  do update set count = booking_api_outcome_daily.count + 1,
               updated_at = now();
$$;

-- The aggregated mix over a window [p_since, today], as a SINGLE jsonb row so it
-- never hits PostgREST's 1000-row SETOF cap (a per-day/per-bucket/per-error grouped
-- SETOF would over a month). `by_outcome` sums every outcome; `by_error` sums the
-- error slice by code (excluding the '' non-error placeholder).
create or replace function booking_api_outcome_mix(p_since date)
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
        group by outcome
      ) o
    ), '{}'::jsonb),
    'by_error', coalesce((
      select jsonb_object_agg(error_code, total)
      from (
        select error_code, sum(count)::int as total
        from booking_api_outcome_daily
        where day >= p_since and outcome = 'error' and error_code <> ''
        group by error_code
      ) e
    ), '{}'::jsonb)
  );
$$;

revoke execute on function bump_booking_api_outcome(date, text, text, text)
  from public, anon, authenticated;
revoke execute on function booking_api_outcome_mix(date)
  from public, anon, authenticated;

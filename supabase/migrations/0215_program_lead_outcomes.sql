-- #4390 (Phase 4 of #4255): count what happened to program leads, per Eastern day.
--
-- A program lead with a good token is shown the placeholder's extra times beside the real
-- ones (#4390). When a read that needs fails (the token secret, the go live switch and
-- day limit, the hours, the horizon, the day counts) the lead is shown real times only,
-- which is the harmless side, and that is COUNTED here rather than only logged: a fallback
-- is rare by construction, so a log line nobody reads cannot show it becoming the rule
-- (L654). The admin page and the fallback alert (#4392) read these rows.
--
-- 1. program_lead_outcomes: one row per (Eastern day, kind). Kinds:
--      times_fallback  a program lead shown real times only because a read failed (#4390)
--      limit_refused   a program booking refused because its day was full (#4391)
--    Counts and instants only, nothing about any lead. About two rows a day; kept.
-- 2. bump_program_lead_outcome(kind): the one writer, an atomic upsert, so two requests
--    bumping at once are both counted (assume it runs twice). The day is today in New
--    York, the zone placeholder_day_held counts calls in (0213). Answers the new total.
--
-- Additive only: a new table and a new function nothing deployed calls, so the deployed
-- code keeps working from the apply to the deploy. Proved in a real Postgres by
-- scripts/verify-program-lead-outcomes-sql.ts.

create table program_lead_outcomes (
  day         date not null,
  kind        text not null
              constraint program_lead_outcomes_kind check (kind in ('times_fallback', 'limit_refused')),
  occurrences integer not null check (occurrences >= 1),
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  primary key (day, kind)
);
alter table program_lead_outcomes enable row level security;
-- No policies: default deny. Only the secret key server client (which bypasses RLS)
-- reads it, and it writes only through the function below.

comment on table program_lead_outcomes is
  'What happened to program leads per Eastern day (#4390): times_fallback (shown real times only because a read failed) and limit_refused (a booking refused because its day was full). Written only by bump_program_lead_outcome; kept.';

create or replace function bump_program_lead_outcome(p_kind text)
  returns integer
  language sql
  volatile
  set search_path = public, pg_catalog
as $$
  insert into program_lead_outcomes as o (day, kind, occurrences)
  values ((now() at time zone 'America/New_York')::date, p_kind, 1)
  on conflict (day, kind) do update
    set occurrences = o.occurrences + 1,
        last_at     = now()
  returning occurrences;
$$;

-- Server side only. service_role keeps its EXECUTE from the default privileges 0121 sets.
revoke execute on function bump_program_lead_outcome(text) from public, anon, authenticated;

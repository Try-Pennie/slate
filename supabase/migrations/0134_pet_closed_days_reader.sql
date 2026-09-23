-- A read-only login for PET, the Project Enrollment Tracker, that can see the
-- days the org is shut and nothing else (PET #1535).
--
-- PET counted every weekday as a working day, so on Labor Day 2026-09-07, with
-- the whole company closed, every rep was credited with a day worked and every
-- per day figure on its board read about 6% low. The org's closed days already
-- live here, in business_hours_exceptions (0106), kept by an admin for the
-- booker. The sales floor closes on the same days (Dan, 2026-09-23), so PET reads
-- this list rather than keeping a second copy of it by hand.
--
-- WHAT PET CAN REACH: one column of one view. The view carries the date only,
-- not the note or who edited the row, and only for CLOSED dates. PET's daily
-- build copies it into PET's own database, so this login is used by one job a
-- day and never by anything a browser can reach.
--
-- It lives in its own schema, pet_export, which the Data API does not expose,
-- so nothing here is reachable through PostgREST with any Slate key. The view is
-- owned by the migration role and so reads the RLS protected table on PET's
-- behalf; pet_reader holds no grant on business_hours_exceptions itself.
--
-- The role is created WITHOUT a password on purpose. A secret does not belong in
-- a committed file, so the password is set out of band (as a SCRAM verifier, so
-- the password itself never reaches the database or any log) and stored only as
-- a PET build secret. Until then the role cannot sign in at all.

create schema if not exists pet_export;
revoke all on schema pet_export from public;

create or replace view pet_export.closed_days as
  select on_date
  from public.business_hours_exceptions
  where is_open = false;

comment on view pet_export.closed_days is
  'Dates the org is shut, read daily by PET (Project Enrollment Tracker #1535) to leave company holidays out of its working day counts. Changing this view''s shape breaks PET''s build.';

revoke all on pet_export.closed_days from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pet_reader') then
    create role pet_reader login noinherit connection limit 2;
  end if;
end
$$;

-- A runaway query from a misconfigured job cannot hold a connection open.
alter role pet_reader set statement_timeout = '10s';

grant usage on schema pet_export to pet_reader;
grant select on pet_export.closed_days to pet_reader;

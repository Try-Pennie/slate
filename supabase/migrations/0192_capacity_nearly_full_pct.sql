-- #3936: the line at which the Team capacity page flags a day as nearly full.
--
-- Settled in the Team capacity design (docs/design/team-capacity.html, D7 and D9):
-- a day at or over this share of its capacity is flagged in mustard, and admins
-- set the line on the page itself behind Change, so Sam can move it without a
-- deploy. It lives on the single-row booking_settings beside the other settings
-- an admin edits on a page.
--
-- NOT NULL DEFAULT 85, the starting line Dan chose, so the page has a real value
-- from the moment this lands. Nothing writes it except an admin saving the line
-- (setNearlyFullPct), which audits the save. The CHECK is the same 1 to 99 the
-- server enforces: 100 would never flag before Full does, and 0 would flag every
-- day.
--
-- Read by readNearlyFullPct (src/lib/booking/settings.ts). A failed read is never
-- replaced by the default: the page says it could not read the line.
alter table booking_settings
  add column capacity_nearly_full_pct smallint not null default 85
    check (capacity_nearly_full_pct between 1 and 99);

comment on column booking_settings.capacity_nearly_full_pct is
  'The share of a day''s capacity, in percent, at which Team capacity flags the day as nearly full (#3936). Default 85. Edited on /admin/team-capacity.';

-- #3936: the past days Team capacity history holds for an organisation, from p_from
-- on, so the page's date picker offers only days that were saved (Dan, 2026-10-19:
-- a day with nothing saved is never offered). One row back, an array, so the read
-- never meets PostgREST's row cap however long history grows.
create or replace function capacity_history_days(p_org uuid, p_from date)
returns date[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct h.day order by h.day), '{}')
  from capacity_history h
  join users u on u.id = h.user_id
  where u.org_id = p_org and h.day >= p_from;
$$;

-- Server only, through the secret key client.
revoke execute on function capacity_history_days(uuid, date) from public, anon, authenticated;

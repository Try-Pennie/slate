-- Persist whether a time-off request is "all day" instead of inferring it from
-- the magic 00:00 / 23:59 local times everywhere it's needed. The inference is
-- a fragile coupling (change the all-day convention and the edit form silently
-- mis-detects), so store the intent explicitly, written at submit/modify.
--
-- Backfill existing rows by the same inference, computed in each request's own
-- display timezone, so already-submitted all-day requests keep pre-filling the
-- "All day" toggle correctly after the readers switch to the column.
alter table ooo_requests
  add column all_day boolean not null default false;

update ooo_requests
set all_day = true
where (starts_at at time zone display_tz_id)::time = time '00:00'
  and (ends_at   at time zone display_tz_id)::time = time '23:59';

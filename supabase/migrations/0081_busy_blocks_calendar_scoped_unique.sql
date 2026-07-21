-- #619: Google reuses one event id across a user's calendars (the same meeting
-- invited to two of an agent's watched calendars). The old uniqueness on
-- (user_id, gcal_event_id) forced those into ONE row, so calendar B's sync
-- overwrote calendar A's calendar_id, and a delete delta from either calendar
-- removed the block though the event still existed on the other, a rare phantom
-- free slot. Widen the key to include calendar_id so each calendar keeps its
-- own row; applyEvents now upserts on this full key and scopes its deletes by
-- calendar_id.
--
-- NULLs stay DISTINCT (the default), so source=slate rows (gcal_event_id null,
-- calendar_id null) never conflict, exactly as before. The new three-column key
-- is strictly more permissive than the old two-column one, so it cannot fail on
-- existing data. ON CONFLICT (user_id, calendar_id, gcal_event_id) infers it.
drop index if exists busy_blocks_gcal_event_idx;
create unique index busy_blocks_gcal_event_idx
  on busy_blocks(user_id, calendar_id, gcal_event_id);

-- Relabel two uncurated zones onto their curated equivalents (#1849).
--
-- APPLIED TO PRODUCTION on 2026-09-03, before the code that depends on it: 9 rows
-- America/Boise -> America/Denver, 1 row America/Indiana/Indianapolis ->
-- America/New_York. Recorded here because it ran, not so that it can be run
-- again; re-running it is a no-op by construction, since the source zones no
-- longer appear.
--
-- WHY THE ORDER MATTERS, and it is the only sequencing trap in this change. The
-- picker resolves a stored zone outside the list to Eastern. Boise is MOUNTAIN,
-- so shipping the fixed list first would have shown nine agents an Eastern
-- control for a Mountain schedule: a wrong answer presented as a correct one.
-- The data goes first, always.
--
-- WHY THIS IS A RELABEL AND NOT A CHANGE. Boise is Mountain and Indianapolis is
-- Eastern. Checked at 2,928 instants across a full year, including both daylight
-- saving transitions: the offset differs by ZERO minutes at every one. No agent's
-- working hours moved. Asserting that rather than assuming it is the whole reason
-- this was safe to do in bulk.
--
-- NO EXPORT CURSOR REWIND. `availability_schedules` is not in MIRROR_TABLES
-- (src/lib/snowflake/export-core.ts), so nothing about it reaches Snowflake and
-- the strictly forward watermark this repo warns about does not apply. Checked
-- rather than assumed, because the failure it prevents is silent.
--
-- Counts are RETURNED rather than the statements being declared done, and both
-- run in one transaction so they land together or not at all.
begin;

with boise as (
  update availability_schedules
     set timezone = 'America/Denver'
   where timezone = 'America/Boise'
  returning 1
), indy as (
  update availability_schedules
     set timezone = 'America/New_York'
   where timezone = 'America/Indiana/Indianapolis'
  returning 1
)
select
  (select count(*) from boise) as boise_to_denver,          -- 9 on the real run
  (select count(*) from indy)  as indianapolis_to_new_york; -- 1 on the real run

commit;

-- Read back: every stored zone, and whether the fixed US list can represent it.
-- After the run: 71 Eastern, 27 Arizona, 18 Mountain, 16 Pacific, 6 Central,
-- 138 in total, and `in_curated_list` true on every row.
select
  timezone,
  count(*) as schedules,
  timezone in (
    'America/New_York','America/Chicago','America/Denver','America/Phoenix',
    'America/Los_Angeles','America/Anchorage','Pacific/Honolulu'
  ) as in_curated_list
from availability_schedules
group by timezone
order by schedules desc;

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
-- WHICH ROWS MOVED, recorded because nothing else can say.
--
-- After the run the nine former Boise agents are indistinguishable from the nine
-- already on America/Denver, so the set cannot be recovered from the data. A row
-- count alone makes this auditable but NOT reversible, and the identities would
-- otherwise exist only in the transcript of the session that ran it.
--
-- User ids rather than addresses: an id is what a reversal would key on anyway,
-- and it keeps ten employees' names out of the repository (L155).
--
--   America/Boise -> America/Denver, 9 users:
--     bbc5a3a2-edf3-4c3a-a84e-7ede0b9f9c14  20824713-08ab-41ca-b145-ad0db79edbee
--     5decaa58-af18-4992-9139-abe9d87a405e  08cc99e0-5814-4a50-810e-51026ef905bc
--     4e18db9c-d4f0-4045-b871-855650074bf3  9cace7bb-cb89-4b43-889c-c6f723c9f6da
--     ce6705b3-137d-46e5-b938-094a1c1e81b3  552f5b03-aa6f-4fd7-a5fd-73b4ea0c0730
--     132434b2-ca2b-433a-89f3-e0bcbb8f690b
--
--   America/Indiana/Indianapolis -> America/New_York, 1 user:
--     a5b6a375-ddbb-4bf3-bb10-12982ada6d99
--
-- All ten were active and bookable at the time of the run, and nobody's working
-- hours moved: both pairs are offset identical, as checked above. To undo it,
-- set those ids back by user_id; the schedules table keys on user_id.
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

-- #532: each user has at most one availability_schedules row, enforced by the DB.
--
-- Nothing (no FK, no unique) stopped a user accumulating multiple schedule rows.
-- assembleMemberAvailability (src/lib/availability/compute.ts) keys schedules by
-- user_id into a Map, so a second row silently wins by query order; if the two
-- ever differ, an agent's bookable hours are non-deterministically wrong. This
-- actually happened on smoketest2@ during the #464 seed work (a stray random-id
-- schedule alongside the deterministic seed one). Sibling of 0067 (#770, one
-- busy_block per booking).
--
-- De-dupe defensively first: keep the OLDEST row per user (created_at asc, id asc
-- as a stable tiebreak); the losers' availability_rules cascade away
-- (availability_rules.schedule_id references availability_schedules on delete
-- cascade). Verified against production before writing this: 124 rows, 124
-- distinct users, ZERO duplicates, so this deletes nothing today and the index
-- builds cleanly.
delete from availability_schedules a
using availability_schedules b
where a.user_id = b.user_id
  and (b.created_at, b.id) < (a.created_at, a.id);

-- NOT partial and NO where clause: user_id is NOT NULL, so a plain unique index
-- has no NULL-distinct concern, and a non-partial index is exactly what
-- supabase-js upsert's bare ON CONFLICT (user_id) can infer (the 42P10 trap 0022
-- hit on busy_blocks). The three admin hours actions now upsert on this target.
create unique index if not exists availability_schedules_user_uniq
  on availability_schedules (user_id);

-- Superseded: the unique index serves every read the plain one did (all lookups
-- are by user_id equality / IN).
drop index if exists availability_schedules_user_idx;

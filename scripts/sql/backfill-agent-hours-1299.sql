-- Move the roster's working day from a 09:00 start to 08:00 (#1299, #1255).
--
-- Phase 6 of milestone 24, and the ONE intended behaviour change in it: every
-- agent gains an hour of offered time per weekday. Phases 1 to 5 were inert by
-- construction; this is not.
--
-- WHY THE GUARDS ARE HEAVY FOR 630 ROWS. The org has zero real bookings, so there
-- is no traffic baseline against which anyone would notice a mistake: nobody
-- complains that a slot is missing, no conversion dips, no agent says their diary
-- looks wrong. The row count and the snapshot table are the ENTIRE detection
-- mechanism. So the assertions abort rather than warn.
--
-- SCOPE: the start only. `end_minute` stays 17:00. Where the working day should
-- FINISH is its own decision with its own evidence, not a side effect of this
-- backfill (Dan, 2026-08-06). Saturday stays off for agents until one opts in;
-- the ORG is open Saturday (business_hours, #1294) but no agent is rostered then,
-- and the agent's own hours are what decide whether anything is offered.
--
-- ALL OR NOTHING PER SCHEDULE. Only a schedule that is ENTIRELY the untouched
-- five-rule seed is moved. A schedule someone has already edited is left exactly
-- as it is: this backfill exists to correct a bad default, not to overwrite a
-- deliberate choice. Measured 2026-08-06: all 126 qualify, 0 do not.
--
-- The `count(distinct r.weekday) = 5` clause is not redundant next to
-- `count(*) = 5`. Five rows plus a weekday range does not prove the days are
-- DISTINCT: a schedule holding five rules that are all Monday, or Monday twice and
-- Tuesday to Thursday, passes a count and a min/max check and is not the seed at
-- all. Several windows on one weekday is a real capability the compute honours
-- (0097 deliberately declined a unique index on (schedule_id, weekday)), so this
-- shape is possible, not hypothetical. Not trusting today's uniformity is the
-- whole point of the guard.
--
-- Also moves `organizations.default_start_minute`, so the next agent the roster
-- sync creates inherits the SAME day rather than 09:00. The other two 09:00 sites
-- (the admin form's blank fallback and the smoke seed) move in the same PR, via
-- SEED_START_MINUTE in src/lib/schedule-core.ts.
--
-- NOT a mirrored table: availability_rules and organizations are absent from
-- MIRROR_TABLES (src/lib/snowflake/export-core.ts), so there is no export_cursor
-- to rewind and nothing is stranded behind a watermark.
--
-- IDEMPOTENT: re-running matches no schedule (none is on 540 any more) and the
-- final assertion then fails on `expected 630, updated 0`, which is the correct
-- outcome for an accidental second run: loud, and having changed nothing.
--
-- Run with the /db-apply skill. Every statement reports its row count.

begin;

-- 1. Snapshot EVERY rule, not only the ones about to move, so the backup is a
--    restore point for the table rather than a diff of this change. `create table
--    as` fails if it already exists, which is the right behaviour: a second run
--    must not overwrite the record of the first.
create table availability_rules_backup_1255 as
select r.*, now() as snapshot_at
from availability_rules r;

-- 2. Move the start on the qualifying schedules only.
with untouched_seed as (
  select s.id
  from availability_schedules s
  join availability_rules r on r.schedule_id = s.id
  group by s.id
  having count(*) = 5
     and count(distinct r.weekday) = 5          -- five DISTINCT days, not five rows
     and min(r.weekday) = 1
     and max(r.weekday) = 5                     -- and those days are Mon..Fri
     and count(*) filter (where r.start_minute = 540 and r.end_minute = 1020) = 5
)
update availability_rules r
set start_minute = 480
from untouched_seed u
where r.schedule_id = u.id;

-- 3. The org default a newly synced agent inherits.
update organizations
set default_start_minute = 480
where default_start_minute = 540;

-- 4. Abort unless the result is EXACTLY what was predicted. Each check names the
--    quantity it protects rather than a proxy for it.
do $$
declare
  v_moved      integer;
  v_left_at_9  integer;
  v_schedules  integer;
  v_org_start  integer;
  v_backup     integer;
begin
  select count(*) into v_moved
  from availability_rules
  where start_minute = 480 and end_minute = 1020 and weekday between 1 and 5;

  select count(*) into v_left_at_9 from availability_rules where start_minute = 540;

  select count(distinct schedule_id) into v_schedules
  from availability_rules
  where start_minute = 480 and end_minute = 1020;

  select min(default_start_minute) into v_org_start from organizations;

  select count(*) into v_backup from availability_rules_backup_1255;

  if v_moved <> 630 then
    raise exception 'expected 630 weekday rules on 08:00-17:00, found %', v_moved;
  end if;
  if v_schedules <> 126 then
    raise exception 'expected 126 schedules on the new day, found %', v_schedules;
  end if;
  if v_left_at_9 <> 0 then
    raise exception '% rule(s) still start at 09:00; the backfill was partial', v_left_at_9;
  end if;
  if v_org_start <> 480 then
    raise exception 'org default_start_minute is %, so the next synced agent would get the old day', v_org_start;
  end if;
  -- The snapshot has to hold the PRE-change rows: a backup written after the
  -- update, or one that came out short, is not a restore point.
  if v_backup <> 630 then
    raise exception 'snapshot holds % rows, expected the 630 that existed before the change', v_backup;
  end if;

  raise notice 'backfill ok: % rules across % schedules now start at 08:00; snapshot holds % rows',
    v_moved, v_schedules, v_backup;
end $$;

commit;

-- The (user_id, gcal_event_id) uniqueness was a PARTIAL unique index
-- (where gcal_event_id is not null). PostgREST/supabase-js upsert with
-- on_conflict=user_id,gcal_event_id generates a bare ON CONFLICT (cols)
-- clause, which Postgres cannot match to a partial index (42P10) - so every
-- gcal busy-block upsert in sync has failed since 0001, silently, while the
-- sync token still advanced. The cache therefore never contained any Google
-- events, availability over-offered slots, and verify-on-book rejected them
-- with 409 (issue #35).
--
-- A full unique index has the same semantics for our data (Postgres treats
-- NULLs as distinct, so the slate-sourced rows with NULL gcal_event_id never
-- conflict) and IS inferable by ON CONFLICT (user_id, gcal_event_id).
drop index if exists busy_blocks_gcal_event_idx;
create unique index busy_blocks_gcal_event_idx
  on busy_blocks(user_id, gcal_event_id);

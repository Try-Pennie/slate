-- #3365: a time off's held window gets a source of its own, 'ooo', with a
-- lifecycle tied to its request.
--
-- #3360 (0170) made the approved window a Slate written block the calendar sync
-- never rewrites, in the shape the fallback already used: source 'slate', no
-- booking, owned through ooo_request_id. That shape survives the reconcile sweep
-- only while its owner is APPROVED: the sweep frees every 'slate' row with no
-- booking unless `loadApprovedOooRequestIds` names its owner. #3365 keeps a
-- NARROWED request's shorter window blocked while it waits for re-approval, so its
-- owner is pending, and the sweep would free the block within a tick, reopening
-- exactly the hours the change was meant to keep.
--
-- So the held window stops borrowing the booking write-through's source. 'ooo' is
-- read by availability like every other busy row (the reader takes all sources and
-- excludes only 'hold' on request), and nothing that sweeps 'slate' or 'gcal' rows
-- can see it: the reconcile sweep and the missing block check read 'slate', the
-- sync, its reconcile and the nightly prune read or match 'gcal'.
--
-- Its lifecycle is tied to the request instead, in the database, so no path can
-- forget it (the 0167 pattern):
--   * the orchestration deletes it when a request is cancelled, declined, or
--     changed in a way that releases it, as before;
--   * a trigger deletes it whenever the request ends (cancelled or declined) or
--     stops pointing at it (busy_block_id cleared or moved to another row), which
--     is the backstop for an orchestration delete that failed, the case the
--     reconcile sweep used to cover;
--   * deleting the request deletes it (the foreign key now cascades). It used to
--     SET NULL so the reconcile sweep could free the orphan later (0103); a held
--     row exists only for its request, so the end state is the same and immediate.
--
-- Expand only, for the deployed code: a widened check, a new constraint no row it
-- writes can break (it writes 'slate' and 'gcal', never 'ooo'), a trigger that
-- touches only 'ooo' rows, and a cascade that removes rows the reconcile sweep
-- would free anyway. Approvals made by that code between this running and the
-- deploy are written as 'slate'; the read-back in docs/migrations-runbook.md
-- ("Held time off windows") finds them and re-running the conversion below takes
-- them.

alter table busy_blocks drop constraint busy_blocks_source_check;
alter table busy_blocks add constraint busy_blocks_source_check
  check (source in ('slate', 'gcal', 'hold', 'ooo'));

-- A held window names its request and nothing else: no booking, no calendar event,
-- no calendar, no reroute hold.
alter table busy_blocks add constraint busy_blocks_ooo_shape check (
  source <> 'ooo'
  or (ooo_request_id is not null and booking_id is null and gcal_event_id is null
      and calendar_id is null and hold_id is null)
);

alter table busy_blocks drop constraint busy_blocks_ooo_request_id_fkey;
alter table busy_blocks add constraint busy_blocks_ooo_request_id_fkey
  foreign key (ooo_request_id) references ooo_requests(id) on delete cascade;

create or replace function ooo_release_held_window()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  delete from busy_blocks
   where ooo_request_id = new.id
     and source = 'ooo'
     and (new.status in ('cancelled', 'rejected')
          or new.busy_block_id is null
          or id <> new.busy_block_id);
  return null;
end
$$;

revoke execute on function ooo_release_held_window() from public, anon, authenticated;

create trigger ooo_release_held_window
  after update of status, busy_block_id on ooo_requests
  for each row execute function ooo_release_held_window();

-- Convert every held window an approved request already has. Asserted inside the
-- transaction, so a surprise rolls the whole migration back.
do $$
declare
  v_expected  integer;
  v_converted integer;
  v_left      integer;
begin
  select count(*)
    into v_expected
    from busy_blocks b
    join ooo_requests r on r.id = b.ooo_request_id and r.busy_block_id = b.id
   where b.source = 'slate'
     and b.booking_id is null
     and r.status = 'approved';

  update busy_blocks b
     set source = 'ooo'
    from ooo_requests r
   where r.id = b.ooo_request_id
     and r.busy_block_id = b.id
     and b.source = 'slate'
     and b.booking_id is null
     and r.status = 'approved';
  get diagnostics v_converted = row_count;

  select count(*)
    into v_left
    from busy_blocks b
    join ooo_requests r on r.id = b.ooo_request_id and r.busy_block_id = b.id
   where b.source <> 'ooo'
     and r.status = 'approved';

  if v_converted <> v_expected or v_left <> 0 then
    raise exception
      '#3365 held window source: expected % rows; converted %, approved requests still held by another source %',
      v_expected, v_converted, v_left;
  end if;

  raise notice '#3365 held window source: % held windows now carry source ooo', v_converted;
end
$$;

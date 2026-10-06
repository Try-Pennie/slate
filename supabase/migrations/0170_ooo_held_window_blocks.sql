-- #3360: an approved time off's window is held by a block the calendar sync never
-- rewrites.
--
-- Until now an approval wrote its busy block as source='gcal' carrying the agent
-- event's id, so the calendar sync's upsert on (user_id, calendar_id, gcal_event_id)
-- treated it as that event's mirror and rewrote its span from Google. On 2026-10-06
-- a hand edit moved one approved day's event to 11:30 AM MT, request 13137fb6's
-- block followed it (c9997303 now starts 17:30Z rather than 06:00Z), and a lead was
-- booked into the morning the edit opened.
--
-- The code now writes the approved window as a Slate block (source 'slate', no
-- event id, no calendar id, owned through ooo_request_id), which no sync path
-- writes or deletes, and lets the sync mirror the event in its own ordinary row.
-- This brings every request approved before that change to the same shape:
--
--   * a held block is INSERTED at the request's approved window;
--   * the request's busy_block_id is pointed at it;
--   * the old gcal row is DETACHED (ooo_request_id cleared) rather than deleted,
--     so it stays the event's mirror and the sync goes on keeping it current.
--     Deleting it would lose any hours a WIDER event blocks, until the next full
--     resync re-reads the event.
--
-- It re-blocks hours an edit had opened, request 13137fb6's Wednesday morning
-- among them. That is the decision on #3360: the approved request is what is
-- protected until somebody changes it, and the new page asks for the two to be
-- made to agree in whichever direction is true.
--
-- Safe for the code deployed while this is applied ahead of it: the held shape is
-- exactly the fallback shape that code already writes and protects (the reconcile
-- sweep spares a slate row whose owner is approved, the pool exit prunes spare any
-- row with an owner), and its cancel path deletes the request's block by id and the
-- event's row by event id, which reaches both rows. A request that code approves
-- between this running and the deploy is written in the old shape; the read-back in
-- docs/migrations-runbook.md ("Held time off windows", #3360) finds it, and
-- re-running this body converts it, because it only ever selects old shaped rows.
--
-- Asserted inside the transaction, so a surprise rolls the whole thing back.
do $$
declare
  v_requests  integer;
  v_owned     integer;
  v_held      integer;
  v_repointed integer;
  v_detached  integer;
  v_left      integer;
begin
  select count(distinct r.id), count(*)
    into v_requests, v_owned
    from busy_blocks b
    join ooo_requests r on r.id = b.ooo_request_id
   where b.source = 'gcal'
     and r.status = 'approved';

  with owners as (
    select distinct r.id, r.user_id, r.starts_at, r.ends_at
      from busy_blocks b
      join ooo_requests r on r.id = b.ooo_request_id
     where b.source = 'gcal'
       and r.status = 'approved'
  ), held as (
    insert into busy_blocks (user_id, starts_at, ends_at, source, gcal_event_id, calendar_id, ooo_request_id)
    select o.user_id, o.starts_at, o.ends_at, 'slate', null, null, o.id
      from owners o
    returning id, ooo_request_id
  ), repointed as (
    update ooo_requests r
       set busy_block_id = h.id
      from held h
     where r.id = h.ooo_request_id
    returning r.id
  )
  select (select count(*) from held), (select count(*) from repointed)
    into v_held, v_repointed;

  update busy_blocks b
     set ooo_request_id = null
    from ooo_requests r
   where r.id = b.ooo_request_id
     and b.source = 'gcal'
     and r.status = 'approved';
  get diagnostics v_detached = row_count;

  select count(*)
    into v_left
    from busy_blocks b
    join ooo_requests r on r.id = b.ooo_request_id
   where b.source = 'gcal'
     and r.status = 'approved';

  if v_held <> v_requests or v_repointed <> v_requests or v_detached <> v_owned or v_left <> 0 then
    raise exception
      '#3360 held window backfill: expected % requests (% owned gcal rows); held %, repointed %, detached %, still owned %',
      v_requests, v_owned, v_held, v_repointed, v_detached, v_left;
  end if;

  raise notice '#3360 held window backfill: % approved requests now hold their window (% gcal rows detached as plain mirrors)',
    v_held, v_detached;
end
$$;

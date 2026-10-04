-- #3248 (phase 2 of #3244): a reroute hold shows in the slot cache.
--
-- 0166 stops a booking landing on a held advisor, and the booker now skips a held
-- advisor before it sends any invite. What remains is the OFFER: while an advisor
-- is held, the cached slots can still show a time only they could serve, so a lead
-- picks it and is then told it is gone. So a hold now writes a busy_blocks row for
-- the held advisor at the held call's window, which the slot recompute reads like
-- any other busy time.
--
-- The row is written and removed by triggers on reroute_holds, never by the
-- caller, so no path that places, replaces, consumes or deletes a hold can forget
-- it:
--   * placing a hold inserts its block (source 'hold', carrying hold_id);
--   * replacing a hold deletes the old hold row, and the block goes with it
--     through the foreign key;
--   * consuming a hold (the confirm) deletes its block in the same transaction;
--   * cancelling the booking deletes the hold (0166), so the block goes too.
-- The one thing a trigger cannot see is time passing, so an EXPIRED hold's block
-- is removed by prune_expired_reroute_hold_blocks, which the every minute self heal
-- lane calls. Meanwhile the booker and the database ignore an expired hold the
-- instant it expires; the block only keeps a time off the offer for up to a minute,
-- which is the safe direction.
--
-- Additive for the deployed code: a new column, a widened check, new functions and
-- triggers. Nothing deployed reads source 'hold' or hold_id.

alter table busy_blocks drop constraint busy_blocks_source_check;
alter table busy_blocks add constraint busy_blocks_source_check
  check (source in ('slate', 'gcal', 'hold'));

alter table busy_blocks
  add column if not exists hold_id uuid references reroute_holds(id) on delete cascade;

-- One block per hold, and a hold block names nothing else: no booking (the
-- booking's own write through block lives on its CURRENT advisor, keyed by
-- booking_id), no calendar event, no time off.
create unique index if not exists busy_blocks_hold_id_uniq on busy_blocks (hold_id) where hold_id is not null;
alter table busy_blocks add constraint busy_blocks_hold_shape check (
  (source = 'hold') = (hold_id is not null)
  and (source <> 'hold' or (booking_id is null and gcal_event_id is null and ooo_request_id is null))
);

create or replace function reroute_hold_write_block()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into busy_blocks (user_id, starts_at, ends_at, source, hold_id)
    values (new.agent_user_id, new.booking_starts_at, new.booking_ends_at, 'hold', new.id);
  elsif new.consumed_at is not null and old.consumed_at is null then
    delete from busy_blocks where hold_id = new.id;
  end if;
  return null;
end
$$;

revoke execute on function reroute_hold_write_block() from public, anon, authenticated;

create trigger reroute_hold_write_block
  after insert or update of consumed_at on reroute_holds
  for each row execute function reroute_hold_write_block();

-- The expiry sweep. Removes the block of every hold that has expired unconsumed
-- and returns the advisors it freed, so the caller can refresh their buckets. The
-- hold row itself is KEPT, so a confirm after expiry is told "expired" rather than
-- "not found".
create or replace function prune_expired_reroute_hold_blocks()
  returns table (user_id uuid)
  language plpgsql
  security definer
  set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    delete from busy_blocks b
     using reroute_holds h
     where b.hold_id = h.id
       and h.consumed_at is null
       and h.expires_at <= now()
    returning b.user_id;
end
$$;

revoke execute on function prune_expired_reroute_hold_blocks() from public, anon, authenticated;

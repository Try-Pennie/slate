-- #3797: tell a time refused at the cached free check that was a LOST RACE apart from
-- a stale offer.
--
-- On 2026-10-16 the booking failure page fired on seven refusals; six were ordinary
-- lost races (the time was free when the lead's list was computed and another booking
-- took the last free advisor before they confirmed), and the page sent the reader to
-- the availability cache, which was right every time. Dan, 2026-10-16: a proven race
-- is counted apart and does not page; only a time offered when it was never free does.
--
-- Three columns, all null on a booked decision and on every refusal the judgement did
-- not reach (another stage, or a confirm that carried no computed_at):
--   * offer_verdict: race (proven, counted apart), stale_offer (judged, nothing proves
--     a race, or the row was already proven stale), unknown (could not be judged). The
--     vocabulary is OFFER_VERDICTS in src/lib/booking/offer-race.ts, and
--     scripts/test-offer-race.ts holds the two together;
--   * served_computed_at: the computed_at of the list the lead picked from, the stamp
--     the verdict was judged against;
--   * stale_row_codes: the bucket codes whose stored row still offered the refused
--     time when the refusal was recorded. These are the row proofs: a later refusal
--     whose list was computed before one of them was handed a list Slate already knew
--     was wrong, and stays a stale offer whatever was written since.
--
-- Additive for the deployed code: nullable columns, a check and a partial index. The
-- deployed inserts name their columns, so they are unaffected; the new code writes
-- these keys only on a refusal the judgement reached. The mirror does not carry them
-- (scripts/lib/snowflake-restore.ts, UNMIRRORED_COLUMNS).

alter table routing_decisions
  add column if not exists offer_verdict text,
  add column if not exists served_computed_at timestamptz,
  add column if not exists stale_row_codes text[];

alter table routing_decisions
  add constraint routing_decisions_offer_verdict_check
  check (offer_verdict is null or offer_verdict in ('race', 'stale_offer', 'unknown'));

comment on column routing_decisions.offer_verdict is
  'On a candidate_read_empty refusal (#3797): race when the time was free when the lead''s list was computed and taken since (counted apart, never paged on), stale_offer when nothing proves a race, unknown when it could not be judged. NULL when not judged.';
comment on column routing_decisions.served_computed_at is
  'The computed_at of the slot list the refused lead picked from (#3797). NULL when the confirm carried none.';
comment on column routing_decisions.stale_row_codes is
  'Bucket codes whose stored bucket_slots row still offered the refused time when the refusal was recorded (#3797): the row proofs later refusals are judged against. NULL when none did.';

-- A later refusal asks for the newest proof on its codes since its list was computed.
-- Partial, because proofs are a small minority of refusals, which are a small minority
-- of the table.
create index if not exists routing_decisions_stale_row_proof_idx
  on routing_decisions using gin (stale_row_codes)
  where stale_row_codes is not null;

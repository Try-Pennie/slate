-- #2071: a hire becomes bookable on their first debt team or the Sales profile.
--
-- The Salesforce roster sync now plans that flip itself and makes it through the
-- same gated service the admin toggle uses, which refuses an agent with no
-- reachable Google calendar. The transition it keys on happens ONCE: after a
-- refusal, the next hour sees "has tiers, not bookable", which is exactly what a
-- manager somebody deliberately held out of the pool looks like. This column is
-- the mark that tells the two apart. Set when a flip is planned, in the same write
-- as the attributes that caused it (so a run that dies between the write and the
-- attempt leaves the intent behind); cleared by ANY explicit bookable write, the
-- sync's or a person's, because either answers the question it was asking.
--
-- null = no flip is owed. Nullable with no default on purpose: a default would
-- mark every existing row as owed a flip, and rvillar@ is an existing row with
-- tiers who was set non-bookable by hand on 2026-09-02.
alter table public.users
  add column if not exists bookable_pending_since timestamptz;

comment on column public.users.bookable_pending_since is
  '#2071: the roster sync planned to make this person bookable and the activation gate refused (no Google calendar yet). Retried hourly while set; cleared by any explicit bookable write.';

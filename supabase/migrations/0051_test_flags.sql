-- Synthetic test markers (#396 follow-up): flag the dedicated smoke-test agent
-- and its isolated buckets so they can be (a) hidden from all internal UI and
-- (b) made unbookable by real consumer leads, while the key-authed smoke test
-- can still book them. Both default false; only the seeded smoke rows set true.
-- Routing is deliberately NOT gated on these (the smoke test must still route to
-- the test agent inside its buckets); the booking block lives in the public
-- create path, and the UI/availability hiding is read-side only.
alter table public.users
  add column if not exists is_test boolean not null default false;

alter table public.buckets
  add column if not exists is_test boolean not null default false;

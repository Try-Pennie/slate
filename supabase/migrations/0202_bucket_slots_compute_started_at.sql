-- #3388: a slot row records when its compute STARTED, beside its stamp.
--
-- The recompute lane reads eligibility through a 60 second cache, and its rows are
-- now stamped (`computed_at`) from when that cached list was read whenever that is
-- earlier than the compute's start, so the write gate lets a row a live path wrote
-- since stand. That stamp is right for the gate and for anything measuring how old
-- the data is, and wrong for scheduling: the lane places each pool on its own
-- phase grid, and a stamp moved back past the grid point brought the pool due again
-- a minute later instead of a window later (16% to 80% more computes, simulated).
--
-- `compute_started_at` is when the compute that wrote the row began. The due set,
-- the stale alarm and the admin "Last computed" column read it through
-- `scheduleAnchorMs` (src/lib/availability/slot-row-times.ts), which falls back to
-- the stamp whenever the start is missing or the stamp cannot explain it (a stamp
-- back dated to the epoch by a settings save or by hand still forces the row due).
--
-- Additive and nullable, so the code already deployed keeps working: it never names
-- the column, and every existing row reads null, which means "use the stamp". The
-- new code falls back to the stamp alone if it runs before this is applied. No
-- grants change: the table is default deny under RLS and only the secret key
-- client reads or writes it.
alter table public.bucket_slots
  add column if not exists compute_started_at timestamptz;

comment on column public.bucket_slots.compute_started_at is
  '#3388: when the compute that wrote this row began. The lane schedules the next recompute from it; computed_at can be up to one eligibility cache lifetime earlier.';

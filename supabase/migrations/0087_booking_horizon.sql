-- #216 (folds in audit AUD-076): make the org-wide booking horizon (how far ahead
-- a lead may book) an explicit, admin-configurable setting instead of a hardcoded
-- constant. It lives on the existing single-row booking_settings config (0086,
-- #1015) rather than a new table: that row is already "the booking-config row".
--
-- Nullable = unset: a null horizon_days reads back through the resolver as env >
-- coded default (4), exactly like default_bucket_code's null = "no default". The
-- CHECK bounds a stored value to 1..7 (7 is the current cap; 14 is deferred pending
-- a 200-agent load-soak because recompute cost is ~super-linear in the horizon). A
-- CHECK is TRUE for NULL in Postgres, so the unset case still passes.
alter table booking_settings
  add column horizon_days smallint
    check (horizon_days is null or horizon_days between 1 and 7);

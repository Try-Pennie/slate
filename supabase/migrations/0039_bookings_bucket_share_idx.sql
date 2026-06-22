-- Per-bucket equal-share assignment (#305, ADR 0002): every booking assignment
-- counts each free agent's bookings in THIS bucket whose meeting (starts_at)
-- falls in the current pay period. This composite, leading on bucket_id and
-- ranged on starts_at, makes that a tight range scan instead of a bucket-wide
-- scan that grows as completed rows accumulate. Partial on the counted statuses
-- keeps it small (cancelled/no-show never enter the index).
create index if not exists bookings_bucket_share_idx
  on bookings (bucket_id, starts_at, assigned_user_id)
  where status in ('confirmed', 'rescheduled', 'completed');

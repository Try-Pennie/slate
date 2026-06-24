-- #392 list endpoint: support the default (starts_at) order + keyset/offset scan
-- and the updatedSince (updated_at) incremental-reconciliation order. The bucket
-- and agent filters are already covered by bookings_bucket_idx (bucket_id) and
-- bookings_assigned_idx (assigned_user_id, starts_at).

create index if not exists bookings_starts_at_id_idx on bookings (starts_at, id);
create index if not exists bookings_updated_at_idx on bookings (updated_at, id);

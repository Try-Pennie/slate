-- One pre-unioned BucketSlots blob per bucket, read by indexed PK on the hot
-- path instead of fanning a live compute across all eligible agents (the
-- precompute + single-row-read availability plan). Additive and isolated.
create table if not exists bucket_slots (
  bucket_code text primary key,
  payload     jsonb not null,
  computed_at timestamptz not null default now()
);

-- Default-deny like the rest of the schema: server uses the secret key
-- (supabaseAdmin, bypasses RLS); no client ever reads this table directly.
alter table bucket_slots enable row level security;

-- SPIKE (spike/precompute-bucket-slots): validate the council's "precompute +
-- single-row read" availability plan. One pre-unioned BucketSlots blob per
-- bucket, read by indexed PK on the hot path instead of fanning a live compute
-- across all eligible agents. Additive and isolated — nothing else reads it
-- until the ?src=pre read path is exercised.
create table if not exists public.bucket_slots (
  bucket_code text primary key,
  payload     jsonb not null,
  computed_at timestamptz not null default now()
);

-- Default-deny like the rest of the schema: server uses the secret key
-- (supabaseAdmin, bypasses RLS); no client ever reads this table directly.
alter table public.bucket_slots enable row level security;

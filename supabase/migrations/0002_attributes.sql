-- Attribute-based routing: agents carry attributes; buckets carry criteria.
-- A bucket's round-robin pool = manual members UNION agents matching criteria.

-- e.g. {"debt_team": ["ultra_high"], "backend_service": "achieve",
--       "role": "sales_agent", "legal_eligible": true}
alter table users add column attributes jsonb not null default '{}'::jsonb;

-- e.g. {"role": "sales_agent", "debt_team": "ultra_high"} — all keys must match.
alter table buckets add column criteria jsonb not null default '{}'::jsonb;

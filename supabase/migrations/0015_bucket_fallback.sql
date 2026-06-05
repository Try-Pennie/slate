-- Fallback agent for a bucket whose criteria/members match nobody (the cal.com
-- "default route" analog). When the eligible pool is empty, routing falls back
-- to this agent instead of silently showing no availability and dropping the
-- booking. Nullable; null means no fallback (empty pool stays empty).
alter table buckets add column if not exists fallback_user_id uuid references users(id);

-- Which calendar a synced busy block came from. Informational: it supports
-- per-calendar reconciliation/debugging. The existing uniqueness on
-- (user_id, gcal_event_id) is kept as-is (event ids don't collide across a
-- single user's calendars in practice), so this stays a safe additive change
-- with no index churn.
alter table busy_blocks add column if not exists calendar_id text;

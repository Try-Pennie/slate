-- #3801: remember what a condition alert's last post said, so an unchanged
-- condition posts again once a day rather than on every cooldown, while a change
-- (a subject the last post did not name, or a worse band) posts at once.
--
-- alert_state (0011) held only `key` and `last_sent_at`. The dispatcher now also
-- records, on a condition's cooldown row:
--   subjects   what the last post named (booking, agent, pool, lane, or the
--              message's normalised lines when the send site names nothing)
--   band       how bad its measured value was, higher is worse, or null
--   opened_at  when the condition was first posted, for the reminder's
--              "still true after N hours" line
--
-- All three are nullable with no default, so the code deployed before this lands
-- (which writes only key and last_sent_at, and selects only last_sent_at) keeps
-- working unchanged, and a row written before this reads as "not recorded", which
-- the dispatcher treats as a change: one post per open condition, the loud side.
-- A firing marker row (`alert_firing:<key>`) leaves them null.
--
-- No new table, so no RLS change: alert_state is deny-all since 0021 and is read
-- and written only by the server's secret-key client.
alter table alert_state
  add column if not exists subjects text[],
  add column if not exists band integer,
  add column if not exists opened_at timestamptz;

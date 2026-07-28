-- #1150: give the WATCH lane its own failure counter, separate from the sync
-- lane's (0038 + 0078).
--
-- Both lanes wrote the same health triple through one helper. The sync lane runs
-- every minute and RESETS the streak on every success; the watch lane runs every
-- ~5 minutes and increments it on a failed push-channel renewal. So a renewal
-- failure was wiped within the minute and could never reach GONE_PAGE_AT or
-- TRANSIENT_PAGE_AT. The watch-lapse alert could therefore only fire when a
-- calendar was failing BOTH ways (a revoked account), which the sync-failure
-- alert already covers, leaving "Google push is degraded but events still sync"
-- unalertable: availability silently falls back to the 1-minute backup cron with
-- nobody told. The same collision ran the other way too, a successful renewal
-- clearing a genuine sync-failure streak.
--
-- Mirrors the sync columns exactly (0038's counter + last success + last error,
-- 0078's classification) so one shared pure transition can serve both lanes.
-- Starting at 0 / null is correct rather than backfilled from the sync columns:
-- the existing values are sync health, and copying them across would invent a
-- renewal history that was never observed.
alter table public.agent_calendars
  add column if not exists watch_consecutive_failures int not null default 0,
  add column if not exists watch_last_success_at timestamptz,
  add column if not exists watch_last_error text,
  add column if not exists watch_last_failure_kind text;

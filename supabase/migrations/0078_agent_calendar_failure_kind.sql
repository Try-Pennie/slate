-- #916: classify each calendar sync/watch failure as 'gone' (a definitive 4xx
-- from the delegated-token mint or calendar API: delegation revoked, account
-- removed from the Workspace) vs 'transient' (5xx, timeout, rate limit). Today
-- the diagnostics (0038) count all consecutive failures the same, so a
-- genuinely-broken account and a self-healing blip page ops identically. Persist
-- the last failure's classification so the watch-lapse / sync-failure alerts can
-- page a gone account promptly and back off on a transient one.
--
-- Nullable, no default: null means the last attempt succeeded (or the failure
-- predates this column), which the paging policy treats conservatively as gone
-- so no streak that used to page goes silent. Sibling of 0038.
alter table agent_calendars
  add column if not exists last_failure_kind text;

-- Per-user theme preference, so the choice follows the account across devices
-- (not just this browser's localStorage). 'system' honors the device setting.
alter table users add column theme_preference text not null default 'system'
  check (theme_preference in ('system', 'light', 'dark'));

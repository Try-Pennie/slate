-- Drop the legacy google_credentials table (#290).
--
-- It held per-user OAuth access/refresh tokens from the original Google
-- integration, superseded by domain-wide delegation + agent_calendars. No code
-- under src/ reads or writes it, yet it stored a live refresh_token: a standing
-- secret surface with no consumer. Dropping it removes that surface and the dead
-- parallel calendar-sync path that confused sync audits (#273).
--
-- No table references it via foreign key, so no cascade beyond its own trigger.
drop table if exists google_credentials;

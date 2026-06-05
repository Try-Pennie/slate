-- alert_state (0011) and agent_calendars (0012) were created without enabling
-- RLS, unlike every table in 0001 (which enables RLS = deny-all to API clients,
-- plus one self-read policy on users). Without it, PostgREST's default grants
-- expose these tables to the anon/publishable client — and agent_calendars holds
-- Google watch/sync tokens. Enable RLS so they're deny-all to clients; all
-- server access is via the secret key, which bypasses RLS.
alter table alert_state enable row level security;
alter table agent_calendars enable row level security;

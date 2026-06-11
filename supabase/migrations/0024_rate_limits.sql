-- #31: per-IP rate limiting for the public booking endpoint. PostgREST has no
-- atomic increment, so the whole hit-and-check is one SQL function: a fixed
-- window per key, with the row reused (window resets in place) so the table
-- stays one row per key and needs no cleanup job.
create table rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  count        int not null
);
alter table rate_limits enable row level security;

create or replace function rate_limit_hit(
  p_key text,
  p_window_seconds int,
  p_max int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean;
begin
  insert into rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else r.count + 1
    end,
    window_start = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else r.window_start
    end
  returning count <= p_max into allowed;
  return allowed;
end
$$;

-- Deny-all by default; only the secret-key server client may call it.
revoke execute on function rate_limit_hit(text, int, int) from public, anon, authenticated;

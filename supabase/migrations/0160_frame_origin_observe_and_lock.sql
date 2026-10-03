-- #3137: who frames the booker, and a switch to stop everyone else.
--
-- The booker and every page it moves to inside its frame carried no frame-ancestors,
-- so any site could embed a live booker and anyone with a manage link could put that
-- page under somebody else's clicks. Dan, 2026-10-03: build it in two steps, OBSERVE
-- then LOCK, with the lock a stored admin setting that defaults off and can be turned
-- back off without a deploy. This migration carries both halves' storage.
--
-- 1. frame_origin_daily: one row per (day, framing origin, booker page), counting
--    framed page loads. Written by the middleware through record_frame_origin after
--    the response has gone (src/lib/embed/frame-guard.ts), read by /admin/embedding.
--
--    ORIGINS ONLY. `origin` is scheme, host and port, reduced in code before it gets
--    here, or one of two literals: 'self' (a navigation inside the frame) and
--    'unstated' (nothing readable). Never a path or a query, which on a host page can
--    carry a lead's details. `surface` is a page NAME (book, confirmation, manage...),
--    never an id or a token.
--
--    BOUNDED, because the referrer is whatever the caller sends: anyone can mint a new
--    origin per request. A day holds at most 200 distinct (origin, surface) rows; past
--    that a new one is counted under the origin '(other)', so a flood still shows up
--    as volume without growing the table. Rows older than 90 days are deleted by the
--    first write of each day, so the table needs no lane of its own.
--
--    Not mirrored to Snowflake: it is operational evidence for one decision, not
--    booking history.
--
-- 2. booking_settings.frame_lock_enabled: the lock. NOT NULL DEFAULT false, so a row
--    that predates it, and a database where nobody ever pressed the switch, frames
--    exactly as before (L72). Read by the middleware through a short per isolate cache
--    (src/lib/embed/frame-lock.ts), so a flip lands within seconds.

create table frame_origin_daily (
  day        date        not null,
  origin     text        not null check (char_length(origin) between 1 and 255),
  surface    text        not null
               check (surface in ('book', 'advisor-link', 'confirmation', 'manage', 'rebook', 'other')),
  loads      bigint      not null default 0,
  last_seen  timestamptz not null default now(),
  primary key (day, origin, surface)
);

comment on table frame_origin_daily is
  'The #3137 observation: framed booker page loads per day, framing origin and booker page. Origins only, never a path, query, id or token. Written by record_frame_origin.';

-- Server reads and writes through the secret key admin client; no client access.
alter table frame_origin_daily enable row level security;
revoke all on table frame_origin_daily from anon, authenticated;

create or replace function record_frame_origin(
  p_origin text,
  p_surface text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- The day is read on the database clock that stamps the row, in the business
  -- zone the admin page labels it in.
  v_day    date := (now() at time zone 'America/New_York')::date;
  v_origin text := p_origin;
begin
  update frame_origin_daily
     set loads = loads + 1, last_seen = now()
   where day = v_day and origin = v_origin and surface = p_surface;
  if found then
    return;
  end if;

  -- A new row for the day. The first of each day also clears rows past retention.
  if not exists (select 1 from frame_origin_daily where day = v_day) then
    delete from frame_origin_daily where day < v_day - 90;
  elsif (select count(*) from frame_origin_daily where day = v_day) >= 200 then
    v_origin := '(other)';
  end if;

  insert into frame_origin_daily (day, origin, surface, loads, last_seen)
  values (v_day, v_origin, p_surface, 1, now())
  on conflict (day, origin, surface)
  do update set loads = frame_origin_daily.loads + 1, last_seen = now();
end
$$;

revoke execute on function record_frame_origin(text, text) from public, anon, authenticated;

alter table booking_settings
  add column frame_lock_enabled boolean not null default false;

comment on column booking_settings.frame_lock_enabled is
  'The #3137 frame lock. True gives the booker and every page it moves to inside its frame a frame-ancestors of Slate plus FRAME_ANCESTOR_ALLOW_LIST (src/lib/embed/frame-policy.ts). Off by default; read by the middleware through a 15 second per isolate cache.';

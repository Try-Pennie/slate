-- #3137: who frames the booker, and a switch to stop everyone else.
--
-- The booker and every page it moves to inside its frame carried no frame-ancestors,
-- so any site could embed a live booker and anyone with a manage link could put that
-- page under somebody else's clicks. Dan, 2026-10-03: build it in two steps, OBSERVE
-- then LOCK, with the lock a stored admin setting that defaults off and can be turned
-- back off without a deploy. This migration carries both halves' storage.
--
-- 1. frame_origin_daily: one row per (day, framing origin, booker page), counting
--    framed page loads. Written by the middleware in BATCHES through
--    record_frame_origins (src/lib/embed/frame-observe.ts), read by /admin/embedding.
--
--    ORIGINS ONLY. `origin` is scheme, host and port, reduced in code before it gets
--    here, or one of three literals: 'self' (a navigation inside the frame),
--    'unstated' (nothing readable) and '(other)' (folded past a cap). Never a path or
--    a query, which on a host page can carry a lead's details. `surface` is a page
--    NAME (book, confirmation, manage...), never an id or a token.
--
--    BOUNDED, because the referrer is whatever the caller sends. The middleware batches
--    and folds in memory first, so a flood costs few writes. Here, a day holds at most
--    200 CAPPED (origin, surface) rows; past that a new capped one is counted under
--    '(other)'. A row is capped unless the caller marked it otherwise, which it does
--    only for the fixed set of exact allow list hosts and the three literals, so junk
--    can never push the production site or a listed partner into '(other)'. Rows
--    older than 90 days are deleted by the first write of each day, so the table needs
--    no lane of its own.
--
--    The day boundary is the zone the CALLER passes (BUSINESS_ZONE), so the database
--    and the admin page that reads the rows cannot disagree about which day a load
--    landed on.
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
  capped     boolean     not null default true,
  last_seen  timestamptz not null default now(),
  primary key (day, origin, surface)
);

comment on table frame_origin_daily is
  'The #3137 observation: framed booker page loads per day, framing origin and booker page. Origins only, never a path, query, id or token. Written by record_frame_origins.';

-- Server reads and writes through the secret key admin client; no client access.
alter table frame_origin_daily enable row level security;
revoke all on table frame_origin_daily from anon, authenticated;

create or replace function record_frame_origins(
  p_zone text,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day    date;
  v_origin text;
  r        record;
begin
  if p_zone is null or p_zone = '' then
    raise exception 'record_frame_origins: a zone is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'record_frame_origins: p_rows must be an array';
  end if;
  -- A batch is bounded by the caller's own folding; anything far past it did not
  -- come from the middleware.
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'record_frame_origins: % rows is more than one batch can hold', jsonb_array_length(p_rows);
  end if;

  -- An unknown zone raises here rather than keying rows to a guessed day.
  v_day := (now() at time zone p_zone)::date;

  -- The first write of each day also clears rows past retention.
  if not exists (select 1 from frame_origin_daily where day = v_day) then
    delete from frame_origin_daily where day < v_day - 90;
  end if;

  for r in
    select * from jsonb_to_recordset(p_rows) as x(origin text, surface text, loads bigint, capped boolean)
  loop
    if r.loads is null or r.loads < 1 or r.loads > 1000000 then
      continue;
    end if;
    v_origin := r.origin;

    update frame_origin_daily
       set loads = loads + r.loads, last_seen = now()
     where day = v_day and origin = v_origin and surface = r.surface;
    if found then
      continue;
    end if;

    if coalesce(r.capped, true)
       and (select count(*) from frame_origin_daily where day = v_day and capped) >= 200 then
      v_origin := '(other)';
    end if;

    insert into frame_origin_daily (day, origin, surface, loads, capped, last_seen)
    values (v_day, v_origin, r.surface, r.loads,
            coalesce(r.capped, true) and v_origin <> '(other)', now())
    on conflict (day, origin, surface)
    do update set loads = frame_origin_daily.loads + excluded.loads, last_seen = now();
  end loop;
end
$$;

revoke execute on function record_frame_origins(text, jsonb) from public, anon, authenticated;

alter table booking_settings
  add column frame_lock_enabled boolean not null default false;

comment on column booking_settings.frame_lock_enabled is
  'The #3137 frame lock. True gives the booker and every page it moves to inside its frame a frame-ancestors of Slate plus FRAME_ANCESTOR_ALLOW_LIST (src/lib/embed/frame-policy.ts). Off by default; read by the middleware through a 15 second per isolate cache.';

-- #3027: each advisor's photo, read daily from the Google Workspace directory and
-- kept as bytes so Slate serves it from its own origin.
--
-- WHY A TABLE OF ITS OWN, not a column on users. The roster, the layouts and
-- every lookup read `users`, often with `select("*")`, and a photo is 2 to 20 KB.
-- On its own table the bytes ride only on the two reads that need them: the public
-- photo route (one image by its hash) and the reminder card. A guard
-- (scripts/test-advisor-photo-reads.ts) fails a `select("*")` or an embed of this
-- table anywhere else.
--
-- WHY BASE64 TEXT, not bytea. supabase-js has no bytea support: a Uint8Array is
-- serialised as a JSON object on write, and a read comes back as a hex string. The
-- refresh stores standard base64 and the readers decode it, so bytes in equal
-- bytes out, which scripts/test-advisor-photo-migration.ts pins against this file.
--
-- WHAT A ROW MEANS. A row exists once the directory has been READ for that person.
-- No row means never read, which every surface treats as its own state rather
-- than as "no photo".
--   state 'photo'  the directory holds a photo; the four image columns are set
--   state 'none'   the directory was read and holds no photo (or served Google's
--                  known placeholder); the image columns are null
-- A failed read leaves the row as it was and sets last_error and failing_since.
--
-- ROSTER BOUNDED: one row per user, so it is on the capped read guard's
-- SAFE_TABLES. NOT mirrored to Snowflake: a photo is presentational, holds no
-- booking or lead data, and the warehouse has no question it answers. Rows of
-- deactivated users are deleted by the daily run, and a deleted user's row goes
-- with them (on delete cascade).
create table advisor_photos (
  user_id       uuid primary key references users(id) on delete cascade,
  state         text not null check (state in ('photo', 'none')),
  -- Standard base64 of the image bytes.
  bytes_b64     text,
  -- Taken from the bytes' own signature, never from Google's label.
  mime          text check (mime in ('image/jpeg', 'image/png')),
  -- Lower case hex SHA-256 of the bytes: the photo's public address.
  sha256        text check (sha256 ~ '^[0-9a-f]{64}$'),
  width         integer check (width > 0),
  height        integer check (height > 0),
  -- The last time the directory answered for this person.
  checked_at    timestamptz not null default now(),
  -- The last time the state or the image changed.
  changed_at    timestamptz not null default now(),
  -- The most recent failed read, and when the current run of failures began.
  last_error    text,
  failing_since timestamptz,
  -- The image columns are set exactly when the state is 'photo'.
  constraint advisor_photos_image_iff_photo check (
    (state = 'photo' and bytes_b64 is not null and mime is not null and sha256 is not null)
    or (state = 'none' and bytes_b64 is null and mime is null and sha256 is null)
  )
);

-- The photo route looks a photo up by its hash.
create index advisor_photos_sha256_idx on advisor_photos (sha256);

-- Server reads and writes through the secret key client only. RLS on with no
-- policy denies every client role, and the default privileges migration 0121 set
-- are taken back as well, so the browser roles cannot even see the table.
alter table advisor_photos enable row level security;
revoke all on advisor_photos from anon, authenticated;

comment on table advisor_photos is
  'The #3027 advisor photos: one row per user once the Google directory has been read for them, holding the image as base64 with its hash, or state none. Refreshed daily by the advisor-photos lane; served at /advisor-photo/{sha256}.';

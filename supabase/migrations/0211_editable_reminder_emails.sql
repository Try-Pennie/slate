-- #4296: editable reminder emails, phase 1 of "Editable reminder emails".
--
-- Until now Slate sent two reminder emails whose timing and words lived in code (the 24
-- hour email, #2359, and the 1 hour email, #4282), each with its own record on the
-- booking (`reminder_sent_for` and `reminder_sent_at`, 0128 and 0210, and
-- `hour_reminder_sent_for`, 0210). This adds the tables an admin edits instead, and the
-- one record per booking, email and start that every email shares:
--
-- 1. `reminder_emails`: one row per email. Timing in minutes before the call, from the
--    30 minute minimum (HOUR_REMINDER_MIN_LEAD_MS, src/lib/booking/reminder.ts) to 48
--    hours (Dan's cap, 2026-10-27; REMINDER_EMAIL_MAX_MINUTES there), what a booking made
--    inside the window gets (`send_now` or `skip`), on or off, and `effective_from`,
--    stamped whenever the email is switched on or retimed, so bookings whose window had
--    already opened are skipped rather than all emailed at once. Roster bounded: a
--    handful of rows.
-- 2. `reminder_email_versions`: a snapshot of the COPY (subject, body, the two switches)
--    each time the copy changes, so an admin can see and restore an earlier version.
-- 3. `booking_reminder_sends`: one row per (booking, email, start). The start the email
--    was about is part of the key, so a booking that moves earns a fresh email and keeps
--    the record of the earlier one. The foreign key to the email is ON DELETE RESTRICT:
--    an email that has ever been claimed, sent or skipped for a booking cannot be
--    deleted, which the database enforces rather than the admin page. A GROWTH table,
--    about two rows per booking per email; cascades away with its booking.
--
-- The rules that keep a lead from being emailed twice or out of order are enforced
-- INSIDE `claim_reminder_send`, under a per booking lock, not left to the lane: one
-- claim per key, no claim within the gap after another email about the same start was
-- claimed or sent, and never an email after a SHORTER one about the same start.
--
-- The two emails Slate sends today are seeded so they render exactly as they do now
-- (the phase 2 parity test), and the live bookings' legacy records are copied in so
-- nothing already sent is sent again. The three bookings columns are left untouched:
-- until phase 6 the lane writes both, so a rollback to the old code resends nothing.
--
-- No lead data in any of the three tables: ids, instants, statuses, and email copy
-- written by staff. Not mirrored to Snowflake.
--
-- Additive only, so the code deployed when this is applied keeps working: it names none
-- of these tables or functions.
--
-- Every table is server only, through the secret key client: RLS on with no policy.
-- Every function is SECURITY DEFINER with search_path pinned to public, pg_catalog and
-- calls only pg_catalog built ins (now, btrim, hashtextextended, pg_advisory_xact_lock,
-- jsonb_*), and EXECUTE is revoked from public, anon and authenticated (#1126, #2391).
-- Proved in a real Postgres by scripts/verify-reminder-emails-sql.ts.

create table reminder_emails (
  id                uuid primary key default gen_random_uuid(),
  -- The stable name code and alert keys use (`booking_reminder_failed:<id>:<slug>`).
  -- Never changes once created; `save_reminder_email` refuses a change.
  slug              text not null unique check (slug ~ '^[a-z][a-z0-9_]{0,39}$'),
  name              text not null check (btrim(name) <> ''),
  minutes_before    integer not null check (minutes_before >= 30 and minutes_before <= 2880),
  late_booking      text not null check (late_booking in ('send_now', 'skip')),
  enabled           boolean not null default false,
  effective_from    timestamptz not null default now(),
  subject           text not null check (btrim(subject) <> ''),
  body              text not null check (btrim(body) <> ''),
  card_block        boolean not null default true,
  placeholder_sends boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references users(id) on delete set null
);

alter table reminder_emails enable row level security;

create trigger reminder_emails_updated_at before update on reminder_emails
  for each row execute function set_updated_at();

comment on table reminder_emails is
  '#4296: the reminder emails Slate sends a lead before the call, editable by admins. Written only through save_reminder_email. Server only (default deny RLS).';
comment on column reminder_emails.effective_from is
  'Stamped whenever the email is switched on or its minutes_before changes: a booking whose window opened before this instant is skipped (before_effective), so enabling or retiming never emails a burst.';

create table reminder_email_versions (
  id                uuid primary key default gen_random_uuid(),
  reminder_email_id uuid not null references reminder_emails(id) on delete cascade,
  version           integer not null check (version > 0),
  -- The copy only: subject, body, card_block, placeholder_sends. Restore brings back
  -- the copy, never the timing or on/off.
  snapshot          jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (reminder_email_id, version)
);

alter table reminder_email_versions enable row level security;

comment on table reminder_email_versions is
  '#4296: each version of a reminder email''s copy, written by save_reminder_email when the copy changes. Server only (default deny RLS).';

create table booking_reminder_sends (
  booking_id        uuid not null references bookings(id) on delete cascade,
  -- RESTRICT: an email with any record here cannot be deleted.
  reminder_email_id uuid not null references reminder_emails(id) on delete restrict,
  -- The appointment start the email is ABOUT, so a moved booking earns a fresh one.
  sent_for          timestamptz not null,
  -- claimed: being sent now (taken before Gmail is called, so a crash costs an email
  --   rather than sending a second copy).
  -- sent: Gmail accepted it, at sent_at.
  -- failed: a permanent failure, with its reason.
  -- released: a transient failure gave the claim back; the next tick may claim again.
  -- skipped: never to be sent, with its reason (late_booking, too_close, ...).
  -- legacy_claimed: copied from a bookings column with no send time recorded.
  status            text not null check (status in ('claimed', 'sent', 'failed', 'released', 'skipped', 'legacy_claimed')),
  reason            text,
  -- When this key was last taken, by a claim or a skip; the per email status counts read it.
  claimed_at        timestamptz,
  sent_at           timestamptz,
  primary key (booking_id, reminder_email_id, sent_for),
  check (status <> 'claimed' or claimed_at is not null),
  check (status <> 'sent' or sent_at is not null),
  check (sent_at is null or status = 'sent'),
  check (status not in ('skipped', 'failed') or (reason is not null and btrim(reason) <> ''))
);

alter table booking_reminder_sends enable row level security;

-- The rows for a set of bookings (the lane's worklist embed) read through the primary
-- key, which leads with booking_id. This one serves the per email status counts and the
-- RESTRICT check on deleting an email.
create index booking_reminder_sends_email_claimed_idx
  on booking_reminder_sends (reminder_email_id, claimed_at);

comment on table booking_reminder_sends is
  '#4296: one row per booking, reminder email and appointment start, moved only by claim_reminder_send, mark_reminder_sent, release_reminder_send, fail_reminder_send and skip_reminder_send. Server only (default deny RLS).';

-- ## Seeds: the two emails Slate sends today
--
-- The text is DEFAULT_TEMPLATES in src/lib/booking/reminder-template.ts, which renders
-- byte for byte as the code builders did (the phase 2 parity test). effective_from is
-- the epoch so no existing booking is skipped as before_effective.
insert into reminder_emails (slug, name, minutes_before, late_booking, enabled, effective_from, subject, body, card_block, placeholder_sends)
values
  ('day', '24 hour reminder', 1440, 'send_now', true, '1970-01-01T00:00:00Z',
   $tpl$Your Pennie call {when}$tpl$,
   $tpl$Hi, this is a reminder that {call with} is {when}.

{how we call}

If that time no longer works, you can pick another or cancel here: {manage link}

If it is easier, just reply to this email and it will reach me directly.

{signature}$tpl$,
   true, true),
  ('hour', '1 hour reminder', 60, 'skip', true, '1970-01-01T00:00:00Z',
   $tpl$Your Pennie call is {when}$tpl$,
   $tpl$Hi, this is a reminder that {call with} is {when}.

{how we call}

If that time no longer works, you can pick another or cancel here: {manage link}

If it is easier, just reply to this email and it will reach me directly.

{signature}$tpl$,
   true, true)
on conflict (slug) do nothing;

insert into reminder_email_versions (reminder_email_id, version, snapshot)
select id, 1, jsonb_build_object('subject', subject, 'body', body, 'card_block', card_block, 'placeholder_sends', placeholder_sends)
  from reminder_emails
 where slug in ('day', 'hour')
on conflict (reminder_email_id, version) do nothing;

-- ## Backfill: what live bookings were already sent
--
-- For every live booking still ahead (confirmed or rescheduled, starting after now):
-- a 24 hour record with its send time becomes `sent`; a 24 hour record without one, and
-- every 1 hour record, becomes `legacy_claimed` with sent_at null. sent_for is the start
-- the record was about, which for a booking that moved is its earlier start. The counts
-- are asserted against the bookings they came from inside the same transaction, so a
-- surprise rolls the whole migration back.
do $$
declare
  n_day_sent     integer;
  n_day_legacy   integer;
  n_hour_legacy  integer;
  v_day_expected integer;
  v_hour_expected integer;
begin
  insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, claimed_at, sent_at)
  select b.id, e.id, b.reminder_sent_for, 'sent', b.reminder_sent_at, b.reminder_sent_at
    from bookings b
    join reminder_emails e on e.slug = 'day'
   where b.status in ('confirmed', 'rescheduled')
     and b.starts_at > now()
     and b.reminder_sent_for is not null
     and b.reminder_sent_at is not null
  on conflict do nothing;
  get diagnostics n_day_sent = row_count;

  insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status)
  select b.id, e.id, b.reminder_sent_for, 'legacy_claimed'
    from bookings b
    join reminder_emails e on e.slug = 'day'
   where b.status in ('confirmed', 'rescheduled')
     and b.starts_at > now()
     and b.reminder_sent_for is not null
     and b.reminder_sent_at is null
  on conflict do nothing;
  get diagnostics n_day_legacy = row_count;

  insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status)
  select b.id, e.id, b.hour_reminder_sent_for, 'legacy_claimed'
    from bookings b
    join reminder_emails e on e.slug = 'hour'
   where b.status in ('confirmed', 'rescheduled')
     and b.starts_at > now()
     and b.hour_reminder_sent_for is not null
  on conflict do nothing;
  get diagnostics n_hour_legacy = row_count;

  select count(*) into v_day_expected
    from bookings
   where status in ('confirmed', 'rescheduled') and starts_at > now() and reminder_sent_for is not null;
  select count(*) into v_hour_expected
    from bookings
   where status in ('confirmed', 'rescheduled') and starts_at > now() and hour_reminder_sent_for is not null;

  if n_day_sent + n_day_legacy <> v_day_expected or n_hour_legacy <> v_hour_expected then
    raise exception 'booking_reminder_sends backfill: expected % 24 hour and % 1 hour rows, wrote % sent + % legacy_claimed and % legacy_claimed',
      v_day_expected, v_hour_expected, n_day_sent, n_day_legacy, n_hour_legacy;
  end if;

  raise notice 'booking_reminder_sends backfill: 24 hour % sent and % legacy_claimed, 1 hour % legacy_claimed',
    n_day_sent, n_day_legacy, n_hour_legacy;
end;
$$;

-- ## save_reminder_email: the one write of an email
--
-- Create (p_id null) or update one email. An update lands only when the row still holds
-- the updated_at the editor loaded; otherwise it answers {status: stale} and writes
-- nothing, and the caller refuses the save. An id that does not exist answers
-- {status: missing}. On success it answers {status: saved, id, updated_at,
-- effective_from, version, action}; version is the new copy version, or null when the
-- copy did not change.
--
-- effective_from is stamped now() when enabled turns on or minutes_before changes, and
-- kept otherwise. A copy version is written on create and whenever the copy differs
-- from what the row held. The audit row, with only the fields that changed, old and new,
-- is inserted in the same transaction; 0160's trigger computes its hash.
--
-- p_restored_from_version names the version whose copy is being restored: the copy sent
-- must equal that version's snapshot, and the name, timing, late booking choice and
-- on/off must equal the row's, or it raises. Restore brings back the copy only.
--
-- The action is derived, not passed: created, restored, toggled (only enabled changed)
-- or updated.
create or replace function save_reminder_email(
  p_id                     uuid,
  p_loaded_updated_at      timestamptz,
  p_slug                   text,
  p_name                   text,
  p_minutes_before         integer,
  p_late_booking           text,
  p_enabled                boolean,
  p_subject                text,
  p_body                   text,
  p_card_block             boolean,
  p_placeholder_sends      boolean,
  p_restored_from_version  integer,
  p_actor_id               uuid,
  p_org_id                 uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_old          reminder_emails%rowtype;
  v_new          reminder_emails%rowtype;
  v_new_copy     jsonb;
  v_old_copy     jsonb;
  v_snapshot     jsonb;
  v_old_fields   jsonb;
  v_new_fields   jsonb;
  v_changed_old  jsonb;
  v_changed_new  jsonb;
  v_version      integer;
  v_action       text;
  v_effective    timestamptz;
begin
  v_new_copy := jsonb_build_object(
    'subject', p_subject, 'body', p_body,
    'card_block', p_card_block, 'placeholder_sends', p_placeholder_sends);

  if p_id is null then
    if p_restored_from_version is not null then
      raise exception 'save_reminder_email: a new email has no version to restore';
    end if;
    insert into reminder_emails (slug, name, minutes_before, late_booking, enabled, subject, body, card_block, placeholder_sends, updated_by)
    values (p_slug, p_name, p_minutes_before, p_late_booking, p_enabled, p_subject, p_body, p_card_block, p_placeholder_sends, p_actor_id)
    returning * into v_new;
    v_version := 1;
    insert into reminder_email_versions (reminder_email_id, version, snapshot, created_by)
    values (v_new.id, v_version, v_new_copy, p_actor_id);
    v_action := 'reminder_email.created';
    v_changed_old := null;
    v_changed_new := jsonb_build_object(
      'name', v_new.name, 'minutes_before', v_new.minutes_before, 'late_booking', v_new.late_booking,
      'enabled', v_new.enabled, 'subject', v_new.subject, 'body', v_new.body,
      'card_block', v_new.card_block, 'placeholder_sends', v_new.placeholder_sends);
  else
    select * into v_old from reminder_emails where id = p_id for update;
    if not found then
      return jsonb_build_object('status', 'missing', 'id', p_id);
    end if;
    if v_old.updated_at is distinct from p_loaded_updated_at then
      return jsonb_build_object('status', 'stale', 'id', p_id, 'updated_at', v_old.updated_at);
    end if;
    if p_slug is distinct from v_old.slug then
      raise exception 'save_reminder_email: an email''s slug never changes (email % is %, not %)', p_id, v_old.slug, p_slug;
    end if;

    if p_restored_from_version is not null then
      select snapshot into v_snapshot
        from reminder_email_versions
       where reminder_email_id = p_id and version = p_restored_from_version;
      if not found then
        raise exception 'save_reminder_email: email % has no version %', p_id, p_restored_from_version;
      end if;
      if v_snapshot is distinct from v_new_copy then
        raise exception 'save_reminder_email: the copy sent does not match version % of email %', p_restored_from_version, p_id;
      end if;
      if (p_name, p_minutes_before, p_late_booking, p_enabled)
           is distinct from (v_old.name, v_old.minutes_before, v_old.late_booking, v_old.enabled) then
        raise exception 'save_reminder_email: a restore brings back the copy only, never the name, timing, late booking choice or on/off';
      end if;
    end if;

    v_effective := case
      when (p_enabled and not v_old.enabled) or p_minutes_before is distinct from v_old.minutes_before then now()
      else v_old.effective_from
    end;

    update reminder_emails
       set name = p_name,
           minutes_before = p_minutes_before,
           late_booking = p_late_booking,
           enabled = p_enabled,
           effective_from = v_effective,
           subject = p_subject,
           body = p_body,
           card_block = p_card_block,
           placeholder_sends = p_placeholder_sends,
           updated_by = p_actor_id
     where id = p_id
    returning * into v_new;

    v_old_copy := jsonb_build_object(
      'subject', v_old.subject, 'body', v_old.body,
      'card_block', v_old.card_block, 'placeholder_sends', v_old.placeholder_sends);
    if v_old_copy is distinct from v_new_copy then
      select coalesce(max(version), 0) + 1 into v_version
        from reminder_email_versions where reminder_email_id = p_id;
      insert into reminder_email_versions (reminder_email_id, version, snapshot, created_by)
      values (p_id, v_version, v_new_copy, p_actor_id);
    else
      v_version := null;
    end if;

    v_old_fields := jsonb_build_object(
      'name', v_old.name, 'minutes_before', v_old.minutes_before, 'late_booking', v_old.late_booking,
      'enabled', v_old.enabled, 'subject', v_old.subject, 'body', v_old.body,
      'card_block', v_old.card_block, 'placeholder_sends', v_old.placeholder_sends);
    v_new_fields := jsonb_build_object(
      'name', v_new.name, 'minutes_before', v_new.minutes_before, 'late_booking', v_new.late_booking,
      'enabled', v_new.enabled, 'subject', v_new.subject, 'body', v_new.body,
      'card_block', v_new.card_block, 'placeholder_sends', v_new.placeholder_sends);
    select coalesce(jsonb_object_agg(o.key, o.value), '{}'::jsonb) into v_changed_old
      from jsonb_each(v_old_fields) o where o.value is distinct from v_new_fields -> o.key;
    select coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb) into v_changed_new
      from jsonb_each(v_new_fields) n where n.value is distinct from v_old_fields -> n.key;

    v_action := case
      when p_restored_from_version is not null then 'reminder_email.restored'
      when v_changed_new = jsonb_build_object('enabled', v_new.enabled) then 'reminder_email.toggled'
      else 'reminder_email.updated'
    end;
  end if;

  insert into audit_log (org_id, actor_id, action, target_id, details)
  values (
    p_org_id,
    p_actor_id,
    v_action,
    null,
    jsonb_build_object(
      'reminder_email_id', v_new.id,
      'slug', v_new.slug,
      'old', v_changed_old,
      'new', v_changed_new,
      'version', v_version,
      'effective_from', v_new.effective_from
    ) || case
      when p_restored_from_version is not null then jsonb_build_object('restored_from_version', p_restored_from_version)
      else '{}'::jsonb
    end
  );

  return jsonb_build_object(
    'status', 'saved',
    'id', v_new.id,
    'updated_at', v_new.updated_at,
    'effective_from', v_new.effective_from,
    'version', v_version,
    'action', v_action
  );
end;
$$;

revoke execute on function save_reminder_email(uuid, timestamptz, text, text, integer, text, boolean, text, text, boolean, boolean, integer, uuid, uuid)
  from public, anon, authenticated;

-- ## claim_reminder_send: take one email for one booking and start, or say why not
--
-- Answers one of:
--   claimed     this caller holds the claim and may send.
--   taken       this key already has a row that is not released (claimed, sent,
--               failed, skipped or legacy_claimed).
--   superseded  an email with a SHORTER minutes_before is claimed, sent or
--               legacy_claimed about this start, so this one would arrive after it.
--               Permanent: the lane records a skip.
--   gap         another email about this start was claimed, or sent, less than p_gap
--               ago. A wait, re-judged next tick, never stored. A send with no
--               recorded time (legacy_claimed) never starts a gap.
--
-- A released row for the key is reopened as the claim. Every check and the write run
-- under a transaction advisory lock keyed on the booking, so two lanes claiming for one
-- booking at once are serialised: the second waits, then reads the first's committed
-- claim (each statement of a plpgsql function takes a fresh snapshot under READ
-- COMMITTED, the PostgREST default). The lock leaves the bookings row alone, so a claim
-- never waits on a reschedule or the reverse.
create or replace function claim_reminder_send(
  p_booking_id         uuid,
  p_reminder_email_id  uuid,
  p_sent_for           timestamptz,
  p_gap                interval
) returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_minutes integer;
begin
  if p_booking_id is null or p_reminder_email_id is null or p_sent_for is null or p_gap is null then
    raise exception 'claim_reminder_send: booking, email, start and gap are all required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('booking_reminder_sends:' || p_booking_id::text, 0));

  select minutes_before into v_minutes from reminder_emails where id = p_reminder_email_id;
  if not found then
    raise exception 'claim_reminder_send: no reminder email %', p_reminder_email_id;
  end if;

  if exists (
    select 1 from booking_reminder_sends
     where booking_id = p_booking_id and reminder_email_id = p_reminder_email_id
       and sent_for = p_sent_for and status <> 'released'
  ) then
    return 'taken';
  end if;

  if exists (
    select 1
      from booking_reminder_sends s
      join reminder_emails e on e.id = s.reminder_email_id
     where s.booking_id = p_booking_id
       and s.sent_for = p_sent_for
       and s.reminder_email_id <> p_reminder_email_id
       and e.minutes_before < v_minutes
       and s.status in ('sent', 'claimed', 'legacy_claimed')
  ) then
    return 'superseded';
  end if;

  if exists (
    select 1
      from booking_reminder_sends s
     where s.booking_id = p_booking_id
       and s.sent_for = p_sent_for
       and s.reminder_email_id <> p_reminder_email_id
       and ((s.status = 'claimed' and s.claimed_at > now() - p_gap)
         or (s.status = 'sent' and s.sent_at > now() - p_gap))
  ) then
    return 'gap';
  end if;

  insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, claimed_at)
  values (p_booking_id, p_reminder_email_id, p_sent_for, 'claimed', now())
  on conflict (booking_id, reminder_email_id, sent_for) do update
     set status = 'claimed', reason = null, claimed_at = now(), sent_at = null
   where booking_reminder_sends.status = 'released';
  if found then
    return 'claimed';
  end if;
  return 'taken';
end;
$$;

revoke execute on function claim_reminder_send(uuid, uuid, timestamptz, interval)
  from public, anon, authenticated;

-- ## mark_reminder_sent: Gmail accepted it. claimed to sent, only from claimed.
create or replace function mark_reminder_sent(
  p_booking_id         uuid,
  p_reminder_email_id  uuid,
  p_sent_for           timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update booking_reminder_sends
     set status = 'sent', sent_at = now()
   where booking_id = p_booking_id and reminder_email_id = p_reminder_email_id
     and sent_for = p_sent_for and status = 'claimed';
  return found;
end;
$$;

revoke execute on function mark_reminder_sent(uuid, uuid, timestamptz)
  from public, anon, authenticated;

-- ## release_reminder_send: a transient failure gives the claim back. claimed to
-- released, only from claimed; the next tick may claim the key again.
create or replace function release_reminder_send(
  p_booking_id         uuid,
  p_reminder_email_id  uuid,
  p_sent_for           timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update booking_reminder_sends
     set status = 'released'
   where booking_id = p_booking_id and reminder_email_id = p_reminder_email_id
     and sent_for = p_sent_for and status = 'claimed';
  return found;
end;
$$;

revoke execute on function release_reminder_send(uuid, uuid, timestamptz)
  from public, anon, authenticated;

-- ## fail_reminder_send: a permanent failure. claimed to failed with its reason, only
-- from claimed. A reason is required.
create or replace function fail_reminder_send(
  p_booking_id         uuid,
  p_reminder_email_id  uuid,
  p_sent_for           timestamptz,
  p_reason             text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'fail_reminder_send: a failure needs a reason';
  end if;
  update booking_reminder_sends
     set status = 'failed', reason = p_reason
   where booking_id = p_booking_id and reminder_email_id = p_reminder_email_id
     and sent_for = p_sent_for and status = 'claimed';
  return found;
end;
$$;

revoke execute on function fail_reminder_send(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;

-- ## skip_reminder_send: this email will never be sent for this booking and start, and
-- why. Inserts a skipped row; a key that already has a row is left as it is, except a
-- released one, which becomes the skip (a claim given back that will not be retried,
-- such as one now too close to the call). Answers whether it wrote. A reason is required.
create or replace function skip_reminder_send(
  p_booking_id         uuid,
  p_reminder_email_id  uuid,
  p_sent_for           timestamptz,
  p_reason             text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'skip_reminder_send: a skip needs a reason';
  end if;
  insert into booking_reminder_sends (booking_id, reminder_email_id, sent_for, status, reason, claimed_at)
  values (p_booking_id, p_reminder_email_id, p_sent_for, 'skipped', p_reason, now())
  on conflict (booking_id, reminder_email_id, sent_for) do update
     set status = 'skipped', reason = excluded.reason, claimed_at = now(), sent_at = null
   where booking_reminder_sends.status = 'released';
  return found;
end;
$$;

revoke execute on function skip_reminder_send(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;

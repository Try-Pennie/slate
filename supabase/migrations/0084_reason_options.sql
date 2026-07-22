-- #346: org-configurable reschedule/cancel/reassign reason options. The three
-- reason lists were compiled constants (RESCHEDULE_REASONS / CANCEL_REASONS /
-- REASSIGN_REASONS in src/lib/booking/core.ts); the codes are the STABLE analytics
-- taxonomy behind the show-rate driver work (#325), so changing them required a
-- code deploy. This moves them into an admin-editable store read at runtime, with
-- precedence store > coded default (an empty/unreadable store degrades to the
-- built-in lists, so booking flows never break on config).
--
-- Global (no org_id): Slate is single-org, matching the monitor_settings (0060)
-- precedent. Codes are immutable once created and NEVER repurposed; retiring is
-- soft (active=false) so historical booking_events still render a real label.
-- `locked` marks system rows an admin may not rename/retire/reorder off: 'other'
-- (the free-text escape hatch wired into validateReason) on every action, and
-- 'owner_reassignment' (the code the automated reassign path emits) on reassign.
create table reason_options (
  action     text not null check (action in ('reschedule', 'cancel', 'reassign')),
  code       text not null,
  label      text not null,
  sort_order integer not null,
  active     boolean not null default true,
  locked     boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  primary key (action, code)
);

-- Server reads/writes via the secret-key admin client; no client access.
alter table reason_options enable row level security;

-- Seed today's exact options (matching core.ts) so behavior is unchanged on
-- deploy until an admin edits. sort_order = the current array index.
insert into reason_options (action, code, label, sort_order, active, locked) values
  ('reschedule', 'schedule_conflict',    'Schedule conflict',          0, true, false),
  ('reschedule', 'found_better_time',    'Found a better time',        1, true, false),
  ('reschedule', 'need_more_prep',       'Need more time to prepare',  2, true, false),
  ('reschedule', 'other',                'Other',                      3, true, true),
  ('cancel',     'no_longer_interested', 'No longer interested',       0, true, false),
  ('cancel',     'got_help_elsewhere',   'Already got help elsewhere', 1, true, false),
  ('cancel',     'booked_by_mistake',    'Booked by mistake',          2, true, false),
  ('cancel',     'schedule_conflict',    'Schedule conflict',          3, true, false),
  ('cancel',     'other',                'Other',                      4, true, true),
  ('reassign',   'owner_reassignment',   'Owner reassignment',         0, true, true),
  ('reassign',   'coverage',             'Coverage (agent unavailable)', 1, true, false),
  ('reassign',   'escalation',           'Escalation',                 2, true, false),
  ('reassign',   'other',                'Other',                      3, true, true);

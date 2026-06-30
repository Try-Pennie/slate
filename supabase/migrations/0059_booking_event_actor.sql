-- #549: record WHICH staff user performed an admin-initiated reschedule/cancel.
-- booking_events already records the initiator TYPE (customer/admin/system); this
-- adds the specific accountable user. Nullable: existing rows + customer/system
-- actions have no staff actor. `on delete set null` so deactivating/removing a
-- user never breaks the immutable history (mirrors from/to_agent_user_id).
alter table booking_events
  add column actor_user_id    uuid references users(id) on delete set null,
  -- When an admin acts via impersonation, actor_user_id is the REAL admin and this
  -- is the user they acted AS; null when not impersonating.
  add column acting_as_user_id uuid references users(id) on delete set null;

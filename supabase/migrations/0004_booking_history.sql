-- Decouple bookings from users so history survives agent deletion.
-- Snapshot the agent's identity onto the booking, and SET NULL the FK on delete.

alter table bookings add column agent_name text;
alter table bookings add column agent_email text;

-- Backfill existing bookings from their current agent.
update bookings b
set agent_name = u.name, agent_email = u.email
from users u
where u.id = b.assigned_user_id;

-- Allow the agent link to be cleared without deleting the booking.
alter table bookings alter column assigned_user_id drop not null;
alter table bookings drop constraint bookings_assigned_user_id_fkey;
alter table bookings add constraint bookings_assigned_user_id_fkey
  foreign key (assigned_user_id) references users(id) on delete set null;

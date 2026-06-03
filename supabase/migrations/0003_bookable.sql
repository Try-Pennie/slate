-- Bookable flag: gates whether an agent enters any bucket's round-robin pool.
-- Existing agents default true (keeps current routing working); the Salesforce
-- sync inserts new/synced agents as bookable=false so a new hire created in SF
-- syncs into Slate but can't receive bookings until an admin toggles them on.
alter table users add column bookable boolean not null default true;

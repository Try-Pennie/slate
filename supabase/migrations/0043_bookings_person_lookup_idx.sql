-- Indexes for the direct booking API's person-lookup (#365). Without these,
-- findActiveBookingsForPerson (#357) scans the whole bookings table on every
-- API booking — fine now, but it degrades as the table grows (~200 agents,
-- ~2000 bookings/day). All partial on ACTIVE rows, matching the lookup's
-- `status in ('confirmed','rescheduled')` filter, so the indexes stay small.
-- external_id is already covered by bookings_external_id_active_idx (0042).

create index if not exists bookings_salesforce_active_idx
  on bookings (salesforce_id)
  where salesforce_id is not null and status in ('confirmed', 'rescheduled');

create index if not exists bookings_attendee_phone_active_idx
  on bookings (attendee_phone)
  where attendee_phone is not null and status in ('confirmed', 'rescheduled');

-- attendee_email is matched case-insensitively (ilike), which a btree can't
-- serve — a trigram GIN index lets the planner use it for the ilike lookup.
create extension if not exists pg_trgm;

create index if not exists bookings_attendee_email_active_trgm_idx
  on bookings using gin (attendee_email gin_trgm_ops)
  where attendee_email is not null and status in ('confirmed', 'rescheduled');

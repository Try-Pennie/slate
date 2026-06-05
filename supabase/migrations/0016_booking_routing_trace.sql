-- How a booking routed, for troubleshooting: the bucket, the agents considered
-- (free + least-recently-booked order), the chosen agent, and whether a
-- fallback was used. JSONB and nullable; populated at booking time.
alter table bookings add column if not exists routing_trace jsonb;

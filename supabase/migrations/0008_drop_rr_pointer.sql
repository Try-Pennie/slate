-- Round-robin no longer uses a mutable pointer. Candidate order is now derived
-- at assignment time from booking history (least-recently-booked first), which
-- is fair under concurrency and immune to the reschedule double-count the
-- pointer had. Drop the now-unused column.
alter table buckets drop column if exists rr_last_assigned_user_id;

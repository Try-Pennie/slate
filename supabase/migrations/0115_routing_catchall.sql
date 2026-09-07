-- #1908: record when a lead's routing code was blank or unreadable and the
-- catch-all sent them to the Low pool.
--
-- WHY A COLUMN AND NOT AN INFERENCE. A rescued lead and a lead who genuinely
-- carries the Low code land in the SAME bucket, so `bucket_code` cannot tell them
-- apart, and 100 is one of the most used real codes on the roster. Without this
-- the rate is unmeasurable, which is how cal.com came to be carrying roughly 2
-- percent of all bookings through its own catch-all with nobody knowing.
--
-- `requested_code` is what the lead's link actually carried, kept verbatim: it is
-- the only evidence of what the upstream page sent, and it separates a blank
-- field from a mangled code at the point somebody is chasing the cause. NULL
-- means the caller did not say (an older embed), which is deliberately different
-- from an empty string, which means the lead arrived with no code at all.

alter table routing_decisions
  add column if not exists requested_code text,
  add column if not exists catchall_applied boolean not null default false;

comment on column routing_decisions.requested_code is
  'The xbc the lead''s link carried, verbatim. NULL = the caller did not say; empty string = the lead arrived with no code (#1908).';
comment on column routing_decisions.catchall_applied is
  'True when a blank or unreadable code was routed to the Low pool (#1908). Distinguishes a rescued lead from one who genuinely asked for Low, since both land in the same bucket.';

-- The alert counts rescued bookings over a recent window, so the index matches
-- that query rather than the column alone. Partial, because the rows it serves
-- are a small minority and a full index would be mostly dead weight on a table
-- that takes a row per booking.
create index if not exists routing_decisions_catchall_idx
  on routing_decisions (created_at desc)
  where catchall_applied;

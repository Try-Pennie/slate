-- #2115: link a coverage sweep to the Twilio redistribute flip that caused it, and
-- make enqueuing one safe to run twice.
--
-- Taking an agent out of the bookable pool strands whatever they already have
-- booked. The admin toggle asks a person to confirm before doing it (#1215), and
-- the offboarding automation enqueues the sweep itself (#1241). The hourly Twilio
-- flip (#2097) does the same pool exit with nobody to ask, so it takes the sweep
-- too, on Dan's call (2026-09-09).
--
-- It is harmless today and will not stay that way. Measured 2026-09-09, right
-- after the first live run turned twelve agents not bookable: zero of them held an
-- upcoming booking, because cal.com is still taking every lead during the parallel
-- run. After cutover (#65) Slate holds the real book, and somebody tagged
-- Redistribute mid week would have their remaining appointments silently left with
-- an agent who can no longer be routed to.
--
-- A THIRD nullable cause column rather than one shared "source" column, for the
-- same reason 0107 was a second one: each names the exact record that explains the
-- sweep, which is what the coverage panel needs in order to say why a sweep exists.
--
-- The value is the moment Slate marked them, stored on the agent's own
-- `attributes.redistribute_at` in the SAME write as the mark. That stamp is both
-- the window start (everything still ahead of the moment they left the pool) and
-- half the key, and it is READ BACK rather than minted per run: the flip writes the
-- mark first, then enqueues, then flips, so a run that dies anywhere in between
-- leaves a marked and still bookable agent whom the next hour plans again, reads
-- the same stamp from, and converges onto this one job. A key derived from "now"
-- would mint a new one every hour and this index would never fire.
--
-- Coming back off redistribute clears the stamp with the mark, so a later flip is a
-- DIFFERENT pool exit with its own stamp and correctly gets its own sweep rather
-- than colliding with a months-old one.
alter table bulk_reassign_jobs
  add column redistribute_marked_at timestamptz;

-- The idempotency key. Both columns are non-null inside the partial, so like 0107
-- and unlike 0095 there is no NULL-never-equals-NULL hole needing a second index.
--
-- Partial (WHERE NOT NULL) so every other sweep is unaffected: many NULLs are
-- permitted. A partial unique index cannot back an ON CONFLICT clause, so the code
-- inserts and handles 23505, then re-snapshots into the existing job rather than
-- merely refusing the duplicate (a refusal would strand a half-written job, #1235).
create unique index bulk_reassign_jobs_redistribute_idx
  on bulk_reassign_jobs (out_user_id, redistribute_marked_at)
  where redistribute_marked_at is not null;

comment on column bulk_reassign_jobs.redistribute_marked_at is
  'The Twilio redistribute pool exit this sweep covers (#2115): the moment the hourly roster sync marked the agent, stored on users.attributes.redistribute_at in the same write. NULL for a sweep a person started, one an approved time-off request caused, or one an offboarding caused. Unique per (agent, mark), so a retried or crashed sync converges on one sweep. Also the record of WHY the job has no created_by: a redistribute sweep has no human actor and its moves are recorded as system-initiated.';

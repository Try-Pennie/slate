-- #1235: link a coverage sweep to the time-off request that caused it, and make
-- enqueuing one safe to run twice.
--
-- Approving time off will enqueue a coverage sweep (#1237). That enqueue sits in
-- runPostApproval, which is retried by the admin retry path and can be re-entered
-- after a crash, so it needs an idempotency key the DATABASE enforces rather than
-- ordering in application code.
--
-- The link lives on the job, not on ooo_requests, so the request table needs no
-- change and the lookup is one indexed read. It also gives the admin coverage
-- panel a way to say WHY a sweep exists.
--
-- ON DELETE SET NULL, not CASCADE: the sweep is a record of customer appointments
-- that moved. It must outlive the request that triggered it, exactly as
-- bulk_reassign_items uses a NO ACTION FK to bookings.
alter table bulk_reassign_jobs
  add column ooo_request_id uuid references ooo_requests(id) on delete set null;

-- The idempotency key. Keyed on the WINDOW as well as the request, deliberately:
-- modifyOoo on an approved request clears its side effects and returns it to
-- pending, and validateWindow does not require the window to have changed, so a
-- re-approval can legitimately need a sweep for a DIFFERENT window. Keying on the
-- request alone would refuse that second, correct sweep.
--
-- Partial (WHERE NOT NULL) so the admin-initiated sweeps, which have no request,
-- are unaffected: many NULLs are permitted. Note a partial unique index cannot
-- back an ON CONFLICT clause, so the code inserts and handles 23505, then
-- re-snapshots into the existing job rather than merely refusing the duplicate
-- (a refusal would strand a half-written job forever).
create unique index bulk_reassign_jobs_ooo_request_window_idx
  on bulk_reassign_jobs (ooo_request_id, range_start, range_end)
  where ooo_request_id is not null;

-- range_end is nullable (an open-ended sweep), and NULL never equals NULL in a
-- unique index, so the index above would let two open-ended sweeps for the same
-- request both exist. This second index closes that hole for exactly that shape.
create unique index bulk_reassign_jobs_ooo_request_open_ended_idx
  on bulk_reassign_jobs (ooo_request_id, range_start)
  where ooo_request_id is not null and range_end is null;

-- The reverse lookup the admin panel uses: which sweep came from this request.
create index bulk_reassign_jobs_ooo_request_idx
  on bulk_reassign_jobs (ooo_request_id)
  where ooo_request_id is not null;

comment on column bulk_reassign_jobs.ooo_request_id is
  'The approved time-off request that triggered this sweep (#1235). NULL for an admin-initiated sweep. Unique per (request, window) so a re-approval of a changed window may sweep again, but the same window can never be swept twice.';

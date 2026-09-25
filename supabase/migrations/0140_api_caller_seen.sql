-- #2717: which host each booking API caller has authenticated from, and when.
--
-- trypennie's confirmed page reads every Slate booking with its own key (#2645). If
-- that key is missing from their production environment every pilot booking ends on
-- their not found page, and before this the only way to know was to ask them. Slate
-- already attributes every authenticated request to a caller; this keeps the last
-- one as a fact `pnpm verify:parallel-run-readiness` and the admin console can read.
--
-- ONE ROW PER (caller, host_kind), not per caller, so a localhost test cannot
-- overwrite the production call it came after. Bounded at four callers times four
-- kinds, sixteen rows, so it is roster bounded and never needs paging.
--
-- Written by the booking API's authorizer on a caller's first success from a host
-- kind and refreshed at most once an hour per isolate after that, deferred past the
-- response (src/lib/booking/caller-seen.ts). A failed write is logged and never
-- reaches the request.
--
-- host_kind's CHECK is held equal to CALLER_HOST_KINDS by
-- scripts/test-caller-seen.ts. `origin` is scheme, host and port only, never a path
-- or query, and null when the request named no readable host.
--
-- Not mirrored to Snowflake: it is operational state about our own integrations,
-- not booking history.

create table api_caller_seen (
  caller        text        not null,
  host_kind     text        not null
                 check (host_kind in ('production', 'localhost', 'other-host', 'unstated')),
  last_seen_at  timestamptz not null,
  method        text        not null,
  origin        text,
  primary key (caller, host_kind)
);

-- Server reads and writes through the secret key admin client; no client access.
alter table api_caller_seen enable row level security;

-- ============================================================================
-- Snowflake Setup: Slate archival mirror (milestone #15, discussion #1095)
-- ============================================================================
-- Run this ONCE in a Snowsight worksheet under ACCOUNTADMIN before the export
-- lane fires. It provisions the warehouse, database, schema, the steady-state
-- append-only role, the service user (key-pair auth), the six mirrored tables,
-- and the grants. Idempotent: safe to re-run (CREATE ... IF NOT EXISTS / CREATE
-- OR REPLACE where a re-run must not drop data).
--
-- Companion runbook (the human, copy-paste-once steps incl. the RSA key-pair and
-- the Worker secrets): docs/snowflake-setup.md. Read that first.
--
-- Design (from the converged plan):
--   * Steady-state role SLATE_ROLE gets USAGE + SELECT + INSERT + UPDATE on the
--     mirror tables, and deliberately NO DELETE / NO TRUNCATE. The export lane
--     uses MERGE-by-id, which needs UPDATE to refresh the current snapshot of a
--     mutable row (bookings, webhook_deliveries, booking_outbox) but never needs
--     to destroy a row. Withholding DELETE is what makes a compromised Slate
--     Worker unable to rewrite or erase warehouse history: tamper-evidence moves
--     here from the Supabase append-only triggers (migration 0089, #1040).
--   * DSR erasure (Phase 7, #1103) is the ONLY path that removes warehouse rows.
--     It runs as a separate privileged operator step, NOT with a standing Worker
--     credential, so no always-on DELETE key exists. Its provisioning lives in
--     the Phase 7 runbook, not here.
--   * Tables are created here by ACCOUNTADMIN, never by Slate at runtime, so the
--     runtime role also cannot CREATE or DROP tables.
-- ============================================================================

USE ROLE ACCOUNTADMIN;

-- ----------------------------------------------------------------------------
-- Warehouse: extra-small, auto-suspend fast (the export lane runs in short
-- bursts on a cron; an idle warehouse should cost nothing).
-- ----------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS SLATE_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 30            -- seconds idle before suspend (#4349)
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  STATEMENT_TIMEOUT_IN_SECONDS = 600
  COMMENT = 'Slate archival mirror export lane (milestone #15).';

-- ----------------------------------------------------------------------------
-- Spend guard (#3125, decided by Dan 2026-10-03). Two parts:
--
--   1. A statement timeout of 600 seconds, so a query that runs away is cut off
--      rather than billed by the minute. Nothing Slate runs comes near it: the
--      Worker's own CPU limit ends every lane long before ten minutes. The ALTER
--      is here as well as on the CREATE above because CREATE ... IF NOT EXISTS does
--      nothing on a warehouse that already exists.
--
--   2. A monthly resource monitor that WARNS ONLY: notify at 75% and at 100%, and
--      NEVER suspend. Suspending the warehouse would stop the 30 minute booking
--      mirror, and that mirror is the booking backup (the prune lanes redact only
--      what it has confirmed), so a spend cap must never be able to switch it off.
--      NOTIFY emails the account administrators who have email notifications
--      turned on in their Snowsight profile.
--
-- The monitor is RM_SLATE: 100 credits a month, attached by the data team and
-- kept by Dan on 2026-10-28 (DEPLOY.md, "Spend and usage alerts", Snowflake, has
-- the measurement). It is in the block marked "RUN IN SNOWSIGHT" at the END of
-- this file. To change the quota later:
-- ALTER RESOURCE MONITOR RM_SLATE SET CREDIT_QUOTA = <quota>;
--
-- The warehouse is Gen1 (2026-10-28). Every Slate statement is a short MERGE,
-- DELETE or SELECT, where Gen2's speed buys nothing and Gen1 bills about a
-- quarter less. GENERATION = '1' is the form the data team ran on this account
-- on 2026-10-28; SHOW WAREHOUSES then read resource_constraint STANDARD_GEN_1.
-- The ALTER, like the timeout's, is what reaches a warehouse that already exists.
-- ----------------------------------------------------------------------------
ALTER WAREHOUSE IF EXISTS SLATE_WH SET STATEMENT_TIMEOUT_IN_SECONDS = 600;
ALTER WAREHOUSE IF EXISTS SLATE_WH SET GENERATION = '1';
-- Every export run resumes the warehouse, billed a minute minimum, and it then
-- idled 60s before suspending: about 1.5 billed minutes a run for a few seconds
-- of MERGE. 30s idle cuts that to just over the minimum (Dan, 2026-10-28, #4349).
ALTER WAREHOUSE IF EXISTS SLATE_WH SET AUTO_SUSPEND = 30;

-- ----------------------------------------------------------------------------
-- Database + schema.
-- ----------------------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS SLATE
  COMMENT = 'Slate operational-data mirror for cross-system analytics.';
CREATE SCHEMA IF NOT EXISTS SLATE.PUBLIC;

USE DATABASE SLATE;
USE SCHEMA PUBLIC;

-- ----------------------------------------------------------------------------
-- Steady-state role: append-only mirror writer (no DELETE, no TRUNCATE).
-- ----------------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS SLATE_ROLE
  COMMENT = 'Slate export lane: SELECT/INSERT/UPDATE on the mirror, no DELETE.';

GRANT USAGE ON WAREHOUSE SLATE_WH TO ROLE SLATE_ROLE;
GRANT USAGE ON DATABASE SLATE TO ROLE SLATE_ROLE;
GRANT USAGE ON SCHEMA SLATE.PUBLIC TO ROLE SLATE_ROLE;

-- ============================================================================
-- Mirror tables. One per mirrored Supabase table. Every table carries a
-- warehouse load stamp `exported_at` (set by the MERGE, not sourced from
-- Supabase). JSONB columns map to VARIANT and are written via PARSE_JSON.
-- Column order and names mirror src/lib/db/types.ts.
-- ============================================================================

-- bookings (MUTABLE: MERGE-by-id, watermark = updated_at). Full fidelity here;
-- Supabase keeps only a skinny-redacted row after any future prune (Phase 6).
CREATE TABLE IF NOT EXISTS bookings (
  id                  VARCHAR PRIMARY KEY,
  org_id              VARCHAR,
  bucket_id           VARCHAR,
  event_type_id       VARCHAR,
  assigned_user_id    VARCHAR,
  agent_name          VARCHAR,
  agent_email         VARCHAR,
  starts_at           TIMESTAMP_TZ,
  ends_at             TIMESTAMP_TZ,
  original_starts_at  TIMESTAMP_TZ,
  original_ends_at    TIMESTAMP_TZ,
  timezone            VARCHAR,
  status              VARCHAR,
  salesforce_id       VARCHAR,
  attendee_name       VARCHAR,
  attendee_email      VARCHAR,
  attendee_phone      VARCHAR,
  prefill             VARIANT,
  gcal_event_id       VARCHAR,
  -- Never written since #2564, and deliberately not dropped. The manage token is a
  -- credential, not a description of the person: whoever holds it can reschedule or
  -- cancel that booking with no other authentication, so mirroring it made warehouse
  -- read access equal to booking control access. The export strips it, the 6h sweep
  -- blanks what was already here, and scripts/test-mirror-credentials.ts fails the
  -- build if it or anything else credential shaped rejoins the mirror. The column is
  -- left in place rather than dropped because a DROP is hand applied DDL against
  -- production that would break any consumer naming it, and gains nothing over a
  -- column that is permanently null and guarded.
  manage_token        VARCHAR,
  idempotency_key     VARCHAR,
  external_id         VARCHAR,
  routing_trace       VARIANT,
  allow_double_book   BOOLEAN,
  reschedule_seq      NUMBER,
  created_at          TIMESTAMP_TZ,
  updated_at          TIMESTAMP_TZ,
  exported_at         TIMESTAMP_NTZ,
  -- #2072: the page the lead booked from (see src/lib/booking/booking-source.ts).
  -- Null for a booking made before sources were recorded. The legacy cal.com event
  -- type is derived from it in code, so a report grouping by the old names joins on
  -- SOURCE_DETAILS rather than on a stored copy.
  source              VARCHAR,
  -- #2772: the origin (never the path) of the page that framed the booker
  -- (#2728, supabase/migrations/0142_booking_referrer_origin.sql). Null when the
  -- booker was not framed, the referrer was stripped, or the booking predates it.
  -- Read beside prefill:parentOrigin; which origins count as production is decided
  -- in code (src/lib/monitor/offsite-origin.ts), not here.
  referrer_origin     VARCHAR,
  -- #2828: 'routed' (through a bucket pool) or 'agent_link' (booked through an
  -- advisor's own named link, which does not route), from
  -- supabase/migrations/0144_agent_links.sql. Anything about routing filters on
  -- kind = 'routed', as every Slate reader does.
  kind                VARCHAR,
  -- #4397: true when the booking came through the partner program (#4387,
  -- supabase/migrations/0213_program_leads.sql). False for every other booking.
  program_lead        BOOLEAN
)
CLUSTER BY (created_at);

-- webhook_deliveries (MUTABLE: watermark = updated_at).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                  VARCHAR PRIMARY KEY,
  endpoint_id         VARCHAR,
  event               VARCHAR,
  payload             VARIANT,
  status              VARCHAR,
  attempts            NUMBER,
  last_response       VARCHAR,
  suppressed          BOOLEAN,
  created_at          TIMESTAMP_TZ,
  updated_at          TIMESTAMP_TZ,
  exported_at         TIMESTAMP_NTZ
)
CLUSTER BY (created_at);

-- booking_outbox (MUTABLE: watermark = updated_at).
CREATE TABLE IF NOT EXISTS booking_outbox (
  id                  VARCHAR PRIMARY KEY,
  booking_id          VARCHAR,
  action              VARCHAR,
  status              VARCHAR,
  steps               VARIANT,
  payload             VARIANT,
  lease_until         TIMESTAMP_TZ,
  attempts            NUMBER,
  last_error          VARCHAR,
  next_attempt_at     TIMESTAMP_TZ,
  created_at          TIMESTAMP_TZ,
  updated_at          TIMESTAMP_TZ,
  exported_at         TIMESTAMP_NTZ
)
CLUSTER BY (created_at);

-- booking_events (APPEND-ONLY: cursor = created_at). Immutable history in
-- Supabase (0089 triggers), so no updated_at exists to drive a watermark.
CREATE TABLE IF NOT EXISTS booking_events (
  id                  VARCHAR PRIMARY KEY,
  booking_id          VARCHAR,
  action              VARCHAR,
  initiator           VARCHAR,
  reason_code         VARCHAR,
  reason_detail       VARCHAR,
  from_starts_at      TIMESTAMP_TZ,
  to_starts_at        TIMESTAMP_TZ,
  from_agent_user_id  VARCHAR,
  to_agent_user_id    VARCHAR,
  actor_user_id       VARCHAR,
  acting_as_user_id   VARCHAR,
  lead_time_minutes   NUMBER,
  reschedule_seq      NUMBER,
  created_at          TIMESTAMP_TZ,
  exported_at         TIMESTAMP_NTZ,
  from_bucket_id      VARCHAR,
  to_bucket_id        VARCHAR
)
CLUSTER BY (created_at);

-- audit_log (APPEND-ONLY: cursor = created_at).
CREATE TABLE IF NOT EXISTS audit_log (
  id                  VARCHAR PRIMARY KEY,
  org_id              VARCHAR,
  actor_id            VARCHAR,
  action              VARCHAR,
  target_id           VARCHAR,
  details             VARIANT,
  created_at          TIMESTAMP_TZ,
  exported_at         TIMESTAMP_NTZ
)
CLUSTER BY (created_at);

-- routing_decisions (APPEND-ONLY: cursor = created_at).
CREATE TABLE IF NOT EXISTS routing_decisions (
  id                  VARCHAR PRIMARY KEY,
  org_id              VARCHAR,
  booking_id          VARCHAR,
  bucket_code         VARCHAR,
  bucket_id           VARCHAR,
  requested_tier      VARCHAR,
  booked_tier         VARCHAR,
  chosen_user_id      VARCHAR,
  considered          VARIANT,
  excluded            VARIANT,
  empty_pool_fallback BOOLEAN,
  tier_fallback       BOOLEAN,
  rungs_dropped       NUMBER,
  outcome             VARCHAR,
  created_at          TIMESTAMP_TZ,
  exported_at         TIMESTAMP_NTZ
)
CLUSTER BY (created_at);

-- ----------------------------------------------------------------------------
-- Self-heal for a table provisioned before a column was added (#1116).
--
-- Every CREATE above is IF NOT EXISTS, which means re-running this file against
-- an already-provisioned warehouse is a no-op: it will NOT add a column that was
-- introduced after the tables were first created. These ALTERs make the file
-- genuinely re-runnable. They matter most for `exported_at`, because the export
-- MERGE writes it on every branch, so a table missing it fails 100% of its
-- exports. /api/admin/snowflake-check probes the live schema for exactly this
-- and reports 503 naming any table that lacks it.
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS bookings            ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP_NTZ;
ALTER TABLE IF EXISTS webhook_deliveries  ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP_NTZ;
ALTER TABLE IF EXISTS booking_outbox      ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP_NTZ;
ALTER TABLE IF EXISTS booking_events      ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP_NTZ;
ALTER TABLE IF EXISTS audit_log           ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP_NTZ;
ALTER TABLE IF EXISTS routing_decisions   ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP_NTZ;

-- #2072: the booking source. The export MERGE writes it on every bookings row, so a
-- warehouse without it fails every bookings export: run this BEFORE the change
-- that exports it deploys.
ALTER TABLE IF EXISTS bookings            ADD COLUMN IF NOT EXISTS source VARCHAR;

-- #2772: the framing page's origin. Same rule as source: the MERGE writes it on
-- every bookings row, so run this BEFORE the change that exports it deploys.
-- scripts/test-snowflake-mirror-columns.ts fails the build on any column added to
-- a CREATE above after provisioning that has no ALTER here.
ALTER TABLE IF EXISTS bookings            ADD COLUMN IF NOT EXISTS referrer_origin VARCHAR;

-- #2828: the booking kind. Same rule as source: the MERGE writes it on every
-- bookings row, so run this BEFORE the change that exports it deploys.
ALTER TABLE IF EXISTS bookings            ADD COLUMN IF NOT EXISTS kind VARCHAR;

-- #3247: a bucket correction's from and to bucket on booking_events (migration
-- 0166). Run this in Snowsight BEFORE the change that adds them to the export's
-- booking_events column list (src/lib/snowflake/export-core.ts) deploys, or every
-- booking_events MERGE fails on an unknown column. That export change is held back
-- until this has run; the corrected bucket already reaches the warehouse through
-- bookings.bucket_id meanwhile.
ALTER TABLE IF EXISTS booking_events      ADD COLUMN IF NOT EXISTS from_bucket_id VARCHAR;
ALTER TABLE IF EXISTS booking_events      ADD COLUMN IF NOT EXISTS to_bucket_id VARCHAR;

-- The ALTER leaves every row already here with a null kind, and a row is exported
-- again only when it changes, so most never would be. Every booking created before
-- advisor links shipped (#2073, merged 2026-09-28 15:17:32 UTC) is routed, because
-- nothing before that could make any other kind, so this says so for exactly those
-- rows and no later ones. It is idempotent. A row created after the cutoff that
-- still reads null was exported before this change deployed and has not changed
-- since: rewind the bookings export cursor to the cutoff (docs/migrations-runbook.md)
-- rather than guessing its kind here.
UPDATE bookings SET kind = 'routed' WHERE kind IS NULL AND created_at < '2026-09-28 15:17:32 +00:00'::TIMESTAMP_TZ;

-- #4397: the program lead flag. Same rule as source: the MERGE writes it on every
-- bookings row, so run this BEFORE the change that exports it deploys.
ALTER TABLE IF EXISTS bookings            ADD COLUMN IF NOT EXISTS program_lead BOOLEAN;

-- The ALTER leaves every row already here null, and a row is exported again only when
-- it changes. False is right for every one of them but one: when this shipped
-- (2026-10-30) the only program booking Supabase held was a cancelled call on the
-- test bucket, which reads false here until it next changes. One test row was not
-- worth a cursor rewind, which re-exports the whole table. Idempotent, and harmless
-- after the export deploys, which writes the flag on every row it touches.
UPDATE bookings SET program_lead = FALSE WHERE program_lead IS NULL;

-- ----------------------------------------------------------------------------
-- Grants on the mirror tables: SELECT + INSERT + UPDATE only. No DELETE.
-- FUTURE grants cover any table added to this schema later under the same rule.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA SLATE.PUBLIC TO ROLE SLATE_ROLE;
GRANT SELECT, INSERT, UPDATE ON FUTURE TABLES IN SCHEMA SLATE.PUBLIC TO ROLE SLATE_ROLE;

-- ----------------------------------------------------------------------------
-- Service user (key-pair JWT auth). The RSA PUBLIC key goes here; the matching
-- PRIVATE key is held ONLY as the SNOWFLAKE_PRIVATE_KEY Worker secret and never
-- stored in Snowflake. Generate the pair per docs/snowflake-setup.md, then paste
-- the public key body (no header/footer lines, no line breaks) below.
--
-- Portable CREATE (works on every Snowflake edition): the user has only a
-- key-pair credential (no password is ever set). RECOMMENDED HARDENING on
-- editions that support service users: after creating it, run the optional
-- ALTER below to make it TYPE = SERVICE (no password, no MFA, key-pair only). If
-- that ALTER errors on an older edition, skip it: the key-pair login already
-- works without it.
-- ----------------------------------------------------------------------------
CREATE USER IF NOT EXISTS SLATE_SERVICE
  DEFAULT_ROLE = SLATE_ROLE
  DEFAULT_WAREHOUSE = SLATE_WH
  COMMENT = 'Slate export lane service user (key-pair auth, append-only role).';

-- Optional hardening (run on editions that support it; safe to skip if it errors):
--   ALTER USER SLATE_SERVICE SET TYPE = SERVICE;

-- Set the public key (run after generating the pair; re-run to rotate):
--   ALTER USER SLATE_SERVICE SET RSA_PUBLIC_KEY = 'MIIBIjANBg...paste-public-key-body...';

GRANT ROLE SLATE_ROLE TO USER SLATE_SERVICE;

-- ----------------------------------------------------------------------------
-- Sanity: confirm the role can read but NOT delete. Run as SLATE_ROLE.
--   USE ROLE SLATE_ROLE; USE WAREHOUSE SLATE_WH; USE DATABASE SLATE; USE SCHEMA PUBLIC;
--   SELECT COUNT(*) FROM bookings;                    -- should succeed (0 rows)
--   DELETE FROM bookings WHERE id = 'nope';           -- should FAIL: no DELETE privilege
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- Spend guard, part 2: the warn only resource monitor (#3125), RM_SLATE since
-- 2026-10-28 (see the Spend guard note near the top, and DEPLOY.md). Never add a
-- SUSPEND trigger: suspending the warehouse stops the booking mirror.
-- ----------------------------------------------------------------------------
-- RUN IN SNOWSIGHT (#3125) ----------------------------------------------------
CREATE RESOURCE MONITOR IF NOT EXISTS RM_SLATE
  WITH CREDIT_QUOTA = 100
  FREQUENCY = MONTHLY
  START_TIMESTAMP = IMMEDIATELY
  TRIGGERS ON 75 PERCENT DO NOTIFY
           ON 100 PERCENT DO NOTIFY;
ALTER WAREHOUSE SLATE_WH SET RESOURCE_MONITOR = RM_SLATE;
-- END RUN IN SNOWSIGHT --------------------------------------------------------

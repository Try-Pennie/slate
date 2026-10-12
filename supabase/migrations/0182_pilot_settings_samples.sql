-- #3641: what the pilot split settings were, read every quarter hour.
--
-- Salesforce keeps no history of SlatePilotActive__c, SlatePilotPercent__c or
-- SlatePilotTiers__c, so `pnpm report:pilot-compare` could only ASSUME the split
-- held at 50 on tiers 1 to 5 across its window (#2946). On 2026-10-12 the record
-- holding them was edited and nothing could say whether the split was touched. The
-- monitor lane now stores, every quarter hour, what Salesforce held, when it was
-- actually read (earlier than the sample when the reading was a cached one), and
-- when the record was last edited, which is what lets the report check a span with
-- no readings in it (src/lib/monitor/pilot-settings-samples.ts).
--
-- A failed read is a row with ok false, its reason, and NO values. The check below
-- makes that the only shape a failure can take, so a failure can never be stored as
-- a split. A successful reading may still hold a null field: that is what
-- Salesforce sent, and the report treats it as not the assumed split.
--
-- The key is the sample instant, so a sample written twice for the same instant is
-- refused rather than counted twice.
--
-- About 96 rows a day, read by one hand run report. Retires with the parallel run
-- at cutover (#65).

create table pilot_settings_samples (
  sampled_at          timestamptz primary key,
  ok                  boolean     not null,
  read_at             timestamptz,
  active              boolean,
  percent             numeric,
  tiers               text,
  record_modified_at  timestamptz,
  error               text,
  constraint pilot_settings_samples_ok_shape check (
    (ok and read_at is not null and record_modified_at is not null and error is null)
    or (not ok and error is not null and read_at is null and active is null
        and percent is null and tiers is null and record_modified_at is null)
  )
);

alter table pilot_settings_samples enable row level security;

comment on table pilot_settings_samples is
  'The #3641 pilot split readings: per quarter hour, what WebsiteConfiguration__c held for SlatePilotActive__c, SlatePilotPercent__c and SlatePilotTiers__c, when Salesforce was read, and when the record was last edited. ok false carries an error and no values. Written by the monitor lane, read by pnpm report:pilot-compare.';

-- #2927: what each booker OFFERS during the pilot split.
--
-- A booking rate difference between the Slate and cal.com halves of the Low split
-- (Halo-lab-Trypennie/trypennie#517) can come from what each system offered
-- rather than from the booker. Every quarter hour the monitor lane asks both
-- systems, read only, what a Low lead would be offered, and stores one row per
-- system: the earliest time and how many fall in the next 24 hours.
-- `pnpm report:pilot-split` reads them beside the booking rates
-- (src/lib/monitor/pilot-offers.ts).
--
-- A failed read is a row with ok false, its reason, and NO numbers. The check
-- below makes that the only shape a failure can take, so a failure can never be
-- stored as zero times, which is a real answer ("offered nothing").
--
-- The key is the sample instant plus the system, so a sample written twice for
-- the same instant is refused rather than counted twice.
--
-- About 190 rows a day, read by one hand run report. Retires with the parallel
-- run at cutover (#65).

create table pilot_offer_samples (
  sampled_at           timestamptz not null,
  system               text        not null check (system in ('slate', 'calcom')),
  bucket_code          text        not null,
  ok                   boolean     not null,
  earliest_offered_at  timestamptz,
  offered_24h          integer     check (offered_24h is null or offered_24h >= 0),
  error                text,
  primary key (sampled_at, system),
  constraint pilot_offer_samples_ok_shape check (
    (ok and offered_24h is not null and error is null)
    or (not ok and offered_24h is null and earliest_offered_at is null and error is not null)
  )
);

alter table pilot_offer_samples enable row level security;

comment on table pilot_offer_samples is
  'The #2927 pilot split availability samples: per quarter hour, what Slate and cal.com each offered a Low lead (earliest time, count in the next 24h). ok false carries an error and no numbers. Written by the monitor lane, read by pnpm report:pilot-split.';

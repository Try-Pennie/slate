-- #3002: record the time zone each cal.com availability sample was asked in.
--
-- Asked with no timeZone, cal.com's calculate-slots answers a truncated list.
-- Measured 2026-10-02 for a 112 lead: Friday stopped at 3:30pm ET and Saturday
-- at 3:40pm ET, while with America/New_York the answer matched the live booker to
-- the minute (Friday to 7:40pm ET). Every cal.com row stored before the fix
-- therefore counts too few times, and it made Slate look like it offered about
-- four times as many times when it really offers fewer.
--
-- The sampler now always passes a zone and records it here on cal.com rows. A
-- cal.com row with NULL was taken before that, and `pnpm report:pilot-split`
-- leaves its whole quarter hour out (both systems' rows) and says how many. The
-- rows are kept rather than deleted, so the truncated readings stay inspectable.
-- Slate rows always carry NULL: the zone is a fact about the cal.com read.

alter table pilot_offer_samples add column calcom_time_zone text;

comment on column pilot_offer_samples.calcom_time_zone is
  '#3002: the timeZone the cal.com read was asked in, on cal.com rows. NULL on a cal.com row means it was taken before the read passed one, so cal.com''s answer was cut short and the report leaves that quarter hour out. Always NULL on slate rows.';

-- #1442 / #1450 / #1709: the baseline for the SELF INFLICTED refusal counts.
--
-- Three refusals the booking API makes to its own caller (our rate ceiling, a
-- rejected or missing credential, an unreadable bookings page) are deliberately
-- kept OUT of the booking failure SHARE, because `attempts` there is every
-- recorded outcome summed and putting a noisy caller's volume in that denominator
-- would make a real outage look proportionally smaller exactly while it is
-- happening. That decision is unchanged and is recorded per path in
-- src/lib/booking/refusal-catalog.ts.
--
-- The cost of it was that nothing measured them at all. They are counted now
-- under their own outcome names, which need no schema change: `total` in
-- normalizeMix is summed over OUTCOME_ORDER alone, so a name outside it can never
-- enter the share, and the mix RPC's by_error slice filters on outcome = 'error'
-- so they cannot pollute the error codes either.
--
-- What DOES need a column is the baseline. The tally is cumulative per ET day, so
-- only the difference between two consecutive readings measures an interval, and
-- the reading each delta is taken against has to survive between ticks. The
-- neighbouring counters (attempts, failures, by_code) each have their own column
-- for exactly this reason.
--
-- Without it the check would be worse than absent: every tick would find no
-- baseline, re-baseline, and record no sample, so the window would stay
-- permanently empty and the three signals would report `unmeasured` forever while
-- the lane looked healthy. That is the "detector that has never once concluded"
-- shape (#1394), which is the one failure this design cannot afford, since these
-- signals exist precisely to speak where nothing else does.
--
-- The per-interval DELTAS ride inside `samples`, which is already jsonb, so they
-- need nothing here. A row written before this shipped has samples with no
-- refusals key, which reads as "not measured in that interval" rather than as
-- zero refusals: judgeRefusalSignals counts INTERVALS that carried a refusal, and
-- an absent key contributes no interval.
--
-- Single row, keyed by a fixed text key, so this table still cannot grow.

alter table booking_failure_rate_state
  add column if not exists refusals jsonb not null default '{}'::jsonb;

comment on column booking_failure_rate_state.refusals is
  'Cumulative self-inflicted refusal counts from the last reading (#1442/#1450/#1709), the baseline the next tick differences against. Never part of the booking failure share.';

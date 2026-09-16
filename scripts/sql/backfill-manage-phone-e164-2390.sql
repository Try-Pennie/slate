-- One-time correction of phone numbers the manage page stored in the wrong shape
-- (#2390).
--
-- WHAT WENT IN. From #1341 until the fix in this change, a lead who corrected
-- their number on `/booking/manage/<token>` had it written through
-- `formatPhoneAsTyped`, which produces "(215) 555-9999" and never E.164. Every
-- other writer stores `toE164(...)`, which is "+12155559999", and the person
-- lookup asks the database `attendee_phone = toE164(<the number the caller gave>)`,
-- an exact equality. So a corrected booking could not be fetched by phone, the
-- rows that query returns are the whole input to the one call per person rule, and
-- the same lead could be booked a second time.
--
-- The code no longer writes that shape. This is the other half: a fix that only
-- fills records going forward never reaches the rows that already exist, and a
-- correction made before this runs is exactly the row the rule cannot see.
--
-- READ STEP 1 BEFORE RUNNING STEP 2. Step 1 writes nothing and says how many rows
-- are affected and what they look like; step 2 is the write. Nobody has counted
-- these against production yet, so the report is how the size is learned rather
-- than assumed.
--
-- NO EXPORT CURSOR REWIND, and this was checked rather than assumed. `bookings`
-- IS a mirrored table, watermarked on `updated_at`
-- (src/lib/snowflake/export-core.ts), but this statement does not SUPPLY that
-- column: the `set_updated_at` trigger from migration 0001 stamps it with now(),
-- so every corrected row lands AHEAD of the export cursor and is picked up by the
-- next tick in the ordinary way. The hazard #1231 warns about is a write that
-- carries an OLD watermark, which this is not.
--
-- Redacted rows are excluded outright. `pii_redacted_at is not null` means the
-- contact details were already blanked by the retention or erasure path, so there
-- is no number to correct, and those rows are deliberately frozen out of the
-- Snowflake export (#1118). Touching one would have nothing to gain.
--
-- IDEMPOTENT: the pattern it matches is the shape this correction removes, so a
-- second run finds nothing.

-- 1. REPORT. Writes nothing. Run this first and read it.
--
--    `correctable` is what step 2 will rewrite. `not_correctable` is the residual
--    described below: the two are reported apart so a leftover count is never read
--    as a step that failed to run.
select
  count(*) filter (
    where attendee_phone ~ '^\([2-9][0-9]{2}\) [2-9][0-9]{2}-[0-9]{4}$'
      and substring(attendee_phone from 2 for 3) <> '555'
  ) as correctable,
  count(*) filter (
    where attendee_phone ~ '^\([0-9]{3}\) [0-9]{3}-[0-9]{4}$'
      and not (
        attendee_phone ~ '^\([2-9][0-9]{2}\) [2-9][0-9]{2}-[0-9]{4}$'
        and substring(attendee_phone from 2 for 3) <> '555'
      )
  ) as not_correctable,
  count(*) filter (where status in ('confirmed', 'rescheduled')) as of_which_active
from bookings
where pii_redacted_at is null
  and attendee_phone ~ '^\([0-9]{3}\) [0-9]{3}-[0-9]{4}$';

-- 2. THE CORRECTION. Reports the number of rows it changed.
--
-- WHY THE PATTERN IS NARROWER THAN "looks formatted". `toE164` is libphonenumber,
-- and it REFUSES a number it cannot recognise as a real US one, handing the input
-- straight back instead. For those numbers the stored value and the value the
-- lookup computes are the SAME formatted string already, so rewriting the row to
-- E.164 would break a match that currently works. Measured against the shipped
-- helper on 2026-09-16: "(215) 555-9999" and "(203) 555-0100" normalise to E.164,
-- while "(555) 555-5555", "(215) 000-0000" and "(111) 555-1234" come back
-- unchanged. So the area code and the exchange must each begin 2 to 9, and the 555
-- area code is excluded by name. Anything else is left exactly as it is and
-- reported by step 1 as `not_correctable`; on this roster those can only be test
-- and fictional numbers, and leaving them alone is the direction that cannot lose
-- a real lead's match.
--
-- The value is rebuilt from the DIGITS rather than by string surgery, so the
-- result is the same "+1" || ten digits every other writer produces.
update bookings
set attendee_phone = '+1' || regexp_replace(attendee_phone, '\D', '', 'g')
where pii_redacted_at is null
  and attendee_phone ~ '^\([2-9][0-9]{2}\) [2-9][0-9]{2}-[0-9]{4}$'
  and substring(attendee_phone from 2 for 3) <> '555';

-- 3. CONFIRM. Should report zero correctable rows left.
select count(*) as still_formatted
from bookings
where pii_redacted_at is null
  and attendee_phone ~ '^\([2-9][0-9]{2}\) [2-9][0-9]{2}-[0-9]{4}$'
  and substring(attendee_phone from 2 for 3) <> '555';

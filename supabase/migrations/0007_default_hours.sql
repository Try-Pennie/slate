-- Org-level default working hours. New (e.g. Salesforce-synced) agents start
-- with NO hours so they can't receive bookings until someone sets them; an
-- admin/agent can then apply these defaults in one click. Each agent's schedule
-- still carries its own timezone (their home tz); bookings are shown in the
-- lead's timezone regardless.
alter table organizations add column default_timezone text not null default 'America/New_York';
alter table organizations add column default_start_minute int not null default 540;   -- 09:00
alter table organizations add column default_end_minute int not null default 1020;    -- 17:00
alter table organizations add column default_weekdays int[] not null default '{1,2,3,4,5}'; -- Mon–Fri

-- #2875: one stored switch that retires every cal.com lane at once.
--
-- During the parallel run cal.com takes every real lead, so Slate compares itself
-- against it (the daily schedule parity sweep and the weekly router replay), copies
-- its hours in every morning, and writes each approved absence into it. Every one
-- of those lanes could only be retired by editing code, so turning cal.com off
-- (#65) would have needed a change on the day of cutover, and until somebody made
-- it the watchdog would page "comparison went quiet", the Worker would re fire the
-- sweep daily, and the morning import would put stale cal.com hours back over a
-- week an admin had set in Slate, with nothing said.
--
-- It lives on the existing single-row `monitor_alert_config` (0060), the row behind
-- /admin/alerts, rather than a table of its own: that page already holds the other
-- declarations about the state of the world the monitor judges against (the arming
-- switches, the ramp end, #2739), and every reader here is already a reader of that
-- row or a script with the same secret key.
--
-- NOT NULL DEFAULT false, like the booking kill switch (0122) and unlike the
-- nullable arming switches beside it. A null here would have to mean something, and
-- both readings are wrong: read as retired it would silence every cal.com lane and
-- stop the time off dual write the moment this lands, while cal.com is still taking
-- bookings; read as live it is a third state every reader has to carry for nothing.
-- The column's default is its OFF value, so the row that exists today keeps the
-- parallel run behaving exactly as it does now (L72).
--
-- Written only by `setCalcomRetired` (src/app/admin/actions.ts), column scoped, and
-- audited there with the value before and after (L529). A failed READ of it is
-- decided per consumer in src/lib/calcom/retirement.ts: the hours import writes
-- nothing, and everything that only watches or protects keeps today's behaviour.
alter table monitor_alert_config
  add column calcom_retired boolean not null default false;

comment on column monitor_alert_config.calcom_retired is
  'The #2875 switch. True once cal.com no longer takes bookings: the cal.com comparison lanes stop being watched and re fired, and Slate stops writing hours from cal.com and time off to cal.com. Default false, the parallel run.';

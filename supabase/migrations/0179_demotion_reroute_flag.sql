-- #3582: the go-live switch for the automatic reroute-on-ineligibility trigger.
--
-- The trigger moves a customer's booked call to another advisor when a Twilio roster change
-- demotes the agent off a tier or backend the booking needs. That is a customer-visible,
-- not-cheap-to-undo action, so it ships behind a stored switch that defaults OFF and can be
-- turned on (and back off) without a deploy, the same shape the frame lock (0162) and the
-- public booking pause (0122) use.
--
-- With the switch OFF the hourly Twilio sync behaves exactly as it does today: it does not
-- stamp a demotion, does not sweep, and moves no booking. Only when an admin turns it on does
-- the lifecycle begin, stamping new narrowings from that point forward.
--
-- NOT NULL DEFAULT false, so a settings row that predates this column, and a database where
-- nobody ever pressed the switch, keep the trigger off rather than silently arming it (L72).
alter table booking_settings
  add column demotion_reroute_enabled boolean not null default false;

comment on column booking_settings.demotion_reroute_enabled is
  'The go-live switch for the reroute-on-ineligibility trigger (#3582). True lets the hourly Twilio sync stamp a tier/backend demotion and, after the debounce, move the agent''s lost-pool bookings to an eligible advisor. NOT NULL DEFAULT false: off until an admin turns it on, and the whole lifecycle is inert while off.';

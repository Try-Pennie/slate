-- #459: mark a delivery that must never leave the building.
--
-- The smoke test books real bookings on a hidden is_test bucket via the key-authed
-- API, so every smoke run used to inject a synthetic lead into Regal/Cadence and then
-- cancel it. The fix records the delivery but skips the external POST.
--
-- The row still has to EXIST: scripts/smoke-create-resume.ts counts webhook_deliveries
-- rows on the smoke bucket to prove the exactly-once dedupe survives a crash-resume,
-- against the real partial unique index. Dropping the emission entirely would leave
-- that check counting zero and proving nothing.
--
-- So the row is written with a terminal status ('success') and this flag, and every
-- send path (inline send, the retry sweep, an admin resend, the dead-letter replay)
-- refuses to POST a flagged row. The flag is what makes that structural: a future send
-- path cannot leak a smoke booking downstream without explicitly ignoring it.
alter table webhook_deliveries
  add column if not exists suppressed boolean not null default false;

comment on column webhook_deliveries.suppressed is
  'Recorded but never POSTed (is_test bucket booking, #459). No send path may deliver it.';

-- #1073: mark a delivery whose payload has been blanked for PII retention.
--
-- webhook_deliveries.payload holds full attendee contact data (name/email/phone)
-- per delivery and was retained forever (a leak, and a DSR/erasure gap, #1029).
-- A daily retention job blanks payload -> '{}' on deliveries that are genuinely
-- done (succeeded, or failed past the retry cap) and older than the retention
-- window, and sets this flag.
--
-- The flag is what makes refusal STRUCTURAL, mirroring `suppressed` (#459): every
-- re-send path (the retry sweep, an admin resend, the dead-letter replay) must
-- refuse a flagged row rather than POST the blanked '{}' body, which the generic
-- endpoint would record as a fake success and the Regal endpoint would throw on.
alter table webhook_deliveries
  add column if not exists payload_erased boolean not null default false;

comment on column webhook_deliveries.payload_erased is
  'Payload blanked for PII retention (#1073). No send path may re-deliver it.';

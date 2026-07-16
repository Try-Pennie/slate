-- #876: webhook fan-out (emitWebhook) POSTs to every active endpoint matching
-- (org_id, event), and the exactly-once dedupe key is scoped per endpoint_id.
-- Two endpoint rows sharing a URL (different ids) therefore each fire, so the
-- same destination gets every booking event twice (e.g. two Regal "Non-Ultra
-- High Team Booking Detected" alerts per booking, cf. #492).
--
-- The admin save path is singleton-per-org and can't create a duplicate, but
-- nothing at the DB level forbade one from a seed script, manual SQL, or a
-- future multi-endpoint feature. A full (non-partial) unique index blocks the
-- duplicate at the source while still allowing an org's several DISTINCT
-- targets (Regal + Cadence live on different URLs).
create unique index webhook_endpoints_org_url_uniq
  on webhook_endpoints (org_id, url);

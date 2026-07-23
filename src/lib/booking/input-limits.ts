/**
 * Size caps for the public booking input (#1034). Both booking entry points (the
 * embed `/booking` route and the direct `/api/bookings` parser) accept caller
 * strings that flow into Postgres, Google Calendar event bodies, and
 * Regal/Cadence webhook payloads. Unbounded, a caller inside the rate limits can
 * store a multi-MB blob that fails those downstream deliveries.
 *
 * This module is the single source of truth for the numbers. It is pure (no
 * imports) so the shared attendee validator can consult it without pulling in
 * zod; the bounded zod field schemas built from these live in `input-schema.ts`.
 */
export const INPUT_LIMITS = {
  /** name / email / phone, each. */
  contact: 200,
  /** bucketCode / timezone (an XBC code is 3 digits; the longest IANA zone ~30). */
  code: 64,
  /** start: an ISO 8601 instant is well under this. */
  start: 64,
  /** salesforceId (an 18-char SFDC id) / externalId (the bot's per-person id). */
  salesforceId: 128,
  externalId: 128,
  /** prefill: at most this many keys, each key/value bounded below. */
  prefillKeys: 20,
  prefillKey: 100,
  prefillValue: 500,
} as const;

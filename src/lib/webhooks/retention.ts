import { DateTime } from "luxon";

/**
 * Webhook delivery payloads hold full attendee PII (name/email/phone) per
 * delivery (#1073). A delivery older than this window is past any realistic
 * incident-replay reach, so its payload is blanked for PII retention. 90 days is
 * the provisional default (a full quarter of replay reach); it remains subject to
 * Pennie legal per #1029.
 *
 * #2085 added a second payload family, `agent.bookable_changed`, which carries an
 * agent's work email and a boolean: staff data, not lead PII. It is blanked on the
 * SAME window anyway, deliberately rather than by inheritance. A trait older than
 * 90 days has no replay value (every send states the agent's value at that send,
 * so the current state is re-sendable at any time by the backfill), and one rule
 * for the whole table keeps the export gate and the prune lane unchanged. The
 * per person erasure (migration 0093) matches on `payload ->> 'booking_id'`, so it
 * never touches a trait row, which is correct: erasing a LEAD must not erase what
 * Regal was told about an agent.
 */
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 90;

/** ISO timestamp `days` before `nowIso`; deliveries older than this are erased. */
export function webhookPayloadCutoffIso(
  nowIso: string,
  days = WEBHOOK_PAYLOAD_RETENTION_DAYS,
): string {
  return DateTime.fromISO(nowIso, { zone: "utc" })
    .minus({ days })
    .toUTC()
    .toISO({ suppressMilliseconds: false })!;
}

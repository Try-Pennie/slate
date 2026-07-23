import { DateTime } from "luxon";

/**
 * Webhook delivery payloads hold full attendee PII (name/email/phone) per
 * delivery (#1073). A delivery older than this window is past any realistic
 * incident-replay reach, so its payload is blanked for PII retention. 90 days is
 * the provisional default (a full quarter of replay reach); it remains subject to
 * Pennie legal per #1029.
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

import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normalizes a phone number to E.164 (e.g. "+12035615295") for the webhook
 * payload so Regal/Cadence can match dialer/SMS records. Defaults to US since
 * Pennie's leads are US-based. Returns the original string if it can't be
 * parsed, so we never drop a number.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, "US");
  return parsed?.isValid() ? parsed.number : trimmed;
}

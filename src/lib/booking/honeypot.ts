/**
 * Public-booker honeypot (#1033). A decoy field rendered hidden on the Booker
 * form: a real user never sees, tabs to, or fills it, so any submission carrying
 * a value in it is a scripted bot filling every field it finds. The name is
 * exported so the client form and the server route share ONE source of truth and
 * can't drift; the check is pure so it's node-testable.
 *
 * Named for a plausible-but-nonexistent field (bots harvesting forms love a
 * "website" field, its comment-spam heritage) that browser autofill does NOT
 * populate for a name/email/phone form, so a real lead can never trip it.
 */
export const HONEYPOT_FIELD = "website";

/** True when the decoy carries content: a trimmed non-empty string, or any other
 *  non-nullish value a bot might send. A blank/whitespace value (what autofill
 *  might leave) never trips, so a real submission is safe. */
export function honeypotTripped(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

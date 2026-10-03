/**
 * The timezone a form submitted, or null when it sent none (#1989).
 *
 * Three saves used to read the field as `form.get("timezone") ?? "America/New_York"`,
 * so a form that sent no zone wrote Eastern and reported success. That is the exact
 * value that was wrong for 74 of 103 agents (#1739), and wrong for this reason: a
 * stored default reads just like a deliberate choice, so nothing could tell a real
 * Eastern agent from an unset one. So a missing zone is never guessed. The caller
 * refuses the save and says why, in the place the person is looking.
 *
 * A blank value counts as missing. Whether a PRESENT value is a real zone is still
 * decided where it was before (`planScheduleReplacement` for hours, Luxon for time
 * off); this only removes the guess.
 */
export function submittedTimezone(form: FormData): string | null {
  const raw = form.get("timezone");
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw;
}

/** The refusal on either working hours save. Nothing was written. */
export const MISSING_TIMEZONE_HOURS =
  "Pick a timezone for these hours, then save again. Nothing was saved.";

/** The refusal on a time off request or a change to one. Nothing was sent. */
export const MISSING_TIMEZONE_TIME_OFF =
  "Pick the timezone for your time off, then send it again. Nothing was sent.";

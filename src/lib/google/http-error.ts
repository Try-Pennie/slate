/**
 * A Google API call that failed with an HTTP status, carrying that status so a
 * caller can tell a definitive account/permission failure apart from a
 * transient one (#913). The message is unchanged from the plain Error the
 * callers used to throw, so existing log/forensic expectations still hold.
 */
export class GoogleHttpError extends Error {
  readonly status: number;
  /** Machine-readable Google error reason (e.g. "rateLimitExceeded"), when the
   *  response body carried one. Disambiguates a 403 rate limit from a 403
   *  permission failure (#917). */
  readonly reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "GoogleHttpError";
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Google's refusal of a guest address it will never invite (#3359): a 400 whose
 * reason is `invalid` and whose message is "Invalid attendee email.". Measured in
 * production on 2026-10-06, verbatim:
 *
 *   400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid attendee email."}],"code":400}}
 *
 * It is matched on the MESSAGE as well as the reason, deliberately. `invalid` is
 * Google's reason for any malformed field in the event we send (a start time, a
 * zone, an id), and every one of those is our own fault: it must keep reaching
 * the internal error page and the drain's retry, where somebody sees it. Only the
 * attendee address is the lead's to change, so only that sentence turns a create
 * into a refusal the lead is asked to correct. Broadening this to every 400 would
 * hide a defect of ours behind "check your email".
 */
export function isInvalidAttendeeEmailRefusal(err: unknown): boolean {
  return (
    err instanceof GoogleHttpError &&
    err.status === 400 &&
    err.reason === "invalid" &&
    /invalid attendee email/i.test(err.message)
  );
}

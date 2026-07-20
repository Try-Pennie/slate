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

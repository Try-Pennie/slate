/**
 * The lead's own sentence for an address we, or Google, will not take: what the
 * email field shows for our own check and for Google's refusal alike. It lives
 * here rather than in `attendee.ts` (which re-exports it) because this module has
 * to import NOTHING: the bulk coverage sweep recognises the refusal below, and a
 * client component reads that sweep's module, so anything imported here ships to
 * the browser. Importing `attendee.ts` from here grew the client bundle by 14 KB
 * gzipped, measured by the pre-push bundle budget.
 */
export const INVALID_EMAIL = "Enter a valid email address";

/**
 * Google refused to invite the lead's email address (#3359), so the calendar write
 * that carried it never happened and none ever can with that address.
 *
 * Our own check (`validateAttendee`) is meant to refuse everything Google does,
 * so this is the backstop for a shape the two still disagree on. It carries the
 * lead's own sentence, the one the email field already shows, so every route
 * answers it as a refusal about that field rather than as an unexpected fault:
 * on 2026-10-06 it was a 500, and the lead tried four more times without ever
 * learning their email was the problem. Google's answer rides along as `cause`.
 *
 * Its own dependency free module rather than inside the orchestration (#3373),
 * because the bulk coverage sweep has to recognise it and that module is also read
 * by a client component, which must not pull the booking layer into the browser.
 */
export class AttendeeEmailRefusedError extends Error {
  /** The field the lead has to change. */
  readonly field = "email" as const;
  constructor(cause: unknown) {
    super(INVALID_EMAIL);
    this.name = "AttendeeEmailRefusedError";
    this.cause = cause;
  }
}

/**
 * The same refusal said to STAFF, on a move or a reassign they started (#3373).
 *
 * The lead's sentence ("Enter a valid email address") is an instruction about a
 * field the manager does not have. This names the email as the reason and says
 * the booking was left as it was, so a manager does not retry a move that can
 * never succeed or go looking for a fault on the advisor's calendar.
 */
export const ATTENDEE_EMAIL_REFUSED_STAFF =
  "Google will not send a calendar invite to this lead's email address, so the booking was left as it was.";

/**
 * How a staff route answers it: 422 with its own code, one place so the reassign
 * routes and the admin reschedule cannot drift. A 4xx because retrying the same
 * request can never succeed, and not 409, which those routes use for a race.
 */
export const ATTENDEE_EMAIL_REFUSED_STAFF_ANSWER = {
  status: 422,
  body: { error: ATTENDEE_EMAIL_REFUSED_STAFF, code: "ATTENDEE_EMAIL_REFUSED" },
} as const;

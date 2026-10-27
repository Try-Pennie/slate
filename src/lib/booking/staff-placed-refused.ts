/**
 * #4202: the machine contact owner reassign refused a call a coordinator placed on the
 * placeholder advisor. Regal redistributes those calls itself when they are due, so an
 * owner move landing first would take the call off Marcia behind that redistribution.
 * A genuine conflict (409): retrying changes nothing until the call leaves the placeholder.
 *
 * Its own dependency free module rather than inside the orchestration, like
 * `attendee-email-refused.ts`, so the reassign routes' error map recognises it in the
 * route suites that mock the booking service.
 */
export class StaffPlacedReassignRefusedError extends Error {
  constructor() {
    super("This call is waiting on the placeholder advisor for Regal to hand it on, so the owner reassign did not move it.");
    this.name = "StaffPlacedReassignRefusedError";
  }
}

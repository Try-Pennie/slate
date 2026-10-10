// The per-run attendee identity the booking canary books under (#3581).
//
// Every smoke booking identity must be UNIQUE PER RUN. Slate derives a
// deterministic Google event id from the booking's idempotency key (which includes
// the attendee email and external id); a FIXED identity on a recurring slot makes
// each run reuse the same id, and once a run cancels its booking the next run meets
// a cancelled tombstone and walks the id chain until it exhausts and pages (#3576,
// the reschedule smoke's failure). The booking canary avoids this by mixing a nonce
// into the plus-alias and the external id; this is that one helper, shared so a new
// scenario cannot quietly reintroduce a fixed identity (the scan in
// scripts/test-smoke-identity-nonce.ts fails on a hand-rolled one).
//
// The address stays a plus-alias of the real smoketest@trypennie.com mailbox, so
// Google's invite/cancel mail delivers there rather than bouncing onto the organizer
// (#396). Pure given an explicit nonce, so it is node-testable with no clock; the
// DEFAULT nonce combines Date.now() with a per-process counter, so two calls in the
// same millisecond still produce distinct identities.
let seq = 0;
export function smokeAttendee(
  tag: string,
  nonce: number | string = `${Date.now()}-${seq++}`,
): { externalId: string; email: string } {
  return {
    externalId: `smoke-${tag}-${nonce}`,
    email: `smoketest+${tag}-${nonce}@trypennie.com`,
  };
}

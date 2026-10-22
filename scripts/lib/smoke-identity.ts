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
// The PHONE is part of the identity as well (#4060). Person dedupe
// (src/lib/booking/person-dedupe.ts) treats a phone match alone as a WEAK match, so a
// fixed phone lets any booking an earlier run left active (a crash before teardown)
// turn this run's create into `409 confirm_required` carrying that OLD booking. On
// 2026-10-21 the reschedule smoke then took the old booking's manage token and
// rescheduled and cancelled it as if it were its own.
//
// The address stays a plus-alias of the real smoketest@trypennie.com mailbox, so
// Google's invite/cancel mail delivers there rather than bouncing onto the organizer
// (#396). Pure given an explicit nonce, so it is node-testable with no clock; the
// DEFAULT nonce combines Date.now() with a per-process counter, so two calls in the
// same millisecond still produce distinct identities.

/**
 * A smoke attendee phone: `+1 <areaCode> 555 <last 4 digits of serial>`.
 *
 * The 555 exchange keeps every number out of ordinary subscriber ranges, so a smoke
 * booking never names a real person's phone. The four digit line gives 10,000
 * numbers per area code: the serial decides which one, and the caller decides how
 * that serial is unique (a per-process counter, or the run's own nonce). Callers in
 * different scripts that can run at once use different area codes, so their
 * numbers can never meet.
 */
export function smokePhone(serial: number, areaCode: string): string {
  const line = ((Math.trunc(serial) % 10_000) + 10_000) % 10_000;
  return `+1${areaCode}555${String(line).padStart(4, "0")}`;
}

/** The booking canary's area code; the reschedule smoke uses 202, so they never meet. */
const CANARY_AREA_CODE = "215";

// The phone serial starts at this process's start time and counts up per call, so
// two identities in one run are GUARANTEED distinct numbers (up to 10,000 calls), and
// a later run starts somewhere else on the line. A clock read per call could not
// promise the first: two reads 10 seconds apart land on the same four digits.
const RUN_BASE = Date.now();
let seq = 0;
export function smokeAttendee(
  tag: string,
  nonce?: number | string,
): { externalId: string; email: string; phone: string } {
  const n = seq++;
  const resolved = nonce ?? `${Date.now()}-${n}`;
  return {
    externalId: `smoke-${tag}-${resolved}`,
    email: `smoketest+${tag}-${resolved}@trypennie.com`,
    phone: smokePhone(RUN_BASE + n, CANARY_AREA_CODE),
  };
}

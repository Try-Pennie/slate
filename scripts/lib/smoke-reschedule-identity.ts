// The attendee identity the reschedule smoke books under (#3576).
//
// Why it has to be UNIQUE PER RUN: Slate derives a deterministic Google event id
// from the booking's idempotency key (bucket | slot | email | phone | salesforceId)
// and the assigned agent (src/lib/booking/core.ts deterministicEventId). The
// reschedule smoke runs every 6h on the ONE dedicated test agent and cancels its
// booking at teardown, which frees the slot again. With a FIXED identity and the
// day-stable earliest free slot, every run of the day built the SAME idempotency
// key, so every run reused the SAME deterministic id. Google keeps a cancelled
// event's id as a tombstone, so run 2 walked to `v1`, run 3 to `v2`, run 4 to `v3`,
// and run 5 exhausted the id chain (#3217) and threw, paging the production
// incident channel with a false 500 (measured 2026-10-06 through 2026-10-10).
//
// A per-run nonce in the plus-alias and the external id makes each run's idempotency
// key unique, so its deterministic id never collides with a prior run's tombstone.
// This mirrors `uniq()` in smoke-booking-api.ts, which already does this for the
// other canary scenarios and so never accumulated a chain. The address stays a
// plus-alias of the real smoketest@trypennie.com mailbox, so Google's invite and
// cancel emails still deliver there rather than bouncing onto the organizer (#396),
// and `smoketest+resched-<n>@` is the shape the orphan sweep already recognises
// (scripts/test-cleanup-smoke-events.ts).
//
// The phone is per run as well (#4060). It was fixed at +12025550123, and person
// dedupe matches on phone alone (a weak match), so on 2026-10-21 a booking a crashed
// run left active turned the next run's create into `409 confirm_required` with the
// OLD booking, which that run then rescheduled and cancelled as its own. The phone is
// built by the shared `smokePhone`, from the same nonce, in the 202 area code the
// booking canary (215) never uses.
//
// Pure, so it is node-testable with an injected nonce (no clock, no network).
import { smokePhone } from "./smoke-identity.ts";

export function rescheduleSmokeIdentity(
  slotIso: string,
  nonce: number,
): { externalId: string; email: string; phone: string } {
  return {
    externalId: `smoke-resched-${slotIso}-${nonce}`,
    email: `smoketest+resched-${nonce}@trypennie.com`,
    phone: smokePhone(nonce, "202"),
  };
}

// The reschedule smoke's attendee identity must be UNIQUE PER RUN (#3576), so its
// deterministic Google event id never collides with a prior run's cancelled
// tombstone and the id chain never exhausts into a false production page. This pins
// that property (and that the address stays a deliverable plus-alias) without
// hitting production.
//
// Run: node --experimental-strip-types scripts/test-smoke-reschedule-identity.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { rescheduleSmokeIdentity } from "./lib/smoke-reschedule-identity.ts";

const slot = "2026-10-12T12:00:00.000Z";

// Stable WITHIN a run: the create, reschedule and cancel steps all use one nonce, so
// two calls with the same nonce must agree.
const a1 = rescheduleSmokeIdentity(slot, 1000);
const a2 = rescheduleSmokeIdentity(slot, 1000);
eq(a1.email, a2.email, "same nonce -> same email (stable within a run)");
eq(a1.externalId, a2.externalId, "same nonce -> same externalId (stable within a run)");

// Unique ACROSS runs: a different nonce on the SAME slot gives a different email AND
// external id, both of which feed the idempotency key the deterministic event id is
// built from, so the id differs run to run and never meets a prior tombstone.
const b = rescheduleSmokeIdentity(slot, 2000);
assert(a1.email !== b.email, "different nonce -> different email");
assert(a1.externalId !== b.externalId, "different nonce -> different externalId");

// Still a plus-alias of the real smoketest@trypennie.com mailbox, so Google's invite
// and cancel mail delivers there (#396) and the orphan sweep still recognises it.
assert(a1.email.startsWith("smoketest+resched-"), "email is a smoketest+resched plus-alias");
assert(a1.email.endsWith("@trypennie.com"), "email is on the trypennie.com mailbox");
assert(!a1.email.includes("++") && a1.email.split("@").length === 2, "email is a single well-formed address");

// The slot is still named in the external id, for readability in the booking row.
assert(a1.externalId.includes(slot), "externalId names the slot it booked");

finish();

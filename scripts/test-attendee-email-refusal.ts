// #3359: which Google refusal means "this attendee email can never be invited".
//
// On 2026-10-06 events.insert answered a lead's `xxxxxxxxxx.@xxxxx.xxx` with
//   400 {"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid attendee email."}],"code":400}}
// and the booker turned it into a 500, then the reservation drain retried it
// thirteen times. The predicate below is what lets both stop. It must be NARROW:
// `reason: "invalid"` is Google's answer to every malformed field (a bad time, a
// bad zone, a bad id), and those are OUR faults, which must keep reaching the
// internal error page and the drain's retry rather than being blamed on the lead.
//
// Run: node --experimental-strip-types scripts/test-attendee-email-refusal.ts
import { GoogleHttpError, isInvalidAttendeeEmailRefusal } from "../src/lib/google/http-error.ts";
import { parseGoogleErrorReason } from "../src/lib/google/reachability-classify.ts";
import { assert, finish } from "./lib/harness.ts";

/** Built the way `ok()` in calendar.ts builds it, from the raw body. */
function fromGoogle(status: number, body: string): GoogleHttpError {
  return new GoogleHttpError(`events.insert failed: ${status} ${body}`, status, parseGoogleErrorReason(body));
}

// The production body, verbatim (it carries no address).
const PRODUCTION =
  '{"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid attendee email."}],"code":400}}';
// Google pretty prints the same body on most responses.
const PRETTY = JSON.stringify(JSON.parse(PRODUCTION), null, 2);

assert(isInvalidAttendeeEmailRefusal(fromGoogle(400, PRODUCTION)), "the production refusal is recognised");
assert(isInvalidAttendeeEmailRefusal(fromGoogle(400, PRETTY)), "and so is the same body pretty printed");

// Narrowness: every one of these must stay an ordinary failure.
const INVALID_TIME =
  '{"error":{"errors":[{"domain":"global","reason":"invalid","message":"Invalid start time."}],"code":400}}';
assert(
  !isInvalidAttendeeEmailRefusal(fromGoogle(400, INVALID_TIME)),
  "another 400 invalid (a bad time we sent) is NOT blamed on the lead's email",
);
assert(
  !isInvalidAttendeeEmailRefusal(fromGoogle(400, '{"error":{"errors":[{"reason":"badRequest","message":"Invalid attendee email."}],"code":400}}')),
  "the sentence under a different reason is not the refusal Google gave in production",
);
assert(
  !isInvalidAttendeeEmailRefusal(fromGoogle(403, PRODUCTION.replace("400", "403"))),
  "a status other than 400 is not this refusal",
);
assert(
  !isInvalidAttendeeEmailRefusal(new Error(`events.insert failed: 400 ${PRODUCTION}`)),
  "a plain Error quoting the text is not a Google answer",
);
assert(!isInvalidAttendeeEmailRefusal(null), "nothing is not a refusal");
assert(!isInvalidAttendeeEmailRefusal("Invalid attendee email."), "nor is a bare string");

finish();

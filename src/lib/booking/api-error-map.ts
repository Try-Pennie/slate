/**
 * Stable, machine-readable error contract (#358) so the bot can act on the
 * outcome without parsing prose: a config error (UNKNOWN_BUCKET /
 * NO_ELIGIBLE_AGENTS) means stop retrying and escalate; SLOT_TAKEN means pick
 * another slot; VERIFY_UNAVAILABLE is transient (retry); INTERNAL is unexpected.
 * OUTSIDE_CALLING_WINDOW (#2310) means the start is before 08:00 or at or after
 * 20:00 in the request's `timezone`: retrying the same time can never succeed,
 * another time can.
 *
 * Moved out of `src/app/api/bookings/route.ts` (#3543) so the direct booking API
 * and Marcia's booking MCP endpoint map a thrown booking error to ONE code, rather
 * than two copies of the mapping drifting apart (L370). The `// refusal:` lines are
 * read by `scripts/test-refusal-catalog.ts`, which lists this file for that reason.
 */
// Imported from the SERVICE, as the route always did, so a suite that mocks the service
// and throws its classes is classified by the same classes the route sees.
import {
  AttendeeEmailRefusedError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
  SlotUnavailableError,
  UnknownBucketError,
  VerifyUnavailableError,
} from "@/lib/booking/service";

export type BookingErrorCode =
  | "UNKNOWN_BUCKET"
  | "NO_ELIGIBLE_AGENTS"
  | "SLOT_TAKEN"
  | "VERIFY_UNAVAILABLE"
  | "OUTSIDE_CALLING_WINDOW"
  | "ATTENDEE_EMAIL_REFUSED"
  | "INTERNAL";

export function mapBookingError(err: unknown): { status: number; code: BookingErrorCode } {
  // Each branch names its decision (#1318). The caller records every one of these as an
  // error outcome under the same code, so the failure-rate window sees all five.
  // refusal: api_unknown_bucket
  if (err instanceof UnknownBucketError) return { status: 422, code: "UNKNOWN_BUCKET" };
  // refusal: api_no_eligible_agents
  if (err instanceof NoEligibleAgentsError) return { status: 409, code: "NO_ELIGIBLE_AGENTS" };
  // refusal: api_slot_taken
  if (err instanceof SlotUnavailableError) return { status: 409, code: "SLOT_TAKEN" };
  // refusal: api_verify_unavailable
  if (err instanceof VerifyUnavailableError) return { status: 503, code: "VERIFY_UNAVAILABLE" };
  // refusal: api_outside_calling_window
  if (err instanceof OutsideCallingWindowError) return { status: 422, code: "OUTSIDE_CALLING_WINDOW" };
  // #3359: Google refused to invite the attendee's address. The caller asks the lead
  // for another one; retrying the same body can never succeed.
  // refusal: api_attendee_email_refused
  if (err instanceof AttendeeEmailRefusedError) return { status: 400, code: "ATTENDEE_EMAIL_REFUSED" };
  // refusal: api_internal
  return { status: 500, code: "INTERNAL" };
}

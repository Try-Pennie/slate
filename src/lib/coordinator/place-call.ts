/**
 * Place a call from the coordinator booking page (#4205): the operation behind the
 * page's one button, everything but the role check and the rate limit, which the server
 * action holds (`src/app/coordinator/actions.ts`).
 *
 *  - The customer is RE-READ from Salesforce on every submit (`findCustomer`): the zone,
 *    bucket and contact details handed to the booking come from the Lead, never from
 *    the page, so nothing the page sends can book a customer in the wrong zone.
 *  - The submission id is the page's when it sent a valid one, and minted otherwise; it
 *    is always handed back, so the page retries a press under the same id and the
 *    booking (`coordinatorKeyFor`) is made once.
 *  - A confirmed move carries a reason the reschedule options allow (`validateReason`).
 *  - Every outcome of `placeBookingForCoordinator` becomes a typed answer with its own
 *    sentence (`coordinator-copy.ts`), and every error it throws a named refusal.
 *
 * Pure apart from the injected deps (relative imports), so
 * `scripts/test-coordinator-place-call.ts` drives every branch.
 */
import { validateReason, type ReasonOption } from "../booking/core.ts";
import {
  PlacedBookingRefusedError,
  type PlacedBookingInput,
  type PlacedBookingOutcome,
  type PlacedCallSummary,
  type PlacedOn,
} from "../booking/placed-booking.ts";
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  ExistingCallCheckUnavailableError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
  RescheduleConflictError,
  RescheduleLockUnavailableError,
  SlotUnavailableError,
  UnknownBucketError,
  VerifyUnavailableError,
} from "../booking/orchestration.ts";
import { AttendeeEmailRefusedError } from "../booking/attendee-email-refused.ts";
import type { CustomerRouting, FoundCustomer } from "./customer.ts";
import {
  bookedSentence,
  movedSentence,
  needsConfirmSentence,
  possibleMatchSentence,
  refusalSentence,
  RETRYABLE_REFUSALS,
  type CoordinatorRefusal,
} from "./coordinator-copy.ts";

export interface PlaceCallRequest {
  /** The Lead link or id, as pasted. */
  reference: string;
  /** The start the customer named. */
  startIso: string;
  /** The page's per submission id; minted when absent or not a uuid. */
  submissionId?: string;
  /** The customer's existing call, confirmed for moving, and why. */
  move?: { bookingId: string; reasonCode: string; reasonDetail?: string };
}

export type PlaceCallOutcome =
  | { kind: "booked"; on: PlacedOn; advisorName: string | null; startsAt: string; zone: string; manageUrl: string; replayed: boolean; submissionId: string; sentence: string }
  | { kind: "moved"; on: PlacedOn; advisorName: string | null; startsAt: string; zone: string; manageUrl: string; submissionId: string; sentence: string }
  | { kind: "needs-confirm"; call: PlacedCallSummary; submissionId: string; sentence: string }
  | { kind: "possible-match"; call: PlacedCallSummary; matchedOn: "email-and-phone" | "email-or-phone"; submissionId: string; sentence: string }
  | { kind: "refused"; reason: CoordinatorRefusal; retryable: boolean; submissionId: string; sentence: string };

export interface PlaceCallDeps {
  /** The customer, re-read with the routing the signed in coordinator decides. */
  findCustomer(reference: string, routing: CustomerRouting): Promise<FoundCustomer>;
  /** `placeBookingForCoordinator`. */
  place(input: PlacedBookingInput): Promise<PlacedBookingOutcome>;
  /** The reschedule reasons a person may submit (`loadReasonOptions().reschedule.selectable`). */
  rescheduleReasons(): Promise<ReasonOption[]>;
  mintSubmissionId(): string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal answered with its sentence and whether trying again unchanged can help. */
export function refused(reason: CoordinatorRefusal, submissionId: string, zone?: string): PlaceCallOutcome {
  return { kind: "refused", reason, retryable: RETRYABLE_REFUSALS.has(reason), submissionId, sentence: refusalSentence(reason, zone) };
}

/** Every error the booking can throw, as the refusal the coordinator is told. */
export function refusalFor(err: unknown): CoordinatorRefusal {
  if (err instanceof PlacedBookingRefusedError) return err.reason;
  if (err instanceof OutsideCallingWindowError) return "outside-calling-window";
  if (err instanceof UnknownBucketError) return "no-bucket";
  if (err instanceof ExistingCallCheckUnavailableError) return "existing-call-unreadable";
  if (err instanceof RescheduleConflictError || err instanceof RescheduleLockUnavailableError) return "move-conflict";
  if (err instanceof BookingNotFoundError || err instanceof BookingNotChangeableError) return "confirmed-call-changed";
  if (err instanceof VerifyUnavailableError) return "calendar-unavailable";
  if (err instanceof AttendeeEmailRefusedError) return "attendee-email-refused";
  if (err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError) return "no-advisor";
  return "internal";
}

export async function placeCall(
  request: PlaceCallRequest,
  /** The signed in coordinator: who placed it, and whether they are a test account (`users.is_test`). */
  coordinator: { id: string; isTest: boolean },
  deps: PlaceCallDeps,
): Promise<PlaceCallOutcome> {
  const submissionId = request.submissionId && UUID.test(request.submissionId) ? request.submissionId : deps.mintSubmissionId();

  let move: PlacedBookingInput["move"];
  if (request.move) {
    const reason = validateReason({ code: request.move.reasonCode, detail: request.move.reasonDetail }, await deps.rescheduleReasons());
    if (!reason.ok) return refused("reason-invalid", submissionId);
    move = { bookingId: request.move.bookingId, reason: reason.reason };
  }

  // The bucket is re-derived here from the Lead and the coordinator; nothing the page
  // sent can name one (a test coordinator always books the partner test bucket).
  const found = await deps.findCustomer(request.reference, { testCoordinator: coordinator.isTest });
  if (!found.ok) return refused(found.refusal, submissionId);
  const { customer } = found;

  let out: PlacedBookingOutcome;
  try {
    out = await deps.place({
      salesforceLeadId: customer.salesforceLeadId,
      bucketCode: customer.bucketCode,
      attendee: {
        name: customer.name ?? undefined,
        firstName: customer.firstName ?? undefined,
        email: customer.email ?? undefined,
        phone: customer.phone ?? undefined,
      },
      timezone: customer.zone,
      startIso: request.startIso,
      coordinatorUserId: coordinator.id,
      submissionId,
      ...(move ? { move } : {}),
    });
  } catch (err) {
    return refused(refusalFor(err), submissionId, customer.zone);
  }

  const zone = customer.zone;
  switch (out.kind) {
    case "booked": {
      const view = viewOf(out, zone);
      return { kind: "booked", ...view, manageUrl: out.manageUrl, replayed: out.replayed, submissionId, sentence: bookedSentence({ ...view, replayed: out.replayed }) };
    }
    case "moved": {
      const view = viewOf(out, zone);
      return { kind: "moved", ...view, manageUrl: out.manageUrl, submissionId, sentence: movedSentence(view) };
    }
    case "existing-call":
      return { kind: "needs-confirm", call: out.call, submissionId, sentence: needsConfirmSentence(out.call, zone) };
    case "possible-match":
      return { kind: "possible-match", call: out.call, matchedOn: out.matchedOn, submissionId, sentence: possibleMatchSentence(out.call, zone, out.matchedOn) };
  }
}

/** What the page shows of a call that was booked or moved. */
function viewOf(out: { on: "advisor" | "placeholder"; booking: { agent_name: string | null; starts_at: string } }, zone: string) {
  return { on: out.on, advisorName: out.booking.agent_name, startsAt: out.booking.starts_at, zone };
}

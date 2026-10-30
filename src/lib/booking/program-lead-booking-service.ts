/**
 * The live wiring of a program lead's booking and move (#4391, `program-lead-booking.ts`).
 *
 * Kept out of `service.ts` like the coordinator's (`placed-booking-service.ts`): it is a
 * new entry point, and everything it drives is the booking machinery every other path
 * uses. Called only by the booker's confirm (`POST /booking`) and the lead facing
 * reschedule route, each after verifying the lead's program lead token.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { deferWebhookSend } from "@/lib/after-response";
import { getBucketSlotsWithFallback } from "@/lib/availability/slot-cache";
import { parseStampMs } from "@/lib/date/stamp";
import { log } from "@/lib/log";
import type { ValidatedReason } from "@/lib/booking/core";
import type { ConfirmLineFacts } from "@/lib/booking/confirm-latency";
import type { BookingContext, CreateBookingInput } from "@/lib/booking/orchestration";
import * as orchestration from "@/lib/booking/orchestration";
import {
  createBooking,
  pageBookingFailure,
  realDeps,
  rescheduleBooking,
  rescheduleProgramLeadOntoPlaceholder,
} from "@/lib/booking/service";
import { readBookingHorizonDays, readPlaceholderBookingEnabled } from "@/lib/booking/settings";
import { findPlaceholderAdvisor } from "@/lib/booking/placed-booking-service";
import {
  bookProgramLead,
  moveProgramLead,
  PlaceholderDayFullError,
  type ProgramLeadOutcome,
} from "@/lib/booking/program-lead-booking";

/**
 * Whether the bucket's cache serves `startIso` right now, through the read the booker's
 * own times come from (`getBucketSlotsWithFallback`, the tier fallback included), so a
 * time the lead was shown as a real one books a real advisor first. Null when it could
 * not be read, or the bucket is unknown: the normal create then runs and answers it.
 */
export async function isServedSlot(bucketCode: string, startIso: string, allowTestBuckets: boolean): Promise<boolean | null> {
  const startMs = parseStampMs(startIso);
  if (startMs === null) return null;
  try {
    const served = await getBucketSlotsWithFallback(bucketCode, startIso, allowTestBuckets);
    if (!served) return null;
    return served.slots.some((s) => parseStampMs(s) === startMs);
  } catch (err) {
    log.warn("program-lead", { msg: "the served times could not be read for a program lead's confirm", bucket_code: bucketCode }, err);
    return null;
  }
}

/** `claim_placeholder_day` (0213). THROWS on a failed call or an answer that is not a boolean. */
export async function claimPlaceholderDay(day: string, claimKey: string, bookingId: string | null): Promise<boolean> {
  const granted = unwrap(
    await supabaseAdmin().rpc("claim_placeholder_day", { p_day: day, p_claim_key: claimKey, p_booking_id: bookingId }),
    "claim_placeholder_day",
  );
  if (typeof granted !== "boolean") throw new Error(`claim_placeholder_day answered ${JSON.stringify(granted)}, not a boolean`);
  return granted;
}

/**
 * Count one full day refusal (`bump_program_lead_outcome('limit_refused')`, migration
 * 0215), on today's Eastern day as the function counts, beside #4390's `times_fallback`.
 * THROWS on a refused or failed call, so it is never read as counted; the caller
 * (`program-lead-booking.ts`) logs that and still answers the full day. `_callDay` is the
 * day of the CALL, which the caller logs; the count itself is by the day it happened.
 */
export async function countLimitRefusal(_callDay: string): Promise<void> {
  const { error } = await supabaseAdmin().rpc("bump_program_lead_outcome", { p_kind: "limit_refused" });
  if (error) throw new Error(`bump_program_lead_outcome failed: ${error.message}`);
}

/**
 * Errors the normal create or the ordinary move already paged for, so the wrapper below
 * does not page them twice. Everything the placeholder half throws pages here instead.
 */
const pagedAlready = new WeakSet<object>();

function remember<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((err: unknown) => {
    if (err && typeof err === "object") pagedAlready.add(err);
    throw err;
  });
}

/**
 * Page a placeholder path failure as a booking failure (`pageBookingFailure`), once. A
 * full day refusal is never paged, by rule here rather than by `bookingFailureAlert`
 * happening to have no alert for its class: it is the limit doing its job, counted by
 * `countLimitRefusal` and alerted on per day by #4392.
 */
export async function pagingFailures<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (caught) {
    if (caught instanceof PlaceholderDayFullError) throw caught;
    if (caught && typeof caught === "object" && pagedAlready.has(caught)) throw caught;
    const err = orchestration.timeoutAsRetryable(caught);
    await pageBookingFailure(err);
    throw err;
  }
}

/** Book a program lead's call from the booker's confirm. */
export function bookProgramLeadLive(input: CreateBookingInput, lineFacts?: ConfirmLineFacts): Promise<ProgramLeadOutcome> {
  const deps = realDeps(deferWebhookSend, lineFacts);
  return pagingFailures(() =>
    bookProgramLead(input, {
      now: () => Date.now(),
      placeholderEnabled: readPlaceholderBookingEnabled,
      isServedSlot,
      businessHours: () => deps.businessHours(),
      horizonDays: readBookingHorizonDays,
      findPlaceholder: findPlaceholderAdvisor,
      claimPlaceholderDay,
      countLimitRefusal,
      createBooking: (i) => remember(() => createBooking(i, lineFacts)),
      findBookingByIdempotencyKey: (key) => deps.findBookingByIdempotencyKey(key),
      manageUrl: (token) => orchestration.manageUrlFor(deps.appBaseUrl(), token),
      resolveBucketByCode: (code) => deps.resolveBucketByCode(code),
      findExistingCall: (identity, world) => orchestration.findExistingCallForIdentity(identity, deps, world),
      createPlaceholderBooking: (i) => orchestration.createPlaceholderBooking(i, deps),
    }),
  );
}

/**
 * The booking a lead's move names by its manage token, for the route to verify the move
 * token against, or null when it cannot be read (the ordinary move then answers it).
 */
export async function loadProgramLeadMoveContext(token: string): Promise<BookingContext | null> {
  try {
    return await realDeps().loadBookingContext(token);
  } catch (err) {
    log.warn("program-lead", { msg: "the booking a program lead is moving could not be read; moving it as an ordinary one" }, err);
    return null;
  }
}

/** Move a program lead's call, from the lead facing reschedule route only. */
export function moveProgramLeadLive(input: {
  token: string;
  ctx: BookingContext;
  startIso: string;
  reason: ValidatedReason;
  attendee?: { name?: string; firstName?: string; email?: string; phone?: string };
  zone?: string | null;
  lineFacts?: ConfirmLineFacts;
}): Promise<ProgramLeadOutcome> {
  const deps = realDeps(deferWebhookSend, input.lineFacts);
  const zone = input.zone ?? null;
  return pagingFailures(() =>
    moveProgramLead(
      { booking: input.ctx.booking, bucket: input.ctx.bucket, eventType: input.ctx.eventType, startIso: input.startIso, zone },
      {
        now: () => Date.now(),
        placeholderEnabled: readPlaceholderBookingEnabled,
        isServedSlot,
        businessHours: () => deps.businessHours(),
        horizonDays: readBookingHorizonDays,
        findPlaceholder: findPlaceholderAdvisor,
        claimPlaceholderDay,
        countLimitRefusal,
        reschedule: ({ ontoPlaceholder }) =>
          remember(() =>
            ontoPlaceholder
              ? rescheduleProgramLeadOntoPlaceholder(input.token, input.startIso, input.reason, ontoPlaceholder, input.attendee, zone, input.lineFacts)
              : rescheduleBooking(input.token, input.startIso, input.reason, "customer", input.attendee, zone, input.lineFacts),
          ),
      },
    ),
  );
}

/**
 * Booking and moving a program lead (#4391, Phase 5 of #4255).
 *
 * A program lead (`program-lead.ts`) holding a verified token may book a time no real
 * advisor is free for, on the placeholder advisor, up to the placeholder day limit
 * (`booking_settings.placeholder_day_limit`, counted by the Eastern day of the CALL).
 * A real free advisor always comes first. The rules, as settled on #4255 and its plan:
 *
 *  - A start the bucket's cache SERVES books through the normal create, marked
 *    `program_lead`. A refusal for want of a free advisor there (a lost race,
 *    `noFreeAdvisor`) falls to the placeholder, and the route records that as its own
 *    outcome, never a refusal. An outage is answered as itself.
 *  - A start the cache does NOT serve is placeholder only, so it goes STRAIGHT to the
 *    placeholder: the normal create never runs, so no refused routing decision, offer
 *    race judgement or failure share is written for a time nobody real was offering.
 *  - The placeholder path, in this order: the replay read (a double submit answers the
 *    first booking, whichever path made it), the one call per person rule, the start's
 *    own checks (nothing past, the event type's minimum notice, Pennie's hours for the
 *    whole call, the lead's calling window, the horizon), the day claim
 *    (`claim_placeholder_day`), and only then the reservation, the invite and the commit
 *    (`createPlaceholderBooking`). So a lead over the limit is never invited.
 *  - The go live switch (`placeholder_booking_enabled`) off or unreadable means no
 *    placeholder at all: the confirm is the normal create, still marked.
 *  - A test bucket's call never claims: the limit counts the real world only (0213).
 *
 * A MOVE follows the same rules through the lead facing reschedule route only, never the
 * shared `rescheduleBooking`, so Marcia's MCP channel, admin moves, the direct API and
 * the coordinator keep #4203 (a call is never moved onto the placeholder for them). The
 * route hands this the booking it already verified the token against; the fall onto the
 * placeholder claims the new day with the booking's own id, so it never counts against
 * its own move, then moves through `commit_reschedule_onto_placeholder`.
 *
 * A start is a placeholder start exactly when #4390's times offer it (`placeholderStarts`
 * in `program-lead-times.ts`, the coordinator's start rule in `bookable-hours.ts` with the
 * event type's notice and interval), and its day is `placeholderCallDay` from the same
 * module, so the times shown and the times accepted cannot disagree (L370).
 *
 * Pure apart from the injected deps (relative imports), so
 * `scripts/test-program-lead-booking.ts` drives every branch;
 * `program-lead-booking-service.ts` wires the real ones.
 */
import type { BusinessHoursRules } from "../availability/compute.ts";
import { withinLeadCallingWindow } from "./lead-calling-window.ts";
import { noFreeAdvisor } from "./placed-booking.ts";
import { placeholderCallDay, placeholderStarts } from "./program-lead-times.ts";
import {
  ExistingCallError,
  OutsideCallingWindowError,
  SlotUnavailableError,
  UnknownBucketError,
  VerifyUnavailableError,
  personIdentityOf,
  stableKeyFor,
  type BookingResult,
  type CreateBookingInput,
  type ExistingCall,
  type PlaceholderBookingInput,
} from "./orchestration.ts";
import type { NamedWorld, PersonIdentity } from "./person-dedupe.ts";
import type { Booking, Bucket, EventType, User } from "../db/types.ts";
import { log } from "@/lib/log";

/** The code the over limit refusal carries, so the booker tells it from a taken time (L35). */
export { PLACEHOLDER_DAY_FULL_CODE } from "./placeholder-day-full.ts";

/**
 * The day's placeholder places are all taken (#4391). Its own refusal with its own
 * sentence, never the taken time one (L11): the time itself is not taken, the day's
 * extra times are, and the picker refreshed after it shows that day's real times only.
 */
export class PlaceholderDayFullError extends Error {
  readonly callDay: string;
  constructor(callDay: string) {
    super(`the placeholder day limit for ${callDay} is reached`);
    this.name = "PlaceholderDayFullError";
    this.callDay = callDay;
  }
}

/**
 * How the booking was made: through the normal create on a served start (`real-slot`,
 * also every confirm with the switch off), on the placeholder after that lost
 * (`lost-race`), or on the placeholder because the start was placeholder only
 * (`straight`). A replay answers with the path the repeat took, and `onPlaceholder` with
 * where the first booking actually is.
 */
export type ProgramLeadPath = "real-slot" | "lost-race" | "straight";

export interface ProgramLeadOutcome {
  result: BookingResult;
  path: ProgramLeadPath;
  onPlaceholder: boolean;
}

/** What both the booking and the move read about the placeholder. */
interface PlaceholderDeps {
  now(): number;
  /** `booking_settings.placeholder_booking_enabled`, or null when the read failed. */
  placeholderEnabled(): Promise<boolean | null>;
  /** Whether the bucket's cache serves `startIso` right now, or null when it could not be read. */
  isServedSlot(bucketCode: string, startIso: string, allowTestBuckets: boolean): Promise<boolean | null>;
  /** The org's week and date exceptions. THROWS when unreadable. */
  businessHours(): Promise<BusinessHoursRules>;
  /** The booking horizon in open days, or null when the read failed. */
  horizonDays(): Promise<number | null>;
  /** The org's placeholder in the given world, or null when it has none. THROWS on a failed read. */
  findPlaceholder(orgId: string, isTest: boolean): Promise<User | null>;
  /** `claim_placeholder_day`: true when a place was granted. THROWS when it could not be asked. */
  claimPlaceholderDay(day: string, claimKey: string, bookingId: string | null): Promise<boolean>;
  /**
   * Count one limit refusal (`bump_program_lead_outcome('limit_refused')`, 0215). MAY
   * throw: the caller logs a failure and still answers the full day, since a count that
   * failed must never change what the lead is told.
   */
  countLimitRefusal(callDay: string): Promise<void>;
}

export interface ProgramLeadBookingDeps extends PlaceholderDeps {
  /** The normal create (`service.createBooking`). */
  createBooking(input: CreateBookingInput): Promise<BookingResult>;
  /** The active booking an earlier submit with this key made, or null. */
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  manageUrl(token: string): string;
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /** The call this person already has (`findExistingCallForIdentity`). THROWS when it cannot be read. */
  findExistingCall(identity: PersonIdentity, world: NamedWorld): Promise<ExistingCall | null>;
  /** `orchestration.createPlaceholderBooking`. */
  createPlaceholderBooking(input: PlaceholderBookingInput): Promise<BookingResult>;
}

export interface ProgramLeadMoveDeps extends PlaceholderDeps {
  /** The shared reschedule as the lead's own move; `ontoPlaceholder` set only by this module. */
  reschedule(args: { ontoPlaceholder?: User }): Promise<BookingResult>;
}


/** The claim key a move takes its place under: one per booking, so a retry keeps its place. */
export function moveClaimKey(bookingId: string): string {
  return `program-move:${bookingId}`;
}

/** The go live switch, read as on only when it says so. */
async function switchedOn(deps: PlaceholderDeps): Promise<boolean> {
  const enabled = await deps.placeholderEnabled();
  if (enabled === null) {
    log.error("program-lead", { msg: "the placeholder switch could not be read, so a program lead gets real times only" });
  }
  return enabled === true;
}

/** A served start, with an unreadable cache read as served: a real advisor is always asked first. */
async function servedOrUnknown(deps: PlaceholderDeps, bucketCode: string, startIso: string, allowTest: boolean): Promise<boolean> {
  const served = await deps.isServedSlot(bucketCode, startIso, allowTest);
  if (served === null) {
    log.warn("program-lead", { msg: "the slot cache could not be read, so the confirm asks a real advisor first", bucket_code: bucketCode });
  }
  return served !== false;
}

/** A failed read on the placeholder path is the retryable outage, never a booking or a refusal. */
function outage(err: unknown): VerifyUnavailableError {
  if (err instanceof VerifyUnavailableError) return err;
  const mapped = new VerifyUnavailableError();
  mapped.cause = err;
  return mapped;
}

async function attempt<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw outage(err);
  }
}

/**
 * The start's own check, before any claim. Answers null when it may go on the placeholder,
 * or the refusal. ONE predicate with the times the lead is shown (#4390): the start must be
 * one of `placeholderStarts` for this lead's zone, the coordinator page's start rule
 * (`bookable-hours.ts`: business hours, calling window, horizon, nothing past) with the
 * event type's minimum notice and slot interval. The calling window is asked first only so
 * it answers with its own sentence (`OutsideCallingWindowError`); anything else the times
 * never offered is `SlotUnavailableError`, and a refreshed picker is the right answer.
 */
async function startRefusal(
  deps: PlaceholderDeps,
  rules: { startIso: string; zone: string; eventType: EventType },
): Promise<Error | null> {
  const startMs = Date.parse(rules.startIso);
  const nowMs = deps.now();
  if (!Number.isFinite(startMs) || startMs <= nowMs) return new SlotUnavailableError();
  if (!withinLeadCallingWindow(rules.startIso, rules.zone)) return new OutsideCallingWindowError(rules.zone);
  const hours = await attempt(() => deps.businessHours());
  const horizonDays = await attempt(() => deps.horizonDays());
  if (horizonDays === null) throw new VerifyUnavailableError();
  const offered = placeholderStarts({ hours, zone: rules.zone, nowMs, horizonDays, eventType: rules.eventType });
  return offered.some((iso) => Date.parse(iso) === startMs) ? null : new SlotUnavailableError();
}

/** Take a place on the call's Eastern day, or refuse it as full. A test call never claims. */
async function claimDay(
  deps: PlaceholderDeps,
  bucket: Bucket,
  startIso: string,
  claimKey: string,
  bookingId: string | null,
): Promise<void> {
  if (bucket.is_test) return;
  const day = placeholderCallDay(Date.parse(startIso));
  const granted = await attempt(() => deps.claimPlaceholderDay(day, claimKey, bookingId));
  if (!granted) {
    // Its own tag beside the per day count (`countLimitRefusal`, shown on /admin/program-leads).
    log.info("program-lead-day-full", { msg: "a program lead met a full placeholder day", call_day: day, bucket_code: bucket.code, ...(bookingId ? { booking_id: bookingId } : {}) });
    try {
      await deps.countLimitRefusal(day);
    } catch (err) {
      // The one failure nothing else sees: the refusal happened and was not counted.
      log.error("program-lead-day-full", { msg: "a full placeholder day refusal could not be counted", call_day: day }, err);
    }
    throw new PlaceholderDayFullError(day);
  }
}

/**
 * Book a program lead's call. `input` is the booker's confirm as the route built it; the
 * route has already verified the lead's token.
 */
export async function bookProgramLead(requested: CreateBookingInput, deps: ProgramLeadBookingDeps): Promise<ProgramLeadOutcome> {
  const input: CreateBookingInput = { ...requested, programLead: true };
  const ordinary = async (): Promise<ProgramLeadOutcome> => {
    const result = await deps.createBooking(input);
    return { result, path: "real-slot", onPlaceholder: result.booking.kind === "staff_placed" };
  };
  const key = stableKeyFor(input);
  // A program lead always names their Lead, so this holds; without a key a double submit
  // could not be recognised on the placeholder, so such a confirm stays ordinary.
  if (key === null || !(await switchedOn(deps))) return ordinary();

  if (await servedOrUnknown(deps, input.bucketCode, input.startIso, input.allowTestBuckets ?? false)) {
    try {
      return await ordinary();
    } catch (err) {
      if (!noFreeAdvisor(err)) throw err;
      return onPlaceholder(input, key, "lost-race", deps, err);
    }
  }
  return onPlaceholder(input, key, "straight", deps, null);
}

/**
 * The placeholder half of a booking. `fellFrom` is the lost race that sent it here, which
 * is answered again (rather than a new refusal) when the placeholder cannot take the call
 * for a reason the lead did not cause: no placeholder to hold it.
 */
async function onPlaceholder(
  input: CreateBookingInput,
  key: string,
  path: Exclude<ProgramLeadPath, "real-slot">,
  deps: ProgramLeadBookingDeps,
  fellFrom: unknown,
): Promise<ProgramLeadOutcome> {
  // First, before anything that could refuse: a repeat of a submit that already booked
  // (on the placeholder, or on the real advisor whose slot it then filled) is that booking.
  const replay = await deps.findBookingByIdempotencyKey(key);
  if (replay) {
    return { result: { booking: replay, manageUrl: deps.manageUrl(replay.manage_token) }, path, onPlaceholder: replay.kind === "staff_placed" };
  }

  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new UnknownBucketError();
  const { bucket, eventType } = resolved;
  // The same rule the normal create applies: a test bucket only with the test pass.
  if (bucket.is_test && !input.allowTestBuckets) throw new UnknownBucketError();

  // One call per person, as the booker's confirm refuses (#1337), in the bucket's world.
  if (input.refuseIfPersonHasCall) {
    const existing = await deps.findExistingCall(personIdentityOf(input), { isTest: bucket.is_test });
    if (existing) throw new ExistingCallError(existing);
  }

  const refused = await startRefusal(deps, { startIso: input.startIso, zone: input.timezone, eventType });
  if (refused) throw path === "lost-race" ? fellFrom : refused;

  const placeholder = await attempt(() => deps.findPlaceholder(bucket.org_id, bucket.is_test));
  if (!placeholder) {
    // The switch is on with no usable placeholder: `placeholder_missing` pages for it.
    log.error("program-lead", { msg: "a program lead's call had no placeholder to go on", bucket_code: bucket.code, path });
    throw path === "lost-race" ? fellFrom : new SlotUnavailableError();
  }

  await claimDay(deps, bucket, input.startIso, key, null);

  const result = await deps.createPlaceholderBooking({
    bucket,
    eventType,
    placeholder,
    startIso: input.startIso,
    timezone: input.timezone,
    // Present: a key exists only for a confirm naming its Lead (`stableKeyFor`).
    salesforceId: input.salesforceId ?? "",
    attendee: input.attendee,
    idempotencyKey: key,
    programLead: { prefill: input.prefill, referrerOrigin: input.referrerOrigin ?? null },
  });
  log.info("program-lead", { msg: "a program lead's call went on the placeholder", booking_id: result.booking.id, path, bucket_code: bucket.code });
  return { result, path, onPlaceholder: result.booking.kind === "staff_placed" };
}

/** What a lead's move of their program booking is made from: the booking the route verified. */
export interface ProgramLeadMove {
  booking: Booking;
  bucket: Bucket;
  eventType: EventType;
  startIso: string;
  /** The zone the lead picked the time in, or null to judge in the zone the booking holds. */
  zone: string | null;
}

/**
 * Move a program lead's call, from the lead facing reschedule route only. A real advisor
 * first through the shared reschedule; the placeholder only when nobody real can take the
 * time, or straight there when the cache does not serve it.
 */
export async function moveProgramLead(move: ProgramLeadMove, deps: ProgramLeadMoveDeps): Promise<ProgramLeadOutcome> {
  const ordinary = async (): Promise<ProgramLeadOutcome> => {
    const result = await deps.reschedule({});
    return { result, path: "real-slot", onPlaceholder: result.booking.kind === "staff_placed" };
  };
  // A "move" onto the time the call already holds is the shared reschedule's no-op.
  if (Date.parse(move.booking.starts_at) === Date.parse(move.startIso)) return ordinary();
  if (!(await switchedOn(deps))) return ordinary();

  if (await servedOrUnknown(deps, move.bucket.code, move.startIso, move.bucket.is_test)) {
    try {
      return await ordinary();
    } catch (err) {
      if (!noFreeAdvisor(err)) throw err;
      return moveOntoPlaceholder(move, "lost-race", deps, err);
    }
  }
  return moveOntoPlaceholder(move, "straight", deps, null);
}

async function moveOntoPlaceholder(
  move: ProgramLeadMove,
  path: Exclude<ProgramLeadPath, "real-slot">,
  deps: ProgramLeadMoveDeps,
  fellFrom: unknown,
): Promise<ProgramLeadOutcome> {
  const { booking, bucket, eventType, startIso } = move;
  const refused = await startRefusal(deps, { startIso, zone: move.zone ?? booking.timezone, eventType });
  if (refused) throw path === "lost-race" ? fellFrom : refused;
  const placeholder = await attempt(() => deps.findPlaceholder(bucket.org_id, bucket.is_test));
  if (!placeholder) {
    log.error("program-lead", { msg: "a program lead's move had no placeholder to go on", booking_id: booking.id, path });
    throw path === "lost-race" ? fellFrom : new SlotUnavailableError();
  }
  // The booking's own id, so it never counts against its own move (0213).
  await claimDay(deps, bucket, startIso, moveClaimKey(booking.id), booking.id);
  const result = await deps.reschedule({ ontoPlaceholder: placeholder });
  log.info("program-lead", { msg: "a program lead's call moved onto the placeholder", booking_id: booking.id, path });
  return { result, path, onPlaceholder: result.booking.kind === "staff_placed" };
}

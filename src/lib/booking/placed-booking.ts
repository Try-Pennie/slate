/**
 * The coordinator's booking (#4202, Phase 4 of milestone 75): ONE operation the
 * coordinator page calls (Phase 7) to book whatever time a customer names on the phone.
 * Plan: https://claude.ai/artifact/XbByMLoaMrBufMr6Chmct1
 *
 * The rules, as Sam and Dan decided them on 2026-10-23 (the issue's comments):
 *
 *  - KEPT, for every call this places: Pennie's business hours (outside them nothing books), the
 *    customer's calling window of 08:00 to before 20:00 in the zone GIVEN (required:
 *    never a device or Eastern default), the horizon, and nothing in the past.
 *  - A REAL ADVISOR FIRST: the normal create (slot predicate, verify on book, confirm
 *    line) books a free advisor in the customer's bucket. Only its refusal for want of
 *    one (`noFreeAdvisor`) falls to the placeholder; an outage is reported as itself.
 *  - THE PLACEHOLDER: the org's own, in the bucket's world, stacked with any others at
 *    that time (`createPlaceholderBooking`). None found is its own refusal.
 *  - THE GO LIVE SWITCH gates ONLY the fall to the placeholder (Dan, 2026-10-26): off or
 *    unreadable (never read as on), a free real advisor still books, and a confirmed move
 *    still moves to one; only when nobody is free is it refused, `switch-off` or
 *    `switch-unreadable`, instead of using the placeholder.
 *  - ONE CALL PER CUSTOMER, matched on the Salesforce id alone. Without a confirmation
 *    naming that call the call is shown so the page can ask; with one, the SAME booking
 *    moves (one Rescheduled event, the same manage link), to a real advisor first and
 *    otherwise onto the placeholder. A call matching only on email or phone is shown
 *    and refused: moving or doubling a stranger's call is worse than asking.
 *  - A DOUBLE SUBMIT books once: the key is the page's per submission id
 *    (`coordinatorKeyFor`), never the person and the start, which repeats the #3291
 *    tombstone defect, and a repeat is answered with the first's booking.
 *
 * Every write goes through the booking machinery and the store, never this module: the
 * coordinator and their page are recorded on the booking row by the save itself
 * (`placed_by_user_id`, source `coordinator`), and a move's history row names them as
 * its actor, written by the outbox step the move's commit records (L593).
 *
 * Pure apart from the injected deps (relative imports, so the node suite runs it):
 * `scripts/test-placed-booking.ts` drives every branch; `service.ts` wires the real ones.
 */
import { DateTime, IANAZone } from "luxon";
import { windowOnDate } from "./business-hours.ts";
import { isOrgOpen, type BusinessHoursRules } from "../availability/compute.ts";
import { withinLeadCallingWindow } from "./lead-calling-window.ts";
import { findPersonMatch, type MatchStrength, type PersonIdentity, type NamedWorld } from "./person-dedupe.ts";
import { leadIdSpellings } from "../salesforce/lead-xbc.ts";
import {
  ExistingCallCheckUnavailableError,
  NoEligibleAgentsError,
  OutsideCallingWindowError,
  RescheduleConflictError,
  SlotUnavailableError,
  UnknownBucketError,
  type BookingResult,
  type CreateBookingInput,
  type KnownBucket,
  type PlaceholderBookingInput,
} from "./orchestration.ts";
import type { ValidatedReason } from "./core.ts";
import type { Booking, Bucket, EventType, User } from "../db/types.ts";
import { log } from "@/lib/log";

/** The idempotency key of one submission of the coordinator page, under a prefix no other key carries. */
export function coordinatorKeyFor(submissionId: string): string {
  return `coordinator:${submissionId}`;
}

export interface PlacedBookingInput {
  /** The customer's Salesforce Lead id. Required: every customer is a Lead (Sam, 2026-10-23). */
  salesforceLeadId: string;
  /** The customer's bucket code. */
  bucketCode: string;
  attendee: { name?: string; firstName?: string; email?: string; phone?: string };
  /** The customer's IANA zone, which the page derives from the Lead. Never defaulted. */
  timezone: string;
  /** The start the customer named. */
  startIso: string;
  /** The signed in coordinator. */
  coordinatorUserId: string;
  /** A uuid minted per submission of the page, so a double submit books once. */
  submissionId: string;
  /**
   * The customer's existing call the coordinator CONFIRMED moving, and the reason they
   * gave. Absent on a first submit; an existing call is then shown, never moved.
   */
  move?: { bookingId: string; reason: ValidatedReason };
}

/** Where the call landed: a real advisor, or the placeholder. */
export type PlacedOn = "advisor" | "placeholder";

/** The customer's existing call, as the coordinator is shown it. */
export interface PlacedCallSummary {
  bookingId: string;
  startsAt: string;
  timezone: string;
  advisorName: string | null;
  onPlaceholder: boolean;
}

export type PlacedBookingOutcome =
  /** A new call. `replayed`: this submission was already booked, and that booking is the answer. */
  | { kind: "booked"; on: PlacedOn; booking: Booking; manageUrl: string; replayed: boolean }
  /** The customer's existing call, moved: the same booking and manage link. */
  | { kind: "moved"; on: PlacedOn; booking: Booking; manageUrl: string }
  /** The customer already has this call; confirm moving it (`move`) to go ahead. */
  | { kind: "existing-call"; call: PlacedCallSummary }
  /** A call that matches the customer only on email or phone: shown, and refused. */
  | { kind: "possible-match"; call: PlacedCallSummary; matchedOn: "email-and-phone" | "email-or-phone" };

/** Why the operation refused before booking or moving anything. Each has its own sentence. */
export const PLACED_BOOKING_REFUSALS = [
  "lead-id-missing",
  "submission-id-invalid",
  "zone-missing",
  "start-unreadable",
  "start-in-past",
  "switch-unreadable",
  "switch-off",
  "horizon-unreadable",
  "beyond-horizon",
  "outside-business-hours",
  "no-placeholder",
  "confirmed-call-changed",
] as const;
export type PlacedBookingRefusal = (typeof PLACED_BOOKING_REFUSALS)[number];

const REFUSAL_SENTENCE: Record<PlacedBookingRefusal, string> = {
  "lead-id-missing": "This customer has no Salesforce Lead id, so the call cannot be placed.",
  "submission-id-invalid": "This booking could not be told apart from another, so nothing was placed. Reload and try again.",
  "zone-missing": "This customer has no usable time zone on their Lead, so the call cannot be placed.",
  "start-unreadable": "That time could not be read, so nothing was placed.",
  "start-in-past": "That time has already passed.",
  "switch-unreadable": "No advisor is free then, and placing calls on the placeholder advisor could not be checked as switched on, so nothing was placed. Try again in a moment.",
  "switch-off": "No advisor is free then, and placing calls on the placeholder advisor is switched off.",
  "horizon-unreadable": "How far ahead calls can be booked could not be read, so nothing was placed. Try again in a moment.",
  "beyond-horizon": "That time is further ahead than calls can be booked.",
  "outside-business-hours": "Pennie is closed at that time.",
  "no-placeholder": "No advisor is free then, and this team has no placeholder advisor to hold the call.",
  "confirmed-call-changed": "The call you confirmed moving is no longer active. Check the customer's calls and try again.",
};

export class PlacedBookingRefusedError extends Error {
  readonly reason: PlacedBookingRefusal;
  constructor(reason: PlacedBookingRefusal) {
    super(REFUSAL_SENTENCE[reason]);
    this.name = "PlacedBookingRefusedError";
    this.reason = reason;
  }
}

export interface PlacedBookingDeps {
  now(): number;
  /** The manage page for a booking's token (`manageUrlFor`). */
  manageUrl(token: string): string;
  /** `booking_settings.placeholder_booking_enabled`, or null when the read failed. */
  placeholderEnabled(): Promise<boolean | null>;
  /** The booking horizon in open days, or null when the read failed. */
  horizonDays(): Promise<number | null>;
  /** The org's week and date exceptions. THROWS when unreadable. */
  businessHours(): Promise<BusinessHoursRules>;
  resolveBucketByCode(code: string): Promise<{ bucket: Bucket; eventType: EventType } | null>;
  /** The active booking this submission already made, or null. */
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  /** The customer's active calls in the bucket's world. THROWS on a failed read. */
  findActiveBookingsForPerson(identity: PersonIdentity, world: NamedWorld): Promise<Booking[]>;
  /** The org's placeholder in the given world, or null when it has none. THROWS on a failed read. */
  findPlaceholder(orgId: string, isTest: boolean): Promise<User | null>;
  /** The normal create (`orchestration.createBooking`). */
  createBooking(input: CreateBookingInput, opts: { requested: KnownBucket }): Promise<BookingResult>;
  /** `orchestration.createPlaceholderBooking`. */
  createPlaceholderBooking(input: PlaceholderBookingInput): Promise<BookingResult>;
  /** `orchestration.rescheduleBooking` as staff, with the customer's zone, and the placeholder to land on when given. */
  rescheduleBooking(args: {
    token: string;
    startIso: string;
    reason: ValidatedReason;
    actorUserId: string;
    zone: string;
    ontoPlaceholder?: User;
  }): Promise<BookingResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A refusal of the real advisor path that says nobody in the bucket can take the time,
 * which is the one case the placeholder exists for. A refusal that is an outage (verify
 * on book, a deadline, the line) is NOT one: the advisor may well be free, and placing
 * the call on Marcia would hide the outage behind a call that looks booked.
 */
export function noFreeAdvisor(err: unknown): boolean {
  return err instanceof SlotUnavailableError || err instanceof NoEligibleAgentsError;
}

const placedOn = (booking: Booking): PlacedOn => (booking.kind === "staff_placed" ? "placeholder" : "advisor");

/**
 * Who the customer is, for the one call per customer rule and the coordinator page's
 * lookup alike (#4205), so the two cannot find different calls. The Lead id goes in
 * BOTH spellings: Slate stores whichever a caller sent (memory: 15 against 18 on
 * 2026-10-14), and a strong id may sit in either id column (`bookingMatchesLookupIds`),
 * so the 15 character key rides in the second slot rather than being lost.
 */
export function placedIdentity(leadId: string, attendee: { email?: string; phone?: string }): PersonIdentity {
  const { short, long } = leadIdSpellings(leadId);
  return {
    externalId: short === long ? null : short,
    salesforceId: long,
    email: attendee.email ?? null,
    phone: attendee.phone ?? null,
  };
}

/** How a call matching only on email or phone is named to the coordinator. */
export function looseMatchKind(strength: Exclude<MatchStrength, "strong">): "email-and-phone" | "email-or-phone" {
  return strength === "medium" ? "email-and-phone" : "email-or-phone";
}

export function placedCallSummary(booking: Booking): PlacedCallSummary {
  return {
    bookingId: booking.id,
    startsAt: booking.starts_at,
    timezone: booking.timezone,
    advisorName: booking.agent_name,
    onPlaceholder: booking.kind === "staff_placed",
  };
}

/**
 * Whether `startMs` falls on one of the first `horizonDays` days Pennie is open, counted
 * in the org's zone from today. A day whose hours are already over counts for nothing,
 * as the booker offers only days that still have times (`trimToBookableDays`).
 */
export function withinHorizon(hours: BusinessHoursRules, startMs: number, nowMs: number, horizonDays: number): boolean {
  const startDay = DateTime.fromMillis(startMs, { zone: hours.zone }).toISODate();
  let day = DateTime.fromMillis(nowMs, { zone: hours.zone }).startOf("day");
  let open = 0;
  // Bounded: a long closure must not turn a far start into an unbounded walk.
  for (let i = 0; i < 366 && open < horizonDays; i++, day = day.plus({ days: 1 })) {
    const iso = day.toISODate();
    if (iso === null) return false;
    const window = windowOnDate(hours, iso, day.weekday);
    if (!window) continue;
    if (day.plus({ minutes: window.end_minute }).toMillis() <= nowMs) continue;
    open++;
    if (iso === startDay) return true;
  }
  return false;
}

export async function placeBooking(input: PlacedBookingInput, deps: PlacedBookingDeps): Promise<PlacedBookingOutcome> {
  const leadId = input.salesforceLeadId.trim();
  if (leadId === "") throw new PlacedBookingRefusedError("lead-id-missing");
  if (!UUID.test(input.submissionId)) throw new PlacedBookingRefusedError("submission-id-invalid");
  const zone = input.timezone.trim();
  if (zone === "" || !IANAZone.isValidZone(zone)) throw new PlacedBookingRefusedError("zone-missing");
  const startMs = Date.parse(input.startIso);
  if (!Number.isFinite(startMs)) throw new PlacedBookingRefusedError("start-unreadable");

  const key = coordinatorKeyFor(input.submissionId);
  const replay = await deps.findBookingByIdempotencyKey(key);
  if (replay) {
    return { kind: "booked", on: placedOn(replay), booking: replay, manageUrl: deps.manageUrl(replay.manage_token), replayed: true };
  }

  const resolved = await deps.resolveBucketByCode(input.bucketCode);
  if (!resolved) throw new UnknownBucketError();
  const { bucket, eventType } = resolved;

  const nowMs = deps.now();
  if (startMs <= nowMs) throw new PlacedBookingRefusedError("start-in-past");
  const hours = await deps.businessHours();
  // Pennie's hours are the top level: outside them nothing books, then the customer's
  // own window applies inside them (Dan, 2026-10-23).
  if (!isOrgOpen(hours, startMs, startMs + eventType.duration_min * 60_000)) {
    throw new PlacedBookingRefusedError("outside-business-hours");
  }
  if (!withinLeadCallingWindow(input.startIso, zone)) throw new OutsideCallingWindowError(zone);
  const horizon = await deps.horizonDays();
  if (horizon === null) throw new PlacedBookingRefusedError("horizon-unreadable");
  if (!withinHorizon(hours, startMs, nowMs, horizon)) throw new PlacedBookingRefusedError("beyond-horizon");

  const identity = placedIdentity(leadId, input.attendee);
  let calls: Booking[];
  try {
    calls = await deps.findActiveBookingsForPerson(identity, { isTest: bucket.is_test });
  } catch (err) {
    log.error("placed-booking", { msg: "the customer's existing calls could not be read; refusing rather than booking" }, err);
    throw new ExistingCallCheckUnavailableError();
  }
  const match = findPersonMatch(identity, calls);
  if (match && match.strength !== "strong") {
    return { kind: "possible-match", call: placedCallSummary(match.booking), matchedOn: looseMatchKind(match.strength) };
  }
  if (match) {
    if (input.move?.bookingId !== match.booking.id) return { kind: "existing-call", call: placedCallSummary(match.booking) };
    return moveExisting(match.booking, bucket, input, zone, deps);
  }
  if (input.move) throw new PlacedBookingRefusedError("confirmed-call-changed");

  const create: CreateBookingInput = {
    bucketCode: bucket.code,
    startIso: input.startIso,
    timezone: zone,
    salesforceId: leadId,
    attendee: input.attendee,
    prefill: {},
    idempotencyKey: key,
    placedByUserId: input.coordinatorUserId,
    // A coordinator may drill the public test bucket; the world follows the bucket.
    allowTestBuckets: bucket.is_test,
  };
  let booked: BookingResult;
  try {
    booked = await deps.createBooking(create, { requested: { code: bucket.code, resolved } });
  } catch (err) {
    if (!noFreeAdvisor(err)) throw err;
    const placeholder = await placeholderFor(bucket, deps);
    log.info("placed-booking", { msg: "no advisor in the bucket is free, so the call goes on the placeholder", bucket_code: bucket.code, why: (err as Error).name });
    booked = await deps.createPlaceholderBooking({
      bucket,
      eventType,
      placeholder,
      startIso: input.startIso,
      timezone: zone,
      salesforceId: leadId,
      attendee: input.attendee,
      idempotencyKey: key,
      placedByUserId: input.coordinatorUserId,
    });
  }
  return { kind: "booked", on: placedOn(booked.booking), booking: booked.booking, manageUrl: booked.manageUrl, replayed: booked.newlyInserted !== true };
}

/**
 * The placeholder a call falls to when nobody real is free, behind the go live switch:
 * the switch is read only here, so off or unreadable refuses the fall and nothing else.
 */
async function placeholderFor(bucket: Bucket, deps: PlacedBookingDeps): Promise<User> {
  const enabled = await deps.placeholderEnabled();
  if (enabled === null) throw new PlacedBookingRefusedError("switch-unreadable");
  if (!enabled) throw new PlacedBookingRefusedError("switch-off");
  const placeholder = await deps.findPlaceholder(bucket.org_id, bucket.is_test);
  if (!placeholder) throw new PlacedBookingRefusedError("no-placeholder");
  return placeholder;
}

/** The confirmed move of the customer's one call: a real advisor first, then the placeholder. */
async function moveExisting(
  existing: Booking,
  bucket: Bucket,
  input: PlacedBookingInput,
  zone: string,
  deps: PlacedBookingDeps,
): Promise<PlacedBookingOutcome> {
  const args = { token: existing.manage_token, startIso: input.startIso, reason: input.move!.reason, actorUserId: input.coordinatorUserId, zone };
  let moved: BookingResult;
  try {
    moved = await deps.rescheduleBooking(args);
  } catch (err) {
    if (!noFreeAdvisor(err)) throw err;
    const placeholder = await placeholderFor(bucket, deps);
    log.info("placed-booking", { msg: "no advisor in the bucket is free, so the call moves onto the placeholder", booking_id: existing.id, why: (err as Error).name });
    moved = await deps.rescheduleBooking({ ...args, ontoPlaceholder: placeholder });
  }
  // A move of this call to this time already in flight answers the call as it was
  // (the reschedule lock's same target no-op), which is not a move: said as the
  // conflict it is, so the coordinator reloads rather than reading "moved".
  if (Date.parse(moved.booking.starts_at) !== Date.parse(input.startIso)) throw new RescheduleConflictError();
  return { kind: "moved", on: placedOn(moved.booking), booking: moved.booking, manageUrl: moved.manageUrl };
}

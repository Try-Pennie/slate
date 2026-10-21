/**
 * Marcia's five booking operations, behind `McpBookingGateway` (#3543, plan phase 4.2).
 *
 * WHO MAY CALL: only the internal route `/api/internal/mcp-booking/<operation>`,
 * which is reached only through the `McpBookingGateway` entrypoint (the public fetch
 * handler refuses the path, and the route checks the gateway secret). WHOSE DATA: the
 * one lead named by Marcia's VERIFIED token. Every operation takes the lead from the
 * claims and never from an argument (L463, decision 19), so a model that writes
 * another lead's id into an argument reaches nobody.
 *
 * ONE implementation (decision 17): each operation calls the same service functions
 * the #250 direct booking API calls (`bookViaApi`, `cancelDirectBooking`,
 * `lookupPersonBookings`, `getPersonBookingById`) and maps their errors with the same
 * `mapBookingError`. Nothing here books, cancels or routes on its own.
 *
 * Idempotency is scoped to one ATTEMPT (`attempt.ts`): a retry of one attempt books
 * once, and a rebook after a cancel gets a fresh key and a fresh calendar event id.
 *
 * The one predicate for "not real" is the booked bucket's `is_test` (L261): a test
 * flagged token is ROUTED into the partner test bucket, the Regal hold (0066) reads
 * that bucket's flag, the monitoring exclusion reads it through the attempt source,
 * and the audit test mark is read back off the booking's own view, never off the
 * token. A real token naming a test bucket meets the same UNKNOWN_BUCKET a typo does.
 *
 * Every failure is classified ONCE (`MARCIA_REFUSALS`), as an expected refusal or an
 * unexpected failure, and every failed write alerts whichever it is (decision 11,
 * reconfirmed as decision 39); the alert is throttled per operation and code so one
 * outage does not page per call.
 *
 * A token may carry no `name`, `email`, `phone` or `time_zone` (Dan, 2026-10-20:
 * Regal, which feeds Marcia, may not hold them). With no zone signed and none
 * passed, every operation uses `DEFAULT_LEAD_TIME_ZONE` and its answer says so in
 * `time_zone_note`, so the model confirms the zone with the lead.
 *
 * Name, email and phone are REQUIRED for a net new booking (Dan, 2026-10-21): a book
 * while the lead holds no call in that world is refused `lead_contact_missing`,
 * naming the fields the token lacks, and nothing is booked. The token's shape check
 * cannot know the operation, so this rule lives in the book operation. For a move,
 * or a book landing on the call the lead already holds, a missing field is filled
 * from what Slate already knows about the salesforce_id (`attendeeFor`): the lead's
 * earlier Slate bookings, then the Salesforce Lead. Anything still missing is left
 * out, as the booking API leaves out a field nobody sent, and the move goes ahead.
 *
 * Pure apart from its deps, so `scripts/test-mcp-booking-operations.ts` drives it.
 */
import { DateTime, IANAZone } from "luxon";
import { formatClockTime, formatLongDate } from "@/lib/date/parse";
import type { AuditEntry } from "@/lib/audit";
import type { ReasonOption, ValidatedReason } from "@/lib/booking/core";
import { validateReason } from "@/lib/booking/core";
import { mapBookingError } from "@/lib/booking/api-error-map";
import { BookingNotFoundError, SlotUnavailableError, type ApiBookingInput, type ApiBookingResult, type ApiBookingView } from "@/lib/booking/orchestration";
import { isBookingWriteFailure } from "@/lib/booking/gated-write";
import { withinLeadCallingWindow } from "@/lib/booking/lead-calling-window";
import { PARTNER_BUCKET_CODE } from "@/lib/embed/public-test-bucket";
import { leadIdSpellings } from "@/lib/salesforce/lead-xbc";
import type { BookingStatus } from "@/lib/db/types";
import { marciaAuditEntry, type MarciaAuditAction } from "./audit-entry.ts";
import { attemptKey, type MarciaWriteOperation } from "./attempt.ts";
import { issueSlotId, readSlotId } from "./slot-id.ts";
import { contactValueValid, type MarciaLeadClaims } from "./token-shape.ts";

import type { MarciaOperation } from "./operation-names.ts";
export { MARCIA_OPERATIONS, isMarciaOperation, type MarciaOperation } from "./operation-names.ts";

/** At most this many times are offered at once (decision 17). */
export const MAX_OFFERED_TIMES = 5;
/** How many nearby times a taken slot offers instead (decision 17: "the nearest one or two"). */
export const ALTERNATIVES_ON_TAKEN = 2;
/**
 * Moves plus cancels one lead may make through Marcia in a rolling day.
 *
 * Plan decision 17 said "about 3 moves plus cancels per lead per day", and the kit's
 * phase 4.1 lists the per lead cap as an expected refusal. Dan set it to 7 on
 * 2026-10-21 because 3 refused a live test lead after three moves in one afternoon
 * ("3 might not be enough"). Neither number is measured against production: the read
 * that would have calibrated it (#3543's comment of 2026-10-16) was not run, so treat
 * 7 as a starting value to re-derive from the real distribution before cutover (L172).
 */
export const MARCIA_LEAD_DAILY_CHANGE_CAP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The zone times are judged and written in when the token signed none and the model
 * passed none (Dan, 2026-10-20): most of Pennie's leads are Eastern, and the answer
 * says it was assumed (`ASSUMED_ZONE_NOTE`) rather than presenting it as the lead's.
 */
export const DEFAULT_LEAD_TIME_ZONE = "America/New_York";

/** What an answer carries, as `time_zone_note`, when its zone was assumed. */
export const ASSUMED_ZONE_NOTE =
  `Slate does not know this lead's time zone, so the times in this answer are in ${DEFAULT_LEAD_TIME_ZONE} (US Eastern). ` +
  "Confirm the lead's time zone, and if it is different, call again with time_zone set to it.";

/** A lead's name, first name, email and phone as another source holds them, null per fact it lacks. */
export interface LeadContact {
  name: string | null;
  firstName: string | null;
  email: string | null;
  phone: string | null;
}

/** Where a missing contact field is looked for, in this order. */
export type ContactSource = "bookings" | "salesforce";

/** Whether a failure was an expected refusal or something going wrong. */
export type FailureClass = "expected" | "unexpected";

/**
 * Every way an operation can end without doing what was asked, classified once
 * (L35). The expected ones are the plan's list (slot taken, a conflict cancel before
 * a move was offered, the per lead cap) plus "the lead already holds a call", which
 * is Marcia being told to move rather than book. Everything else is unexpected.
 */
export const MARCIA_REFUSALS = {
  slot_taken: { class: "expected", status: 409 },
  move_not_offered: { class: "expected", status: 409 },
  lead_daily_cap: { class: "expected", status: 429 },
  cap_unreadable: { class: "unexpected", status: 503 },
  history_unreadable: { class: "unexpected", status: 503 },
  lead_has_booking: { class: "expected", status: 409 },
  lead_contact_missing: { class: "expected", status: 422 },
  slot_invalid: { class: "unexpected", status: 400 },
  args_invalid: { class: "unexpected", status: 400 },
  reason_invalid: { class: "unexpected", status: 400 },
  reason_not_allowed: { class: "unexpected", status: 400 },
  booking_not_found: { class: "unexpected", status: 404 },
  booking_ambiguous: { class: "unexpected", status: 409 },
  no_booking: { class: "unexpected", status: 404 },
  unknown_bucket: { class: "unexpected", status: 422 },
  no_eligible_agents: { class: "unexpected", status: 409 },
  outside_calling_window: { class: "unexpected", status: 422 },
  attendee_email_refused: { class: "unexpected", status: 400 },
  verify_unavailable: { class: "unexpected", status: 503 },
  write_failed: { class: "unexpected", status: 503 },
  internal: { class: "unexpected", status: 500 },
} as const satisfies Record<string, { class: FailureClass; status: number }>;
export type MarciaRefusalCode = keyof typeof MARCIA_REFUSALS;

/** One offered time, preformatted in the lead's zone. */
export interface OfferedTime {
  slot_id: string;
  starts_at: string;
  /** e.g. "Thursday, October 22 at 2:30pm CDT", the product's one date and clock spelling, in the zone it was asked for. */
  label: string;
}

/** A booking as Marcia sees it: Slate's id, the time, the advisor's name. Never contact data. */
export interface MarciaBookingView {
  booking_id: string;
  status: BookingStatus;
  starts_at: string;
  label: string;
  advisor: string | null;
  manage_url: string;
}

export type MarciaAnswer =
  | { ok: true; operation: MarciaOperation; status: 200; data: Record<string, unknown> }
  | {
      ok: false;
      operation: MarciaOperation;
      status: number;
      code: MarciaRefusalCode;
      class: FailureClass;
      message: string;
      alternatives?: OfferedTime[];
      /** Present when the alternatives are written in an ASSUMED zone. */
      time_zone_note?: string;
      /** For lead_contact_missing: which of name, email and phone the token lacked. Never a value. */
      missing_fields?: ("name" | "email" | "phone")[];
    };

/** What an alert about a failure may carry: ids, the class and the code. Never the token or the lead's contact data (L658). */
export interface MarciaFailure {
  operation: MarciaOperation;
  code: MarciaRefusalCode;
  class: FailureClass;
  salesforceId: string;
  bucketCode: string;
  test: boolean;
  /** The internal error, for the LOG only; never put in an alert. */
  cause?: unknown;
}

export interface MarciaSlots {
  slots: string[];
  minNoticeMin: number;
  /** When the slot cache row was computed: the data's own time (decision 7). */
  computedAt: string | null;
}

export interface MarciaDeps {
  nowMs(): number;
  /** Key for slot ids, derived from the gateway secret. */
  slotSecret: string;
  readSlots(bucketCode: string, fromIso: string, allowTest: boolean, nowMs: number): Promise<MarciaSlots | null>;
  book(input: ApiBookingInput): Promise<ApiBookingResult>;
  cancel(input: { bookingId: string; identity: { externalId: string | null; salesforceId: string | null }; reason: ValidatedReason }): Promise<ApiBookingView>;
  lookup(identity: { externalId: string; salesforceId: string | null }): Promise<ApiBookingView[]>;
  bookingById(input: { bookingId: string; identity: { externalId: string | null; salesforceId: string | null }; status: BookingStatus | null }): Promise<ApiBookingView>;
  /** Every cancel reason, active and retired, as validation needs them. */
  cancelReasons(): Promise<ReasonOption[]>;
  /** How many moves plus cancels this lead made through Marcia since `sinceMs`. */
  recentChanges(salesforceId: string, sinceMs: number): Promise<number>;
  /** The booking's org and its bucket's `is_test`, read off the booking row. Throws when unreadable. */
  bookingFacts(bookingId: string): Promise<{ orgId: string; isTest: boolean }>;
  /**
   * The booking this attempt already wrote, read off its own audit row, or null when
   * the attempt has not written. How a RETRY of a write is recognised before the cap
   * or the lookups judge it as though it were new. Throws when unreadable.
   */
  attemptBooking(attempt: string): Promise<string | null>;
  /** Record one audit row for this attempt, at most once per attempt key. */
  audit(entry: AuditEntry, attempt: string): Promise<void>;
  /** A write happened and its audit row could not be written: log and page. */
  auditMissed(action: MarciaAuditAction, bookingId: string, err: unknown): Promise<void>;
  /** Count a booking attempt's outcome, as the #250 API does. */
  recordOutcome(outcome: string, bucketCode: string, errorCode: string | null): void;
  alert(failure: MarciaFailure): Promise<void>;
  /**
   * What the lead's earlier Slate bookings hold, newest first per field, in the
   * token's world only (a test token never reads a real lead's details), or null
   * when they hold nothing. Asked with both spellings of the lead id. May throw; a
   * throw is reported and booked past.
   */
  knownContact(salesforceIds: readonly string[], isTest: boolean): Promise<LeadContact | null>;
  /**
   * What the Salesforce Lead with this id holds, or null when Salesforce returns no
   * such lead. May throw (a refusal or the deadline);
   * a throw is reported and booked past.
   */
  leadContact(salesforceId: string): Promise<LeadContact | null>;
  /** A contact lookup failed: log which one, never a value. Must not throw. */
  contactLookupFailed(source: ContactSource, err: unknown): void;
}

/** The bucket a token books into: the partner test bucket when test flagged (decision 20). */
export function bookingBucketFor(claims: Pick<MarciaLeadClaims, "test" | "bucket_code">): string {
  return claims.test ? PARTNER_BUCKET_CODE : claims.bucket_code;
}

const WRITE_OPS: ReadonlySet<MarciaOperation> = new Set<MarciaWriteOperation>(["book", "move", "cancel"]);

function argsOf(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** The zone an operation shows and judges times in, and whether it was assumed. */
interface Zone {
  zone: string;
  assumed: boolean;
}

/**
 * A valid zone the model passed, else the token's, else `DEFAULT_LEAD_TIME_ZONE`,
 * marked assumed. Null for a passed zone that is not one: refused, never guessed.
 */
function zoneFor(args: Record<string, unknown>, claims: MarciaLeadClaims): Zone | null {
  const z = args.time_zone;
  if (z === undefined || z === null || z === "") {
    return claims.time_zone ? { zone: claims.time_zone, assumed: false } : { zone: DEFAULT_LEAD_TIME_ZONE, assumed: true };
  }
  return typeof z === "string" && IANAZone.isValidZone(z) ? { zone: z, assumed: false } : null;
}

/** The field an answer carries when its zone was assumed, and nothing otherwise. */
const zoneNote = (z: Zone): { time_zone_note?: string } => (z.assumed ? { time_zone_note: ASSUMED_ZONE_NOTE } : {});

export function formatTime(iso: string, zone: string): string {
  const dt = DateTime.fromISO(iso, { setZone: false }).setZone(zone).setLocale("en-US");
  const day = formatLongDate(dt);
  const clock = formatClockTime(dt);
  return day && clock ? `${day} at ${clock} ${dt.toFormat("ZZZZ")}` : iso;
}

type ViewSource = Pick<ApiBookingView, "id" | "status" | "startsAt" | "manageUrl"> & { agent: { name: string | null } };

function view(b: ViewSource, zone: string): MarciaBookingView {
  return {
    booking_id: b.id,
    status: b.status,
    starts_at: b.startsAt,
    label: formatTime(b.startsAt, zone),
    advisor: b.agent.name,
    manage_url: b.manageUrl,
  };
}

const MESSAGES: Record<MarciaRefusalCode, string> = {
  slot_taken: "That time was just taken. Offer the lead one of the alternatives.",
  move_not_offered: "Offer the lead a new time first. A schedule conflict cancels only after a move was offered and declined.",
  lead_daily_cap: "This lead has made as many changes today as Slate allows. Try again tomorrow.",
  cap_unreadable: "Slate could not check how many changes this lead has made today. Try again in a minute.",
  history_unreadable: "Slate could not check whether this call was already handled. Try again in a minute.",
  lead_has_booking: "The lead already has a call booked. Use move to change its time.",
  lead_contact_missing:
    "Slate needs the lead's name, email and phone to book a new call, and Marcia's token is missing the ones in missing_fields. Ask the lead for them.",
  slot_invalid: "That slot id was not offered to this lead, or has expired. Find times again.",
  args_invalid: "The arguments were not valid for this operation.",
  reason_invalid: "That cancel reason is not one of Slate's reasons.",
  reason_not_allowed: "That cancel reason cannot be recorded through Marcia.",
  booking_not_found: "No booking of this lead's matches that id.",
  booking_ambiguous: "The lead holds more than one booking. Name the booking id.",
  no_booking: "The lead has no active booking.",
  unknown_bucket: "The lead's bucket is not one Slate books.",
  no_eligible_agents: "Nobody in the lead's bucket can take calls right now.",
  outside_calling_window: "That time is outside the hours a lead may be called.",
  attendee_email_refused: "The calendar refused the lead's email address. Ask the lead for another one.",
  verify_unavailable: "Slate could not check the calendar just now. Try again in a minute.",
  write_failed: "Slate could not save the change just now. Try again in a minute.",
  internal: "Something went wrong in Slate. The team has been told.",
};

function codeForBookingError(err: unknown): MarciaRefusalCode {
  if (isBookingWriteFailure(err)) return "write_failed";
  if (err instanceof BookingNotFoundError) return "booking_not_found";
  const mapped = mapBookingError(err).code;
  const byCode: Record<typeof mapped, MarciaRefusalCode> = {
    UNKNOWN_BUCKET: "unknown_bucket",
    NO_ELIGIBLE_AGENTS: "no_eligible_agents",
    SLOT_TAKEN: "slot_taken",
    VERIFY_UNAVAILABLE: "verify_unavailable",
    OUTSIDE_CALLING_WINDOW: "outside_calling_window",
    ATTENDEE_EMAIL_REFUSED: "attendee_email_refused",
    INTERNAL: "internal",
  };
  return byCode[mapped];
}

/**
 * The code a failed write is COUNTED under, in the #250 API's vocabulary, from the same
 * classification `codeForBookingError` makes: a write that did not land and a booking
 * that was not found are their own codes there too (`mapLookupError`), never INTERNAL.
 */
function tallyCodeFor(err: unknown): string {
  if (isBookingWriteFailure(err)) return "WRITE_FAILED";
  if (err instanceof BookingNotFoundError) return "NOT_FOUND";
  return mapBookingError(err).code;
}

interface Ctx {
  op: MarciaOperation;
  claims: MarciaLeadClaims;
  deps: MarciaDeps;
  bucketCode: string;
  /**
   * The token's lead id in BOTH spellings (`leadIdSpellings`). A booking stores
   * whichever spelling its channel sent, and the token accepts either, so every
   * lookup asks with both, and Marcia's own records (slot ids, the audit trail and
   * the per lead cap it counts) use `long`, so one lead is one key whichever
   * spelling Marcia signed. A booking row stores the token's own spelling
   * (`bookingIdsFor`).
   */
  lead: { short: string; long: string };
}

async function refuse(
  ctx: Ctx,
  code: MarciaRefusalCode,
  extra: { alternatives?: OfferedTime[]; zone?: Zone; missingFields?: ("name" | "email" | "phone")[]; cause?: unknown } = {},
): Promise<MarciaAnswer> {
  const spec = MARCIA_REFUSALS[code];
  // Every failed WRITE alerts, expected or not (decision 11). A read alerts only on
  // something going wrong: an expected read refusal is not a failed write.
  if (WRITE_OPS.has(ctx.op) || spec.class === "unexpected") {
    await ctx.deps
      .alert({
        operation: ctx.op,
        code,
        class: spec.class,
        salesforceId: ctx.lead.long,
        bucketCode: ctx.bucketCode,
        test: ctx.claims.test,
        cause: extra.cause,
      })
      .catch(() => undefined);
  }
  return {
    ok: false,
    operation: ctx.op,
    status: spec.status,
    code,
    class: spec.class,
    message: MESSAGES[code],
    ...(extra.alternatives ? { alternatives: extra.alternatives, ...(extra.zone ? zoneNote(extra.zone) : {}) } : {}),
    ...(extra.missingFields ? { missing_fields: extra.missingFields } : {}),
  };
}

/**
 * Who a lookup, a by id read or a cancel is about. The service matches EVERY id it is
 * given against either id column (`lookupStrongIds`, #2657), so passing one spelling
 * in each field finds a booking stored under either.
 */
const identityOf = (ctx: Ctx) => ({ externalId: ctx.lead.short, salesforceId: ctx.lead.long });

async function offeredTimes(ctx: Ctx, zone: string, fromIso: string, pick: (slots: string[]) => string[]): Promise<{ times: OfferedTime[]; computedAt: string | null } | null> {
  const now = ctx.deps.nowMs();
  const read = await ctx.deps.readSlots(ctx.bucketCode, fromIso, ctx.claims.test, now);
  if (!read) return null;
  // The slot read ignores `fromIso` (#3381) and returns the whole stored window from
  // now, so the floor is applied here, where the offer is made, whatever the reader does.
  const cutoff = Math.max(now + read.minNoticeMin * 60_000, Date.parse(fromIso));
  const open = read.slots.filter((s) => Date.parse(s) >= cutoff && withinLeadCallingWindow(s, zone));
  const times: OfferedTime[] = [];
  for (const startIso of pick(open)) {
    times.push({
      slot_id: await issueSlotId({ startIso, bucketCode: ctx.bucketCode, salesforceId: ctx.lead.long }, ctx.deps.slotSecret, now),
      starts_at: startIso,
      label: formatTime(startIso, zone),
    });
  }
  return { times, computedAt: read.computedAt };
}

/** The nearest open times to one that was just taken. */
async function alternativesTo(ctx: Ctx, zone: string, takenIso: string): Promise<OfferedTime[]> {
  const takenMs = Date.parse(takenIso);
  const found = await offeredTimes(ctx, zone, new Date(ctx.deps.nowMs()).toISOString(), (open) =>
    open
      .filter((s) => s !== takenIso)
      .sort((a, b) => Math.abs(Date.parse(a) - takenMs) - Math.abs(Date.parse(b) - takenMs))
      .slice(0, ALTERNATIVES_ON_TAKEN),
  ).catch(() => null);
  return found?.times ?? [];
}

/**
 * The per lead cap's verdict, or the refusal to give. A count that cannot be read
 * refuses (the cap fails closed) under its OWN code, never as "the cap is reached",
 * which would claim a count nobody measured (L11).
 */
async function capRefusal(ctx: Ctx): Promise<MarciaRefusalCode | null> {
  let n: number;
  try {
    n = await ctx.deps.recentChanges(ctx.lead.long, ctx.deps.nowMs() - DAY_MS);
  } catch {
    return "cap_unreadable";
  }
  return n < MARCIA_LEAD_DAILY_CHANGE_CAP ? null : "lead_daily_cap";
}

/**
 * Write the audit row for a write that happened. The org and the test mark are read
 * off the BOOKING (its org, its bucket's `is_test`), which is the one predicate for
 * "not real". A row that cannot be built or written never undoes the write it
 * records; it is reported as a missing audit row instead (`auditMissed`).
 */
async function auditWrite(ctx: Ctx, action: MarciaAuditAction, bookingId: string, attempt: string): Promise<void> {
  try {
    const facts = await ctx.deps.bookingFacts(bookingId);
    await ctx.deps.audit(
      marciaAuditEntry({ action, booking: { id: bookingId, org_id: facts.orgId }, salesforceId: ctx.lead.long, isTest: facts.isTest, attempt }),
      attempt,
    );
  } catch (err) {
    await ctx.deps.auditMissed(action, bookingId, err).catch(() => undefined);
  }
}

/**
 * The lead ids a book or move hands the booking service.
 *
 * A NEW booking stores exactly the spelling the token carried, in both id columns, as
 * every other channel stores its caller's spelling: webhook consumers (Regal) may key
 * on `external_id`, and nobody decided to change what it holds. So both fields are the
 * token's spelling, EXCEPT when the lead already holds a call in this world stored only
 * under the OTHER spelling. Then `salesforceId` carries that stored spelling, so the
 * person decision behind book and move (which matches every id it is given against
 * either column) finds the call and moves or dedupes it instead of booking a second
 * one. That case always matches, so it never creates a row, and the other spelling is
 * never written anywhere.
 */
function bookingIdsFor(ctx: Ctx, held: readonly ApiBookingView[]): { salesforceId: string; externalId: string } {
  const signed = ctx.claims.salesforce_id;
  const spellings = new Set([ctx.lead.short, ctx.lead.long]);
  const sameWorld = held.filter((b) => b.isTest === ctx.claims.test);
  const holdsSigned = sameWorld.some((b) => b.salesforceId === signed || b.externalId === signed);
  const otherSpelling = holdsSigned
    ? undefined
    : sameWorld.flatMap((b) => [b.salesforceId, b.externalId]).find((id): id is string => typeof id === "string" && id !== signed && spellings.has(id));
  return { salesforceId: otherSpelling ?? signed, externalId: signed };
}

const CONTACT_FIELDS = ["name", "email", "phone"] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

/**
 * The attendee a book or move writes (Dan, 2026-10-20). Per field, the first that
 * holds a usable value wins:
 *   1. the token's claim (Marcia's value always wins over a looked up one);
 *   2. the lead's earlier Slate bookings with this salesforce_id, in the token's
 *      world, newest first per field (`knownContactFromBookings`);
 *   3. the Salesforce Lead with this id, for a test token too (Dan, 2026-10-21).
 * Reached only for a booking the lead already holds (a move, or a book landing on
 * that call): a net new book needs all three on the token (`lead_contact_missing`).
 * A lookup runs only while a field is still missing. A value found elsewhere is held
 * to the same rule the claim is (`contactValueValid`), so Slate never books a value
 * it would have refused from Marcia. A failed lookup is reported by its source and
 * booked past, never a refusal: the lead gets their call with what Slate has.
 * The first name travels only with the name it came beside.
 */
async function attendeeFor(ctx: Ctx): Promise<ApiBookingInput["attendee"]> {
  const found: Partial<Record<ContactField, string>> = {};
  let firstName: string | undefined;
  for (const f of CONTACT_FIELDS) {
    const v = ctx.claims[f];
    if (typeof v === "string" && v !== "") found[f] = v;
  }
  const missing = () => CONTACT_FIELDS.filter((f) => found[f] === undefined);
  const fill = (from: LeadContact | null) => {
    if (!from) return;
    for (const f of missing()) {
      const v = from[f];
      if (!contactValueValid(f, v)) continue;
      found[f] = v;
      if (f === "name" && from.firstName) firstName = from.firstName;
    }
  };
  const lookUp = async (source: ContactSource, read: () => Promise<LeadContact | null>) => {
    try {
      fill(await read());
    } catch (err) {
      try {
        ctx.deps.contactLookupFailed(source, err);
      } catch {
        // Reporting is best effort: the booking goes ahead either way.
      }
    }
  };
  const { short, long } = ctx.lead;
  if (missing().length > 0) await lookUp("bookings", () => ctx.deps.knownContact([short, long], ctx.claims.test));
  if (missing().length > 0) await lookUp("salesforce", () => ctx.deps.leadContact(long));
  // A fixed key order, and no key for a field nobody holds: the booking API leaves a
  // field nobody sent out, and "" would be stored and matched as though it were one.
  return {
    ...(found.name !== undefined ? { name: found.name } : {}),
    ...(firstName !== undefined && found.name !== undefined ? { firstName } : {}),
    ...(found.email !== undefined ? { email: found.email } : {}),
    ...(found.phone !== undefined ? { phone: found.phone } : {}),
  };
}

/** `near` is a 24 hour local clock time, exactly HH:MM. Anything else is refused, never read loosely. */
const NEAR_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The instant `near` names on `day`, in the lead's zone, or null when it is not an HH:MM time. */
function nearInstant(day: DateTime, near: unknown): DateTime | null {
  const m = typeof near === "string" ? NEAR_CLOCK.exec(near) : null;
  if (!m) return null;
  const at = day.startOf("day").set({ hour: Number(m[1]), minute: Number(m[2]) });
  return at.isValid ? at : null;
}

/**
 * Up to five open times on `target`'s day in the lead's zone, nearest `target` first
 * (a tie goes to the earlier), then given back in start order. Marcia moves a lead to
 * the offered time nearest what they asked for, so with only the first five of the
 * day a lead asking for 3pm was moved to 9:30am (live 2026-10-21).
 */
function nearestOnDay(open: string[], target: DateTime, zone: string): string[] {
  const dayOf = (iso: string) => DateTime.fromISO(iso, { setZone: false }).setZone(zone).toISODate();
  const targetDay = target.setZone(zone).toISODate();
  const targetMs = target.toMillis();
  const distance = (iso: string) => Math.abs(Date.parse(iso) - targetMs);
  return open
    .filter((s) => dayOf(s) === targetDay)
    .sort((a, b) => distance(a) - distance(b) || Date.parse(a) - Date.parse(b))
    .slice(0, MAX_OFFERED_TIMES)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

async function findTimes(ctx: Ctx, args: Record<string, unknown>): Promise<MarciaAnswer> {
  const z = zoneFor(args, ctx.claims);
  if (!z) return refuse(ctx, "args_invalid");
  const zone = z.zone;
  let fromIso = new Date(ctx.deps.nowMs()).toISOString();
  // The day `near` is read on: the from date in the lead's zone, else today there. A
  // from date already past is read as now, for `near` as for the offer itself.
  let day = DateTime.fromMillis(ctx.deps.nowMs(), { zone });
  if (args.from !== undefined) {
    const from = typeof args.from === "string" ? DateTime.fromISO(args.from, { zone }) : null;
    if (!from || !from.isValid) return refuse(ctx, "args_invalid");
    day = DateTime.max(from, day);
    fromIso = day.toUTC().toISO() ?? fromIso;
  }
  let pick = (open: string[]) => open.slice(0, MAX_OFFERED_TIMES);
  if (args.near !== undefined) {
    const target = nearInstant(day, args.near);
    if (!target) return refuse(ctx, "args_invalid");
    pick = (open) => nearestOnDay(open, target, zone);
  }
  try {
    const found = await offeredTimes(ctx, zone, fromIso, pick);
    if (!found) return refuse(ctx, "unknown_bucket");
    return {
      ok: true,
      operation: "find_times",
      status: 200,
      data: { time_zone: zone, ...zoneNote(z), times: found.times, data_as_of: found.computedAt },
    };
  } catch (err) {
    return refuse(ctx, "internal", { cause: err });
  }
}

async function bookOrMove(ctx: Ctx, args: Record<string, unknown>, op: "book" | "move"): Promise<MarciaAnswer> {
  const z = zoneFor(args, ctx.claims);
  if (!z) return refuse(ctx, "args_invalid");
  const zone = z.zone;
  const attempt = attemptKey(op, ctx.claims);
  // A retry of an attempt that already wrote is a replay, recognised FIRST: it answers
  // with the booking it made, and is never judged again by a slot id that has since
  // expired, the cap its own first write used up, or a lookup its own move changed.
  let replayOf: string | null;
  try {
    replayOf = await ctx.deps.attemptBooking(attempt);
  } catch (err) {
    return refuse(ctx, "history_unreadable", { cause: err });
  }
  if (replayOf) {
    try {
      const done = await ctx.deps.bookingById({ bookingId: replayOf, identity: identityOf(ctx), status: null });
      return { ok: true, operation: op, status: 200, data: { outcome: op === "book" ? "created" : "rescheduled", replay: true, booking: view(done, zone), ...zoneNote(z) } };
    } catch (err) {
      return refuse(ctx, codeForBookingError(err), { cause: err });
    }
  }
  const slot = await readSlotId(args.slot_id, ctx.lead.long, ctx.deps.slotSecret, ctx.deps.nowMs());
  if (!slot.ok || slot.bucketCode !== ctx.bucketCode) return refuse(ctx, "slot_invalid");
  // The calls the lead holds, under either spelling of its id: a move needs one, and
  // both ops need to know which spelling a held call is stored under (`bookingIdsFor`).
  let held: ApiBookingView[];
  try {
    held = await ctx.deps.lookup(identityOf(ctx));
  } catch (err) {
    return refuse(ctx, codeForBookingError(err), { cause: err });
  }
  if (op === "move") {
    // A move moves a call the lead HOLDS. With none, `confirmReschedule` would quietly
    // create one, and the answer would say "moved" about a booking that never existed.
    if (held.length === 0) return refuse(ctx, "no_booking");
    const capped = await capRefusal(ctx);
    if (capped) return refuse(ctx, capped);
  } else if (!held.some((b) => b.isTest === ctx.claims.test)) {
    // A NET NEW booking (Dan, 2026-10-21): the lead holds no call in this world, so this
    // book creates one, and a new call needs the lead's name, email and phone ON THE
    // TOKEN. Judged on the token alone, before any lookup: a lead Slate is meeting for
    // the first time is confirmed by Marcia asking them, never by an old record. A book
    // landing on a call the lead holds (dedupe, confirm) is not net new and fills below.
    const missingFields = CONTACT_FIELDS.filter((f) => !ctx.claims[f]);
    if (missingFields.length > 0) return refuse(ctx, "lead_contact_missing", { missingFields });
  }
  const input: ApiBookingInput = {
    bucketCode: ctx.bucketCode,
    startIso: slot.startIso,
    timezone: zone,
    ...bookingIdsFor(ctx, held),
    attendee: await attendeeFor(ctx),
    prefill: {},
    confirmReschedule: op === "move",
    allowTestBuckets: ctx.claims.test,
    idempotencyKey: attempt,
    mcpChannel: "marcia",
  };
  let result: ApiBookingResult;
  try {
    result = await ctx.deps.book(input);
  } catch (err) {
    const code = codeForBookingError(err);
    ctx.deps.recordOutcome("error", ctx.bucketCode, tallyCodeFor(err));
    if (err instanceof SlotUnavailableError) {
      return refuse(ctx, "slot_taken", { alternatives: await alternativesTo(ctx, zone, slot.startIso), zone: z, cause: err });
    }
    return refuse(ctx, code, { cause: err });
  }
  ctx.deps.recordOutcome(result.outcome, ctx.bucketCode, null);
  if (result.outcome === "confirm_required") return refuse(ctx, "lead_has_booking");
  const booked = view(
    {
      id: result.booking.id,
      status: result.booking.status,
      startsAt: result.booking.starts_at,
      manageUrl: result.manageUrl,
      agent: { name: result.booking.agent_name },
    },
    zone,
  );
  // A dedupe is the lead already holding this time: nothing changed, nothing to audit.
  if (result.outcome !== "deduped") {
    const action: MarciaAuditAction = result.outcome === "rescheduled" ? "booking.rescheduled" : "booking.created";
    await auditWrite(ctx, action, result.booking.id, attempt);
  }
  return { ok: true, operation: op, status: 200, data: { outcome: result.outcome, booking: booked, ...zoneNote(z) } };
}

async function lookup(ctx: Ctx, args: Record<string, unknown>): Promise<MarciaAnswer> {
  const z = zoneFor(args, ctx.claims);
  if (!z) return refuse(ctx, "args_invalid");
  const zone = z.zone;
  try {
    const bookings = await ctx.deps.lookup(identityOf(ctx));
    return { ok: true, operation: "lookup", status: 200, data: { bookings: bookings.map((b) => view(b, zone)), ...zoneNote(z) } };
  } catch (err) {
    return refuse(ctx, codeForBookingError(err), { cause: err });
  }
}

/** The cancel reason rules of decision 17, applied to a code Slate's own validator accepted. */
async function cancel(ctx: Ctx, args: Record<string, unknown>): Promise<MarciaAnswer> {
  const z = zoneFor(args, ctx.claims);
  if (!z) return refuse(ctx, "args_invalid");
  const zone = z.zone;
  const attempt = attemptKey("cancel", ctx.claims);
  // A retry of a cancel that already landed answers as the first call did, FIRST,
  // before any rule is judged again: no second write, no lookup that would now find
  // nothing, no cap it used up itself, and no conflict proof whose slot ids expired.
  let already: string | null;
  try {
    already = await ctx.deps.attemptBooking(attempt);
  } catch (err) {
    return refuse(ctx, "history_unreadable", { cause: err });
  }
  if (already) {
    try {
      const done = await ctx.deps.bookingById({ bookingId: already, identity: identityOf(ctx), status: null });
      return { ok: true, operation: "cancel", status: 200, data: { outcome: "already_cancelled", booking: view(done, zone), ...zoneNote(z) } };
    } catch (err) {
      return refuse(ctx, codeForBookingError(err), { cause: err });
    }
  }
  let reasons: ReasonOption[];
  try {
    reasons = await ctx.deps.cancelReasons();
  } catch (err) {
    return refuse(ctx, "internal", { cause: err });
  }
  const code = typeof args.reason_code === "string" ? args.reason_code : "";
  const detail = typeof args.reason_detail === "string" ? args.reason_detail : null;
  const validated = validateReason({ code, detail }, reasons);
  if (!validated.ok) return refuse(ctx, "reason_invalid");
  // Opt outs never reach Slate through Marcia (decision 17), and no system only code
  // may be recorded by a caller: those are Slate's own words.
  if (reasons.find((r) => r.code === validated.reason.code)?.systemOnly) return refuse(ctx, "reason_not_allowed");
  if (validated.reason.code === "schedule_conflict") {
    // A conflict cancels only after a move was OFFERED and declined. The proof that it
    // was offered is a slot id Slate issued to this lead; the model cannot make one.
    const offered = Array.isArray(args.declined_slot_ids) ? args.declined_slot_ids : [];
    let proven = false;
    for (const id of offered.slice(0, 10)) {
      const r = await readSlotId(id, ctx.lead.long, ctx.deps.slotSecret, ctx.deps.nowMs());
      if (r.ok) proven = true;
    }
    if (!proven) return refuse(ctx, "move_not_offered");
  }
  let bookingId = typeof args.booking_id === "string" && args.booking_id ? args.booking_id : null;
  try {
    if (!bookingId) {
      const active = await ctx.deps.lookup(identityOf(ctx));
      if (active.length === 0) return refuse(ctx, "no_booking");
      if (active.length > 1) return refuse(ctx, "booking_ambiguous");
      bookingId = active[0]!.id;
    }
  } catch (err) {
    return refuse(ctx, codeForBookingError(err), { cause: err });
  }
  const capped = await capRefusal(ctx);
  if (capped) return refuse(ctx, capped);
  try {
    const cancelled = await ctx.deps.cancel({ bookingId, identity: identityOf(ctx), reason: validated.reason });
    await auditWrite(ctx, "booking.cancelled", cancelled.id, attempt);
    return { ok: true, operation: "cancel", status: 200, data: { outcome: "cancelled", booking: view(cancelled, zone), ...zoneNote(z) } };
  } catch (err) {
    // A retry of an attempt that already cancelled finds nothing ACTIVE to cancel.
    // Read the booking in any status: cancelled means this attempt already acted,
    // and it answers as it did the first time, with no second write.
    if (err instanceof BookingNotFoundError) {
      const already = await ctx.deps.bookingById({ bookingId, identity: identityOf(ctx), status: "cancelled" }).catch(() => null);
      if (already) return { ok: true, operation: "cancel", status: 200, data: { outcome: "already_cancelled", booking: view(already, zone), ...zoneNote(z) } };
    }
    return refuse(ctx, codeForBookingError(err), { cause: err });
  }
}

/** Run one operation for one verified lead. Never throws: every ending is an answer. */
export async function runMarciaOperation(op: MarciaOperation, rawArgs: unknown, claims: MarciaLeadClaims, deps: MarciaDeps): Promise<MarciaAnswer> {
  const ctx: Ctx = { op, claims, deps, bucketCode: bookingBucketFor(claims), lead: leadIdSpellings(claims.salesforce_id) };
  const args = argsOf(rawArgs);
  if (!args) return refuse(ctx, "args_invalid");
  try {
    switch (op) {
      case "find_times":
        return await findTimes(ctx, args);
      case "book":
        return await bookOrMove(ctx, args, "book");
      case "move":
        return await bookOrMove(ctx, args, "move");
      case "lookup":
        return await lookup(ctx, args);
      case "cancel":
        return await cancel(ctx, args);
    }
  } catch (err) {
    return refuse(ctx, "internal", { cause: err });
  }
}

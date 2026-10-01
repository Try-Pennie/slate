/**
 * Request parsing + validation for the direct booking API (#356). Pure (relative
 * imports, no IO) so it runs under `node --experimental-strip-types`; the route
 * wires it to NextRequest. Validates the machine caller's body and normalizes it
 * so the booking layer (#357) gets clean input.
 *
 * Stricter than the embed in two ways the bot needs: a REAL IANA timezone (a bot
 * may send "EST"/""—which would silently skew the calendar event), and a
 * required `external_id` (the bot's stable per-person id, used for dedupe). The
 * attendee rules are deliberately the SAME strict name+email+phone as the embed
 * (`validateAttendee`), per the locked product decision.
 */
import { z } from "zod";
import { IANAZone, DateTime } from "luxon";
import { validateAttendee, type AttendeeErrors } from "../attendee.ts";
import { validateReason, type ReasonOption, type ValidatedReason } from "./core.ts";
import { INPUT_LIMITS } from "./input-limits.ts";
import { bucketCodeSchema, startSchema, timezoneSchema, salesforceIdSchema, prefillSchema } from "./input-schema.ts";
import type { BookingStatus } from "../db/types.ts";

export interface DirectBookingRequest {
  bucketCode: string;
  startIso: string;
  timezone: string;
  attendee: { name: string; email: string; phone: string };
  salesforceId: string | null;
  prefill: Record<string, string>;
  externalId: string;
  /** Set by the bot on a follow-up call after it asked the lead, so a
   *  low-confidence (single-field) person match may still auto-reschedule (#357). */
  confirmReschedule: boolean;
  /** Dry run (#380): report what WOULD happen (routing + would-be agent) without
   *  creating a calendar event, booking, or webhook. */
  dryRun: boolean;
}

export type ParseResult =
  | { ok: true; value: DirectBookingRequest }
  | { ok: false; status: 400; error: string; fieldErrors?: AttendeeErrors };

const schema = z.object({
  // Bounded, shared with the embed route so the size caps can't drift (#1034).
  bucketCode: bucketCodeSchema,
  start: startSchema,
  timezone: timezoneSchema,
  // Field-level attendee rules run through validateAttendee below (shared with
  // the embed), so accept loose shapes here and validate after.
  attendee: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  salesforceId: salesforceIdSchema.nullish(),
  prefill: prefillSchema,
  // Required for the API (the bot's stable per-person id); blank/whitespace is
  // not an id. `.trim()` collapses "  " to "" so .min(1) rejects it.
  externalId: z.string().trim().min(1).max(INPUT_LIMITS.externalId),
  confirmReschedule: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const INVALID = { ok: false as const, status: 400 as const, error: "Invalid request" };

export function parseDirectBookingRequest(raw: unknown): ParseResult {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return INVALID;
  const data = parsed.data;

  // A real IANA zone — not "EST"/""/"GMT+5", which would skew the gcal event.
  if (!IANAZone.isValidZone(data.timezone)) {
    return { ...INVALID, error: "Invalid timezone (expected an IANA zone, e.g. America/New_York)" };
  }

  // A parseable instant that carries an explicit offset (Z or ±HH:MM). A bare
  // local time ("2026-07-01T15:00:00") has no zone, so it'd be read as server
  // time and could book the wrong hour — require the offset (#358).
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(data.start.trim());
  if (!hasOffset || !DateTime.fromISO(data.start, { setZone: true }).isValid) {
    return {
      ...INVALID,
      error:
        "Invalid start (expected an ISO 8601 instant with a timezone offset, e.g. 2026-07-01T15:00:00Z)",
    };
  }

  const attendeeErrors = validateAttendee(data.attendee);
  if (Object.keys(attendeeErrors).length > 0) {
    return {
      ok: false,
      status: 400,
      error: "Invalid attendee contact details",
      fieldErrors: attendeeErrors,
    };
  }

  return {
    ok: true,
    value: {
      bucketCode: data.bucketCode,
      startIso: data.start,
      timezone: data.timezone,
      attendee: {
        // Validated non-empty above; trim so the booking layer stores clean values.
        name: (data.attendee.name ?? "").trim(),
        email: (data.attendee.email ?? "").trim(),
        phone: (data.attendee.phone ?? "").trim(),
      },
      // external_id IS the lead's Salesforce id (every lead has one; same value).
      // Default salesforce_id from it when not sent separately, so an API booking
      // dedupes against a website booking via salesforce_id regardless of which
      // field the caller populated (#363/#377).
      salesforceId: data.salesforceId ?? data.externalId,
      prefill: data.prefill,
      externalId: data.externalId,
      confirmReschedule: data.confirmReschedule,
      dryRun: data.dryRun,
    },
  };
}

const BOOKING_STATUSES: readonly BookingStatus[] = [
  "confirmed",
  "rescheduled",
  "cancelled",
  "completed",
];

export interface LookupQuery {
  externalId: string;
  salesforceId: string | null;
  bookingId: string | null;
  status: BookingStatus | null;
}

export type LookupParseResult =
  | { ok: true; value: LookupQuery }
  | { ok: false; status: 400; error: string };

/**
 * Parse a GET /api/bookings lookup query (#386). `externalId` is required
 * (the bot's stable per-person id). `bookingId` selects one booking; `status` is
 * an optional assertion meaningful only with `bookingId` (the by-id handler
 * applies it). An unrecognized `status` is a 400.
 */
export function parseLookupQuery(params: URLSearchParams): LookupParseResult {
  const externalId = (params.get("externalId") ?? "").trim();
  if (!externalId) {
    return { ok: false, status: 400, error: "externalId is required" };
  }
  const salesforceId = (params.get("salesforceId") ?? "").trim() || null;
  const bookingId = (params.get("bookingId") ?? "").trim() || null;

  let status: BookingStatus | null = null;
  const statusRaw = (params.get("status") ?? "").trim();
  if (statusRaw) {
    if (!BOOKING_STATUSES.includes(statusRaw as BookingStatus)) {
      return { ok: false, status: 400, error: "Invalid status filter" };
    }
    status = statusRaw as BookingStatus;
  }
  return { ok: true, value: { externalId, salesforceId, bookingId, status } };
}

export interface CancelQuery {
  bookingId: string;
  externalId: string | null;
  salesforceId: string | null;
  reason: ValidatedReason | null;
}

export type CancelParseResult =
  | { ok: true; value: CancelQuery }
  | { ok: false; status: 400; error: string };

/**
 * Parse a DELETE /api/bookings cancel query (#386). Requires an explicit
 * `bookingId` AND a strong id (`externalId` or `salesforceId`) so the caller
 * targets exactly one ownership-checked booking. Optional `reason` (+
 * `reasonDetail` for the "other" code) is validated against the live cancel option
 * set `allowedCancel` (active + retired, #346), which the route loads and passes in
 * (this parser stays sync/pure); absent → null (the service substitutes the default
 * api_cancellation reason).
 */
export function parseCancelQuery(
  params: URLSearchParams,
  allowedCancel: ReasonOption[],
): CancelParseResult {
  return parseCancelFields((name) => params.get(name), allowedCancel);
}

/**
 * The same cancel, carried in a JSON body (#2591, POST /api/bookings/cancel), for a
 * caller that cannot send DELETE: a Regal journey's webhook step offers GET, POST,
 * PUT and PATCH only. Only a string counts as a value. A number or an object in an
 * id field reads as ABSENT rather than being stringified into something that might
 * match a booking.
 */
export function parseCancelBody(body: unknown, allowedCancel: ReasonOption[]): CancelParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const fields = body as Record<string, unknown>;
  return parseCancelFields((name) => {
    const v = fields[name];
    return typeof v === "string" ? v : null;
  }, allowedCancel);
}

/** The one rule both carriers share, so the query form and the body form cannot drift. */
function parseCancelFields(
  read: (name: "bookingId" | "externalId" | "salesforceId" | "reason" | "reasonDetail") => string | null,
  allowedCancel: ReasonOption[],
): CancelParseResult {
  const bookingId = (read("bookingId") ?? "").trim();
  if (!bookingId) {
    return { ok: false, status: 400, error: "bookingId is required" };
  }
  const externalId = (read("externalId") ?? "").trim() || null;
  const salesforceId = (read("salesforceId") ?? "").trim() || null;
  if (!externalId && !salesforceId) {
    return { ok: false, status: 400, error: "externalId or salesforceId is required" };
  }

  let reason: ValidatedReason | null = null;
  const reasonCode = (read("reason") ?? "").trim();
  if (reasonCode) {
    const v = validateReason({ code: reasonCode, detail: read("reasonDetail") }, allowedCancel);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    reason = v.reason;
  }
  return { ok: true, value: { bookingId, externalId, salesforceId, reason } };
}

const MAX_LIST_OFFSET = 10000;

/** Opaque page token (base64 of a non-negative integer offset). btoa/atob are
 *  global in Node and the Worker runtime. */
export function encodeCursor(offset: number): string {
  return btoa(String(offset));
}
export function decodeCursor(s: string): number | null {
  try {
    const n = Number(atob(s));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export interface ListQuery {
  status: BookingStatus | null;
  afterStart: string | null;
  beforeEnd: string | null;
  updatedSince: string | null;
  bucketCode: string | null;
  agentEmail: string | null;
  limit: number;
  offset: number;
}

export type ListParseResult =
  | { ok: true; value: ListQuery }
  | { ok: false; status: 400; error: string };

function isoWithOffset(v: string): boolean {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(v.trim());
  return hasOffset && DateTime.fromISO(v, { setZone: true }).isValid;
}

/**
 * Parse the #392 list query (GET /api/bookings without an externalId key). All
 * filters optional; OFFSET pagination via an opaque cursor; max offset capped.
 * The externalId-vs-list mode decision is the route's job, not this parser's.
 */
export function parseListQuery(params: URLSearchParams): ListParseResult {
  const bad = (error: string): ListParseResult => ({ ok: false, status: 400, error });

  // #2872: a booking id selects ONE booking and is only honoured beside the lead
  // id it was booked under. Here, with no externalId, it used to be ignored and the
  // caller got the first page of every booking with a 200, which a host page could
  // show as the lead's own call. Refused by name instead.
  if (params.has("bookingId")) {
    return bad("bookingId looks up one booking and needs the externalId it was booked under; send both, or neither to list");
  }

  const status = (params.get("status") ?? "").trim();
  if (status && !BOOKING_STATUSES.includes(status as BookingStatus)) {
    return bad("Invalid status filter");
  }
  for (const k of ["afterStart", "beforeEnd", "updatedSince"] as const) {
    const v = (params.get(k) ?? "").trim();
    if (v && !isoWithOffset(v)) {
      return bad(`Invalid ${k} (expected an ISO 8601 instant with a timezone offset)`);
    }
  }

  let limit = 50;
  const limitRaw = (params.get("limit") ?? "").trim();
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) return bad("Invalid limit");
    limit = Math.min(n, 100);
  }

  let offset = 0;
  const cursor = (params.get("cursor") ?? "").trim();
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded === null) return bad("Invalid cursor");
    offset = decoded;
  }
  if (offset > MAX_LIST_OFFSET) {
    return bad(
      "Result window too large. Narrow your filters (use afterStart/beforeEnd or updatedSince)",
    );
  }

  return {
    ok: true,
    value: {
      status: status ? (status as BookingStatus) : null,
      afterStart: (params.get("afterStart") ?? "").trim() || null,
      beforeEnd: (params.get("beforeEnd") ?? "").trim() || null,
      updatedSince: (params.get("updatedSince") ?? "").trim() || null,
      bucketCode: (params.get("bucket") ?? "").trim() || null,
      agentEmail: (params.get("agentEmail") ?? "").trim() || null,
      limit,
      offset,
    },
  };
}

/** The list-only query keys; the route 400s if any appear alongside externalId. */
export const LIST_ONLY_PARAMS = [
  "afterStart",
  "beforeEnd",
  "updatedSince",
  "bucket",
  "agentEmail",
  "cursor",
  "limit",
] as const;

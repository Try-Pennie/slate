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
  bucketCode: z.string().trim().min(1),
  start: z.string().min(1),
  timezone: z.string().min(1),
  // Field-level attendee rules run through validateAttendee below (shared with
  // the embed), so accept loose shapes here and validate after.
  attendee: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  salesforceId: z.string().nullish(),
  prefill: z.record(z.string(), z.string()).default({}),
  // Required for the API (the bot's stable per-person id); blank/whitespace is
  // not an id. `.trim()` collapses "  " to "" so .min(1) rejects it.
  externalId: z.string().trim().min(1),
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
      salesforceId: data.salesforceId ?? null,
      prefill: data.prefill,
      externalId: data.externalId,
      confirmReschedule: data.confirmReschedule,
      dryRun: data.dryRun,
    },
  };
}

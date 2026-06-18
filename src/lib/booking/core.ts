import type { Booking, Bucket, BusySource, EventType } from "@/lib/db/types";

/**
 * Pure, side-effect-free cores of the booking flow, split out from
 * `service.ts` (which does DB writes + live Google calls) so the decision
 * logic is deterministic and unit-testable. See `scripts/test-booking.ts`.
 */

/** Normalized [start, end) window for a slot of `durationMin` minutes. */
export function bookingWindow(
  startIso: string,
  durationMin: number,
): { startIso: string; endIso: string } {
  const start = new Date(startIso).toISOString();
  const end = new Date(Date.parse(start) + durationMin * 60_000).toISOString();
  return { startIso: start, endIso: end };
}

/**
 * Stable idempotency key for a booking submission: same bucket + slot + attendee
 * identity → same key, so a double-clicked/retried submit dedupes to one booking.
 * Returns null when there's NO identity (no email/phone/salesforceId) — without
 * an identity we can't safely dedupe (two different anonymous people booking the
 * same slot must not collapse), so the active-slot unique index is the only guard.
 */
export function idempotencyKeyFor(parts: {
  bucketCode: string;
  startIso: string;
  email?: string;
  phone?: string;
  salesforceId?: string | null;
}): string | null {
  const email = parts.email?.trim().toLowerCase() ?? "";
  const phone = parts.phone?.replace(/\s+/g, "") ?? "";
  const sf = parts.salesforceId ?? "";
  if (!email && !phone && !sf) return null;
  const start = new Date(parts.startIso).toISOString();
  return [parts.bucketCode, start, email, phone, sf].join("|");
}

export interface AssignResult {
  userId: string;
  email: string;
}

/**
 * Verify-on-book selection: walk candidates in round-robin order and return the
 * first one that has an email AND is confirmed free — doing ONE free/busy check
 * per candidate (not all N up front). `loadEmail` and `isFree` are injected so
 * this is testable without DB/Google. Returns null when no candidate is free
 * (the caller turns that into SlotUnavailableError).
 */
export async function selectAgent(
  candidates: string[],
  loadEmail: (userId: string) => Promise<string | null>,
  isFree: (email: string) => Promise<boolean>,
): Promise<AssignResult | null> {
  for (const userId of candidates) {
    const email = await loadEmail(userId);
    if (!email) continue;
    if (await isFree(email)) return { userId, email };
  }
  return null;
}

// A `type` (not `interface`) so it gains an implicit index signature and stays
// assignable to the Supabase client's `Record<string, unknown>` insert param.
export type BusyBlockInsert = {
  user_id: string;
  starts_at: string;
  ends_at: string;
  source: BusySource;
  booking_id: string;
};

/** The write-through busy block a Slate booking inserts into the cache. */
export function busyBlockFor(
  userId: string,
  startIso: string,
  endIso: string,
  bookingId: string,
): BusyBlockInsert {
  return {
    user_id: userId,
    starts_at: startIso,
    ends_at: endIso,
    source: "slate",
    booking_id: bookingId,
  };
}

/**
 * The Google event description, shown on the lead's calendar invite: phone
 * (when present) plus the self-serve manage link - the invite is the lead's
 * only email, so the reschedule/cancel link must ride along (#64).
 */
export function eventDescription(
  phone: string | null,
  manageUrl: string,
): string {
  const lines = ["Booked via Pennie."];
  if (phone) lines[0] = `Booked via Pennie. Phone: ${phone}`;
  lines.push(`Reschedule or cancel: ${manageUrl}`);
  return lines.join("\n");
}

/**
 * Pairs each booking with its bucket + event type from already-fetched sets,
 * so the completion sweep can resolve them with two `.in()` queries instead of
 * a round-trip per booking (#164). A booking whose bucket or event type isn't
 * in the fetched set is dropped (FK integrity makes this unreachable in prod;
 * dropping is the safe choice if it ever happens).
 */
export function joinBookingContexts(
  bookings: Booking[],
  buckets: Bucket[],
  eventTypes: EventType[],
): { booking: Booking; bucket: Bucket; eventType: EventType }[] {
  const bucketById = new Map(buckets.map((b) => [b.id, b]));
  const eventTypeById = new Map(eventTypes.map((e) => [e.id, e]));

  const out: { booking: Booking; bucket: Bucket; eventType: EventType }[] = [];
  for (const booking of bookings) {
    const bucket = bucketById.get(booking.bucket_id);
    const eventType = eventTypeById.get(booking.event_type_id);
    if (bucket && eventType) out.push({ booking, bucket, eventType });
  }
  return out;
}

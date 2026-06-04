import type { BusySource } from "@/lib/db/types";

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

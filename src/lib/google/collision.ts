/**
 * External-Google double-booking detection (#316, pure).
 *
 * Slate-vs-Slate double-booking is prevented by the active-slot unique index.
 * But verify-on-book is a single best-effort live check, not transactional with
 * Google, so someone can book an agent directly in Google in the race window.
 * Google offers no cross-system lock, so this can't be cheaply prevented — but
 * once sync mirrors that external event into busy_blocks we can DETECT it: an
 * external (`source: gcal`) event overlapping an active Slate booking on the
 * same agent. The booking's OWN event (Slate created it in Google, sync mirrors
 * it back with the same id) is excluded so it doesn't self-collide.
 *
 * Overlap is half-open: a block starting exactly when the booking ends (or
 * ending exactly when it starts) does not collide.
 */
export interface GcalBlock {
  gcalEventId: string | null;
  startMs: number;
  endMs: number;
}

export interface SlateBooking {
  id: string;
  /** The booking's own Google event id, so its mirrored block isn't a collision. */
  gcalEventId: string | null;
  startMs: number;
  endMs: number;
  /**
   * The booking was placed on a busy agent ON PURPOSE (#2442).
   *
   * `allow_double_book` is written by exactly one path, the contact owner
   * override (#9), which is the only path allowed to double book: the lead goes
   * back to the advisor they already spoke with whether or not that advisor is
   * free, and the flag is what lets the active slot unique index stack it.
   *
   * OPTIONAL, and absent means ordinary. The flag is what the reassign path
   * writes, so a booking carrying nothing is the commonest row on the table and
   * must fail toward speaking up: an alarm that goes quiet on a missing field
   * would be silent about every overlap that arrives before the column is read.
   */
  allowDoubleBook?: boolean;
}

export interface ExternalCollision {
  bookingId: string;
  gcalEventId: string | null;
}

export function findExternalCollisions(
  blocks: GcalBlock[],
  bookings: SlateBooking[],
): ExternalCollision[] {
  const collisions: ExternalCollision[] = [];
  for (const b of bookings) {
    // An owner reassign put this call on a busy advisor deliberately (#2442), so
    // the overlap is not news. Skipping the BOOKING rather than one block is the
    // point: the reassign does not know which of the advisor's events it landed
    // on, and naming one would be a guess.
    if (b.allowDoubleBook) continue;
    for (const g of blocks) {
      // Skip the booking's own mirrored event (same Google id).
      if (g.gcalEventId !== null && g.gcalEventId === b.gcalEventId) continue;
      if (g.startMs < b.endMs && g.endMs > b.startMs) {
        collisions.push({ bookingId: b.id, gcalEventId: g.gcalEventId });
        break; // one collision per booking is enough to flag
      }
    }
  }
  return collisions;
}

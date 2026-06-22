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

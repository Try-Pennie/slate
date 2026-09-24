/**
 * Identity resolution for the LOOKUP and CANCEL APIs (#2657):
 * `GET /api/bookings?externalId=…` in its by id and its list mode, and the cancel
 * behind `DELETE /api/bookings` and `POST /api/bookings/cancel`, which asks the
 * same ownership question.
 *
 * A booking made through the embed (`/book?external_id=<lead id>`) is written with
 * the lead's id in `salesforce_id` and `external_id` null: the page maps the query
 * value into the Booker's `salesforceId` prop (#2166) and the confirm inserts it
 * under that name. A booking made through `POST /api/bookings` carries whichever
 * ids the caller sent. The caller of the lookup cannot know which route made the
 * booking, and `docs/booking-api.md` tells it to send the lead's id as
 * `externalId`, so before this every embed booking answered 404 to the page built
 * to show it.
 *
 * Decided by Dan, 2026-09-24: a supplied strong id is ONE value that may sit in
 * EITHER column. `externalId=X` matches a booking whose `external_id` is X or whose
 * `salesforce_id` is X, and `salesforceId` likewise. A different lead's id still
 * matches nothing.
 *
 * Deliberately separate from `findPersonMatch` and `findActiveBookingsForPerson`
 * (`person-dedupe.ts`, `service.ts`), which serve the one call per person dedupe
 * (#357). That path asks whether an incoming booking is the same person as an
 * existing one and matches column to column; this one asks whether a caller
 * holding a lead's id may read or cancel that lead's booking. Two questions, so
 * two predicates (L342), and this change leaves the dedupe path's fetch and
 * grading untouched. It replaced `bookingBelongsToPerson`, the column to column
 * ownership check the lookup and the cancel used until #2657.
 *
 * Pure (type only `@/` imports, erased at runtime) so it unit tests under
 * `node --experimental-strip-types`.
 */
import type { Booking } from "@/lib/db/types";
import type { PersonIdentity } from "./person-dedupe.ts";

export type LookupIdentity = Pick<PersonIdentity, "externalId" | "salesforceId">;

/**
 * The strong ids a lookup caller supplied, as one set: trimmed, blanks dropped, a
 * value given in both fields kept once. Empty when the caller proved nothing, and
 * an empty set matches no booking, so a blank can never match a blank column.
 */
export function lookupStrongIds(identity: LookupIdentity): string[] {
  const ids = new Set<string>();
  for (const raw of [identity.externalId, identity.salesforceId]) {
    const id = (raw ?? "").trim();
    if (id.length > 0) ids.add(id);
  }
  return [...ids];
}

/** Does any supplied id sit in EITHER of the booking's id columns? */
export function bookingMatchesLookupIds(
  booking: Pick<Booking, "external_id" | "salesforce_id">,
  ids: readonly string[],
): boolean {
  if (ids.length === 0) return false;
  return ids.some(
    (id) => booking.external_id === id || booking.salesforce_id === id,
  );
}

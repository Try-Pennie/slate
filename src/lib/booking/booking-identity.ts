import type { Booking } from "../db/types.ts";

/**
 * The lead ids a booking is STORED under, in the shape every response names them
 * (#2750). Built once so the key authed lookup views (#2657), the Booker's confirm
 * response and the move's response cannot describe one call's owner three ways
 * (L41).
 *
 * These are the booking's own ids, never the page's. A lead who submits twice
 * holds two lead records, and moving the call they already had from the second
 * page leaves the call on the FIRST lead, so the page's id and the booking's
 * differ exactly there. The by id lookup refuses a booking the id it is given
 * does not own, so a host must look a booking up with these.
 *
 * Null, never absent, for an id the booking does not hold, so the field is always
 * there to read.
 */
export interface BookingIdentity {
  salesforceId: string | null;
  externalId: string | null;
}

export function bookingIdentityFrom(
  b: Pick<Booking, "salesforce_id" | "external_id">,
): BookingIdentity {
  return {
    salesforceId: b.salesforce_id ?? null,
    externalId: b.external_id ?? null,
  };
}

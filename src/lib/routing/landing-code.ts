/**
 * The code a booker PAGE shows times for (#2638).
 *
 * The same resolver the confirm uses (`resolveRoutingCode`, wired to the real
 * Salesforce reader here and to the injected one in `createBooking`), so the
 * times a lead is shown and the pool they are booked into cannot disagree: a
 * lead whose link carried no code but whose Lead record holds 512 is shown the
 * 512 pool's times, not the catch-all's.
 *
 * A failed Salesforce read THROWS, and the page's error boundary offers a retry.
 * Rendering the catch-all's times instead would be the misroute the read exists
 * to prevent, shown to the lead before they have even picked a time.
 */
import { readLeadXbcLive } from "@/lib/salesforce/lead-xbc";
import { resolveRoutingCode, type RoutingCodeResolution } from "./lead-code.ts";

export async function resolveLandingCode(
  requested: string | null | undefined,
  leadId: string | null | undefined,
): Promise<RoutingCodeResolution> {
  return resolveRoutingCode(requested, leadId, readLeadXbcLive);
}

/**
 * The code a booker PAGE shows times for (#2638).
 *
 * The same resolver the confirm uses (`resolveRoutingCode`, wired to the real
 * Salesforce reader here and to the injected one in `createBooking`), so the
 * times a lead is shown and the pool they are booked into cannot disagree. Since
 * #3508 the landing also corrects a ROUTABLE link code that is stale
 * (`correctLinkToLeadScore`), and the confirm books the team it showed: a
 * lead whose link carried no code but whose Salesforce score is 512 is shown the
 * 512 pool's times, not the catch-all's.
 *
 * A failed Salesforce read THROWS, and the page's error boundary offers a retry.
 * Rendering the catch-all's times instead would be the misroute the read exists
 * to prevent, shown to the lead before they have even picked a time.
 *
 * A landing page passes the id `landingLookupId` handed back, never the raw one
 * from the link (#3173): the read is up to three Salesforce queries per guessed id
 * (the Lead, its submission, and the score's edit history when the two disagree,
 * #3502), so it sits behind the per address landing throttle, and over the
 * ceiling the blank id takes
 * the page to the default route. `scripts/test-landing-identity-throttle.ts` holds
 * every call site to that.
 */
import { readLeadXbcLive, readSubmissionLeadIdLive } from "@/lib/salesforce/lead-xbc";
import { correctLinkToLeadScore, resolveRoutingCode, type RoutingCodeResolution } from "./lead-code.ts";
import { log } from "@/lib/log";
import { resolveRequestedCode } from "./catchall.ts";

/**
 * Whether the link's own code leaves the page needing a Salesforce read (#3246):
 * only then is a submission id worth spending the per address landing allowance on.
 */
export function codeNeedsLookup(requested: string | null | undefined): boolean {
  return resolveRequestedCode(requested ?? "").kind !== "valid";
}

export async function resolveLandingCode(
  requested: string | null | undefined,
  leadId: string | null | undefined,
  /** #3246: the submission the link named, already through the landing throttle,
   *  or null. Required, so every page says whether it has one. */
  submissionId: string | null,
): Promise<RoutingCodeResolution> {
  const routed = await resolveRoutingCode(requested, leadId, readLeadXbcLive, {
    id: submissionId,
    readLeadId: readSubmissionLeadIdLive,
  });
  // #3508: a link carrying a routable but STALE code is shown the lead's current
  // score's team. A failed read keeps the link's code, as before, and says so.
  const corrected = await correctLinkToLeadScore(routed, leadId, readLeadXbcLive, (err) =>
    log.warn("landing", { msg: "lead score unreadable, showing the link's code", code: routed.code }, err),
  );
  if (corrected.code !== routed.code) {
    log.info("landing", { msg: "link code corrected to the lead's current score", from: routed.code, to: corrected.code });
  }
  return corrected;
}

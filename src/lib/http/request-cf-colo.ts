/**
 * The runtime's `request.cf.colo` for the request in force, raw (#3784).
 *
 * Cloudflare documents it as "the data center that the request hit" and says nothing
 * about a placed Worker; a community thread is quoted as saying it stays the colo
 * nearest the client even when placement runs the Worker elsewhere, which nobody has
 * confirmed on Slate. So the confirm line logs it under its
 * own name, `request_cf_colo`, and never reads it as where the Worker ran: that is
 * `supabase_edge_colo` (`cf-ray.ts`). Comparing the two on one line is what settles
 * which this one is (docs/cloudflare-platform-notes.md, "Where a confirm ran").
 *
 * Kept apart from `cf-ray.ts` because it imports the OpenNext adapter, which a module
 * reachable from a client chunk (the call budget) must not.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * `request.cf.colo`, or null when there is no cf object (node, `next dev`) or it
 * cannot be read. Never throws: it only feeds a log line.
 */
export function requestCfColo(read: () => { colo?: unknown } | undefined = () => getCloudflareContext().cf): string | null {
  try {
    const colo = read()?.colo;
    return typeof colo === "string" && colo ? colo : null;
  } catch {
    return null;
  }
}

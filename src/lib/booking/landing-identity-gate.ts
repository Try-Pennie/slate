import { clientIp, landingIdentityAllowed } from "@/lib/rate-limit";

/**
 * The Salesforce id a lead landing page may look a person up by, or "" for none (#3106).
 *
 * `/book?external_id=` and `/booking/{id}` read the stored name, email and phone for the id
 * in the link, and whether that person already has a call. A lead id is not a secret, so
 * those reads are throttled per address. Over the ceiling the page still draws the ordinary
 * booker, just with nothing prefilled and no existing call named: a real lead can still book
 * (the confirm still refuses a second call), and somebody walking ids learns nothing. A link
 * with no id identifies nobody and spends nothing.
 */
export async function landingLookupId(
  id: string,
  /** Read only when there is an id to judge, so a link naming nobody touches nothing. */
  readHeaders: () => Promise<Headers>,
  allowed: (ip: string) => Promise<boolean> = landingIdentityAllowed,
): Promise<string> {
  const trimmed = id.trim();
  if (!trimmed) return "";
  return (await allowed(clientIp(await readHeaders()))) ? trimmed : "";
}

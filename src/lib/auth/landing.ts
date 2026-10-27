import { canManageAgents } from "./roles.ts";
import { ME_TABS } from "../me/nav.ts";
import type { Role } from "../db/types.ts";

/**
 * Where a signed in person lands, by role: the sign in callback and the root page
 * both send people here, and they used to write the split out twice (#4205).
 *
 * A coordinator lands on the coordinator booking page, the one page they open
 * (`canUseCoordinatorDesk`); managers and up on the console; everybody else on their
 * own pages. An admin opens the coordinator page too, from its address, but lands on
 * the console as before.
 */
export const COORDINATOR_PAGE = "/coordinator";

export function landingPathFor(role: Role): string {
  if (role === "coordinator") return COORDINATOR_PAGE;
  return canManageAgents(role) ? "/admin" : ME_TABS[0].href;
}

/**
 * The sign in error for an address that belongs to the placeholder advisor (#4205),
 * and what the sign in page says for it. Settled, not a retry: signing in again
 * reaches the same row (L111).
 */
export const PLACEHOLDER_ACCOUNT_LOGIN_ERROR = "placeholder_account";

export const PLACEHOLDER_ACCOUNT_MESSAGE =
  "This address belongs to the placeholder advisor, which nobody signs in as. Sign in with your own Pennie Google account.";

import { type NextRequest } from "next/server";
import { cronSecret } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";

/**
 * Cron lanes authorize via `Authorization: Bearer <CRON_SECRET>` only. The
 * secret is never accepted as a URL query param: query strings leak into CF
 * logs, observability, and browser history (#591). Compared constant-time via
 * the shared bearer helper (#594) so the secret can't be timed out.
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  return bearerTokenMatches(req.headers.get("authorization"), cronSecret());
}

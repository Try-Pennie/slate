import { type NextRequest } from "next/server";
import { cronSecret, cronSecret2 } from "@/lib/env";
import { bearerTokenMatches } from "@/lib/bearer-auth";

/**
 * Cron lanes authorize via `Authorization: Bearer <CRON_SECRET>` only. The
 * secret is never accepted as a URL query param: query strings leak into CF
 * logs, observability, and browser history (#591). Compared constant-time via
 * the shared bearer helper (#594) so the secret can't be timed out.
 *
 * A route answers a false here through `refuseCronSecret` (src/lib/bearer-failure.ts,
 * #3174), the failed credential throttle that leaves the Worker's own scheduled ticks
 * uncounted; `scripts/test-bearer-failure-throttle.ts` holds every call site to it.
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  return bearerTokenMatches(req.headers.get("authorization"), [cronSecret(), cronSecret2()]);
}

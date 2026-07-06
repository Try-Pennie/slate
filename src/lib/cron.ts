import { type NextRequest } from "next/server";
import { cronSecret } from "@/lib/env";

/**
 * Cron lanes authorize via `Authorization: Bearer <CRON_SECRET>` only. The
 * secret is never accepted as a URL query param: query strings leak into CF
 * logs, observability, and browser history (#591).
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${cronSecret()}`;
}

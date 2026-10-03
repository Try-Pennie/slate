import { NextResponse } from "next/server";
import { bearerFailureWithinLimit, clientIp } from "@/lib/rate-limit";

/**
 * The answer for a refused credential on a key authenticated route (#3142): the route's own
 * refusal, or a 429 once this address has failed too often in a minute.
 *
 * Asked only AFTER the credential failed, so a caller with a good key never spends anything,
 * and every key authenticated route refuses through it (`scripts/test-bearer-failure-throttle.ts`
 * enumerates them), so a flood of garbage tokens buys a bounded amount of work on each.
 */
export async function refuseCredential(
  headers: Headers,
  refusal: () => Response,
): Promise<Response> {
  if (await bearerFailureWithinLimit(clientIp(headers))) return refusal();
  return NextResponse.json(
    { error: "Too many failed attempts. Try again in a minute." },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

/**
 * The refusal for an `authenticateBearer` failure on the smoke endpoints: a refused
 * credential (401) goes through the throttle, while an unset key (503) is our own
 * deployment rather than a caller, so it is answered as is.
 */
export function refuseBearerAuth(
  headers: Headers,
  auth: { status: number; error: string },
): Promise<Response> | Response {
  const refusal = () => NextResponse.json({ error: auth.error }, { status: auth.status });
  return auth.status === 401 ? refuseCredential(headers, refusal) : refusal();
}

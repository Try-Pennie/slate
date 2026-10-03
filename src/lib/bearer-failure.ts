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

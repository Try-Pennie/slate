import { NextResponse } from "next/server";
import { bearerFailureWithinLimit, clientIp } from "@/lib/rate-limit";
import { UNIDENTIFIED_IP } from "@/lib/rate-limit-core";

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
 * The answer for a refused cron secret (#3174): the same failed credential throttle, with
 * one exception. The Worker's own scheduled ticks reach the cron routes as an in process
 * request (`worker/lane-run.ts`) that never crosses the network, so it carries no client
 * address, while every outside request through Cloudflare carries `cf-connecting-ip`.
 * A request with no address is therefore answered with the route's own refusal and counts
 * against nothing: if the deployment's secret were ever wrong, the lanes' own refusals must
 * read as the 401 they are rather than as a 429 against one shared counter.
 */
export async function refuseCronSecret(
  headers: Headers,
  refusal: () => Response,
): Promise<Response> {
  if (clientIp(headers) === UNIDENTIFIED_IP) return refusal();
  return refuseCredential(headers, refusal);
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

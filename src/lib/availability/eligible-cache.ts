/**
 * 60-second cross-invocation cache for eligibleAgentIds (#421).
 *
 * Use ONLY in monitoring/precompute cron lanes so every lane in a tick shares
 * one eligibility read per bucket rather than each re-querying the DB.
 *
 * The live booking path (booking/orchestration.ts) and routing API
 * (resolveRouting in service.ts) do NOT use this; they always call
 * eligibleAgentIds directly so a stale cache can never mis-route a real booking.
 *
 * Best-effort: any cache read/write failure falls through to the live
 * computation. Never throws.
 */

import type { Bucket } from "@/lib/db/types";
import { appUrl } from "@/lib/env";
import { eligibleAgentIds } from "./service.ts";
import { eligibleCacheKey, ELIGIBLE_TTL_SECONDS } from "./eligible-cache-key.ts";

export { eligibleCacheKey, ELIGIBLE_TTL_SECONDS } from "./eligible-cache-key.ts";

type CfCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
};

function eligibleCache(): CfCache | null {
  return (
    (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default ?? null
  );
}

function keyRequest(bucketId: string): Request {
  return new Request(
    `${appUrl()}/__eligible-cache/${encodeURIComponent(eligibleCacheKey(bucketId))}`,
  );
}

type EligibleResult = { ids: string[]; fallbackApplied: boolean };

/**
 * Eligible agents for `bucket`, served from the 60-second Cloudflare Cache API
 * when available, falling through to the live DB read on miss or in test/non-
 * Worker environments where `caches.default` is absent.
 *
 * @param resolver - Injectable live resolver; defaults to the real DB call.
 *                   Override in tests to avoid hitting the DB.
 */
export async function eligibleAgentIdsCached(
  bucket: Bucket,
  resolver: (b: Bucket) => Promise<EligibleResult> = eligibleAgentIds,
): Promise<EligibleResult> {
  const cache = eligibleCache();

  if (cache) {
    try {
      const hit = await cache.match(keyRequest(bucket.id));
      if (hit) {
        return JSON.parse(await hit.text()) as EligibleResult;
      }
    } catch {
      // Best-effort: a cache read error is not fatal; fall through to live.
    }
  }

  const result = await resolver(bucket);

  if (cache) {
    try {
      await cache.put(
        keyRequest(bucket.id),
        new Response(JSON.stringify(result), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ELIGIBLE_TTL_SECONDS}`,
          },
        }),
      );
    } catch {
      // Best-effort: a cache write failure is silent.
    }
  }

  return result;
}

import { getBucketSlots, type BucketSlots } from "./service";
import { slotCacheKey } from "./cache-key";
import { appUrl } from "@/lib/env";

export const SLOT_TTL_SECONDS = 60;
export const HORIZON_DAYS = 14;

// `caches.default` is a Cloudflare runtime extension not in the standard lib types.
type CfCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
  delete(req: Request): Promise<boolean>;
};
function slotCache(): CfCache | null {
  return (globalThis as unknown as { caches?: { default?: CfCache } }).caches?.default ?? null;
}

// Lookup-only key Request on the app's own zone (not a real route).
function keyRequest(key: string): Request {
  return new Request(`${appUrl()}/__slot-cache/${encodeURIComponent(key)}`);
}

export async function getCachedBucketSlots(
  code: string,
  fromIso: string,
  horizonDays = HORIZON_DAYS,
): Promise<BucketSlots | null> {
  const { key, fromIso: nf, toIso: nt } = slotCacheKey(code, fromIso, horizonDays);
  const cache = slotCache();
  const req = keyRequest(key);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return JSON.parse(await hit.text()) as BucketSlots;
    } catch { /* fall through to compute */ }
  }
  const fresh = await getBucketSlots(code, nf, nt);
  if (cache && fresh) {
    try {
      await cache.put(
        req,
        new Response(JSON.stringify(fresh), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${SLOT_TTL_SECONDS}`,
          },
        }),
      );
    } catch { /* ignore */ }
  }
  return fresh;
}

/**
 * Best-effort clear of a bucket's cached slots after a booking changes it.
 * The Cache API is per-datacenter with no prefix-list, so we delete the exact
 * current-day key (the only realistically-cached one, since reads use from≈now).
 * Other datacenters / a crossed day boundary ride the 60s TTL; verify-on-book is
 * the hard double-book guard regardless.
 */
export async function invalidateBucketSlots(code: string): Promise<void> {
  const cache = slotCache();
  if (!cache) return;
  try {
    const { key } = slotCacheKey(code, new Date().toISOString(), HORIZON_DAYS);
    await cache.delete(keyRequest(key));
  } catch { /* ignore */ }
}

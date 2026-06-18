import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getBucketSlots, type BucketSlots } from "./service";
import { slotCacheKey } from "./cache-key";

export const SLOT_TTL_SECONDS = 60;
export const HORIZON_DAYS = 14;

function kv(): CloudflareEnv["SLOT_CACHE"] | null {
  try { return getCloudflareContext().env.SLOT_CACHE ?? null; } catch { return null; }
}

export async function getCachedBucketSlots(
  code: string,
  fromIso: string,
  horizonDays = HORIZON_DAYS,
): Promise<BucketSlots | null> {
  const { key, fromIso: nf, toIso: nt } = slotCacheKey(code, fromIso, horizonDays);
  const store = kv();
  if (store) {
    try {
      const hit = await store.get(key, "json");
      if (hit) return hit as BucketSlots;
    } catch { /* fall through to compute */ }
  }
  const fresh = await getBucketSlots(code, nf, nt);
  if (store && fresh) {
    try { await store.put(key, JSON.stringify(fresh), { expirationTtl: SLOT_TTL_SECONDS }); } catch { /* ignore */ }
  }
  return fresh;
}

/** Best-effort: clear a bucket's cached slot lists after its availability changes. */
export async function invalidateBucketSlots(code: string): Promise<void> {
  const store = kv();
  if (!store) return;
  try {
    const { keys } = await store.list({ prefix: `slots:v1:${code}:` });
    await Promise.all(keys.map((k: { name: string }) => store.delete(k.name)));
  } catch { /* ignore */ }
}

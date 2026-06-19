import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBucketSlots, type BucketSlots } from "./service";

/**
 * IO for the precompute path (the `bucket_slots` table). The read orchestration
 * lives in precompute-core.ts (pure, DI, unit-tested); this module is the thin
 * Supabase layer + the writer used by refresh-on-change and the cron backstop.
 * Verified by build + the live latency re-measure, not a node unit test
 * (Supabase isn't reachable under `node`), matching slot-cache.ts's convention.
 */

/** Single indexed PK read of the precomputed blob. */
export async function readBucketSlotsRow(
  code: string,
): Promise<{ payload: unknown } | null> {
  const { data } = await supabaseAdmin()
    .from("bucket_slots")
    .select("payload")
    .eq("bucket_code", code)
    .maybeSingle();
  return (data as { payload: unknown } | null) ?? null;
}

/** Upsert a freshly computed blob for a bucket. */
export async function writeBucketSlotsRow(
  code: string,
  val: BucketSlots,
): Promise<void> {
  await supabaseAdmin()
    .from("bucket_slots")
    .upsert(
      { bucket_code: code, payload: val as unknown, computed_at: new Date().toISOString() },
      { onConflict: "bucket_code" },
    );
}

/**
 * Compute a bucket's slots the existing way and persist the blob. Used by the
 * refresh-on-change writers (booking / Google sync / OOO) and the cron backstop.
 * On compute failure we do NOT overwrite an existing good row with an empty one
 * — better to serve slightly-stale slots than a false "no times".
 */
export async function recomputeBucketSlots(
  code: string,
  fromIso: string,
  toIso: string,
): Promise<BucketSlots | null> {
  let fresh: BucketSlots | null = null;
  try {
    fresh = await getBucketSlots(code, fromIso, toIso);
  } catch {
    fresh = null;
  }
  if (fresh) await writeBucketSlotsRow(code, fresh);
  return fresh;
}

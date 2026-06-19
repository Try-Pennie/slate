import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBucketSlots, type BucketSlots } from "./service";
import { bucketsMatchingAgent, type BucketForMatch } from "./bucket-match";
import type { Attributes, Criteria } from "@/lib/db/types";

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

/** All bucket codes (for the cron backstop's rotation). */
export async function listAllBucketCodes(): Promise<string[]> {
  const { data } = await supabaseAdmin().from("buckets").select("code");
  return (data ?? []).map((b) => (b as { code: string }).code);
}

/** Existing precomputed rows with their last-computed time (epoch ms). */
export async function listKnownBucketSlotRows(): Promise<
  { code: string; computedAtMs: number }[]
> {
  const { data } = await supabaseAdmin()
    .from("bucket_slots")
    .select("bucket_code, computed_at");
  return (data ?? []).map((r) => {
    const row = r as { bucket_code: string; computed_at: string };
    return { code: row.bucket_code, computedAtMs: Date.parse(row.computed_at) };
  });
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

/**
 * The bucket codes an agent affects: org buckets where they're an active manual
 * member, match the attribute criteria, or are the fallback agent. Mirrors
 * resolveBucketAgentIds's eligibility so a calendar/OOO change recomputes exactly
 * the buckets whose slots could move. One small read + an in-memory filter.
 */
export async function bucketsForAgent(userId: string): Promise<string[]> {
  const db = supabaseAdmin();
  const { data: user } = await db
    .from("users")
    .select("org_id, attributes")
    .eq("id", userId)
    .maybeSingle();
  if (!user) return [];
  const u = user as { org_id: string; attributes: Attributes | null };

  const [bucketsRes, memberRes] = await Promise.all([
    db.from("buckets").select("id, code, criteria, fallback_user_id").eq("org_id", u.org_id),
    db.from("bucket_members").select("bucket_id").eq("user_id", userId).eq("active", true),
  ]);
  const manualBucketIds = new Set(
    (memberRes.data ?? []).map((m) => (m as { bucket_id: string }).bucket_id),
  );
  const buckets: BucketForMatch[] = (bucketsRes.data ?? []).map((b) => {
    const row = b as {
      id: string;
      code: string;
      criteria: Criteria | null;
      fallback_user_id: string | null;
    };
    return {
      code: row.code,
      criteria: row.criteria ?? {},
      manualMemberIds: manualBucketIds.has(row.id) ? [userId] : [],
      fallbackUserId: row.fallback_user_id,
    };
  });
  return bucketsMatchingAgent(userId, u.attributes ?? {}, buckets);
}

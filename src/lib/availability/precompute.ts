import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { getBucketSlots, type BucketSlots } from "./service";
import { bucketsMatchingAgent, type BucketForMatch } from "./bucket-match";
import type { Attributes, Criteria } from "@/lib/db/types";
import { log } from "@/lib/log";

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
  const data = unwrap(
    await supabaseAdmin()
      .from("bucket_slots")
      .select("payload")
      .eq("bucket_code", code)
      .maybeSingle(),
    "readBucketSlotsRow",
  );
  return (data as { payload: unknown } | null) ?? null;
}

/** All bucket codes (for the cron backstop's rotation). */
export async function listAllBucketCodes(): Promise<string[]> {
  const data = unwrap(
    await supabaseAdmin().from("buckets").select("code"),
    "listAllBucketCodes",
  );
  return (data ?? []).map((b) => (b as { code: string }).code);
}

/** Existing precomputed rows with their last-computed time (epoch ms). */
export async function listKnownBucketSlotRows(): Promise<
  { code: string; computedAtMs: number }[]
> {
  const data = unwrap(
    await supabaseAdmin()
      .from("bucket_slots")
      .select("bucket_code, computed_at"),
    "listKnownBucketSlotRows",
  );
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
  } catch (err) {
    // A failed availability read (#277) must NOT write an empty slot row — that
    // is the silent "no availability" degrade. Skip the write so the prior row
    // stands and the recompute lane's stale-bucket alarm surfaces it; log the
    // cause here so the alarm isn't the only trace of WHY the bucket went stale.
    log.error("precompute", { msg: "recompute skipped", bucket: code }, err);
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
  return (await bucketsForAgents([userId])).get(userId) ?? [];
}

/**
 * The same answer for MANY agents in a constant 3 queries (#762), rather than 3
 * per agent. The per-agent version cost one `users` read, one `buckets` read (the
 * whole org, identical on every call) and one `bucket_members` read EACH, so the
 * every-minute lanes paid up to ~600 reads per sweep to answer a question that
 * three reads answer. The matching itself is the same pure predicate.
 *
 * Fails loud on a query error (#313, same class as #277): swallowing a failed read
 * returned no buckets, so a changed agent's buckets silently never recomputed.
 * Throw instead; `touchedBucketCodes` logs it and the freshness sweep backstops.
 */
export async function bucketsForAgents(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;

  const db = supabaseAdmin();
  const users = (unwrap(
    await db.from("users").select("id, org_id, attributes").in("id", ids),
    "bucketsForAgents users",
  ) ?? []) as { id: string; org_id: string; attributes: Attributes | null }[];
  if (users.length === 0) return out;

  const orgIds = [...new Set(users.map((u) => u.org_id))];
  const [bucketsRes, memberRes] = await Promise.all([
    db
      .from("buckets")
      .select("id, code, criteria, fallback_user_id, org_id")
      .in("org_id", orgIds),
    db.from("bucket_members").select("bucket_id, user_id").in("user_id", ids).eq("active", true),
  ]);

  const bucketRows = (unwrap(bucketsRes, "bucketsForAgents buckets") ?? []) as {
    id: string;
    code: string;
    criteria: Criteria | null;
    fallback_user_id: string | null;
    org_id: string;
  }[];
  const memberRows = (unwrap(memberRes, "bucketsForAgents members") ?? []) as {
    bucket_id: string;
    user_id: string;
  }[];

  // Membership is per (bucket, agent), so it must stay keyed by both: one batched
  // read now carries every requested agent's rows, and handing the whole list to
  // each agent would make them all look like members of each other's buckets.
  const membersByBucket = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = membersByBucket.get(m.bucket_id);
    if (list) list.push(m.user_id);
    else membersByBucket.set(m.bucket_id, [m.user_id]);
  }

  const byOrg = new Map<string, BucketForMatch[]>();
  for (const row of bucketRows) {
    const forMatch: BucketForMatch = {
      code: row.code,
      criteria: row.criteria ?? {},
      manualMemberIds: membersByBucket.get(row.id) ?? [],
      fallbackUserId: row.fallback_user_id,
    };
    const list = byOrg.get(row.org_id);
    if (list) list.push(forMatch);
    else byOrg.set(row.org_id, [forMatch]);
  }

  for (const u of users) {
    out.set(
      u.id,
      bucketsMatchingAgent(u.id, u.attributes ?? {}, byOrg.get(u.org_id) ?? []),
    );
  }
  return out;
}

/**
 * The deduped, bounded set of bucket codes a group of changed agents affects, ready
 * to hand to the recompute fan-out (#762).
 *
 * This is the shape all three every-minute callers wanted (both self-heal reconcile
 * sweeps and the Google sync lane), each of which had its own copy of a serial
 * per-agent loop. The cap is what bounds the downstream recompute.
 *
 * A failed lookup logs and yields nothing rather than throwing: every caller is a
 * best-effort refresh whose job is to make a change show up in ~1 min, and the
 * recompute lane's freshness sweep is the real backstop. It must not fail silently,
 * hence the log. (Unlike the old per-agent loop, one bad read now costs the whole
 * batch, but a batched read fails at the DB level, not per agent.)
 */
export async function touchedBucketCodes(
  userIds: string[],
  max: number,
  label: string,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  try {
    const byAgent = await bucketsForAgents(userIds);
    const touched = new Set<string>();
    for (const codes of byAgent.values()) {
      for (const code of codes) touched.add(code);
    }
    return [...touched].slice(0, max);
  } catch (err) {
    log.error("precompute", { msg: "bucket lookup failed", label, agents: userIds.length }, err);
    return [];
  }
}

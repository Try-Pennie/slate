import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { parseStampMs } from "@/lib/date/stamp";
import { getBucketSlots, type BucketSlots, type EligibleResolver } from "./service";
import { bucketsMatchingAgent, type BucketForMatch } from "./bucket-match";
import { trimToBookableDays } from "./bookable-days";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import type { Attributes, Criteria } from "@/lib/db/types";
import type { InvalidationMarker } from "./precompute-cron";
import { log } from "@/lib/log";

/**
 * IO for the precompute path (the `bucket_slots` table). The read orchestration
 * lives in precompute-core.ts (pure, DI, unit-tested); this module is the thin
 * Supabase layer + the writer used by refresh-on-change and the cron backstop.
 * Verified by build + the live latency re-measure, not a node unit test
 * (Supabase isn't reachable under `node`), matching slot-cache.ts's convention.
 */

/** Single indexed PK read of the precomputed blob + its freshness stamp (#257). */
export async function readBucketSlotsRow(
  code: string,
): Promise<{ payload: unknown; computed_at: string } | null> {
  const data = unwrap(
    await supabaseAdmin()
      .from("bucket_slots")
      .select("payload, computed_at")
      .eq("bucket_code", code)
      .maybeSingle(),
    "readBucketSlotsRow",
  );
  return (data as { payload: unknown; computed_at: string } | null) ?? null;
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
    // #1169: fail closed. An unparseable computed_at reads as epoch 0 (ancient:
    // first in line to recompute, flagged stale), never NaN, which compared false
    // against the freshness window so the bucket was never recomputed AND never
    // flagged: a frozen slot cache with no alert.
    return { code: row.bucket_code, computedAtMs: parseStampMs(row.computed_at) ?? 0 };
  });
}

/**
 * Per-bucket cached slot COUNT over the precomputed (4-day) horizon, for the
 * availability canary (#749). One row per bucket (`bucket_slots` is roster-bounded
 * and on SAFE_TABLES), so a single page. A row whose payload has no slots array
 * counts as zero.
 */
export async function listBucketSlotCounts(): Promise<{ code: string; slots: number }[]> {
  const data = unwrap(
    await supabaseAdmin().from("bucket_slots").select("bucket_code, payload"),
    "listBucketSlotCounts",
  );
  return (data ?? []).map((r) => {
    const row = r as { bucket_code: string; payload: { slots?: unknown[] } | null };
    const slots = Array.isArray(row.payload?.slots) ? row.payload.slots.length : 0;
    return { code: row.bucket_code, slots };
  });
}

/** Epoch stamp used to force a row "due" for recompute (older than any freshness
 *  window). */
const STALE_STAMP = "1970-01-01T00:00:00.000Z";

/**
 * Mark every precomputed row stale (#216): back-date `computed_at` so
 * `bucketsDueForRecompute` treats all buckets as due and the recompute lane
 * rebuilds them over the CURRENT horizon on its next tick(s). Used by the admin
 * horizon-save so a change converges promptly instead of trickling out only as
 * rows naturally age past the freshness window. A bulk write (never a capped read);
 * roster-bounded, so a single statement covers every bucket. Returns the number of
 * rows re-stamped. Idempotent: a second run matches nothing (rows are already at the
 * epoch stamp, so `gt` excludes them).
 */
export async function markAllBucketSlotsStale(): Promise<number> {
  // Record the INTENT before causing the staleness (#1301, and the L33 ordering).
  // A marker with no staleness grants a grace nothing needs, which is harmless;
  // staleness with no marker is the false page this exists to prevent, so the
  // write that can strand us must not be the second one.
  await recordMassInvalidation();
  const data = unwrap(
    await supabaseAdmin()
      .from("bucket_slots")
      .update({ computed_at: STALE_STAMP })
      .gt("computed_at", STALE_STAMP)
      .select("bucket_code"),
    "markAllBucketSlotsStale",
  );
  return (data ?? []).length;
}

/**
 * The "a deliberate mass invalidation is draining" marker (#1301).
 *
 * Stored in `alert_state`, already a generic key-to-timestamp table with deny-all
 * RLS, so this needs no migration (the same trick as the #1102 lane watchdog). The
 * key is namespaced away from the `bucket_slots_stale` cooldown key so the two
 * cannot collide.
 *
 * All three helpers are best-effort and never throw: they ride a cron lane and an
 * admin save, and neither should fail over a monitoring marker. The failure
 * directions are chosen so a marker problem can never buy silence: a failed READ
 * returns null, which `staleBucketPage` treats as "nothing explains this
 * staleness", so it PAGES.
 */
const MASS_INVALIDATION_KEY = "bucket_slots_invalidated_at";

async function recordMassInvalidation(): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("alert_state")
      .upsert(
        { key: MASS_INVALIDATION_KEY, last_sent_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    if (error) {
      log.warn("precompute", { msg: "invalidation marker write failed", error: error.message });
    }
  } catch (err) {
    log.error("precompute", { msg: "invalidation marker write threw" }, err);
  }
}

/** When the last deliberate mass invalidation happened, or null if none is on
 *  record. NaN when the stored stamp is unreadable, which pages rather than
 *  granting an open-ended grace (#1169). */
export async function readMassInvalidationMarker(): Promise<InvalidationMarker> {
  try {
    // Reads `error` deliberately (#1304): a failed read and an ABSENT marker used
    // to share one null, and they call for opposite handling. Absent is the normal
    // state and pages at once; a failed read is tolerated for a few ticks. Scoring
    // one as the other means either an alarm three minutes late every time it
    // matters, or a page for every database blip.
    const { data, error } = await supabaseAdmin()
      .from("alert_state")
      .select("last_sent_at")
      .eq("key", MASS_INVALIDATION_KEY)
      .maybeSingle();
    if (error) {
      log.warn("precompute", { msg: "invalidation marker read failed", error: error.message });
      return { state: "unreadable" };
    }
    const at = (data as { last_sent_at: string } | null)?.last_sent_at;
    if (!at) return { state: "absent" };
    const atMs = parseStampMs(at);
    // A stamp we cannot parse is unreadable, not absent: the marker IS there, we
    // just cannot tell when it was written, and treating that as "nobody
    // invalidated anything" would page through a real drain (#1169's direction).
    if (atMs === null) {
      log.warn("precompute", { msg: "invalidation marker unparseable", at });
      return { state: "unreadable" };
    }
    return { state: "at", atMs };
  } catch (err) {
    log.warn("precompute", { msg: "invalidation marker read threw" }, err);
    return { state: "unreadable" };
  }
}

/** Drop the marker once the drain has finished, so the NEXT staleness pages at
 *  once instead of inheriting a grace it did not earn. */
export async function clearMassInvalidation(): Promise<void> {
  try {
    await supabaseAdmin().from("alert_state").delete().eq("key", MASS_INVALIDATION_KEY);
  } catch (err) {
    log.warn("precompute", { msg: "invalidation marker clear failed" });
    void err;
  }
}

/** Upsert a freshly computed blob for a bucket. */
export async function writeBucketSlotsRow(
  code: string,
  val: BucketSlots,
): Promise<string> {
  const computedAt = new Date().toISOString();
  await supabaseAdmin()
    .from("bucket_slots")
    .upsert(
      { bucket_code: code, payload: val as unknown, computed_at: computedAt },
      { onConflict: "bucket_code" },
    );
  return computedAt;
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
  resolveEligible?: EligibleResolver,
  bookableDays?: number,
): Promise<BucketSlots | null> {
  let fresh: BucketSlots | null = null;
  try {
    fresh = await getBucketSlots(code, fromIso, toIso, resolveEligible);
    // #1326: [fromIso, toIso) is a SEARCH window, deliberately wider than the number
    // of days we intend to offer, so a closed day inside it cannot eat one of them.
    // Trim to the first `bookableDays` days that actually produced times before the
    // row is stored, so what is persisted is exactly what a lead is offered.
    //
    // Trimmed at COMPUTE time rather than on read, so the read path stays free of a
    // settings lookup. A horizon change therefore lands on the next recompute, which
    // is already how it works: the admin save marks every bucket stale.
    if (fresh && bookableDays !== undefined) {
      fresh = {
        ...fresh,
        slots: trimToBookableDays(fresh.slots, BUSINESS_ZONE, bookableDays),
      };
    }
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

import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import {
  computeBucketSlots,
  freeMembersForSlot,
  type MemberAvailability,
} from "@/lib/availability/compute";
import { matchesCriteria } from "@/lib/availability/match";
import {
  applyFallback,
  payPeriod,
  bucketShareFromResult,
  orderByBucketShare,
  shadowRankingDivergence,
} from "@/lib/availability/roundrobin";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import type { Attributes, Bucket, EventType } from "@/lib/db/types";

/**
 * Resolves a bucket's round-robin pool: active manual members UNION agents in
 * the org whose attributes match the bucket criteria. Either source may be
 * empty; manual selection and attribute routing compose.
 */
export async function resolveBucketAgentIds(bucket: Bucket): Promise<string[]> {
  const db = supabaseAdmin();

  // The manual-members and org-agents reads are independent, so fire them
  // together: one round-trip instead of two on the availability hot path.
  const [membersRes, agentsRes] = await Promise.all([
    db
      .from("bucket_members")
      .select("user_id")
      .eq("bucket_id", bucket.id)
      .eq("active", true),
    // One pass over org agents: include a bookable agent if they're a manual
    // member OR match the criteria. Non-bookable and deactivated (offboarded)
    // agents never enter the pool.
    db
      .from("users")
      .select("id, attributes, bookable")
      .eq("org_id", bucket.org_id)
      .eq("bookable", true)
      .is("deactivated_at", null),
  ]);
  // Fail loud on a query error (#277): a broken read here used to swallow into
  // an empty pool and silently show no availability. Throw instead.
  const manual = new Set(
    (unwrap(membersRes, "bucket_members") ?? []).map(
      (m) => (m as { user_id: string }).user_id,
    ),
  );

  const criteria = bucket.criteria ?? {};
  const hasCriteria = Object.keys(criteria).length > 0;
  const agents = unwrap(agentsRes, "bucket pool agents");

  return (agents ?? [])
    .filter((a) => {
      const row = a as { id: string; attributes: Attributes };
      return manual.has(row.id) || (hasCriteria && matchesCriteria(row.attributes, criteria));
    })
    .map((a) => (a as { id: string }).id);
}

/**
 * The agents eligible for a bucket, with the fallback applied: the matched pool
 * (manual ∪ attribute), or — when that's empty and the bucket has a
 * `fallback_user_id` — just the fallback agent. `fallbackApplied` flags which.
 */
export async function eligibleAgentIds(
  bucket: Bucket,
): Promise<{ ids: string[]; fallbackApplied: boolean }> {
  const matched = await resolveBucketAgentIds(bucket);
  // The fallback is only consulted when the matched pool is empty, so skip the
  // eligibility round-trip otherwise. A stored fallback_user_id can point at an
  // agent who is no longer bookable (or, with offboarding, deactivated); never
  // route to them just because the pool came up empty.
  if (matched.length > 0 || !bucket.fallback_user_id) {
    return applyFallback(matched, bucket.fallback_user_id, false);
  }
  const db = supabaseAdmin();
  const fallback = unwrap(
    await db
      .from("users")
      .select("id")
      .eq("id", bucket.fallback_user_id)
      .eq("org_id", bucket.org_id)
      .eq("bookable", true)
      .is("deactivated_at", null)
      .maybeSingle(),
    "fallback agent",
  );
  return applyFallback(matched, bucket.fallback_user_id, !!fallback);
}

export interface ResolvedBucket {
  bucket: Bucket;
  eventType: EventType;
}

/** Look up a bucket by its public code (the `xbc` query param) + its event type. */
export async function resolveBucketByCode(
  code: string,
): Promise<ResolvedBucket | null> {
  const db = supabaseAdmin();
  const bucket = unwrap(
    await db.from("buckets").select("*").eq("code", code).maybeSingle(),
    "bucket by code",
  );
  if (!bucket) return null;

  const eventType = unwrap(
    await db
      .from("event_types")
      .select("*")
      .eq("id", (bucket as Bucket).event_type_id)
      .maybeSingle(),
    "event type",
  );
  if (!eventType) return null;

  return { bucket: bucket as Bucket, eventType: eventType as EventType };
}

/** Loads cached availability for the bucket's resolved pool over [from, to]. */
export async function loadMembersAvailability(
  bucket: Bucket,
  from: string,
  to: string,
): Promise<MemberAvailability[]> {
  const db = supabaseAdmin();

  const { ids: userIds } = await eligibleAgentIds(bucket);
  if (userIds.length === 0) return [];

  const [schedulesRes, busyRes, bookingsRes] = await Promise.all([
    db.from("availability_schedules").select("id, user_id, timezone").in("user_id", userIds),
    db
      .from("busy_blocks")
      .select("user_id, starts_at, ends_at")
      .in("user_id", userIds)
      .lt("starts_at", to)
      .gt("ends_at", from),
    db
      .from("bookings")
      .select("assigned_user_id, starts_at")
      .in("assigned_user_id", userIds)
      .in("status", ["confirmed", "rescheduled"])
      .gte("starts_at", from)
      .lte("starts_at", to),
  ]);

  // Fail loud on any of these reads (#277). A swallowed busy_blocks error is
  // the worst case: an agent looks fully free and gets overbooked. Throwing
  // surfaces the broken query instead of silently degrading availability.
  const schedules = (unwrap(schedulesRes, "availability_schedules") ?? []) as {
    id: string;
    user_id: string;
    timezone: string;
  }[];
  const busy = (unwrap(busyRes, "busy_blocks") ?? []) as {
    user_id: string;
    starts_at: string;
    ends_at: string;
  }[];
  const bookingStarts = (unwrap(bookingsRes, "bookings") ?? []) as {
    assigned_user_id: string;
    starts_at: string;
  }[];
  const scheduleIds = schedules.map((s) => s.id);

  const rulesRes = scheduleIds.length
    ? await db
        .from("availability_rules")
        .select("schedule_id, weekday, start_minute, end_minute")
        .in("schedule_id", scheduleIds)
    : { data: [], error: null };

  const rules = (unwrap(rulesRes, "availability_rules") ?? []) as {
    schedule_id: string;
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];

  return userIds.map((userId) => {
    const schedule = schedules.find((s) => s.user_id === userId);
    return {
      userId,
      timezone: schedule?.timezone ?? "America/New_York",
      rules: schedule
        ? rules.filter((r) => r.schedule_id === schedule.id)
        : [],
      busy: busy
        .filter((b) => b.user_id === userId)
        .map((b) => ({
          start: Date.parse(b.starts_at),
          end: Date.parse(b.ends_at),
        })),
      bookingStartsMs: bookingStarts
        .filter((b) => b.assigned_user_id === userId)
        .map((b) => Date.parse(b.starts_at)),
    } satisfies MemberAvailability;
  });
}

export interface BucketSlots {
  bucket: Bucket;
  eventType: EventType;
  orgName: string;
  slots: string[];
}

/** Cached slot list for a bucket code — the read path for the embed modal. */
export async function getBucketSlots(
  code: string,
  from: string,
  to: string,
): Promise<BucketSlots | null> {
  const resolved = await resolveBucketByCode(code);
  if (!resolved) return null;
  const { bucket, eventType } = resolved;

  // The org-name read doesn't depend on member availability, so overlap them
  // instead of running the org lookup as its own sequential hop.
  const [orgRes, members] = await Promise.all([
    supabaseAdmin()
      .from("organizations")
      .select("name")
      .eq("id", bucket.org_id)
      .maybeSingle(),
    loadMembersAvailability(bucket, from, to),
  ]);
  const org = orgRes.data;
  const slots = computeBucketSlots({
    members,
    durationMin: eventType.duration_min,
    bufferBeforeMin: eventType.buffer_before_min,
    bufferAfterMin: eventType.buffer_after_min,
    minNoticeMin: eventType.min_notice_min,
    dailyCap: eventType.daily_cap,
    slotIntervalMin: eventType.slot_interval_min,
    from,
    to,
    nowMs: Date.now(),
  });

  return {
    bucket,
    eventType,
    orgName: (org as { name: string } | null)?.name ?? "",
    slots,
  };
}

/**
 * Round-robin candidate order for a specific slot: the cached-free members,
 * ordered least-recently-booked first (the agent booked longest ago, or never,
 * is tried first). Verify-on-book then confirms with a single live Google check
 * before committing. No mutable pointer — fair under concurrency and immune to
 * the reschedule double-count the old `rr_last_assigned_user_id` rotation had.
 */
export async function roundRobinCandidates(
  bucket: Bucket,
  eventType: EventType,
  startMs: number,
): Promise<string[]> {
  const endIso = new Date(
    startMs + eventType.duration_min * 60_000,
  ).toISOString();
  const members = await loadMembersAvailability(
    bucket,
    new Date(startMs).toISOString(),
    endIso,
  );

  const free = freeMembersForSlot(
    members,
    {
      durationMin: eventType.duration_min,
      bufferBeforeMin: eventType.buffer_before_min,
      bufferAfterMin: eventType.buffer_after_min,
      minNoticeMin: eventType.min_notice_min,
      dailyCap: eventType.daily_cap,
      slotIntervalMin: eventType.slot_interval_min,
      nowMs: Date.now(),
    },
    startMs,
  );
  if (free.length <= 1) return free;
  // Per-bucket equal-share (#305): anchor the pay period on the SLOT's start so a
  // next-period slot balances against next-period meetings. shadowLog=true: this
  // is the real assignment path, so log the equal-share vs recency divergence
  // (#321) for pre-cutover validation.
  return rankBucketShare(
    bucket.id,
    free,
    startMs,
    "verify-on-book candidate order",
    true,
  );
}

const UNFAIR_ORDERING_ALERT_KEY = "rr_ordering_degraded";
const UNFAIR_ORDERING_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * The fairness ordering read failed. Per the booking-never-fails rule (#277) the
 * booking still proceeds; the assignment just may not reflect each agent's fair
 * share this period. Fire a throttled alert so a potentially unfair assignment is
 * visible. Never throws (a failed alert must not fail the booking).
 */
async function alertUnfairOrdering(context: string): Promise<void> {
  await sendThrottledAlert(
    UNFAIR_ORDERING_ALERT_KEY,
    UNFAIR_ORDERING_COOLDOWN_MS,
    `Slate: equal-share fairness ordering degraded (${context}). The booking still went through, but agent assignment may not reflect each agent's fair share this period. Check DB health.`,
  ).catch(() => {});
}

/**
 * Shared per-bucket equal-share ranker (#305) for BOTH the booking path and the
 * routing API, so they can't diverge. Among `candidateIds`, orders by fewest
 * bookings in `bucketId` whose meeting falls in the pay period containing
 * `anchorMs`, tie-broken least-recently-booked then id (new-to-pool agents seeded
 * at the pool average). Reads one bucket's bookings from the prior period start
 * through this period's end (the prior window distinguishes a brand-new agent
 * from an established-but-quiet one). Fail-safe: a read error degrades to a valid
 * order and alerts, never throws.
 */
async function rankBucketShare(
  bucketId: string,
  candidateIds: string[],
  anchorMs: number,
  context: string,
  shadowLog = false,
): Promise<string[]> {
  if (candidateIds.length <= 1) return candidateIds;
  const period = payPeriod(anchorMs);
  const priorStartMs = payPeriod(period.startMs - 1).startMs;
  const share = bucketShareFromResult(
    await supabaseAdmin()
      .from("bookings")
      .select("assigned_user_id, starts_at, created_at")
      .eq("bucket_id", bucketId)
      .gte("starts_at", new Date(priorStartMs).toISOString())
      .lt("starts_at", new Date(period.endMs).toISOString())
      .in("assigned_user_id", candidateIds)
      .in("status", ["confirmed", "rescheduled", "completed"]),
    period.startMs,
  );
  if (share.degraded) await alertUnfairOrdering(context);

  // Pre-cutover shadow run (#321): on the real assignment path, log how the live
  // equal-share order compares to the prior recency order, so the equal-share
  // distribution can be validated against real traffic before the fleet relies
  // on it. Structured line for Cloudflare observability; assignment is unaffected
  // (the live order is always equal-share). Skipped for the routing-API preview.
  if (shadowLog && !share.degraded) {
    const div = shadowRankingDivergence(candidateIds, share);
    console.log(
      JSON.stringify({
        tag: "routing_shadow",
        bucket_id: bucketId,
        anchor_ms: anchorMs,
        candidates: candidateIds.length,
        diverged: div.diverged,
        equal_share_top: div.equalShareTop,
        recency_top: div.recencyTop,
        equal_share_order: div.equalShareOrder,
        recency_order: div.recencyOrder,
      }),
    );
    return div.equalShareOrder;
  }
  return orderByBucketShare(candidateIds, share);
}

export interface RoutingResolution {
  bucket: Bucket;
  eventType: EventType;
  eligibleIds: string[];
  fallbackApplied: boolean;
  routedAgentId: string | null;
}

/**
 * Resolve routing for a bucket code (xbc) WITHOUT a calendar check: the eligible
 * agents (fallback applied), ordered least-recently-booked, plus the top pick.
 * Powers the standalone routing API; the booking flow still verifies on book.
 */
export async function resolveRouting(
  code: string,
): Promise<RoutingResolution | null> {
  const resolved = await resolveBucketByCode(code);
  if (!resolved) return null;
  const { bucket, eventType } = resolved;
  const { ids, fallbackApplied } = await eligibleAgentIds(bucket);
  // No slot in a routing preview, so anchor the period on now.
  const ordered = await rankBucketShare(bucket.id, ids, Date.now(), "routing API order");
  return {
    bucket,
    eventType,
    eligibleIds: ordered,
    fallbackApplied,
    routedAgentId: ordered[0] ?? null,
  };
}

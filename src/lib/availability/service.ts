import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  computeBucketSlots,
  freeMembersForSlot,
  type MemberAvailability,
} from "@/lib/availability/compute";
import { matchesCriteria } from "@/lib/availability/match";
import {
  applyFallback,
  orderByLeastRecentlyBooked,
} from "@/lib/availability/roundrobin";
import type { Attributes, Bucket, EventType } from "@/lib/db/types";

/**
 * Resolves a bucket's round-robin pool: active manual members UNION agents in
 * the org whose attributes match the bucket criteria. Either source may be
 * empty; manual selection and attribute routing compose.
 */
export async function resolveBucketAgentIds(bucket: Bucket): Promise<string[]> {
  const db = supabaseAdmin();

  const { data: members } = await db
    .from("bucket_members")
    .select("user_id")
    .eq("bucket_id", bucket.id)
    .eq("active", true);
  const manual = new Set(
    (members ?? []).map((m) => (m as { user_id: string }).user_id),
  );

  const criteria = bucket.criteria ?? {};
  const hasCriteria = Object.keys(criteria).length > 0;

  // One pass over org agents: include a bookable agent if they're a manual
  // member OR match the criteria. Non-bookable agents never enter the pool.
  const { data: agents } = await db
    .from("users")
    .select("id, attributes, bookable")
    .eq("org_id", bucket.org_id)
    .eq("bookable", true);

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
  return applyFallback(matched, bucket.fallback_user_id);
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
  const { data: bucket } = await db
    .from("buckets")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (!bucket) return null;

  const { data: eventType } = await db
    .from("event_types")
    .select("*")
    .eq("id", (bucket as Bucket).event_type_id)
    .maybeSingle();
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

  const schedules = (schedulesRes.data ?? []) as {
    id: string;
    user_id: string;
    timezone: string;
  }[];
  const scheduleIds = schedules.map((s) => s.id);

  const { data: rulesData } = scheduleIds.length
    ? await db
        .from("availability_rules")
        .select("schedule_id, weekday, start_minute, end_minute")
        .in("schedule_id", scheduleIds)
    : { data: [] };

  const rules = (rulesData ?? []) as {
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
      busy: (busyRes.data ?? [])
        .filter((b) => (b as { user_id: string }).user_id === userId)
        .map((b) => {
          const row = b as { starts_at: string; ends_at: string };
          return { start: Date.parse(row.starts_at), end: Date.parse(row.ends_at) };
        }),
      bookingStartsMs: (bookingsRes.data ?? [])
        .filter((b) => (b as { assigned_user_id: string }).assigned_user_id === userId)
        .map((b) => Date.parse((b as { starts_at: string }).starts_at)),
    } satisfies MemberAvailability;
  });
}

export interface BucketSlots {
  bucket: Bucket;
  eventType: EventType;
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

  const members = await loadMembersAvailability(bucket, from, to);
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

  return { bucket, eventType, slots };
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

  // Newest active booking per free agent → least-recently-booked goes first.
  const { data } = await supabaseAdmin()
    .from("bookings")
    .select("assigned_user_id, created_at")
    .in("assigned_user_id", free)
    .in("status", ["confirmed", "rescheduled", "completed"]);

  const lastBookedAtMs: Record<string, number | null> = {};
  for (const r of (data ?? []) as { assigned_user_id: string; created_at: string }[]) {
    const t = Date.parse(r.created_at);
    const prev = lastBookedAtMs[r.assigned_user_id];
    if (prev == null || t > prev) lastBookedAtMs[r.assigned_user_id] = t;
  }

  return orderByLeastRecentlyBooked(free, lastBookedAtMs);
}

/** Order agents least-recently-booked first (newest active booking's created_at). */
async function rankByLeastRecentlyBooked(ids: string[]): Promise<string[]> {
  if (ids.length <= 1) return ids;
  const { data } = await supabaseAdmin()
    .from("bookings")
    .select("assigned_user_id, created_at")
    .in("assigned_user_id", ids)
    .in("status", ["confirmed", "rescheduled", "completed"]);

  const lastBookedAtMs: Record<string, number | null> = {};
  for (const r of (data ?? []) as { assigned_user_id: string; created_at: string }[]) {
    const t = Date.parse(r.created_at);
    const prev = lastBookedAtMs[r.assigned_user_id];
    if (prev == null || t > prev) lastBookedAtMs[r.assigned_user_id] = t;
  }
  return orderByLeastRecentlyBooked(ids, lastBookedAtMs);
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
  const ordered = await rankByLeastRecentlyBooked(ids);
  return {
    bucket,
    eventType,
    eligibleIds: ordered,
    fallbackApplied,
    routedAgentId: ordered[0] ?? null,
  };
}

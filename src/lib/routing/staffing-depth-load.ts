import type { supabaseAdmin } from "@/lib/supabase/admin";
import {
  bucketStaffingDepths,
  isRoutable,
  type ActiveMember,
  type StaffingAgent,
  type TierDepth,
} from "./staffing-depth";
import { isAllDayBlock } from "@/lib/google/sync-core";
import { selectAllPages } from "@/lib/supabase/paginate";
import type { Bucket, BucketMember, BusyBlock, OooRequest, User } from "@/lib/db/types";

/** Mirrors the sync + availability compute fallback, so the depth math and the
 *  cached blocks agree on which local day an all-day event occupies (#616). */
const FALLBACK_TIMEZONE = "America/New_York";

/**
 * The agents who are out right now because their own Google calendar is blocked
 * for the whole local day (#744), rather than because they filed a Slate time-off
 * request. Reads each block in ITS OWN agent's timezone, so an ET agent's all-day
 * event can never discount a PT agent.
 */
async function loadAllDayOutUserIds(
  db: ReturnType<typeof supabaseAdmin>,
  agentIds: string[],
  nowIso: string,
): Promise<Set<string>> {
  type BlockRow = Pick<BusyBlock, "user_id" | "starts_at" | "ends_at">;
  type ScheduleRow = { user_id: string; timezone: string | null };

  const [blocks, schedules] = await Promise.all([
    // Google-sourced blocks covering `now` (starts_at <= now < ends_at). Scoped
    // to the roster's agents, which also keeps this org-scoped.
    selectAllPages<BlockRow>("staffing depth busy_blocks", (from, to) =>
      db
        .from("busy_blocks")
        .select("user_id, starts_at, ends_at")
        .eq("source", "gcal")
        .in("user_id", agentIds)
        .lte("starts_at", nowIso)
        .gt("ends_at", nowIso)
        .range(from, to),
    ),
    selectAllPages<ScheduleRow>("staffing depth availability_schedules", (from, to) =>
      db.from("availability_schedules").select("user_id, timezone").in("user_id", agentIds).range(from, to),
    ),
  ]);

  // First schedule wins, matching sync's loadAgentTimezone (see #533: a user with
  // several schedules is a data problem tracked separately, not decided here).
  const timezoneByUser = new Map<string, string>();
  for (const s of schedules) {
    if (s.timezone && !timezoneByUser.has(s.user_id)) timezoneByUser.set(s.user_id, s.timezone);
  }

  const out = new Set<string>();
  for (const b of blocks) {
    const tz = timezoneByUser.get(b.user_id) ?? FALLBACK_TIMEZONE;
    if (isAllDayBlock(b.starts_at, b.ends_at, tz)) out.add(b.user_id);
  }
  return out;
}

/**
 * Shared IO loader for per-tier staffing depth (#584 view + #569 cron whisper).
 * One source of truth for the reads and the roster mapping the depth math needs,
 * so the admin page and the monitor cron can never diverge.
 *
 * `orgId` scopes buckets + users + OOO (the admin page passes the caller's org);
 * the cron omits it (Slate is structurally single-org and the monitor scans
 * org-wide, matching its existing bucket load). `now` (#738) defines "out today":
 * an agent with an approved OOO active at `now` is discounted from effective
 * depth. Row volumes here (≈60 buckets, ~200 agents, a few hundred memberships,
 * a handful of active OOOs) sit well under PostgREST's 1,000-row cap.
 */
export async function loadTierDepths(
  db: ReturnType<typeof supabaseAdmin>,
  orgId?: string,
  now: Date = new Date(),
): Promise<TierDepth[]> {
  const nowIso = now.toISOString();
  let bucketsQuery = db.from("buckets").select("*");
  let usersQuery = db.from("users").select("id, name, email, attributes, bookable, deactivated_at");
  // Approved time off that covers `now`: starts_at <= now < ends_at (ends_at is
  // exclusive, matching the all-day busy_block convention).
  let oooQuery = db
    // cap-safe: agents whose approved time off covers this instant, at most the roster size.
    .from("ooo_requests")
    .select("user_id")
    .eq("status", "approved")
    .lte("starts_at", nowIso)
    .gt("ends_at", nowIso);
  if (orgId) {
    bucketsQuery = bucketsQuery.eq("org_id", orgId);
    usersQuery = usersQuery.eq("org_id", orgId);
    oooQuery = oooQuery.eq("org_id", orgId);
  }
  const [bucketsRes, usersRes, membersRes, oooRes] = await Promise.all([
    bucketsQuery,
    usersQuery,
    // Only active memberships count toward a pool (matches resolveBucketPool).
    db.from("bucket_members").select("bucket_id, user_id").eq("active", true),
    oooQuery,
  ]);

  const buckets = (bucketsRes.data ?? []) as Bucket[];
  const userRows = (usersRes.data ?? []) as Pick<
    User,
    "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at"
  >[];
  // Match the booker exactly: it routes to any bookable, non-deactivated agent
  // (it does NOT exclude the synthetic test agent), so neither do we here.
  const agents: StaffingAgent[] = userRows.map((u) => ({
    id: u.id,
    name: u.name ?? u.email,
    attributes: u.attributes,
    bookable: u.bookable,
    deactivated_at: u.deactivated_at,
  }));
  const activeMembers: ActiveMember[] = (
    (membersRes.data ?? []) as Pick<BucketMember, "bucket_id" | "user_id">[]
  ).map((m) => ({ bucket_id: m.bucket_id, user_id: m.user_id }));
  const outUserIds = new Set(
    ((oooRes.data ?? []) as Pick<OooRequest, "user_id">[]).map((o) => o.user_id),
  );

  // #744: an agent is also out when their own calendar is blocked all day, with
  // no Slate time-off request. Only routable agents can affect a tier's depth, so
  // scoping the block read to them bounds it and matches bucketStaffingDepths.
  const routableIds = agents.filter(isRoutable).map((a) => a.id);
  for (const id of await loadAllDayOutUserIds(db, routableIds, nowIso)) outUserIds.add(id);

  return bucketStaffingDepths(buckets, agents, activeMembers, outUserIds);
}

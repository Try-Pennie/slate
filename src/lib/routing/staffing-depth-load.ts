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
import { unwrap } from "@/lib/db/result";
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
    selectAllPages<BlockRow>("staffing depth busy_blocks", "id", () =>
      db
        .from("busy_blocks")
        .select("id, user_id, starts_at, ends_at")
        .eq("source", "gcal")
        .in("user_id", agentIds)
        .lte("starts_at", nowIso)
        .gt("ends_at", nowIso),
    ),
    selectAllPages<ScheduleRow>("staffing depth availability_schedules", "id", () =>
      db.from("availability_schedules").select("id, user_id, timezone").in("user_id", agentIds),
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
 *
 * ## It THROWS on an unreadable read, and that is its only failure signal (#1629)
 *
 * All four reads go through `unwrap`. Before that they were `(<name>Res.data ?? [])`,
 * so a failed `buckets` or `users` query produced an EMPTY depth list, and every
 * consumer read that as a real answer: `/admin/tiers` rendered "No tiers yet", the
 * thin-tier whisper counted zero thin tiers, and the availability canary scored
 * zero staffed buckets and answered a healthy 200 on a read that never ran.
 *
 * A throw rather than a `null` return, deliberately: this function ALREADY threw
 * on an unreadable `busy_blocks` / `availability_schedules` read (both go through
 * `selectAllPages`), so returning a null for the other four would give one
 * function two different ways to say "I could not tell", and a caller that handled
 * only one of them would be silently wrong on the other. One contract: a depth
 * list means it was measured, and an exception means it was not.
 *
 * Every caller must map that exception to an explicit unknown rather than to a
 * number. A count nobody could measure is `null`, never `0`:
 *   - `/api/health/availability` answers 503 with `staffedBuckets: null`;
 *   - `/admin/tiers` renders its unreadable state instead of "No tiers yet";
 *   - `bucketSupplyReport` takes `depthByCode: null` and shows depth as unknown;
 *   - the monitor's thin-tier step is inside `steps.run(..., null, ...)`, so the
 *     step records a failure and the whisper does not fire on nothing.
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

  const buckets = (unwrap(bucketsRes, "staffing depth buckets") ?? []) as Bucket[];
  const userRows = (unwrap(usersRes, "staffing depth users") ?? []) as Pick<
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
    (unwrap(membersRes, "staffing depth bucket_members") ?? []) as Pick<
      BucketMember,
      "bucket_id" | "user_id"
    >[]
  ).map((m) => ({ bucket_id: m.bucket_id, user_id: m.user_id }));
  const outUserIds = new Set(
    (
      (unwrap(oooRes, "staffing depth ooo_requests") ?? []) as Pick<OooRequest, "user_id">[]
    ).map((o) => o.user_id),
  );

  // #744: an agent is also out when their own calendar is blocked all day, with
  // no Slate time-off request. Only routable agents can affect a tier's depth, so
  // scoping the block read to them bounds it and matches bucketStaffingDepths.
  const routableIds = agents.filter(isRoutable).map((a) => a.id);
  for (const id of await loadAllDayOutUserIds(db, routableIds, nowIso)) outUserIds.add(id);

  return bucketStaffingDepths(buckets, agents, activeMembers, outUserIds);
}

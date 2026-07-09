import type { supabaseAdmin } from "@/lib/supabase/admin";
import { bucketStaffingDepths, type ActiveMember, type StaffingAgent, type TierDepth } from "./staffing-depth";
import type { Bucket, BucketMember, User } from "@/lib/db/types";

/**
 * Shared IO loader for per-tier staffing depth (#584 view + #569 cron whisper).
 * One source of truth for the three reads and the roster mapping the depth math
 * needs, so the admin page and the monitor cron can never diverge.
 *
 * `orgId` scopes buckets + users (the admin page passes the caller's org); the
 * cron omits it (Slate is structurally single-org and the monitor scans org-wide,
 * matching its existing bucket load). Row volumes here (≈60 buckets, ~200 agents,
 * a few hundred memberships) sit well under PostgREST's 1,000-row cap.
 */
export async function loadTierDepths(
  db: ReturnType<typeof supabaseAdmin>,
  orgId?: string,
): Promise<TierDepth[]> {
  let bucketsQuery = db.from("buckets").select("*");
  let usersQuery = db.from("users").select("id, name, email, attributes, bookable, deactivated_at");
  if (orgId) {
    bucketsQuery = bucketsQuery.eq("org_id", orgId);
    usersQuery = usersQuery.eq("org_id", orgId);
  }
  const [bucketsRes, usersRes, membersRes] = await Promise.all([
    bucketsQuery,
    usersQuery,
    // Only active memberships count toward a pool (matches resolveBucketPool).
    db.from("bucket_members").select("bucket_id, user_id").eq("active", true),
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

  return bucketStaffingDepths(buckets, agents, activeMembers);
}

import { bucketStaffingDepths, type StaffingAgent } from "@/lib/routing/staffing-depth";
import type { Bucket, BucketMember, User } from "@/lib/db/types";

/**
 * Bookable-agent depth per bucket code for the admin buckets editor (#584).
 *
 * Delegates to the shared staffing-depth helper so the editor's "N eligible
 * agents" line matches the booker's pool exactly (bookable + not deactivated,
 * active members only) instead of an ad-hoc recompute that could drift. Owns the
 * admin-page transformation the page used to inline: User -> StaffingAgent and
 * the active-membership filter.
 */
export function bucketDepthByCode(
  buckets: Bucket[],
  users: Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">[],
  members: Pick<BucketMember, "bucket_id" | "user_id" | "active">[],
): Map<string, number> {
  const agents: StaffingAgent[] = users.map((u) => ({
    id: u.id,
    name: u.name ?? u.email,
    attributes: u.attributes,
    bookable: u.bookable,
    deactivated_at: u.deactivated_at,
  }));
  const activeMembers = members
    .filter((m) => m.active)
    .map((m) => ({ bucket_id: m.bucket_id, user_id: m.user_id }));
  return new Map(
    bucketStaffingDepths(buckets, agents, activeMembers).map((d) => [d.code, d.depth]),
  );
}

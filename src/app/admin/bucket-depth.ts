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
function depthRows(
  buckets: Bucket[],
  users: Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">[],
  members: Pick<BucketMember, "bucket_id" | "user_id" | "active">[],
) {
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
  return bucketStaffingDepths(buckets, agents, activeMembers);
}

/**
 * Depth and overflow for every bucket in ONE staffing depth pass, which is what
 * the buckets page reads (Dan, 2026-10-02). The editor counts the ROSTER, so the
 * overflow is the roster overflow, not today's: a bucket nobody matches whose
 * ladder reaches a staffed pool is not failing its leads. It is named by the
 * pool's words, or the rung's code where the criteria are not the routing matrix,
 * since this page is admin only and codes are its vocabulary. Null overflow when
 * the bucket is staffed or the ladder reaches nobody.
 */
export function bucketCoverageByCode(
  buckets: Bucket[],
  users: Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">[],
  members: Pick<BucketMember, "bucket_id" | "user_id" | "active">[],
): Map<string, { depth: number; overflowTo: string | null }> {
  return new Map(
    depthRows(buckets, users, members).map((d) => [
      d.code,
      {
        depth: d.depth,
        overflowTo: d.overflowOnRoster ? (d.overflowOnRoster.label ?? d.overflowOnRoster.code) : null,
      },
    ]),
  );
}

export function bucketDepthByCode(
  buckets: Bucket[],
  users: Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">[],
  members: Pick<BucketMember, "bucket_id" | "user_id" | "active">[],
): Map<string, number> {
  return new Map([...bucketCoverageByCode(buckets, users, members)].map(([c, v]) => [c, v.depth]));
}

export function bucketOverflowByCode(
  buckets: Bucket[],
  users: Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">[],
  members: Pick<BucketMember, "bucket_id" | "user_id" | "active">[],
): Map<string, string | null> {
  return new Map([...bucketCoverageByCode(buckets, users, members)].map(([c, v]) => [c, v.overflowTo]));
}

import { bucketStaffingDepths, type StaffingAgent } from "@/lib/routing/staffing-depth";
import type { Bucket, BucketMember, User } from "@/lib/db/types";

/** The shared staffing depth rows for the editor's own inputs. */
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
 * Bookable-agent depth per bucket code for the admin buckets editor (#584), and
 * where each empty bucket's leads go (Dan, 2026-10-02), from ONE staffing depth
 * pass.
 *
 * Delegates to the shared staffing-depth helper so the editor's "N eligible
 * agents" line matches the booker's pool exactly (bookable + not deactivated,
 * active members only) instead of an ad-hoc recompute that could drift. Owns the
 * admin-page transformation the page used to inline: User -> StaffingAgent and
 * the active-membership filter.
 *
 * The editor counts the ROSTER, so the overflow is the roster overflow, not
 * today's: a bucket nobody matches whose ladder reaches a staffed pool is not
 * failing its leads. It is named by the pool's words, or the rung's code where
 * the criteria are not the routing matrix, since this page is admin only and
 * codes are its vocabulary. Null when the bucket is staffed or the ladder
 * reaches nobody.
 */
export function bucketCoverageByCode(
  buckets: Bucket[],
  users: Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">[],
  members: Pick<BucketMember, "bucket_id" | "user_id" | "active">[],
): { depthByCode: Map<string, number>; overflowByCode: Map<string, string | null> } {
  const rows = depthRows(buckets, users, members);
  return {
    depthByCode: new Map(rows.map((d) => [d.code, d.depth])),
    overflowByCode: new Map(
      rows.map((d) => [
        d.code,
        d.overflowOnRoster ? (d.overflowOnRoster.label ?? d.overflowOnRoster.code) : null,
      ]),
    ),
  };
}

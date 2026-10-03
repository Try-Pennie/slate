import { supabaseAdmin } from "@/lib/supabase/admin";
import { isRole } from "@/lib/auth/roles";
import { pendingQueueScope } from "@/lib/ooo/core";
import { log } from "@/lib/log";
import { PendingBadge } from "@/components/ui/PendingBadge";

/**
 * The pending time off count on the Team Requests tab (#1847).
 *
 * ## Why it is its own component
 *
 * It was the LAST SERIAL HOP in front of every internal page. Measured in
 * production on 2026-09-03, an admin page came back in 100 to 563ms of wall time
 * on 8 to 37ms of Worker CPU: those pages were not working, they were waiting.
 * The header ran its reads in a chain, and this one was at the end of it because
 * it filtered on the staff ids the read before it returned (that read went with
 * #3114, below).
 *
 * On `/admin/agents` the roster read the person actually asked for finished at
 * +391ms while this count had not started until +390ms. The content was ready
 * and waiting on a badge.
 *
 * Pulled out here it sits under its own `Suspense` boundary, so the shell and
 * the page flush as soon as the page's own data is ready and the count fills in
 * a moment later. That is fine for what it is: a nudge, on a tab whose page is
 * one click away.
 *
 * ## What did not change
 *
 * The count still consults its own `error` and logs rather than rendering a
 * healthy zero (#1165), and an unreadable count still hides the badge and still
 * lets the header render. Throwing here would take down every admin page over a
 * nudge, and the Team Requests page is the source of truth one click away.
 */
export async function PendingApprovalsBadge({
  role,
  userId,
  orgId,
}: {
  role: string | null | undefined;
  userId: string | null | undefined;
  orgId: string | null | undefined;
}) {
  if (!role || !isRole(role) || !userId || !orgId) return null;

  // #3114: count exactly the Team Requests queue, which is what this viewer can
  // decide (`pendingQueueScope`, held equal to canModerate). Admin-authored
  // requests used to be dropped here; an admin cannot decide their own time off
  // now, so the other moderators are the ones who must be nudged about it.
  const scope = pendingQueueScope({ id: userId, role });
  if (!scope) return null;

  let q = supabaseAdmin()
    .from("ooo_requests")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "pending");
  if (scope.managerId) q = q.eq("manager_id", scope.managerId);
  if (scope.excludeUserId) q = q.neq("user_id", scope.excludeUserId);

  // #1165: consult `error`. A failed count came back null and `?? 0` hid the
  // badge, which is exactly what an empty queue looks like, so a broken read
  // presented as "nothing waiting for you".
  const { count, error } = await q;
  if (error) {
    log.warn("app-header", {
      msg: "pending time-off count read failed; badge hidden",
      org_id: orgId,
      err: error.message,
    });
  }

  return <PendingBadge count={count ?? 0} />;
}

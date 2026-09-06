import { supabaseAdmin } from "@/lib/supabase/admin";
import { canModerateAllOoo, isRole } from "@/lib/auth/roles";
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
 * The header ran its reads in a chain, and this one is at the end of it because
 * it filters on the staff ids the read before it returns.
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

  // Exclude requests authored by admins and super admins, mirroring the Team
  // Requests page, so test and operator requests cannot inflate the badge.
  //
  // error-ok: an unreadable staff list means the exclusion is not applied; the
  // count below consults its own error and hides the badge either way.
  const staffRows = (
    await supabaseAdmin()
      .from("users")
      .select("id")
      .eq("org_id", orgId)
      .in("role", ["admin", "super_admin"])
  ).data as { id: string }[] | null;

  const staffIds = (staffRows ?? []).map((u) => u.id);

  let q = supabaseAdmin()
    .from("ooo_requests")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "pending");
  if (staffIds.length > 0) q = q.not("user_id", "in", `(${staffIds.join(",")})`);
  // Scoped to the manager's own reports; team leads and up see the whole org.
  if (!canModerateAllOoo(role)) q = q.eq("manager_id", userId);

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

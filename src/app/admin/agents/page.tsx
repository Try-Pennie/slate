import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents, canEditOrgSettings, ROLES } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isActive } from "@/lib/active-user";
import { rosterFiltersFromParams } from "@/lib/admin/roster-filter";
import { syncSalesforceNow } from "@/app/admin/actions";
import { SyncButton } from "@/components/SyncButton";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { RosterTable } from "@/components/admin/RosterTable";
import { teamsOf } from "@/lib/admin/agent-display";
import { cardCls, proseCls } from "@/components/ui/styles";
import type { User } from "@/lib/db/types";
import { IMPERSONATION_WARNING } from "@/lib/admin/impersonation-copy";

export const dynamic = "force-dynamic";

export default async function AgentRosterPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    role?: string;
    team?: string;
    manager?: string;
    bookable?: string;
    page?: string;
    imp_error?: string;
    synced?: string;
    sync_error?: string;
  }>;
}) {
  const sp = await searchParams;

  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");
  const isAdmin = canEditOrgSettings(me.role);

  // Exclude the synthetic smoke-test agent (#396) from the roster and the counts.
  const usersRes = await supabaseAdmin()
    .from("users")
    .select("*")
    .eq("org_id", me.org_id)
    .eq("is_test", false);
  // #1629: an unreadable roster and an empty one render identically once the
  // error is dropped, and this is the page somebody opens when access is not
  // working. Kept as an explicit "could not tell" so the surfaces that can say
  // so, do.
  const users = (usersRes.data ?? []) as User[];
  const rosterUnreadable = usersRes.error != null;
  const bookableAgents = users.filter((u) => u.bookable && isActive(u));
  // The push-health pill and the sync-health panel moved to the Health page
  // (#1748), which is where anything time sensitive lives; this page is the
  // roster itself.

  // Filter option lists, derived from the roster so they only offer real values.
  const rolesPresent = ROLES.filter((r) => users.some((u) => u.role === r));
  const teamOptions = [...new Set(users.flatMap(teamsOf))].sort();
  const managerOptions = [
    ...new Map(
      users
        .filter((u) => u.manager_id)
        .map((u) => {
          const mgr = users.find((x) => x.id === u.manager_id);
          return [u.manager_id!, mgr ? (mgr.name ?? mgr.email) : u.manager_id!] as const;
        }),
    ),
  ].sort((a, b) => a[1].localeCompare(b[1]));

  // #1752: the roster is filtered in the BROWSER. This server-side pass is the
  // no-JavaScript path and the first paint, and it goes through the SAME
  // predicate the client component uses, so the two cannot drift apart.
  const filters = rosterFiltersFromParams(
    new URLSearchParams(
      Object.entries(sp).filter(([, v]) => typeof v === "string") as [string, string][],
    ),
  );

  return (
    <>
      <AdminPageHeader title="Agent roster">
        Everyone Slate can route a lead to, and whether they are bookable.
      </AdminPageHeader>
      {sp.synced && (
        <div className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-fg">
          Salesforce sync complete. {sp.synced}.
        </div>
      )}
      {sp.sync_error && (
        <div
          role="alert"
          className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
        >
          Salesforce sync failed: {sp.sync_error}
        </div>
      )}
      <section id="agents" className={cardCls}>
        {rosterUnreadable && (
          <UnreadableNotice className="mb-4">
            The roster could not be read, so this list is not the roster. Nobody
            has been removed. Reload in a moment.
          </UnreadableNotice>
        )}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">
              Agents{" "}
              {rosterUnreadable ? (
                <span className="font-normal text-fg-muted">(count unavailable)</span>
              ) : (
                <span className="font-normal text-fg-muted tabular-nums">
                  ({bookableAgents.length} bookable / {users.length})
                </span>
              )}
            </h2>
          </div>
          {isAdmin && (
            <form action={syncSalesforceNow}>
              <SyncButton />
            </form>
          )}
        </div>
        {/* #1795: a failed "view as" redirects here, so the message is rendered
            here. It used to be rendered inside a panel that the redirect never
            reached, which made every failure silent. */}
        {sp.imp_error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {sp.imp_error}
          </p>
        )}
        {/* The only explanation of what "view as" does. It lived inside the free
            text panel that is now gone, and each row's own control had no warning
            of its own, so it sits above the table where it covers whichever
            control the row ends up carrying (#1794 is moving that). */}
        {isAdmin && (
          <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>{IMPERSONATION_WARNING}</p>
        )}
        <RosterTable
          rows={users}
          initialFilters={filters}
          actorRole={me.role}
          actorId={me.id}
          roleOptions={rolesPresent}
          teamOptions={teamOptions}
          managerOptions={managerOptions}
          totalRoster={users.length}
        />
      </section>
    </>
  );
}

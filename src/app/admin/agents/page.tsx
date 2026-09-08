import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { canManageAgents, ROLES } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { rosterFiltersFromParams } from "@/lib/admin/roster-filter";
import { syncSalesforceNow } from "@/app/admin/actions";
import { SyncButton } from "@/components/SyncButton";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { RosterTable } from "@/components/admin/RosterTable";
import { teamsOf } from "@/lib/admin/agent-display";
import { cardCls } from "@/components/ui/styles";
import type { User } from "@/lib/db/types";

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
    /** The Twilio half refused while Salesforce succeeded (#2097). */
    twilio_error?: string;
  }>;
}) {
  const sp = await searchParams;

  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");

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
      {/* The job reads Salesforce and Twilio (#2097), so it is named for what it
          does rather than for one of its two sources. One vocabulary for it in
          every place it is mentioned, including the button (L605). */}
      {sp.synced && (
        <div className="rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-pennie-graphite">
          Roster sync complete. {sp.synced}.
        </div>
      )}
      {sp.sync_error && (
        <div
          role="alert"
          className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
        >
          Roster sync failed: {sp.sync_error}
        </div>
      )}
      {/* Half a run. It sits BESIDE the success wash above rather than replacing
          it: the Salesforce writes committed, so calling the run a failure would be
          a lie, and calling it a plain success would hide that the Redistribute tag
          was not acted on at all. */}
      {sp.twilio_error && (
        <UnreadableNotice>
          Twilio could not be read, so nobody was taken out of the bookable pool for
          the Redistribute tag and nobody was put back in. Salesforce still synced.{" "}
          {sp.twilio_error}
        </UnreadableNotice>
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
            {/* Just "Agents" (#1810). The parenthetical read as a ratio with a
                word on only one of its numbers, and its two halves counted
                different populations. Both questions are already answered
                better elsewhere: the table has a Bookable column and a status
                filter, which gives the actual rows, and the fleet figure lives
                on the Health page where fleet health belongs. The unreadable
                case keeps its own notice above, so removing this does not make
                a failed read look like a healthy one. */}
            <h2 className="text-sm font-semibold">Agents</h2>
          </div>
          {/* #2071: for every manager, not only admins. The person who has just
              added a hire in Salesforce and cannot see them here is a manager, and
              the page already admits nobody below that role. */}
          <SaveForm action={syncSalesforceNow} name="salesforce-sync">
            <SyncButton />
          </SaveForm>
        </div>
        {/* #1795: a failed "view as" redirects here, so the message is rendered
            here. It used to be rendered inside a panel that the redirect never
            reached, which made every failure silent. */}
        {sp.imp_error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {sp.imp_error}
          </p>
        )}
        <RosterTable
          rows={users}
          initialFilters={filters}
          actorRole={me.role}
          actorId={me.id}
          roleOptions={rolesPresent}
          teamOptions={teamOptions}
          managerOptions={managerOptions}
        />
      </section>
    </>
  );
}

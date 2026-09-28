import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { cardCls, proseCls } from "@/components/ui/styles";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { TeamHoursTable } from "@/components/admin/TeamHoursTable";
import { teamHoursScope } from "@/lib/admin/team-hours";
import { loadTeamHours } from "@/lib/admin/team-hours-load";

export const dynamic = "force-dynamic";

/**
 * Team hours (#1757): every agent's timezone and week, grouped by manager, so a
 * manager can check their own team in one pass instead of opening one agent at a
 * time. Read only; each name opens that agent's hours editor.
 *
 * Who sees what is `teamHoursScope`'s decision, applied in the loader's query as
 * well as in the builder, so a manager's page never reads another team's rows.
 */
export default async function TeamHoursPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  const scope = teamHoursScope(me);
  if (!canManageAgents(me.role) || scope === null) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to view team hours.
      </main>
    );
  }

  const result = await loadTeamHours(me, scope);
  const own = scope.kind === "team";

  return (
    <>
      <AdminPageHeader title={own ? "Your team's hours" : "Team hours"}>
        A lead is only offered an agent inside these hours, read in the
        agent&apos;s own timezone, so a wrong week here is a wrong time offered.
      </AdminPageHeader>

      {result.kind === "unreadable" ? (
        <UnreadableNotice>
          {result.what === "roster"
            ? "Your team could not be read just now, so nobody is listed. Nothing here means your team is empty. Reload to try again."
            : "The working hours could not be read just now, so no week is shown. Nothing here means anybody has no hours. Reload to try again."}
        </UnreadableNotice>
      ) : result.groups.length === 0 ? (
        <section className={cardCls}>
          <p className={`text-sm text-fg-muted ${proseCls}`}>
            {own
              ? "Nobody has you as their manager of record in Slate. Managers come from Salesforce, so an agent missing from here has a different manager there."
              : "There are no agents on the roster."}
          </p>
        </section>
      ) : (
        <TeamHoursTable groups={result.groups} showTeamHeadings={!own} />
      )}
    </>
  );
}

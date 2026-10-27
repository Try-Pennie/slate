import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { atLeast, canManageAgents, ROLES } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { rosterFiltersFromParams, rosterPhotoNotice, type RosterHours } from "@/lib/admin/roster-filter";
import { loadPhotoRecords } from "@/lib/advisor-photos/store";
import { photoOutcomeFromParams, photoOutcomeText } from "@/lib/advisor-photos/copy";
import { resolveAdvisorPhoto, type PhotoRecord } from "@/lib/advisor-photos/resolve";
import { loadRosterHours } from "@/lib/admin/roster-hours";
import { log } from "@/lib/log";
import { refreshAdvisorPhotosNow, syncSalesforceNow } from "@/app/admin/actions";
import { SyncButton } from "@/components/SyncButton";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { RosterTable } from "@/components/admin/RosterTable";
import { teamsOf } from "@/lib/admin/agent-display";
import { btnSecondaryCls, cardCls } from "@/components/ui/styles";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { User } from "@/lib/db/types";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";

export const metadata = { title: "Agent roster" };

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
    /** The outcome of "Refresh photos from Google" (#3027): a code and counts. */
    photos?: string;
    pa?: string;
    pg?: string;
    pc?: string;
    pl?: string;
    pu?: string;
    pf?: string;
    pm?: string;
    pd?: string;
    ph?: string;
    pr?: string;
  }>;
}) {
  const sp = await searchParams;

  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canManageAgents(me.role)) return <AdminDenied need="a manager or admin" />;

  // Real advisors only (#396, #4201): no smoke-test agent or placeholder in the
  // roster and the counts.
  const usersRes = await realAdvisorsOnly(
    supabaseAdmin().from("users").select("*").eq("org_id", me.org_id),
  );
  // #1629: an unreadable roster and an empty one render identically once the
  // error is dropped, and this is the page somebody opens when access is not
  // working. Kept as an explicit "could not tell" so the surfaces that can say
  // so, do.
  const users = (usersRes.data ?? []) as User[];
  const rosterUnreadable = usersRes.error != null;
  // #1802: whether each agent's working hours are still the seeded default, a
  // fact Slate records (`hours_source`, #1753). Its own boundary: a failed read
  // costs the Hours column, never the roster, and is said once rather than drawn
  // as a column of "None" that would read as nobody having hours.
  let hoursByUser: Map<string, RosterHours> | null = null;
  if (!rosterUnreadable) {
    try {
      hoursByUser = await loadRosterHours(supabaseAdmin(), me.org_id, users.map((u) => u.id));
    } catch (err) {
      log.error("admin-roster", { msg: "working hours unreadable" }, err);
    }
  }
  // #3027: each person's picture, resolved once here so the roster never reads
  // `avatar_url` itself. Its own boundary like the hours: a failed read becomes the
  // explicit unreadable state and one sentence above the table, never a roster of
  // people who all appear to need a photo.
  let photoRecords: Map<string, PhotoRecord> | null = null;
  if (!rosterUnreadable) {
    try {
      photoRecords = await loadPhotoRecords(users.map((u) => u.id));
    } catch (err) {
      log.error("admin-roster", { msg: "advisor photos unreadable" }, err);
    }
  }
  const rows = users.map((u) => ({
    ...u,
    hours: hoursByUser?.get(u.id) ?? null,
    photo: resolveAdvisorPhoto(u, photoRecords),
  }));
  const photoNotice = rosterUnreadable ? null : rosterPhotoNotice(rows);
  const isAdmin = atLeast(me.role, "admin");
  // #3027: the button's outcome arrives as a code and numbers and is looked up
  // here, so a crafted link can only ever draw one of the sentences copy.ts holds.
  const photoRun = photoOutcomeFromParams(sp, "photos");
  const photoNoticeFromRun = photoRun ? photoOutcomeText(photoRun) : null;

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
  const parsed = rosterFiltersFromParams(
    new URLSearchParams(
      Object.entries(sp).filter(([, v]) => typeof v === "string") as [string, string][],
    ),
  );
  // With no hours read there is no hours picker, so a linked hours filter would
  // empty the table for a reason no control on the page shows.
  const filters = hoursByUser ? parsed : { ...parsed, hours: "" as const };

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
      {/* #3027: the manual photo refresh reports back to this page (L608). */}
      {photoNoticeFromRun && (
        <div
          role={photoNoticeFromRun.ok ? undefined : "alert"}
          className={
            photoNoticeFromRun.ok
              ? "rounded-md bg-[var(--pennie-green-wash)] px-5 py-4 text-sm text-pennie-graphite"
              : "rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
          }
        >
          {photoNoticeFromRun.text}
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
          <div className="flex flex-wrap items-center gap-2">
            {/* #3027: admins only, matching the server side check in the action. */}
            {isAdmin && (
              <SaveForm action={refreshAdvisorPhotosNow} name="advisor-photos-refresh" unsaved="nothing typed here">
                <SubmitButton className={`${btnSecondaryCls} min-h-11 disabled:opacity-80`} pendingLabel="Reading photos from Google">
                  Refresh photos from Google
                </SubmitButton>
              </SaveForm>
            )}
            <SaveForm action={syncSalesforceNow} name="salesforce-sync" unsaved="nothing typed here">
              <SyncButton />
            </SaveForm>
          </div>
        </div>
        {/* #1795: a failed "view as" redirects here, so the message is rendered
            here. It used to be rendered inside a panel that the redirect never
            reached, which made every failure silent. */}
        {sp.imp_error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {sp.imp_error}
          </p>
        )}
        {!rosterUnreadable && !hoursByUser && (
          <UnreadableNotice className="mb-4">
            Working hours could not be read, so the roster is shown without them.
            Reload in a moment.
          </UnreadableNotice>
        )}
        {photoNotice && (
          <UnreadableNotice className="mb-4">{photoNotice}</UnreadableNotice>
        )}
        <RosterTable
          rows={rows}
          hoursReadable={hoursByUser !== null}
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

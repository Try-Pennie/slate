import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { atLeast, canManageAgents, canEditOrgSettings, roleLabel, ROLES } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isActive } from "@/lib/active-user";
import { paginateRows } from "@/lib/paginate-rows";
import { startImpersonation, syncSalesforceNow } from "@/app/admin/actions";
import { AutoSubmitSelect } from "@/components/ui/AutoSubmitSelect";
import { FilterForm } from "@/components/ui/FilterForm";
import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { SyncButton } from "@/components/SyncButton";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { Pill } from "@/components/ui/Pill";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import { attrToText, teamsOf } from "@/lib/admin/agent-display";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, proseCls } from "@/components/ui/styles";
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
    imp_email?: string;
    synced?: string;
    sync_error?: string;
  }>;
}) {
  const sp = await searchParams;
  const query = (sp.q ?? "").trim().toLowerCase();
  const roleFilter = sp.role ?? "";
  const teamFilter = sp.team ?? "";
  const managerFilter = sp.manager ?? "";
  const bookableFilter = sp.bookable ?? ""; // "" all · "yes" · "no"
  const requestedPage = Number.parseInt(sp.page ?? "1", 10);
  const hasFilter =
    !!query || !!roleFilter || !!teamFilter || !!managerFilter || !!bookableFilter;

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

  const lastNameKey = (u: User): string => {
    const name = (u.name ?? "").trim();
    if (!name) return (u.email ?? "").toLowerCase();
    const parts = name.split(/\s+/);
    return parts[parts.length - 1].toLowerCase();
  };

  const filterCtl =
    "h-11 rounded-sm border border-border bg-surface px-2.5 text-sm text-fg";
  // Filter option lists, derived from the roster so they only offer real values.
  const rolesPresent = ROLES.filter((r) => users.some((u) => u.role === r));
  const teamOptions = [...new Set(users.flatMap(teamsOf))].sort();
  const managerOptions = [
    ...new Map(
      users
        .filter((u) => u.manager_id)
        .map((u) => [u.manager_id as string, users.find((x) => x.id === u.manager_id)] as const)
        // Admins and super admins are operators, not real managers, so keep them out
        // of the manager filter even if they're set as someone's manager_id.
        .filter(([, m]) => m && !atLeast(m.role, "admin"))
        .map(([id, m]) => [id, m ? (m.name ?? m.email) : "Unknown"] as [string, string]),
    ),
  ].sort((a, b) => a[1].localeCompare(b[1]));

  const visibleAgents = users
    .filter((u) => {
      if (!isActive(u)) return false; // hide offboarded users from the roster
      if (roleFilter && u.role !== roleFilter) return false;
      if (bookableFilter === "yes" && !u.bookable) return false;
      if (bookableFilter === "no" && u.bookable) return false;
      if (teamFilter && !teamsOf(u).includes(teamFilter)) return false;
      if (managerFilter && u.manager_id !== managerFilter) return false;
      if (query) {
        const hay = `${u.name ?? ""} ${u.email}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        lastNameKey(a).localeCompare(lastNameKey(b)) ||
        (a.name ?? a.email).localeCompare(b.name ?? b.email),
    );

  // Render the roster a page at a time so the DOM stays bounded as the roster
  // grows (#94). The full `users` load stays whole (the bucket/depth/filter
  // editors above need it); only the table's rendered rows are paged.
  const AGENTS_PER_PAGE = 50;
  const agentsPage = paginateRows(visibleAgents, requestedPage, AGENTS_PER_PAGE);
  // A link to another agents page that preserves the active filters and jumps to
  // the table anchor so the viewport doesn't reset to the top of the page.
  const agentsPageHref = (page: number) => {
    const params = new URLSearchParams();
    if (sp.q) params.set("q", sp.q);
    if (roleFilter) params.set("role", roleFilter);
    if (teamFilter) params.set("team", teamFilter);
    if (managerFilter) params.set("manager", managerFilter);
    if (bookableFilter) params.set("bookable", bookableFilter);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return `/admin/agents${qs ? `?${qs}` : ""}#agents`;
  };

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
        <FilterForm action="/admin/agents" className="mb-4 flex flex-wrap items-center gap-2">
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search name or email…"
            aria-label="Search by name or email"
            className={`${inputCls} w-56`}
          />
          <button className={btnSecondaryCls}>Search</button>

          <AutoSubmitSelect
            name="role"
            defaultValue={roleFilter}
            ariaLabel="Filter by role"
            className={filterCtl}
          >
            <option value="">All roles</option>
            {rolesPresent.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </AutoSubmitSelect>

          {teamOptions.length > 0 && (
            <AutoSubmitSelect
              name="team"
              defaultValue={teamFilter}
              ariaLabel="Filter by team"
              className={filterCtl}
            >
              <option value="">All teams</option>
              {teamOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </AutoSubmitSelect>
          )}

          {managerOptions.length > 0 && (
            <AutoSubmitSelect
              name="manager"
              defaultValue={managerFilter}
              ariaLabel="Filter by manager"
              className={filterCtl}
            >
              <option value="">All managers</option>
              {managerOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </AutoSubmitSelect>
          )}

          <AutoSubmitSelect
            name="bookable"
            defaultValue={bookableFilter}
            ariaLabel="Filter by bookable"
            className={filterCtl}
          >
            <option value="">Any status</option>
            <option value="yes">Bookable</option>
            <option value="no">Not bookable</option>
          </AutoSubmitSelect>

          {hasFilter && (
            <InPlaceLink
              href="/admin"
              replace
              className="text-xs text-pennie-blue underline dark:text-pennie-sky"
            >
              clear
            </InPlaceLink>
          )}
          <span className="ml-auto text-xs text-fg-muted tabular-nums">
            {agentsPage.total === 0
              ? `showing 0 of ${users.length}`
              : `showing ${agentsPage.start}-${agentsPage.end} of ${agentsPage.total}${
                  agentsPage.total !== users.length ? ` (of ${users.length})` : ""
                }`}
          </span>
        </FilterForm>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
                <th className="px-4 py-2.5 font-semibold">Member</th>
                <th className="px-3 py-2.5 font-semibold">Role</th>
                <th className="px-3 py-2.5 font-semibold">Team</th>
                <th className="px-3 py-2.5 font-semibold">Manager</th>
                <th className="px-3 py-2.5 font-semibold">Bookable</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agentsPage.items.map((u) => {
                const mgr = u.manager_id
                  ? users.find((x) => x.id === u.manager_id)
                  : null;
                return (
                  <tr key={u.id} className="transition-colors hover:bg-[var(--bg-alt)]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {u.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- external Google avatar; OpenNext/CF has no image loader
                          <img
                            src={u.avatar_url}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="h-8 w-8 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pennie-navy text-[11px] font-semibold text-pennie-beige">
                            {(u.name ?? u.email).slice(0, 2).toUpperCase()}
                          </span>
                        )}
                        <div className="min-w-0">
                          <a
                            href={`/admin/agents/${u.id}`}
                            className="font-semibold text-fg hover:underline"
                          >
                            {u.name ?? u.email}
                          </a>
                          <p className="truncate text-xs text-fg-muted">
                            {u.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Pill variant={`role-${u.role}`}>{roleLabel(u.role)}</Pill>
                    </td>
                    <td className="px-3 py-3 text-fg-muted">
                      {attrToText(u.attributes?.debt_team) || "-"}
                    </td>
                    <td className="px-3 py-3 text-fg-muted">
                      {mgr ? (mgr.name ?? mgr.email) : "-"}
                    </td>
                    <td className="px-3 py-3">
                      {u.bookable ? (
                        <Pill variant="status-ok">Bookable</Pill>
                      ) : (
                        <span className="text-fg-muted">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-4">
                        {/* #1749: the action is on the person, so nobody has to
                            copy an address out of this table and paste it into a
                            field two screens away. It renders only where it could
                            actually work. */}
                        <ViewAsButton
                          actorRole={me.role}
                          actorId={me.id}
                          target={u}
                        />
                        <a
                          href={`/admin/agents/${u.id}`}
                          className="text-sm text-pennie-blue underline dark:text-pennie-sky"
                        >
                          Manage
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {agentsPage.items.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-sm text-fg-muted"
                  >
                    {users.length === 0
                      ? "No agents yet. Sync from Salesforce or sign in."
                      : "No agents match your search."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {agentsPage.pageCount > 1 && (
          <nav
            aria-label="Agent roster pages"
            className="mt-3 flex items-center justify-between text-sm"
          >
            {agentsPage.page > 1 ? (
              <InPlaceLink href={agentsPageHref(agentsPage.page - 1)} className={btnSecondaryCls}>
                Previous
              </InPlaceLink>
            ) : (
              <span className={`${btnSecondaryCls} pointer-events-none opacity-40`} aria-disabled="true">
                Previous
              </span>
            )}
            <span className="text-xs text-fg-muted tabular-nums">
              Page {agentsPage.page} of {agentsPage.pageCount}
            </span>
            {agentsPage.page < agentsPage.pageCount ? (
              <InPlaceLink href={agentsPageHref(agentsPage.page + 1)} className={btnSecondaryCls}>
                Next
              </InPlaceLink>
            ) : (
              <span className={`${btnSecondaryCls} pointer-events-none opacity-40`} aria-disabled="true">
                Next
              </span>
            )}
          </nav>
        )}
      </section>
      {isAdmin && (
      <section className={cardCls}>
        <h2 className="mb-1 text-sm font-semibold">View as somebody not in this list</h2>
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          Each row above carries its own <strong>View as</strong> action, so this
          is only for somebody the roster does not hold. While viewing as them,
          what you do happens as them, so be careful. A banner stays up the whole
          time with a way back to yourself.
        </p>
        {sp.imp_error && (
          <p role="alert" className="mb-3 text-sm text-error">
            {sp.imp_error}
          </p>
        )}
        <form action={startImpersonation} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>Their email</label>
            <input
              name="email"
              type="email"
              required
              // #141: repopulate the typed email when a "view as" attempt failed,
              // so the admin doesn't have to retype it.
              defaultValue={sp.imp_email ?? ""}
              aria-label="Email of the user to view as"
              placeholder="agent@trypennie.com"
              className={`${inputCls} w-72`}
            />
          </div>
          <SubmitButton className={btnCls} pendingLabel="Switching…">
            View as them
          </SubmitButton>
        </form>
      </section>
      )}
    </>
  );
}

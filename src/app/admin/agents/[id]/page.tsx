import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import {
  canManageAgents,
  canManageUser,
  canEditOrgSettings,
  canSetRole,
  roleLabel,
  ROLES,
} from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isActive } from "@/lib/active-user";
import { oooOnlyFor } from "@/lib/env";
import {
  setUserRole,
  setBookable,
  setAgentManager,
  setOooCalendarId,
  setWorkingHours,
  useDefaultHours,
  setAgentAttributes,
  setUserLifecycle,
} from "@/app/admin/actions";
import { AppHeader } from "@/components/AppHeader";
import BulkReassignCoverage from "@/components/BulkReassignCoverage";
import DeactivateAgentButton from "@/components/DeactivateAgentButton";
import { previewBulkReassign } from "@/lib/booking/service";
import { log } from "@/lib/log";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { DayToggles } from "@/components/ui/DayToggles";
import { TimeField } from "@/components/ui/TimeField";
import { labelCls, inputCls, btnCls, btnSecondaryCls, cardCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import type { Attributes, Organization, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * How many active future appointments this agent still holds (#1215), or null
 * when the count could not be read.
 *
 * Null, never 0, on a read error. Zero is what the UI uses to skip the confirm
 * entirely, so turning a failed read into 0 would wave the admin through with an
 * implied "nothing is booked" that nothing measured, the same defect as an
 * all-clear off a query that never ran (#1134). The profile page still renders:
 * an unreadable count degrades to a confirm that says so, not to a blank page.
 */
async function upcomingBookingCount(agentId: string): Promise<number | null> {
  try {
    return await previewBulkReassign(agentId, new Date().toISOString(), null);
  } catch (err) {
    log.error("admin-agent", { msg: "upcoming booking count failed", user_id: agentId }, err);
    return null;
  }
}

function attrToText(v: Attributes[string] | undefined): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v == null) return "";
  return String(v);
}

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to manage agents.
      </main>
    );
  }
  // OOO-only launch: agent management is part of the booking tool; managers are
  // limited to the OOO surfaces until scheduling goes live. Admins keep it.
  if (oooOnlyFor(me.role)) {
    redirect("/admin/ooo");
  }
  const isAdmin = canEditOrgSettings(me.role);
  const db = supabaseAdmin();
  // Roles this actor may assign to this target. A regular admin can't grant or
  // revoke super_admin (so the option is hidden and the form disappears for a
  // super_admin target).
  const roleOptions = (target: User["role"]) =>
    ROLES.filter((r) => canSetRole(me.role, target, r));

  const { data: agentData } = await db
    .from("users")
    .select("*")
    .eq("id", id)
    .eq("org_id", me.org_id)
    .maybeSingle();
  const agent = agentData as User | null;
  if (!agent) notFound();
  const active = isActive(agent);
  const isSelf = agent.id === me.id;
  // Control visibility must match what the mutating actions permit (#550/#544).
  // requireManageAgent enforces the strict-outrank rule (canManageUser), so a
  // manager viewing a peer or higher-ranked user (or an admin viewing a
  // super_admin) would otherwise see manager+ controls that 403 on click. Gate
  // those controls on the SAME predicate. Admin-only controls (role, OOO calendar)
  // keep their own isAdmin gates, which are already correct.
  const canManageThisAgent = canManageUser(me.role, agent.role, isSelf);

  const [schedRes, usersRes, orgRes] = await Promise.all([
    db
      .from("availability_schedules")
      .select("id, timezone")
      .eq("user_id", agent.id)
      .maybeSingle(),
    // Hide the synthetic smoke-test agent (#396) from the manager picker.
    db.from("users").select("id, name, email, role, deactivated_at").eq("org_id", me.org_id).eq("is_test", false),
    db.from("organizations").select("*").eq("id", me.org_id).single(),
  ]);
  const sched = schedRes.data as { id: string; timezone: string } | null;
  const { data: rulesData } = sched
    ? await db
        // cap-safe: one agent's schedule rules, at most a few per weekday.
        .from("availability_rules")
        .select("weekday, start_minute, end_minute")
        .eq("schedule_id", sched.id)
    : { data: [] };
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  const days = new Set(rules.map((r) => r.weekday));
  const start = rules[0]?.start_minute ?? 540;
  const end = rules[0]?.end_minute ?? 1020;
  const hasHours = rules.length > 0;

  const allUsers = (usersRes.data ?? []) as Pick<
    User,
    "id" | "name" | "email" | "role" | "deactivated_at"
  >[];
  // Deactivated users are not offered as managers. The currently-assigned
  // manager is resolved from the full set below (and shown via the prepend even
  // if deactivated), so an existing assignment still displays — you just can't
  // newly assign a departed manager.
  const managers = allUsers
    .filter((u) => (u.role === "manager" || u.role === "admin") && isActive(u))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
  const assignedManager = agent.manager_id
    ? allUsers.find((u) => u.id === agent.manager_id)
    : null;
  const managerOptions =
    assignedManager && !managers.some((m) => m.id === assignedManager.id)
      ? [assignedManager, ...managers.filter((m) => m.id !== agent.id)]
      : managers.filter((m) => m.id !== agent.id);
  const org = orgRes.data as Organization;

  const initials = (agent.name ?? agent.email).slice(0, 2).toUpperCase();

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        active="admin"
        themePreference={me.theme_preference}
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-6 py-10 sm:px-8">
        <a
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          &larr; All agents
        </a>

        {/* Identity band */}
        <section className="flex flex-wrap items-center gap-4 rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          {agent.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- external Google avatar; OpenNext/CF has no image loader
            <img
              src={agent.avatar_url}
              alt=""
              referrerPolicy="no-referrer"
              className="h-12 w-12 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-pennie-sky text-sm font-semibold text-pennie-graphite">
              {initials}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="pn-h4 truncate text-pennie-beige">
              {agent.name ?? agent.email}
            </h1>
            <p className="truncate text-sm text-pennie-beige/75">{agent.email}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Pill variant={`role-${agent.role}`}>{roleLabel(agent.role)}</Pill>
            {!active && <Pill variant="outline">Deactivated</Pill>}
            <Pill variant={agent.bookable ? "status-ok" : "outline"}>
              {agent.bookable ? "Bookable" : "Not bookable"}
            </Pill>
          </div>
        </section>

        {/* Access: role + bookable + manager */}
        <section className={cardCls}>
          <p className="pn-eyebrow text-fg-muted">Access</p>
          {!canManageThisAgent && (
            <p className="mt-2 text-xs text-fg-muted">
              You can view {agent.name ?? agent.email} but cannot change their
              settings: managing an agent needs a role above theirs.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-4">
            {isAdmin && roleOptions(agent.role).length > 0 && (
              <form action={setUserRole} className="flex items-end gap-2">
                <input type="hidden" name="user_id" value={agent.id} />
                <div>
                  <label className={labelCls}>Role</label>
                  <select
                    name="role"
                    aria-label="Role"
                    defaultValue={agent.role}
                    className={`${inputCls} w-40`}
                  >
                    {roleOptions(agent.role).map((r) => (
                      <option key={r} value={r}>
                        {r === "super_admin" ? "super admin" : r}
                      </option>
                    ))}
                  </select>
                </div>
                <button className={btnSecondaryCls}>Set role</button>
              </form>
            )}
            {canManageThisAgent && (
              <form action={setBookable} className="flex items-end">
                <input type="hidden" name="user_id" value={agent.id} />
                <input
                  type="hidden"
                  name="bookable"
                  value={agent.bookable ? "false" : "true"}
                />
                <button className={btnSecondaryCls}>
                  {agent.bookable ? "Make not bookable" : "Make bookable"}
                </button>
              </form>
            )}
            {canManageThisAgent && (
              <form action={setAgentManager} className="flex items-end gap-2">
                <input type="hidden" name="user_id" value={agent.id} />
                <div>
                  <label className={labelCls}>Manager (time off approvals)</label>
                  <select
                    name="manager_id"
                    aria-label="Manager"
                    defaultValue={agent.manager_id ?? ""}
                    className={`${inputCls} w-56`}
                  >
                    <option value="">No manager</option>
                    {managerOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name ?? m.email}
                      </option>
                    ))}
                  </select>
                </div>
                <button className={btnSecondaryCls}>Set manager</button>
              </form>
            )}
          </div>
          {isAdmin && agent.role !== "agent" && (
            <form
              action={setOooCalendarId}
              className="mt-4 flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="user_id" value={agent.id} />
              <div>
                <label className={labelCls}>OOO calendar ID</label>
                <input
                  name="ooo_calendar_id"
                  aria-label="OOO calendar ID"
                  defaultValue={agent.ooo_calendar_id ?? ""}
                  placeholder="c_xxxx@group.calendar.google.com"
                  className={`${inputCls} w-80`}
                />
              </div>
              <button className={btnSecondaryCls}>Save calendar</button>
            </form>
          )}
        </section>

        {/* Working hours */}
        <section className={cardCls}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="pn-eyebrow text-fg-muted">Working hours</p>
            {!agent.bookable && (
              <span className="text-xs text-fg-muted">
                Not bookable, so these don&apos;t affect availability yet.
              </span>
            )}
          </div>
          {canManageThisAgent ? (
            <>
              <form
                action={setWorkingHours}
                className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3"
              >
                <input type="hidden" name="user_id" value={agent.id} />
                <div>
                  <label className={labelCls}>Timezone (agent home tz)</label>
                  <input
                    name="timezone"
                    aria-label="Timezone"
                    defaultValue={sched?.timezone ?? org.default_timezone}
                    className={`${inputCls} w-44`}
                  />
                </div>
                <div>
                  <span className={labelCls}>Days</span>
                  <div className="mt-1">
                    <DayToggles
                      namePrefix="day_"
                      isOn={(d) => (hasHours ? days.has(d) : d <= 5)}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Start</label>
                  <TimeField
                    name="start"
                    ariaLabel="Start"
                    defaultValue={minutesToTime(start)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className={labelCls}>End</label>
                  <TimeField
                    name="end"
                    ariaLabel="End"
                    round="up"
                    defaultValue={minutesToTime(end)}
                    className="mt-1"
                  />
                </div>
                <button className={btnCls}>Save hours</button>
              </form>
              <form action={useDefaultHours} className="mt-3">
                <input type="hidden" name="user_id" value={agent.id} />
                <button className="text-xs text-pennie-blue underline dark:text-pennie-sky">
                  Apply company default hours
                </button>
              </form>
            </>
          ) : (
            <p className="mt-4 text-xs text-fg-muted">
              Only someone who outranks this agent can change their hours.
            </p>
          )}
        </section>

        {/* Routing attributes */}
        <section className={cardCls}>
          <p className="pn-eyebrow text-fg-muted">Routing attributes</p>
          <p className="mt-1 text-xs text-fg-muted">
            What this agent can be routed for. Normally synced from Salesforce.
          </p>
          {!canManageThisAgent && (
            <p className="mt-4 text-xs text-fg-muted">
              Only someone who outranks this agent can change their attributes.
            </p>
          )}
          {canManageThisAgent && (
          <form
            action={setAgentAttributes}
            className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3"
          >
            <input type="hidden" name="user_id" value={agent.id} />
            <div>
              <label className={labelCls}>Debt team(s)</label>
              <input
                name="debt_team"
                defaultValue={attrToText(agent.attributes?.debt_team)}
                placeholder="ultra_high, very_high"
                className={`${inputCls} w-48`}
              />
            </div>
            <div>
              <label className={labelCls}>Backend</label>
              <input
                name="backend_service"
                defaultValue={attrToText(agent.attributes?.backend_service)}
                placeholder="achieve"
                className={`${inputCls} w-32`}
              />
            </div>
            <div>
              <label className={labelCls}>Role</label>
              <input
                name="agent_role"
                defaultValue={attrToText(agent.attributes?.role)}
                placeholder="sales_agent"
                className={`${inputCls} w-36`}
              />
            </div>
            <div>
              <label className={labelCls}>Legal eligible</label>
              <select
                name="legal_eligible"
                aria-label="Legal eligible"
                defaultValue={
                  agent.attributes?.legal_eligible === true
                    ? "true"
                    : agent.attributes?.legal_eligible === false
                      ? "false"
                      : ""
                }
                className={inputCls}
              >
                <option value="">Not set</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <button className={btnCls}>Save attributes</button>
          </form>
          )}
        </section>

        {/* Account status: deactivate / reactivate (#278) */}
        <section className={cardCls}>
          <p className="pn-eyebrow text-fg-muted">Account status</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <Pill variant={active ? "status-ok" : "outline"}>
              {active ? "Active" : "Deactivated"}
            </Pill>
            {!canManageThisAgent ? (
              <span className="text-xs text-fg-muted">
                Only someone who outranks this agent can change this.
              </span>
            ) : active ? (
              isSelf ? (
                <span className="text-xs text-fg-muted">
                  You can&apos;t deactivate your own account.
                </span>
              ) : (
                <form action={setUserLifecycle} className="flex items-end">
                  <input type="hidden" name="user_id" value={agent.id} />
                  <input type="hidden" name="action" value="deactivate" />
                  {/* #1215: confirm (never block) when this agent still holds
                      upcoming appointments, because deactivating does not move
                      them. The count comes from previewBulkReassign, the same
                      helper the coverage sweep enqueues from, so the warning and
                      the panel below can never disagree about the same gap. */}
                  <DeactivateAgentButton
                    agentId={agent.id}
                    agentName={agent.name ?? agent.email}
                    upcomingBookings={await upcomingBookingCount(agent.id)}
                  />
                </form>
              )
            ) : (
              <form action={setUserLifecycle} className="flex items-end">
                <input type="hidden" name="user_id" value={agent.id} />
                <input type="hidden" name="action" value="reactivate" />
                <button className={btnSecondaryCls}>Reactivate account</button>
              </form>
            )}
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            Deactivating removes the agent from the booking pool and hides them
            from pickers, but keeps their history (bookings, time off). Fully
            reversible by reactivating.
          </p>
        </section>

        {/* Coverage: bulk-reassign this agent's upcoming bookings (#974). The
            id is the anchor the #1215 deactivate confirm links to. */}
        {canManageThisAgent && (
          <div id="coverage">
            <BulkReassignCoverage
              agentId={agent.id}
              agentName={agent.name ?? agent.email}
              reassignReasons={(await loadReasonOptions()).reassign.active}
            />
          </div>
        )}
      </main>
    </>
  );
}

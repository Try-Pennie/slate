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
  setOooCalendarId,
  setWorkingHours,
  useDefaultHours,
  setAgentAttributes,
  setUserLifecycle,
} from "@/app/admin/actions";
import BulkReassignCoverage from "@/components/BulkReassignCoverage";
import PoolExitConfirmButton from "@/components/PoolExitConfirmButton";
import { previewBulkReassign } from "@/lib/booking/service";
import { log } from "@/lib/log";
import { unwrap } from "@/lib/db/result";
import { loadReasonOptions } from "@/lib/booking/reason-options";
import { WorkingHoursForm } from "@/components/ui/WorkingHoursForm";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { workingHoursDays } from "@/lib/schedule-week";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls, selectCls } from "@/components/ui/styles";
import { Pill } from "@/components/ui/Pill";
import { ViewAsButton } from "@/components/admin/ViewAsButton";
import type { Attributes, Organization, User } from "@/lib/db/types";
import { BookablePill } from "@/components/ui/BookablePill";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

export const dynamic = "force-dynamic";

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

// nav-ok: a row in the roster opens this, so no navigation entry can name it: the address contains the agent's id
export default async function AgentProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `job` opens the coverage panel on an existing sweep (#1239), which is how the
   * time off queue links to the sweep an approval enqueued.
   *
   * `bookable` is what the pool toggle came back saying (#1769). A CODE rather
   * than a sentence, so the wording lives here where the copy rules and the
   * preview can see it, and nothing an admin types can reach the banner.
   */
  searchParams?: Promise<{ job?: string; bookable?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const openJobId = query?.job;
  const bookableOutcome = query?.bookable;
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

  // #1629: a swallowed error made this null, and null here means notFound(): the
  // page told an admin the agent does not exist when the read simply failed.
  // `unwrap` throws instead, so a real 404 still means a real 404.
  const agentData = unwrap(
    await db.from("users").select("*").eq("id", id).eq("org_id", me.org_id).maybeSingle(),
    "agent detail row",
  );
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

  // #1215: how many upcoming appointments this agent still holds, read ONCE and
  // shared by both pool-exit controls (deactivate and the bookable toggle). Two
  // reads of the same question could disagree with each other on the same page.
  // Only needed when the controls actually render.
  const heldUpcoming = canManageThisAgent ? await upcomingBookingCount(agent.id) : null;

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
  // #1629: all three, and the rules read below, feed FORMS whose save replaces
  // what they show. An unreadable schedule renders as "this agent has no hours"
  // and saving that writes an empty week (the #1308 lossy-projection shape); an
  // unreadable roster renders the manager of record as unassigned. None of these
  // may be guessed, so each throws rather than drawing a blank the admin acts on.
  const sched = unwrap(schedRes, "agent schedule") as { id: string; timezone: string } | null;
  const rulesData = sched
    ? unwrap(
        await db
          // cap-safe: one agent's schedule rules, at most a few per weekday.
          .from("availability_rules")
          .select("weekday, start_minute, end_minute")
          .eq("schedule_id", sched.id),
        "agent schedule rules",
      )
    : [];
  const rules = (rulesData ?? []) as {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  // #1308: a window PER DAY, read back from each day's own rule rather than from
  // rules[0], which showed Monday's hours for the whole week and then overwrote
  // the rest on save.

  const allUsers = (unwrap(usersRes, "agent detail roster") ?? []) as Pick<
    User,
    "id" | "name" | "email" | "role" | "deactivated_at"
  >[];
  // The manager of record is DISPLAYED, not chosen (#1474): Salesforce owns the
  // link and the hourly sync converges on it, so there is no picker to build a
  // candidate list for. Resolved from the full user set, including deactivated
  // ones, so an existing assignment still shows who it points at.
  const assignedManager = agent.manager_id
    ? allUsers.find((u) => u.id === agent.manager_id)
    : null;
  const org = unwrap(orgRes, "agent detail org") as Organization;

  const initials = (agent.name ?? agent.email).slice(0, 2).toUpperCase();

  return (
    <>
      <>
        <a
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        >
          &larr; All agents
        </a>

        <BookableOutcome code={bookableOutcome} />

        {/* Identity band */}
        <AdminPageHeader
          title={agent.name ?? agent.email}
          leading={
            agent.avatar_url ? (
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
            )
          }
          aside={
            <>
              {/* #1838: the band this sat in is an ordinary card now, so these
                  pills take the page theme like every other pill. The `onDark`
                  they used to pass would INVERT them here. */}
              <Pill variant={`role-${agent.role}`}>{roleLabel(agent.role)}</Pill>
              {!active && <Pill variant="outline">Deactivated</Pill>}
              {/* #1823: the same component the roster uses, so the variant and
                  the mark are one decision and the two screens cannot drift.
                  Nothing else on this page names the fact, so it carries the
                  noun rather than Yes or No. */}
              <BookablePill bookable={agent.bookable} wording="full" />
            </>
          }
        >
          <p className="truncate text-sm">{agent.email}</p>
        </AdminPageHeader>
        {/* #1749: this page had no view-as action at all, so an admin looking at a
            specific person still had to copy their address to a field elsewhere.
            It renders only where it could actually work, and the whole banner and
            two hour expiry behind it are unchanged. */}
        <ViewAsButton
          actorRole={me.role}
          actorId={me.id}
          target={agent}
          className={btnSecondaryCls}
        />

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
                    className={`${selectCls} w-40`}
                  >
                    {roleOptions(agent.role).map((r) => (
                      <option key={r} value={r}>
                        {r === "super_admin" ? "super admin" : r}
                      </option>
                    ))}
                  </select>
                </div>
                <SubmitButton className={btnSecondaryCls} pendingLabel="Setting role">Set role</SubmitButton>
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
                {/* #1215: taking an agent out of the pool via this toggle
                    strands their booked appointments exactly as deactivating
                    does, so the person who flips it is asked the same question.
                    The other direction strands nothing, so it stays one click. */}
                {agent.bookable ? (
                  <PoolExitConfirmButton
                    action="not_bookable"
                    agentId={agent.id}
                    agentName={agent.name ?? agent.email}
                    upcomingBookings={heldUpcoming}
                  />
                ) : (
                  <SubmitButton className={btnSecondaryCls} pendingLabel="Making bookable">
                    Make bookable
                  </SubmitButton>
                )}
              </form>
            )}
            {/* Read only on purpose (#1474). Salesforce owns this link: the hourly
                roster sync now converges on Agent_Manager__c, clearing a link
                Salesforce no longer backs, so anything set here would be undone
                within the hour. An editable control that silently reverts is worse
                than none, so the value is shown with where to change it. */}
            {canManageThisAgent && (
              <div>
                <span className={labelCls}>Manager (time off approvals)</span>
                <p className="text-sm">
                  {assignedManager ? (
                    assignedManager.name ?? assignedManager.email
                  ) : (
                    <span className="text-[color:var(--pn-muted)]">No manager</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-[color:var(--pn-muted)]">
                  Set in Salesforce (Agent Manager), and synced hourly.
                </p>
              </div>
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
              <SubmitButton className={btnSecondaryCls} pendingLabel="Saving calendar">Save calendar</SubmitButton>
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
              <div className="mt-4">
                <WorkingHoursForm
                  action={setWorkingHours}
                  days={workingHoursDays(rules, org.default_weekdays)}
                  timezone={sched?.timezone ?? org.default_timezone}
                  timezoneLabel="Timezone (agent home tz)"
                  userId={agent.id}
                  saveLabel="Save hours"
                />
              </div>
              <form action={useDefaultHours} className="mt-3">
                <input type="hidden" name="user_id" value={agent.id} />
                <SubmitButton
                  className="text-xs text-pennie-blue underline dark:text-pennie-sky"
                  pendingLabel="Applying company hours"
                >
                  Apply company default hours
                </SubmitButton>
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
                className={selectCls}
              >
                <option value="">Not set</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <SubmitButton className={btnCls} pendingLabel="Saving attributes">Save attributes</SubmitButton>
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
                  <PoolExitConfirmButton
                    action="deactivate"
                    agentId={agent.id}
                    agentName={agent.name ?? agent.email}
                    upcomingBookings={heldUpcoming}
                  />
                </form>
              )
            ) : (
              <form action={setUserLifecycle} className="flex items-end">
                <input type="hidden" name="user_id" value={agent.id} />
                <input type="hidden" name="action" value="reactivate" />
                <SubmitButton className={btnSecondaryCls} pendingLabel="Reactivating account">
                  Reactivate account
                </SubmitButton>
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
              initialJobId={openJobId}
            />
          </div>
        )}
      </>
    </>
  );
}

/**
 * What the pool toggle came back saying (#1769).
 *
 * The toggle used to return void: on success the only thing that changed was one
 * button being replaced by another in the corner of a dense row, and on a refusal
 * it threw, which on a route with no error boundary means Next's generic error
 * page with the message scrubbed. So the action that makes a LIVE Google call
 * before it writes anything was also the one that said the least.
 *
 * The refusals keep the wording that tells somebody what to DO, because the two
 * causes need different actions: an account gone from the Workspace is a
 * credential repair, and a temporary Google failure is worth retrying (see "Three
 * ways a Google calendar can fail, not two" in AGENTS.md).
 */
function BookableOutcome({ code }: { code?: string }) {
  if (!code) return null;

  const ok = code === "on" || code === "off";
  const said =
    code === "on"
      ? "This agent is now bookable. New bookings can be routed to them."
      : code === "off"
        ? "This agent is no longer bookable. New bookings will not be routed to them."
        : code === "blocked-gone"
          ? "Not made bookable: their Google calendar is unreachable, so the account may be gone from the Workspace or the delegation may be broken. Fix the calendar, then try again."
          : code === "blocked-transient"
            ? "Not made bookable: their Google calendar could not be checked just now, which is usually a temporary Google issue. Try again shortly."
            : code === "missing"
              ? "That agent could not be found, so nothing was changed."
              : null;
  if (!said) return null;

  return (
    <p
      role="status"
      className={`rounded-[var(--radius-md)] border px-4 py-3 text-sm ${
        ok ? "border-border bg-[var(--bg-alt)] text-fg" : "border-error text-error"
      }`}
    >
      {said}
    </p>
  );
}

import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { formatWhenLine, overlaps } from "@/lib/ooo/core";
import {
  approvalStats,
  busiestMonth,
  companyApprovalStats,
  coverageAlerts,
  managerBreakdown,
  medianAdvanceNoticeDays,
  peopleWithNoTimeOff,
  type RosterPerson,
} from "@/lib/ooo/analytics-core";
import {
  approveOooAction,
  rejectOooAction,
  retryOooAction,
} from "@/app/admin/ooo/actions";
import { AppHeader } from "@/components/AppHeader";
import { btnCls, btnSecondaryCls, cardCls, inputCls, labelCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import type { Booking, OooRequest, OooStatus, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<OooStatus, PillVariant> = {
  pending: "status-pending",
  approved: "status-ok",
  rejected: "status-error",
  cancelled: "outline",
};

const HISTORY_DAYS = 90;

// Module scope so the Date.now() calls don't trip react-hooks/purity in render.
function historySinceIso(): string {
  return new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString();
}

/** Legacy-parity insights over a roster + its requests (see analytics-core). */
function buildInsights(
  roster: RosterPerson[],
  requests: OooRequest[],
  zone: string,
) {
  const now = Date.now();
  return {
    stats: approvalStats(requests),
    alerts: coverageAlerts(roster, requests, now, zone),
    noTimeOff: peopleWithNoTimeOff(roster, requests, now),
    advanceNotice: medianAdvanceNoticeDays(requests),
    busiest: busiestMonth(requests, zone),
  };
}

export default async function OooQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; msg?: string }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to review time off.
      </main>
    );
  }
  const isAdmin = me.role === "admin";
  const db = supabaseAdmin();

  // Managers see their reports' requests; admins see the whole org.
  let pendingQuery = db
    .from("ooo_requests")
    .select("*")
    .eq("org_id", me.org_id)
    .eq("status", "pending")
    .order("starts_at", { ascending: true });
  if (!isAdmin) pendingQuery = pendingQuery.eq("manager_id", me.id);

  const historySince = historySinceIso();
  let historyQuery = db
    .from("ooo_requests")
    .select("*")
    .eq("org_id", me.org_id)
    .in("status", ["approved", "rejected", "cancelled"])
    .gte("updated_at", historySince)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (!isAdmin) historyQuery = historyQuery.eq("manager_id", me.id);

  const [pendingRes, historyRes, usersRes, orgRes, allRes] = await Promise.all([
    pendingQuery,
    historyQuery,
    db
      .from("users")
      .select("id, name, email, manager_id")
      .eq("org_id", me.org_id),
    db
      .from("organizations")
      .select("default_timezone")
      .eq("id", me.org_id)
      .single(),
    // Insights run over the full request history, not just the 90-day list.
    db.from("ooo_requests").select("*").eq("org_id", me.org_id),
  ]);
  const pending = (pendingRes.data ?? []) as OooRequest[];
  const history = (historyRes.data ?? []) as OooRequest[];
  const users = (usersRes.data ?? []) as Pick<
    User,
    "id" | "name" | "email" | "manager_id"
  >[];
  const orgZone =
    (orgRes.data as { default_timezone: string } | null)?.default_timezone ??
    "America/New_York";
  const allRequests = (allRes.data ?? []) as OooRequest[];

  // Manager view: their reports + their requests. Admin view: everyone who is
  // in the OOO system (has a manager), org-wide requests, manager breakdown.
  const toRoster = (
    u: Pick<User, "id" | "name" | "email" | "manager_id">,
  ): RosterPerson => ({ id: u.id, name: u.name ?? u.email });
  const roster = isAdmin
    ? users.filter((u) => u.manager_id !== null).map(toRoster)
    : users.filter((u) => u.manager_id === me.id).map(toRoster);
  const scopedRequests = isAdmin
    ? allRequests
    : allRequests.filter((r) => r.manager_id === me.id);
  const insights = buildInsights(roster, scopedRequests, orgZone);
  const company = isAdmin ? companyApprovalStats(allRequests) : null;
  const breakdown = isAdmin ? managerBreakdown(allRequests) : null;
  const nameOf = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.name ?? u.email) : "unknown";
  };

  // Booked-meeting overlap warnings for the pending queue: one batched query
  // over the union window, matched up in memory (never blocks approval).
  let bookingsByAgent = new Map<string, Booking[]>();
  if (pending.length > 0) {
    const minStart = pending
      .map((r) => r.starts_at)
      .reduce((a, b) => (a < b ? a : b));
    const maxEnd = pending
      .map((r) => r.ends_at)
      .reduce((a, b) => (a > b ? a : b));
    const { data } = await db
      .from("bookings")
      .select("*")
      .eq("org_id", me.org_id)
      .in("status", ["confirmed", "rescheduled"])
      .in("assigned_user_id", [...new Set(pending.map((r) => r.user_id))])
      .lt("starts_at", maxEnd)
      .gt("ends_at", minStart);
    bookingsByAgent = ((data ?? []) as Booking[]).reduce((map, b) => {
      if (b.assigned_user_id) {
        map.set(b.assigned_user_id, [...(map.get(b.assigned_user_id) ?? []), b]);
      }
      return map;
    }, new Map<string, Booking[]>());
  }
  const overlapsFor = (r: OooRequest): Booking[] =>
    (bookingsByAgent.get(r.user_id) ?? []).filter((b) =>
      overlaps(r.starts_at, r.ends_at, b.starts_at, b.ends_at),
    );

  const whenOf = (r: OooRequest) =>
    formatWhenLine(r.starts_at, r.ends_at, r.display_tz_id, r.display_tz_label);
  const failedEffects = (r: OooRequest) =>
    Object.entries(r.side_effects ?? {}).filter(([, v]) =>
      v.startsWith("failed"),
    );

  return (
    <>
      <AppHeader
        email={me.email}
        role={me.role}
        active="ooo"
        themePreference={me.theme_preference}
      />
      <main className="mx-auto w-full min-w-0 max-w-4xl space-y-8 p-8">
        <div>
          <h1 className="pn-h3">Time off</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {isAdmin
              ? "Requests across the whole team."
              : "Requests from your reports."}
          </p>
        </div>

        {sp.msg && (
          <div
            role="alert"
            className="rounded-md border border-[var(--error)] p-4 text-sm text-error"
          >
            {sp.msg}
          </div>
        )}

        <section className={cardCls}>
          <h2 className="mb-4 text-sm font-semibold">
            Waiting for review{pending.length > 0 && ` (${pending.length})`}
          </h2>
          {pending.length === 0 && (
            <p className="text-sm text-fg-muted">
              No requests waiting. New ones will show up here and in Slack.
            </p>
          )}
          <div className="space-y-5">
            {pending.map((r) => {
              const conflicts = overlapsFor(r);
              const highlighted = sp.request === r.id;
              return (
                <div
                  key={r.id}
                  id={`request-${r.id}`}
                  className={`border-t border-border pt-4 first:border-0 first:pt-0 ${
                    highlighted
                      ? "rounded-md outline-2 outline-offset-8 outline-[var(--focus-ring)]"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{nameOf(r.user_id)}</span>
                    <span>{whenOf(r)}</span>
                  </div>
                  <p className="mt-1 text-sm text-fg-muted">
                    Reason: {r.reason}
                    {r.notes ? ` · Notes: ${r.notes}` : ""}
                  </p>
                  {conflicts.length > 0 && (
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <Pill variant="status-error">
                        {conflicts.length} booked{" "}
                        {conflicts.length === 1 ? "meeting" : "meetings"}
                      </Pill>
                      <span className="text-fg-muted">
                        {conflicts
                          .slice(0, 3)
                          .map((b) =>
                            formatWhenLine(
                              b.starts_at,
                              b.ends_at,
                              r.display_tz_id,
                              r.display_tz_label,
                            ),
                          )
                          .join("; ")}
                        {conflicts.length > 3 &&
                          ` and ${conflicts.length - 3} more`}
                        . Approving will not move them; rebook first.
                      </span>
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <form action={approveOooAction}>
                      <input type="hidden" name="request_id" value={r.id} />
                      <button className={btnCls}>Approve time off</button>
                    </form>
                    <form
                      action={rejectOooAction}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="request_id" value={r.id} />
                      <div>
                        <label className={labelCls}>
                          Note to {nameOf(r.user_id)}
                        </label>
                        <input
                          name="rejection_note"
                          aria-label={`Rejection note for ${nameOf(r.user_id)}`}
                          placeholder="Why this week does not work"
                          className={`${inputCls} w-64`}
                        />
                      </div>
                      <button className={btnSecondaryCls}>Decline</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className={cardCls}>
          <h2 className="mb-4 text-sm font-semibold">
            Recent decisions (last {HISTORY_DAYS} days)
          </h2>
          {history.length === 0 && (
            <p className="text-sm text-fg-muted">Nothing decided yet.</p>
          )}
          <div className="space-y-4">
            {history.map((r) => {
              const failures = failedEffects(r);
              return (
                <div
                  key={r.id}
                  id={`request-${r.id}`}
                  className={`flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 first:border-0 first:pt-0 ${
                    sp.request === r.id
                      ? "rounded-md outline-2 outline-offset-8 outline-[var(--focus-ring)]"
                      : ""
                  }`}
                >
                  <div className="min-w-0 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{nameOf(r.user_id)}</span>
                      <span>{whenOf(r)}</span>
                      <Pill variant={STATUS_PILL[r.status]}>{r.status}</Pill>
                      {r.status === "approved" && failures.length > 0 && (
                        <Pill
                          variant="status-error"
                          title={failures.map(([k, v]) => `${k}: ${v}`).join("\n")}
                        >
                          calendar updates incomplete
                        </Pill>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-fg-muted">
                      {r.reason}
                      {r.rejection_note ? ` · Note: ${r.rejection_note}` : ""}
                      {r.decided_by ? ` · by ${nameOf(r.decided_by)}` : ""}
                    </p>
                  </div>
                  {isAdmin && r.status === "approved" && failures.length > 0 && (
                    <form action={retryOooAction}>
                      <input type="hidden" name="request_id" value={r.id} />
                      <button className={btnSecondaryCls}>
                        Retry calendar updates
                      </button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className={cardCls}>
          <h2 className="mb-1 text-sm font-semibold">
            {isAdmin ? "Team insights (whole company)" : "Team insights"}
          </h2>
          <p className="mb-4 text-xs text-fg-muted">
            {roster.length} {roster.length === 1 ? "person" : "people"} on the
            roster. Numbers cover all requests on record.
          </p>
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className={labelCls}>Approval rate</dt>
              <dd className="mt-1 tabular-nums">
                {insights.stats.rate}%
                <span className="text-xs text-fg-muted">
                  {" "}
                  of {insights.stats.total}
                </span>
              </dd>
            </div>
            <div>
              <dt className={labelCls}>Median advance notice</dt>
              <dd className="mt-1 tabular-nums">
                {insights.advanceNotice}{" "}
                {insights.advanceNotice === 1 ? "day" : "days"}
              </dd>
            </div>
            <div>
              <dt className={labelCls}>Busiest month</dt>
              <dd className="mt-1">{insights.busiest}</dd>
            </div>
            {company && (
              <div>
                <dt className={labelCls}>Median manager approval</dt>
                <dd className="mt-1 tabular-nums">
                  {company.rate}%
                  <span className="text-xs text-fg-muted">
                    {" "}
                    across {company.managerCount}
                  </span>
                </dd>
              </div>
            )}
          </dl>

          {insights.alerts.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-semibold text-fg-muted">
                Coverage alerts (next 30 days)
              </h3>
              <ul className="mt-2 space-y-2">
                {insights.alerts.map((a) => (
                  <li
                    key={a.date}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <Pill
                      variant={
                        a.severity === "high" ? "status-error" : "status-pending"
                      }
                    >
                      {a.dateFormatted}
                    </Pill>
                    <span>
                      {a.count} of {roster.length} out ({a.percent}%):{" "}
                      {a.people.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights.noTimeOff.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-semibold text-fg-muted">
                No time off in the last 90 days or next 30
              </h3>
              <p className="mt-2 text-sm text-fg-muted">
                {insights.noTimeOff.map((p) => p.name).join(", ")}
              </p>
            </div>
          )}

          {breakdown && breakdown.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-semibold text-fg-muted">
                By manager
              </h3>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th className="py-1 font-semibold">Manager</th>
                    <th className="py-1 font-semibold">Approved</th>
                    <th className="py-1 font-semibold">Rejected</th>
                    <th className="py-1 font-semibold">Pending</th>
                    <th className="py-1 font-semibold">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((row) => (
                    <tr key={row.managerId} className="border-t border-border">
                      <td className="py-1.5">
                        {row.managerId === "unassigned"
                          ? "No manager"
                          : nameOf(row.managerId)}
                      </td>
                      <td className="py-1.5 tabular-nums">{row.approved}</td>
                      <td className="py-1.5 tabular-nums">{row.rejected}</td>
                      <td className="py-1.5 tabular-nums">{row.pending}</td>
                      <td className="py-1.5 tabular-nums">{row.rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

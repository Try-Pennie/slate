import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canManageAgents, canModerateAllOoo } from "@/lib/auth/roles";
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
import { btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { DeepLinkScroll } from "@/components/ui/DeepLinkScroll";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DeclineConfirm } from "@/components/ui/DeclineConfirm";
import type { Booking, OooRequest, OooStatus, User } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<OooStatus, PillVariant> = {
  pending: "status-pending",
  approved: "status-ok",
  rejected: "status-error",
  cancelled: "outline",
};

const HISTORY_DAYS = 90;

const fieldBaseCls =
  "h-[44px] rounded-sm border border-border bg-surface px-3 text-fg placeholder:text-fg-muted";

/** One metric cell inside the navy insights band. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-5 py-4">
      <dt className="text-xs font-semibold text-pennie-beige/60">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-pennie-beige">
        {value}
        {sub && (
          <span className="text-sm font-normal text-pennie-beige/60"> {sub}</span>
        )}
      </dd>
    </div>
  );
}

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
  searchParams: Promise<{ request?: string; msg?: string; ok?: string }>;
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
  // Team leads, admins, and super admins moderate the whole org; a regular
  // manager is scoped to their own reports.
  const seesAll = canModerateAllOoo(me.role);
  const db = supabaseAdmin();

  // Managers see their reports' requests; team leads and up see the whole org.
  let pendingQuery = db
    .from("ooo_requests")
    .select("*")
    .eq("org_id", me.org_id)
    .eq("status", "pending")
    .order("starts_at", { ascending: true });
  if (!seesAll) pendingQuery = pendingQuery.eq("manager_id", me.id);

  const historySince = historySinceIso();
  let historyQuery = db
    .from("ooo_requests")
    .select("*")
    .eq("org_id", me.org_id)
    .in("status", ["approved", "rejected", "cancelled"])
    .gte("updated_at", historySince)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (!seesAll) historyQuery = historyQuery.eq("manager_id", me.id);

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
  const roster = seesAll
    ? users.filter((u) => u.manager_id !== null).map(toRoster)
    : users.filter((u) => u.manager_id === me.id).map(toRoster);
  const scopedRequests = seesAll
    ? allRequests
    : allRequests.filter((r) => r.manager_id === me.id);
  const insights = buildInsights(roster, scopedRequests, orgZone);
  const company = seesAll ? companyApprovalStats(allRequests) : null;
  const breakdown = seesAll ? managerBreakdown(allRequests) : null;
  const stats: { label: string; value: string; sub?: string }[] = [
    {
      label: "Approval rate",
      value: `${insights.stats.rate}%`,
      sub: `of ${insights.stats.total}`,
    },
    {
      label: "Median notice",
      value: String(insights.advanceNotice),
      sub: insights.advanceNotice === 1 ? "day" : "days",
    },
    { label: "Most time off", value: insights.busiest },
    // Org-wide moderators get a company-wide stat here; a scoped manager
    // doesn't (the count that used to sit here just duplicated the "N waiting
    // on you" header above).
    ...(company
      ? [
          {
            label: "Median mgr approval",
            value: `${company.rate}%`,
            sub: `of ${company.managerCount}`,
          },
        ]
      : []),
  ];
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

  // Team-coverage note (#140): who on the same team is ALREADY approved off
  // during this request's window. Informational only — never blocks approval.
  // "Team" = the request's manager; teammates are that manager's other reports,
  // matched in memory over the requests already loaded (no extra query).
  const managerByUser = new Map(users.map((u) => [u.id, u.manager_id]));
  const teammatesOffDuring = (r: OooRequest): string[] => {
    if (!r.manager_id) return [];
    const names = new Set<string>();
    for (const other of allRequests) {
      if (
        other.status === "approved" &&
        other.user_id !== r.user_id &&
        managerByUser.get(other.user_id) === r.manager_id &&
        overlaps(r.starts_at, r.ends_at, other.starts_at, other.ends_at)
      ) {
        names.add(nameOf(other.user_id));
      }
    }
    return [...names];
  };

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
        userId={me.id}
        orgId={me.org_id}
        bookable={me.bookable}
        avatarUrl={me.avatar_url}
      />
      <DeepLinkScroll
        targetId={sp.request ? `request-${sp.request}` : null}
      />
      <main className="mx-auto w-full min-w-0 max-w-4xl space-y-10 px-6 py-10 sm:px-8">
        {/* Navy header carrying the actionable status: how many wait on you. */}
        <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          <p className="pn-eyebrow text-pennie-sky">Team requests</p>
          <h1 className="pn-h2 mt-2 text-pennie-beige">
            {pending.length === 0
              ? "You're all caught up."
              : `${pending.length} waiting on you`}
          </h1>
          <p className="mt-2 text-pennie-beige/75">
            {seesAll
              ? "Requests across the team."
              : "Requests from your reports."}
          </p>
        </section>

        {sp.msg && (
          <div
            role="alert"
            className="rounded-md border border-[var(--error)] px-5 py-4 text-sm text-error"
          >
            {sp.msg}
          </div>
        )}
        {sp.ok && (
          <div
            role="status"
            className="pn-confirm-enter flex items-center gap-3 rounded-md bg-pennie-sky-soft px-5 py-4 dark:bg-accent/15"
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-pennie-sky text-pennie-graphite"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <p className="font-semibold text-fg">{sp.ok}</p>
          </div>
        )}

        {/* Insights — a navy stat band, then supporting detail */}
        <section>
          <p className="pn-eyebrow text-fg-muted">
            {seesAll ? "Team insights · whole company" : "Team insights"}
          </p>
          <p className="mt-1 text-sm text-fg-muted">
            {roster.length} {roster.length === 1 ? "person" : "people"} on the
            roster. Numbers cover all requests on record.
          </p>
          <dl
            className={`mt-3 grid grid-cols-2 divide-x divide-y divide-pennie-beige/10 overflow-hidden rounded-xl bg-pennie-navy sm:divide-y-0 dark:bg-surface dark:divide-border ${
              company ? "sm:grid-cols-4" : "sm:grid-cols-3"
            }`}
          >
            {stats.map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} sub={s.sub} />
            ))}
          </dl>

          {insights.alerts.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs font-semibold text-fg-muted">
                Coverage alerts · next 30 days
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
                      <span className="tabular-nums">
                        {a.count} of {roster.length}
                      </span>{" "}
                      out ({a.percent}%): {a.people.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights.noTimeOff.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs font-semibold text-fg-muted">
                No time off in the last 90 days or next 30
              </h3>
              <p className="mt-2 text-sm text-fg-muted">
                {insights.noTimeOff.map((p) => p.name).join(", ")}
              </p>
            </div>
          )}

          {breakdown && breakdown.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs font-semibold text-fg-muted">By manager</h3>
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

        {/* Pending queue — the work surface */}
        <section>
          <p className="pn-eyebrow text-fg-muted">
            Waiting for review
            {pending.length > 0 && (
              <span className="tabular-nums"> ({pending.length})</span>
            )}
          </p>
          {pending.length === 0 ? (
            <p className="mt-3 rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
              Nothing waiting. New requests show up here and in Slack.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-md bg-surface shadow-xs">
              {pending.map((r) => {
                const conflicts = overlapsFor(r);
                const teamOff = teammatesOffDuring(r);
                return (
                  <li
                    key={r.id}
                    id={`request-${r.id}`}
                    className={`p-5 ${sp.request === r.id ? "pn-deeplink" : ""}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-semibold text-fg">
                        {nameOf(r.user_id)}
                      </span>
                      <span className="tabular-nums text-sm text-fg-muted">
                        {whenOf(r)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-fg-muted">
                      {r.reason}
                      {r.notes ? ` · ${r.notes}` : ""}
                    </p>
                    {r.manager_id === null && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        <Pill variant="status-error">No manager</Pill>
                        <span className="text-fg-muted">
                          No manager is assigned, so no one was nudged to review
                          it. Approve it here, and set their manager on the agent
                          page so future requests route automatically.
                        </span>
                      </p>
                    )}
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
                          . Approving won&apos;t move them; rebook first.
                        </span>
                      </p>
                    )}
                    {teamOff.length > 0 && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        <Pill variant="status-pending">
                          {teamOff.length} teammate
                          {teamOff.length === 1 ? "" : "s"} off then
                        </Pill>
                        <span className="text-fg-muted">
                          {teamOff.slice(0, 3).join(", ")}
                          {teamOff.length > 3 && ` and ${teamOff.length - 3} more`}{" "}
                          {teamOff.length === 1 ? "is" : "are"} already approved
                          off during this window.
                        </span>
                      </p>
                    )}
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <form action={approveOooAction}>
                        <input type="hidden" name="request_id" value={r.id} />
                        <SubmitButton className={btnCls} pendingLabel="Approving…">
                          Approve
                        </SubmitButton>
                      </form>
                      <form
                        action={rejectOooAction}
                        className="flex flex-1 flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="request_id" value={r.id} />
                        <input
                          name="rejection_note"
                          aria-label={`Note to ${nameOf(r.user_id)} if you decline`}
                          placeholder="Add a note (optional)"
                          className={`${fieldBaseCls} min-w-0 flex-1`}
                        />
                        <DeclineConfirm agentName={nameOf(r.user_id)} />
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Recent decisions — flat list */}
        <section>
          <p className="pn-eyebrow text-fg-muted">
            Recent decisions{" "}
            <span className="font-normal normal-case text-fg-muted">
              · last {HISTORY_DAYS} days
            </span>
          </p>
          {history.length === 0 ? (
            <p className="mt-3 text-sm text-fg-muted">Nothing decided yet.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border">
              {history.map((r) => {
                const failures = failedEffects(r);
                return (
                  <li
                    key={r.id}
                    id={`request-${r.id}`}
                    className={`flex flex-wrap items-center justify-between gap-2 py-4 ${
                      sp.request === r.id ? "pn-deeplink" : ""
                    }`}
                  >
                    <div className="min-w-0 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-fg">
                          {nameOf(r.user_id)}
                        </span>
                        <span className="tabular-nums text-fg-muted">
                          {whenOf(r)}
                        </span>
                        <Pill variant={STATUS_PILL[r.status]}>{r.status}</Pill>
                        {r.status === "approved" && failures.length > 0 && (
                          <Pill
                            variant="status-error"
                            title={failures
                              .map(([k, v]) => `${k}: ${v}`)
                              .join("\n")}
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
                    {seesAll && r.status === "approved" && failures.length > 0 && (
                      <form action={retryOooAction}>
                        <input type="hidden" name="request_id" value={r.id} />
                        <button className={btnSecondaryCls}>
                          Retry calendar updates
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

      </main>
    </>
  );
}

import { redirect } from "next/navigation";
import { SaveForm } from "@/components/ui/SaveForm";
import { currentUser } from "@/lib/auth";
import { consoleHiddenFor } from "@/lib/env";
import { ConsoleComingSoonNote, ConsoleLink } from "@/components/ui/ConsoleLink";
import { atLeast, canManageAgents, canModerateAllOoo } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  canHoldManagerOfRecord,
  canModerate,
  canRetrySideEffects,
  formatWhenLine,
  managerCannotApproveNotice,
  overlaps,
  pendingQueueScope,
} from "@/lib/ooo/core";
import { oooDayCount } from "@/lib/ooo/cancel-copy";
import { describeEffects } from "@/lib/ooo/effect-copy";
import { FailedSteps } from "./FailedSteps";
import { loadOrgOooHistory } from "@/lib/ooo/history-load";
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
import { btnCls, btnSecondaryCls } from "@/components/ui/styles";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { DeepLinkScroll } from "@/components/ui/DeepLinkScroll";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { DeclineConfirm } from "@/components/ui/DeclineConfirm";
import type { Booking, OooRequest, OooStatus, User } from "@/lib/db/types";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";

export const metadata = { title: "Team time off" };

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
          <span className="mt-0.5 block text-sm font-normal text-pennie-beige/60">
            {sub}
          </span>
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
    busiest: busiestMonth(requests, zone, now),
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
  // #2119: whether the console routes this page points at would redirect this
  // viewer straight back here. Resolved ONCE, by the page that knows who is
  // looking, and handed to every control that offers such a destination.
  const consoleHidden = consoleHiddenFor(me.role);
  // #1468: the retry is a narrower power than moderating. Read it from the SAME
  // predicate the action enforces, so the button can never be offered to someone
  // the action will refuse (a team lead used to see it and get "Not authorized").
  const canRetry = canRetrySideEffects(me);
  const db = supabaseAdmin();

  // Managers see their reports' requests; team leads and up see the whole org,
  // less an admin's own (#3114: they cannot decide it, so another admin or a
  // team lead does). The same scope the header badge counts.
  const queueScope = pendingQueueScope(me);
  let pendingQuery = db
    // cap-safe: the org's pending time off queue, drained by moderation, well under a page.
    .from("ooo_requests")
    .select("*")
    .eq("org_id", me.org_id)
    .eq("status", "pending")
    .order("starts_at", { ascending: true });
  if (queueScope?.managerId) pendingQuery = pendingQuery.eq("manager_id", queueScope.managerId);
  if (queueScope?.excludeUserId) pendingQuery = pendingQuery.neq("user_id", queueScope.excludeUserId);

  const historySince = historySinceIso();
  let historyQuery = db
    .from("ooo_requests")
    .select("*")
    .eq("org_id", me.org_id)
    .in("status", ["approved", "rejected", "cancelled"])
    // Windowed by recency of the decision (updated_at), but sorted by the time
    // off itself — most recent / upcoming time-off dates first.
    .gte("updated_at", historySince)
    .order("starts_at", { ascending: false })
    .limit(50);
  if (!seesAll) historyQuery = historyQuery.eq("manager_id", me.id);

  const [pendingRes, historyRes, usersRes, orgRes, allRequestsRaw] = await Promise.all([
    pendingQuery,
    historyQuery,
    // Real advisors only (#396, #4201): no smoke-test agent or placeholder in the
    // OOO roster + insights.
    realAdvisorsOnly(
      db.from("users").select("id, name, email, manager_id, role").eq("org_id", me.org_id),
    ),
    db
      .from("organizations")
      .select("default_timezone")
      .eq("id", me.org_id)
      .single(),
    // Insights run over the full request history, not just the 90-day list. That
    // history grows past PostgREST's 1,000-row cap within a year, so it must be
    // paged or the aggregates silently under-report (#828).
    loadOrgOooHistory(db, me.org_id),
  ]);
  // #1629: the roster decides who is filtered OUT of this queue (`staffIds`
  // below), so an empty one does not merely blank the page, it lets operator and
  // test requests back into the moderation queue as if they were real.
  const users = (unwrap(usersRes, "ooo admin roster") ?? []) as Pick<
    User,
    "id" | "name" | "email" | "manager_id" | "role"
  >[];
  // error-ok: the org's default timezone falls back to the documented canonical
  // one (America/New_York), which is the value this read returns in practice for
  // the only organization that exists, so the fallback and the stored value are
  // the same string.
  //
  // #1651 corrected what this used to claim. The zone does NOT only decide how a
  // date is FORMATTED: it is handed to buildInsights, which passes it to
  // coverageAlerts and busiestMonth, and those BUCKET requests by day and by
  // month in that zone, so a wrong zone would move a request across a boundary
  // and change a count. The exemption is safe because the fallback equals the
  // stored value, not because the value is cosmetic. A second organization, or a
  // changed default, breaks that and this becomes an unwrap.
  const orgRow = orgRes.data as { default_timezone: string } | null;
  const orgZone = orgRow?.default_timezone ?? "America/New_York";

  // Exclude OOO requests authored by admins/super admins from the history and the
  // insights: they're operators (and the source of test requests), not part of
  // the bookable team. NOT from the pending queue (#3114): an admin cannot
  // decide their own time off, so another admin or a team lead has to be able to
  // decide it here. They still see their own on /me. (team_lead and below stay in.)
  const staffIds = new Set(
    users.filter((u) => atLeast(u.role, "admin")).map((u) => u.id),
  );
  const notStaff = (r: OooRequest) => !staffIds.has(r.user_id);

  // Explicitly ignore the dev/operator account (Dan Hankins-Wright) as a
  // *manager* — one agent has him set as their manager, which would otherwise
  // surface "Dan Hankins-Wright" as a manager row in the breakdown. Scoped to
  // this one identity by email (NOT all super admins), so his managed requests
  // roll into "No manager" everywhere on this page.
  const IGNORED_MANAGER_EMAILS = ["dwright@trypennie.com"];
  const ignoredManagerIds = new Set(
    users
      .filter((u) => IGNORED_MANAGER_EMAILS.includes(u.email.toLowerCase()))
      .map((u) => u.id),
  );
  const deOperatorManager = (r: OooRequest): OooRequest =>
    r.manager_id && ignoredManagerIds.has(r.manager_id)
      ? { ...r, manager_id: null }
      : r;

  // #1475: managers of record who cannot actually approve. The SAME predicate the
  // approve rule uses, so the badge and the action can never disagree about who
  // qualifies, and the sentence comes from the same builder the test reads.
  const cannotApprove = new Map(
    users
      .filter((u) => !canHoldManagerOfRecord(u.role))
      .map((u) => [u.id, managerCannotApproveNotice(u.name ?? u.email, u.role)] as const),
  );

  // #1629: this IS a moderation queue, so an empty one says "nothing is waiting
  // for you" to the person whose job is to clear it, and the history says "no
  // decisions were made". Both are answers, not absences.
  // Every row is one the viewer can decide, by the predicate the approve and
  // decline actions enforce (#3114), so no row carries controls that answer "Not
  // authorized" (L109). The query is scoped the same way; this keeps the
  // controls honest even where the two could ever differ.
  const pending = ((unwrap(pendingRes, "ooo pending queue") ?? []) as OooRequest[]).filter(
    (r) => canModerate(me, r),
  );
  const history = ((unwrap(historyRes, "ooo decision history") ?? []) as OooRequest[]).filter(
    notStaff,
  );
  const allRequests = allRequestsRaw
    .filter(notStaff)
    .map(deOperatorManager);

  // Manager view: their reports + their requests. Admin view: everyone who is
  // in the OOO system (has a manager), org-wide requests, manager breakdown.
  const toRoster = (
    u: Pick<User, "id" | "name" | "email" | "manager_id">,
  ): RosterPerson => ({ id: u.id, name: u.name ?? u.email });
  // Roster mirrors the request filter: admins/super admins are excluded so the
  // headcount and coverage/no-time-off insights cover only the bookable team.
  // #1499: "is in the OOO system" used to mean "has a manager of record", which
  // is no longer true now that a request with no manager routes to the moderators
  // instead of being refused. Nine active people were outside this roster while
  // their requests counted in the same insights (L16: the count and the rows it
  // promises come from one predicate), so coverage alerts compared them against a
  // headcount they were not in.
  const inScope = seesAll
    ? () => true
    : (u: (typeof users)[number]) => u.manager_id === me.id;
  const roster = users
    .filter((u) => inScope(u) && !atLeast(u.role, "admin"))
    .map(toRoster);
  const scopedRequests = seesAll
    ? allRequests
    : allRequests.filter((r) => r.manager_id === me.id);
  const insights = buildInsights(roster, scopedRequests, orgZone);
  // Active managers = anyone a current user reports to. A manager with no active
  // reports is offboarded, so their historical rows are hidden from By manager
  // (and dropped from the median-manager stat so the two agree).
  const activeManagerIds = new Set(
    users.map((u) => u.manager_id).filter((id): id is string => !!id),
  );
  const company = seesAll
    ? companyApprovalStats(allRequests, activeManagerIds)
    : null;
  const breakdown = seesAll
    ? managerBreakdown(allRequests, activeManagerIds)
    : null;
  const stats: { label: string; value: string; sub?: string }[] = [
    {
      label: "Approval rate",
      // #201: over decided requests only; "N/A" when nothing has been decided yet.
      value: insights.stats.decided > 0 ? `${insights.stats.rate}%` : "N/A",
      sub: `${insights.stats.total} ${insights.stats.total === 1 ? "request" : "requests"}`,
    },
    {
      label: "Median notice",
      value: String(insights.advanceNotice),
      sub: insights.advanceNotice === 1 ? "day" : "days",
    },
    { label: "Most time off ahead", value: insights.busiest },
    // Org-wide moderators get a company-wide stat here; a scoped manager
    // doesn't (the count that used to sit here just duplicated the "N waiting
    // on you" header above).
    ...(company
      ? [
          {
            label: "Median manager rate",
            value: company.managerCount > 0 ? `${company.rate}%` : "N/A",
            sub: `${company.managerCount} ${company.managerCount === 1 ? "manager" : "managers"}`,
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
  //
  // #1629: an empty result here is the absence of a WARNING, and absence of a
  // warning is read as "this time off clashes with nothing" by the manager about
  // to approve it. It must not throw either, because that would take the whole
  // approval queue down over an advisory panel, so it degrades to an explicit
  // "could not check" that the queue states out loud.
  let bookingsByAgent = new Map<string, Booking[]>();
  let overlapsUnreadable = false;
  if (pending.length > 0) {
    const minStart = pending
      .map((r) => r.starts_at)
      .reduce((a, b) => (a < b ? a : b));
    const maxEnd = pending
      .map((r) => r.ends_at)
      .reduce((a, b) => (a > b ? a : b));
    const { data, error } = await db
      // cap-safe: active bookings for the few agents with pending time off, within their requested dates.
      .from("bookings")
      // #2660: through the bucket join, keeping test bookings out. A test agent
      // never asks for time off through Slate, so nothing here changes today; it
      // is pinned so the clash panel can never count a stranger's test call as a
      // meeting somebody has to cover.
      .select("*, buckets!inner(is_test)")
      .eq("buckets.is_test", false)
      .eq("org_id", me.org_id)
      .in("status", ["confirmed", "rescheduled"])
      .in("assigned_user_id", [...new Set(pending.map((r) => r.user_id))])
      .lt("starts_at", maxEnd)
      .gt("ends_at", minStart);
    if (error) {
      log.error("admin-ooo", { msg: "overlap warning read failed" }, error);
      overlapsUnreadable = true;
    }
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

  // #1239: the coverage sweep each approved request enqueued, so its row can link
  // to the panel that shows what has actually moved. Without it the manager is told
  // in Slack that a dozen appointments were queued and has nowhere in Slate to watch
  // them land.
  //
  // Most recent sweep per request: `modifyOoo` can legitimately produce a second one
  // for a re-approved window, and the newest is the one still draining.
  const coverageJobByRequest = new Map<string, string>();
  const approvedRequestIds = history
    .filter((r) => r.status === "approved")
    .map((r) => r.id);
  if (approvedRequestIds.length > 0) {
    // error-ok: a read error costs the row its link and nothing else. Nothing here
    // counts these rows or decides anything from their absence; the panel is still
    // reachable from the agent's own page, and the next render retries.
    const { data, error } = await db
      .from("bulk_reassign_jobs")
      // cap-safe: bounded by the explicit limit below, over the at most 50 decided
      // requests this page lists.
      .select("id, ooo_request_id, created_at")
      .in("ooo_request_id", approvedRequestIds)
      .order("created_at", { ascending: false })
      .limit(200);
    if (!error) {
      for (const job of (data ?? []) as {
        id: string;
        ooo_request_id: string | null;
      }[]) {
        if (job.ooo_request_id && !coverageJobByRequest.has(job.ooo_request_id)) {
          coverageJobByRequest.set(job.ooo_request_id, job.id);
        }
      }
    }
  }

  const whenOf = (r: OooRequest) =>
    formatWhenLine(r.starts_at, r.ends_at, r.display_tz_id, r.display_tz_label);
  // One description of the request's finished state, shared with the retry
  // banner (#1476), so the marker, the list under it and the message after a
  // retry can never disagree about which steps are in place.
  const failedEffects = (r: OooRequest) => describeEffects(r.side_effects).failed;

  return (
    <>
      <DeepLinkScroll
        targetId={sp.request ? `request-${sp.request}` : null}
      />
      <>
        {/* The header carries the actionable status: how many wait on you. */}
        <AdminPageHeader
          title={
            pending.length === 0
              ? "You're all caught up."
              : `${pending.length} waiting on you`
          }
        >
            {seesAll
              ? "Requests across the team."
              : "Requests from your reports."}
        </AdminPageHeader>

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
          <p className="pn-eyebrow text-fg-muted">Team insights</p>
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
            <details className="group mt-6">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm [&::-webkit-details-marker]:hidden">
                <svg
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                >
                  <path d="M6 4l4 4-4 4" />
                </svg>
                <h3 className="text-xs font-semibold text-fg-muted">
                  <span className="tabular-nums">{insights.noTimeOff.length}</span>{" "}
                  {insights.noTimeOff.length === 1
                    ? "person has"
                    : "people have"}{" "}
                  taken no time off · last 90 days or next 30
                </h3>
              </summary>
              <ul className="mt-3 flex flex-wrap gap-1.5 pl-5">
                {insights.noTimeOff.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-md bg-bg-alt px-2.5 py-1 text-sm text-fg dark:bg-surface"
                  >
                    {p.name}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {breakdown && breakdown.length > 0 && (
            <div className="mt-6">
              <h3 className="text-xs font-semibold text-fg-muted">By manager</h3>
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th className="py-1 font-semibold">Manager</th>
                    <th className="py-1 font-semibold">Submitted</th>
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
                      <td className="py-1.5 tabular-nums">{row.total}</td>
                      <td className="py-1.5 tabular-nums">{row.approved}</td>
                      <td className="py-1.5 tabular-nums">{row.rejected}</td>
                      <td className="py-1.5 tabular-nums">{row.pending}</td>
                      <td className="py-1.5 tabular-nums">
                        {row.decided > 0 ? `${row.rate}%` : "N/A"}
                      </td>
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
            <>
            {overlapsUnreadable && (
              <UnreadableNotice className="mt-3">
                The booked meetings could not be read, so no clash is flagged below.
                That is not a check that came back clear. Reload before approving
                anything whose dates you are unsure about.
              </UnreadableNotice>
            )}
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
                          it. Approve it here, and set their Agent Manager in
                          Salesforce so future requests route automatically.
                        </span>
                      </p>
                    )}
                    {/* #1475: the named manager exists but cannot approve, so
                        nobody was nudged and the request is sitting here waiting
                        on a team lead. Without this the row looks like an ordinary
                        pending request with an approver who is simply slow. */}
                    {r.manager_id !== null && cannotApprove.has(r.manager_id) && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                        <Pill variant="status-error">Manager cannot approve</Pill>
                        <span className="text-fg-muted">
                          {cannotApprove.get(r.manager_id)}
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
                      <SaveForm action={approveOooAction} name={`ooo-approve-${r.id}`} unsaved="nothing typed here">
                        <input type="hidden" name="request_id" value={r.id} />
                        <SubmitButton className={btnCls} pendingLabel="Approving…">
                          Approve
                        </SubmitButton>
                      </SaveForm>
                      <SaveForm
                        name={`ooo-reject-${r.id}`}
                        unsaved="this rejection note"
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
                        <DeclineConfirm
                          agentName={nameOf(r.user_id)}
                          dayCount={oooDayCount(
                            r.starts_at,
                            r.ends_at,
                            r.display_tz_id,
                          )}
                        />
                      </SaveForm>
                    </div>
                  </li>
                );
              })}
            </ul>
            </>
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
          {/* #2119: the reason ONCE for the section, not once per row. These
              controls appear on every approved request that has a sweep, and the
              first build put the sentence inside each one, which at the real count
              was a wall of the identical sentence down the page (L579). Rendered
              only when there is something for it to explain, so a manager with no
              coverage sweeps is not told about a control they cannot see. */}
          {consoleHidden && coverageJobByRequest.size > 0 && (
            <ConsoleComingSoonNote className="mt-2 text-xs text-fg-muted" />
          )}
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
                        {/* Org-wide moderators (team lead+) span multiple teams,
                            so name the managing team on each decision. */}
                        {seesAll && (
                          <Pill variant="outline">
                            {r.manager_id && !ignoredManagerIds.has(r.manager_id)
                              ? nameOf(r.manager_id)
                              : "No manager"}
                          </Pill>
                        )}
                        {r.status === "approved" && failures.length > 0 && (
                          <Pill variant="status-error">
                            calendar updates incomplete
                          </Pill>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        {r.reason}
                        {r.rejection_note ? ` · Note: ${r.rejection_note}` : ""}
                        {r.decided_by ? ` · by ${nameOf(r.decided_by)}` : ""}
                      </p>
                      {/* #1477: the steps that failed, as VISIBLE text. This
                          detail used to live in a title attribute, so the page
                          named a problem and offered no way to read it on a
                          phone, to a screen reader, or from the keyboard, and
                          this is the surface someone lands on after an alert to
                          decide whether to press Retry. */}
                      {r.status === "approved" && <FailedSteps steps={failures} />}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {/* #1239: straight to the sweep that is moving this agent's
                          appointments, carrying the job so the panel opens on it.

                          #2119: through `ConsoleLink`, because the destination is
                          a CONSOLE route and every console route redirects a
                          manager back to this very page. As a plain anchor it did
                          not refuse and did not explain: it appeared to do
                          nothing, and pressing it again was the only diagnosis
                          available. Managers are the only people using Slate
                          before cutover and this is the one link out of the one
                          page they work on, so it read as the product being
                          broken rather than as a feature not being open yet. */}
                      {coverageJobByRequest.has(r.id) && (
                        <ConsoleLink
                          consoleHidden={consoleHidden}
                          href={`/admin/agents/${r.user_id}?job=${coverageJobByRequest.get(r.id)}#coverage`}
                        >
                          View the coverage sweep
                        </ConsoleLink>
                      )}
                      {canRetry && r.status === "approved" && failures.length > 0 && (
                        <SaveForm action={retryOooAction} name={`ooo-retry-${r.id}`} unsaved="nothing typed here">
                          <input type="hidden" name="request_id" value={r.id} />
                          <SubmitButton className={btnSecondaryCls} pendingLabel="Retrying calendar updates">
                            Retry calendar updates
                          </SubmitButton>
                        </SaveForm>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

      </>
    </>
  );
}

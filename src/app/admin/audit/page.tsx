import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { log } from "@/lib/log";
import { AUDIT_ACTIONS } from "@/lib/audit";
import {
  parseAuditFilters,
  auditFilterHref,
  describeAuditFilters,
  auditActionChoices,
  AUDIT_PAGE_SIZE,
  testAdvisorRowsFilter,
} from "@/lib/audit-filter";
import { auditActionLabel, auditActorText, auditDetailText } from "@/lib/audit-display";
import { InPlaceLink } from "@/components/ui/InPlaceLink";
import { AdminPageHeader, AdminDenied } from "@/components/admin/AdminPageHeader";
import { btnSecondaryCls, cardCls, inputCls, proseCls } from "@/components/ui/styles";
import type { AuditEntry, User } from "@/lib/db/types";
import { realAdvisorsOnly } from "@/lib/advisors/real-advisor";
import { SelectField } from "@/components/ui/SelectField";

export const metadata = { title: "Audit log" };

export const dynamic = "force-dynamic";

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    routine?: string;
    test?: string;
    auditPage?: string;
  }>;
}) {
  const sp = await searchParams;
  const me = await currentUser();
  if (!me) redirect("/login");
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canEditOrgSettings(me.role)) return <AdminDenied need="an admin" />;
  const isAdmin = true;

  const db = supabaseAdmin();
  // The roster, for the actor filter and for naming who did what. unwrap, not
  // `?? []`: an unreadable roster renders every actor as an id fragment and offers
  // an empty actor filter, on the one surface somebody opens precisely because
  // they suspect something happened. A trail that cannot say who did anything is
  // a failure, not a trail with nothing in it.
  const users = unwrap(
    await realAdvisorsOnly(db.from("users").select("*").eq("org_id", me.org_id)),
    "audit log roster",
  ) as User[];

  // Audit log (admin only): the privileged actions, filtered and paged (#1222).
  //
  // Measured 2026-08-17: 373 of 378 rows were time off decisions, so the newest 25
  // were routine approvals and the impersonations, PII actions and settings changes
  // the trail exists for sat far outside the window. `parseAuditFilters` therefore
  // HIDES the routine family unless it is asked for.
  //
  // Filtered and paged in the DATABASE rather than in memory. `audit_log` is a
  // growth table (roughly 80 rows a month), so a single unbounded read would pass
  // today and silently truncate at one PostgREST page later, under-reporting the
  // trail exactly as it got long enough to need this panel.
  //
  // Both reads go through unwrap/unwrapCount (#1526): an unreadable trail rendered
  // as an empty one is the reassuring direction to fail, on the surface somebody
  // opens precisely when they suspect something happened.
  const auditFilters = parseAuditFilters({
    action: sp.action,
    actor: sp.actor,
    from: sp.from,
    to: sp.to,
    routine: sp.routine,
    test: sp.test,
    page: sp.auditPage,
  });
  let auditEntries: AuditEntry[] = [];
  let auditTotal = 0;
  let auditUnreadable = false;
  if (isAdmin) {
    // The same predicate for the COUNT and for the ROWS, so the number above the
    // table and the rows in it can never describe different sets (L16).
    // #3615: the test advisors, whose rows (the daily reroute drill's) are hidden unless asked
    // for. Read through unwrap: an unreadable list would quietly show the drill's rows again.
    const testIds = auditFilters.includeTest
      ? []
      : (
          unwrap(
            // any-advisor-ok: the test advisors themselves, whose drill rows are hidden.
            await db.from("users").select("id").eq("org_id", me.org_id).eq("is_test", true),
            "audit log test advisors",
          ) as { id: string }[]
        ).map((u) => u.id);
    const hideTest = testAdvisorRowsFilter(testIds);
    type Filterable = {
      or: (f: string) => Filterable;
      eq: (c: string, v: string) => Filterable;
      in: (c: string, v: string[]) => Filterable;
      not: (c: string, op: string, v: string) => Filterable;
      gte: (c: string, v: string) => Filterable;
      lte: (c: string, v: string) => Filterable;
    };
    const scoped = <T,>(q: T): T => {
      let b = q as Filterable;
      b = b.eq("org_id", me.org_id);
      if (auditFilters.actions?.length) b = b.in("action", auditFilters.actions);
      else if (!auditFilters.includeRoutine) b = b.not("action", "like", "ooo.%");
      if (auditFilters.actorId) b = b.eq("actor_id", auditFilters.actorId);
      if (hideTest) b = b.or(hideTest);
      if (auditFilters.fromIso) b = b.gte("created_at", `${auditFilters.fromIso}T00:00:00Z`);
      // Inclusive of the whole end day, which is what a person picking a date means.
      if (auditFilters.toIso) b = b.lte("created_at", `${auditFilters.toIso}T23:59:59.999Z`);
      return b as T;
    };

    try {
      auditTotal = unwrapCount(
        await scoped(db.from("audit_log").select("id", { count: "exact", head: true })),
        "audit log count",
      );
      const pageCount = Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE));
      const page = Math.min(auditFilters.page, pageCount);
      const from = (page - 1) * AUDIT_PAGE_SIZE;
      auditEntries = (unwrap(
        await scoped(db.from("audit_log").select("*"))
          .order("created_at", { ascending: false })
          .range(from, from + AUDIT_PAGE_SIZE - 1),
        "audit log page",
      ) ?? []) as AuditEntry[];
    } catch (err) {
      // Distinct from "nothing to show": the panel says it could not read rather
      // than reporting an empty trail it never measured (L10, L11).
      log.error("admin", { msg: "audit log read failed" }, err);
      auditUnreadable = true;
    }
  }
  // Every action the trail can hold, application-written and database-written
  // alike (pii.erasure comes from erase_booking_pii, not from recordAudit).
  const auditActionOptions = auditActionChoices(AUDIT_ACTIONS);
  // Who can be filtered for. Only people who could plausibly appear as an actor,
  // taken from the roster this page already loaded, so it costs no extra read.
  const auditActorChoices = [...users].sort((a, b) =>
    (a.name ?? a.email).localeCompare(b.name ?? b.email),
  );
  const auditPageCount = Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE));
  const auditPage = Math.min(Math.max(1, auditFilters.page), auditPageCount);

  const agentName = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  const nameOf = (id: string | null) =>
    id ? (agentName.get(id) ?? id.slice(0, 8)) : "unassigned";

  return (
    <>
      <AdminPageHeader title="Audit log">
        The privileged actions taken in Slate: who did what, to whom, and when.
      </AdminPageHeader>
      <section className={cardCls} id="audit">
        {/* #1915: no heading of its own. The page header above names this,
            and a section that IS the page restating the page's title is the
            redundancy Dan read as "this is redundant". A page shell that titles
            itself and a section that titles itself are each correct alone; the
            duplication exists only in the composition, which is the one place
            nobody reads. */}
        {/* #1222: what this view is actually showing. A filtered table that reads
            like the whole trail is how somebody concludes nothing happened. */}
        <p className={`mb-3 text-xs text-fg-muted ${proseCls}`}>
          {auditUnreadable
            ? "The audit trail could not be read just now, so this is showing nothing rather than nothing having happened. Reload to try again."
            : describeAuditFilters(auditFilters, auditTotal)}{" "}
          Rows marked as rebuilt were reconstructed from the request record after
          a fault left them unrecorded at the time.
        </p>

        {/* The filter. A GET form, so every view is a URL somebody can link to
            or come back to, and so it works with no JavaScript. */}
        {/* unsaved-ok: a filter row holds a view, not work. Losing what is in one
          is an annoyance, and a guard that fires on filters is the one people
          learn to click through, after which it is not protecting the alert
          floors either (L36, #2076). */}
      <form
        method="GET"
        action="/admin/audit"
        className="mb-3 flex flex-wrap items-end gap-2"
        autoComplete="off"
      >
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Action
            <SelectField
              name="action"
              ariaLabel="Action"
              defaultValue={auditFilters.actions?.[0] ?? ""}
              className="w-56"
              options={[
                { value: "", label: "Any" },
                ...auditActionOptions.map((a) => ({ value: a, label: auditActionLabel(a) })),
              ]}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Person
            <SelectField
              name="actor"
              ariaLabel="Person"
              defaultValue={auditFilters.actorId ?? ""}
              className="w-56"
              options={[
                { value: "", label: "Anyone" },
                ...auditActorChoices.map((u) => ({ value: u.id, label: u.name ?? u.email })),
              ]}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            From
            <input type="date" name="from" defaultValue={auditFilters.fromIso ?? ""} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            To
            <input type="date" name="to" defaultValue={auditFilters.toIso ?? ""} className={inputCls} />
          </label>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              name="routine"
              value="1"
              defaultChecked={auditFilters.includeRoutine}
              className="h-4 w-4"
            />
            Include time off decisions
          </label>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              name="test"
              value="1"
              defaultChecked={auditFilters.includeTest}
              className="h-4 w-4"
            />
            Include test advisors
          </label>
          <button type="submit" className={btnSecondaryCls}>
            Apply
          </button>
          {(auditFilters.actions ||
            auditFilters.actorId ||
            auditFilters.fromIso ||
            auditFilters.toIso ||
            auditFilters.includeRoutine ||
            auditFilters.includeTest) && (
            <InPlaceLink href="/admin/audit" className={btnSecondaryCls}>
              Clear
            </InPlaceLink>
          )}
        </form>

        {auditUnreadable ? null : auditEntries.length === 0 ? null : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-fg-muted">
                <tr>
                  <th className="py-1 pr-3 font-semibold">When</th>
                  <th className="py-1 pr-3 font-semibold">Who</th>
                  <th className="py-1 pr-3 font-semibold">Action</th>
                  <th className="py-1 pr-3 font-semibold">Target</th>
                  <th className="py-1 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody>
                {auditEntries.map((a) => (
                  <tr key={a.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                      {new Date(a.created_at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-1.5 pr-3">{auditActorText(a, nameOf)}</td>
                    <td className="py-1.5 pr-3">{auditActionLabel(a.action)}</td>
                    <td className="py-1.5 pr-3">{nameOf(a.target_id)}</td>
                    <td className="py-1.5 text-fg-muted">{auditDetailText(a, nameOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* An empty RESULT and an unreadable trail are different screens, and
            neither may read as "nothing has ever happened here" (L10, L11). */}
        {!auditUnreadable && auditEntries.length === 0 && (
          <p className="text-sm text-fg-muted">
            {describeAuditFilters(auditFilters, 0)}
          </p>
        )}

        {!auditUnreadable && auditPageCount > 1 && (
          <nav
            aria-label="Audit log pages"
            className="mt-3 flex items-center justify-between text-sm"
          >
            {auditPage > 1 ? (
              <InPlaceLink
                href={auditFilterHref(auditFilters, { page: auditPage - 1 })}
                className={btnSecondaryCls}
              >
                Previous
              </InPlaceLink>
            ) : (
              <span className={`${btnSecondaryCls} pointer-events-none opacity-40`} aria-disabled="true">
                Previous
              </span>
            )}
            <span className="text-xs text-fg-muted tabular-nums">
              Page {auditPage} of {auditPageCount}
            </span>
            {auditPage < auditPageCount ? (
              <InPlaceLink
                href={auditFilterHref(auditFilters, { page: auditPage + 1 })}
                className={btnSecondaryCls}
              >
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
    </>
  );
}

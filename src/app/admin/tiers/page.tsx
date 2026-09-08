import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { cardCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { UnreadableNotice } from "@/components/ui/UnreadableNotice";
import { type StaffingFlag, type TierDepth } from "@/lib/routing/staffing-depth";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import { log } from "@/lib/log";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

export const dynamic = "force-dynamic";

/** Flag -> pill treatment + short label. Color is never the sole signal: the
 *  label states the meaning, so a colorblind reader still gets it. */
function flagPill(flag: StaffingFlag): { variant: PillVariant; className?: string; label: string } {
  switch (flag) {
    case "none":
      return { variant: "status-error", label: "No coverage" };
    case "spof":
      return { variant: "status-error", label: "Single point of failure" };
    case "thin":
      // No yellow pill variant; tint an outline pill so thin reads as a warning
      // distinct from the rose error and the green ok.
      return {
        variant: "outline",
        className: "border-pennie-yellow text-fg dark:border-pennie-yellow",
        label: "Thin",
      };
    case "ok":
      return { variant: "status-ok", label: "OK" };
  }
}

/**
 * What the Bookable agents column counts (#1901).
 *
 * The first number is the roster depth for that tier, and the smaller one beside
 * it is how many of those are actually available today once anyone on approved
 * time off or holding an all day block is set aside (#738). Written once here and
 * read by the column header, so the definition and the numbers cannot drift.
 */
const DEPTH_LEGEND =
  "on the roster for this tier, with how many are available today beside it " +
  "once anyone out on approved time off is set aside";

/** Human detail for a row: who the sole agent is, who is out today, or the
 *  fallback situation. The status column reflects the EFFECTIVE flag, so this
 *  detail explains it (roster vs available today when agents are out). */
function rowDetail(row: TierDepth): string {
  // #738/#744: agents who are out today (approved time off, or an all-day block
  // on their own calendar) thin the tier, or empty it.
  if (row.outCount > 0) {
    const avail =
      row.effectiveDepth === 0
        ? "nobody is available today"
        : row.effectiveDepth === 1
          ? "only 1 is available today"
          : `only ${row.effectiveDepth} are available today`;
    return `${row.depth} on the roster, but ${avail} (${row.outCount} out today).`;
  }
  if (row.flag === "spof") {
    return row.soleAgentName
      ? `Only ${row.soleAgentName} can take these bookings.`
      : "Rests on a single agent.";
  }
  if (row.flag === "none") {
    return row.hasWorkingFallback
      ? "No eligible agent; a fallback agent is set, so bookings still route."
      : "No eligible agent and no fallback set, so bookings will fail.";
  }
  if (row.flag === "thin") {
    return "Two agents deep. One time-off or offboarding away from a single point of failure.";
  }
  return "";
}

export default async function TiersPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to view staffing depth.
      </main>
    );
  }
  // Mirror /admin: during the OOO-only launch, everyone below super admin is
  // limited to the OOO surfaces (scheduling config isn't live yet).
  if (consoleHiddenFor(me.role)) {
    redirect("/admin/ooo");
  }

  // #1629: `loadTierDepths` THROWS on an unreadable read rather than answering
  // with an empty list. Caught here and turned into its own screen, because
  // "no tiers are configured" and "the roster could not be read" are the same
  // picture once the error is dropped, and on this page the first reads as a
  // staffing emergency (L10). Nothing below may count over an unmeasured roster.
  let rows: TierDepth[] | null = null;
  try {
    rows = await loadTierDepths(supabaseAdmin(), me.org_id);
  } catch (err) {
    log.error("admin-tiers", { msg: "staffing depth unreadable" }, err);
    rows = null;
  }
  // Summary + status reflect the EFFECTIVE (time-off-aware) flag: the real
  // short-term risk today. Roster depth stays visible per row for context (#738).
  // Each is null, never 0, when there was nothing to count over.
  const spofCount = rows && rows.filter((r) => r.effectiveFlag === "spof").length;
  const noneCount = rows && rows.filter((r) => r.effectiveFlag === "none").length;
  const thinCount = rows && rows.filter((r) => r.effectiveFlag === "thin").length;
  const outTodayCount = rows && rows.reduce((n, r) => n + r.outCount, 0);

  return (
    <>
      <>
        <AdminPageHeader title="Staffing depth">
            How many currently-bookable agents can take each tier&rsquo;s bookings, and how
            many are actually available today once you set aside anyone who is out, so a
            tier resting on one person (now or this week) is visible before it runs out of
            times. An agent counts as out whether they filed time off or blocked the whole
            day on their calendar. Most at risk today first.
        </AdminPageHeader>

        <section className={cardCls}>
          {rows === null ? (
            <UnreadableNotice>
              Staffing depth could not be read, so this page is not showing your
              tiers. No tier has lost its agents. Reload in a moment, and if it keeps
              saying this, the database read is failing rather than the roster.
            </UnreadableNotice>
          ) : (
          <>
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span className="text-fg-muted">
              <span className="font-semibold tabular-nums text-fg">{rows.length}</span> tiers
            </span>
            <span className={(noneCount ?? 0) > 0 ? "text-error" : "text-fg-muted"}>
              <span className="font-semibold tabular-nums">{noneCount}</span> with no coverage
            </span>
            <span className={(spofCount ?? 0) > 0 ? "text-error" : "text-fg-muted"}>
              <span className="font-semibold tabular-nums">{spofCount}</span> on a single agent today
            </span>
            <span className="text-fg-muted">
              <span className="font-semibold tabular-nums">{thinCount}</span> two deep today
            </span>
            <span className="text-fg-muted">
              <span className="font-semibold tabular-nums">{outTodayCount}</span> agent-slots out today
            </span>
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
                  <th scope="col" className="px-4 py-2.5 font-semibold">Tier</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Code</th>
                  {/* #1901: the definition is reachable rather than in the way.
                      It read "Bookable agents (available today)", a gloss every
                      reader passed through on every view to serve the one who
                      needed it once. Same treatment as the roster's Team column
                      (#1812): a `title` for a pointer, and an `sr-only` span so
                      it is not available by hover alone. */}
                  <th scope="col" className="px-3 py-2.5 font-semibold" title={DEPTH_LEGEND}>
                    Bookable agents
                    <span className="sr-only">{` (${DEPTH_LEGEND})`}</span>
                  </th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const pill = flagPill(row.effectiveFlag);
                  const detail = rowDetail(row);
                  return (
                    <tr key={row.code} className="align-top transition-colors hover:bg-[var(--bg-alt)]">
                      <td className="px-4 py-3 font-semibold text-fg">{row.name}</td>
                      <td className="px-3 py-3 text-fg-muted tabular-nums">{row.code}</td>
                      <td className="px-3 py-3">
                        {/* #740: click to expand the covering agents. Native
                            details/summary: keyboard-accessible, needs no client JS. */}
                        <details className="group">
                          <summary className="flex cursor-pointer items-center gap-1 tabular-nums marker:text-fg-muted">
                            <span
                              className={`font-semibold ${row.effectiveDepth <= 1 ? "text-error" : "text-fg"}`}
                            >
                              {row.depth}
                            </span>
                            {row.outCount > 0 && (
                              <span className="text-xs text-fg-muted">({row.effectiveDepth} today)</span>
                            )}
                            <span className="ml-1 text-xs text-fg-muted underline-offset-2 group-hover:underline">
                              agents
                            </span>
                          </summary>
                          <ul className="mt-2 space-y-1">
                            {row.agents.length === 0 && (
                              <li className="text-xs text-fg-muted">No eligible agents.</li>
                            )}
                            {row.agents.map((a) => (
                              <li key={a.id} className="text-xs">
                                <a
                                  href={`/admin/agents/${a.id}`}
                                  className="text-fg underline-offset-2 hover:underline"
                                >
                                  {a.name}
                                </a>
                                {a.out && <span className="ml-1 text-fg-muted">(out today)</span>}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <Pill variant={pill.variant} className={pill.className} alignToColumn>
                            {pill.label}
                          </Pill>
                          {detail && <p className="text-xs text-fg-muted">{detail}</p>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-10 text-center text-sm text-fg-muted">
                      No tiers yet. Create a bucket on the admin page to route bookings.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </>
          )}
        </section>
      </>
    </>
  );
}

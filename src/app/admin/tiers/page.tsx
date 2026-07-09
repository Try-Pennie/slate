import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canManageAgents } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { AppHeader } from "@/components/AppHeader";
import { cardCls } from "@/components/ui/styles";
import { Pill, type PillVariant } from "@/components/ui/Pill";
import { type StaffingFlag, type TierDepth } from "@/lib/routing/staffing-depth";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";

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

/** Human detail for a row: who the sole agent is, or the fallback situation. */
function rowDetail(row: TierDepth): string {
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
  if (oooOnlyFor(me.role)) {
    redirect("/admin/ooo");
  }

  const rows = await loadTierDepths(supabaseAdmin(), me.org_id);
  const spofCount = rows.filter((r) => r.flag === "spof").length;
  const noneCount = rows.filter((r) => r.flag === "none").length;
  const thinCount = rows.filter((r) => r.flag === "thin").length;

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
      <main className="mx-auto w-full min-w-0 max-w-4xl space-y-8 px-6 py-10 sm:px-8">
        <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          <p className="pn-eyebrow text-pennie-sky">Admin</p>
          <h1 className="pn-h3 mt-2 text-pennie-beige">Staffing depth</h1>
          <p className="mt-2 text-pennie-beige/75">
            How many currently-bookable agents can take each tier&rsquo;s bookings, so a
            tier resting on one person is visible before it runs out of times. Thinnest
            first.
          </p>
        </section>

        <section className={cardCls}>
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span className="text-fg-muted">
              <span className="font-semibold tabular-nums text-fg">{rows.length}</span> tiers
            </span>
            <span className={noneCount > 0 ? "text-error" : "text-fg-muted"}>
              <span className="font-semibold tabular-nums">{noneCount}</span> with no coverage
            </span>
            <span className={spofCount > 0 ? "text-error" : "text-fg-muted"}>
              <span className="font-semibold tabular-nums">{spofCount}</span> on a single agent
            </span>
            <span className="text-fg-muted">
              <span className="font-semibold tabular-nums">{thinCount}</span> two deep
            </span>
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border bg-[var(--bg-alt)] text-left text-xs text-fg-muted">
                  <th scope="col" className="px-4 py-2.5 font-semibold">Tier</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Code</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Bookable agents</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const pill = flagPill(row.flag);
                  const detail = rowDetail(row);
                  return (
                    <tr key={row.code} className="align-top transition-colors hover:bg-[var(--bg-alt)]">
                      <td className="px-4 py-3 font-semibold text-fg">{row.name}</td>
                      <td className="px-3 py-3 text-fg-muted tabular-nums">{row.code}</td>
                      <td className="px-3 py-3 tabular-nums">
                        <span
                          className={`font-semibold ${row.depth <= 1 ? "text-error" : "text-fg"}`}
                        >
                          {row.depth}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <Pill variant={pill.variant} className={pill.className}>
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
        </section>
      </main>
    </>
  );
}

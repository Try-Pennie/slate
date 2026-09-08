import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { cardCls, proseCls } from "@/components/ui/styles";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { loadAvailabilityGrid, GRID_DAYS } from "@/lib/admin/availability-grid-load";
import { AvailabilityGridTable } from "@/components/AvailabilityGridTable";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

export const dynamic = "force-dynamic";

/**
 * The availability grid (#1302): for each day and hour, whether anyone can be
 * booked, and when they cannot, WHY.
 *
 * The whole reason it is a grid rather than another alert is that an empty hour
 * has five different causes and each one is a different person's job. Colour is
 * never the sole signal: every cell carries a letter and a full sentence in its
 * title, so a colourblind reader and a screen reader both get the same answer.
 */
export default async function AvailabilityGridPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to view availability.
      </main>
    );
  }
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");

  const grid = await loadAvailabilityGrid();
  const zoneLabel = DateTime.now().setZone(BUSINESS_ZONE).toFormat("ZZZZ");

  return (
    <>
      <>
        <AdminPageHeader title="Availability">
            Every hour of the next {GRID_DAYS} days, and whether a lead could book it.
            When they could not, this says which of the five reasons it was, because
            an hour nobody is rostered for, an hour the whole team is away, and an
            hour that is simply full are different problems for different people.
            All times are {zoneLabel}.
        </AdminPageHeader>

        {!grid.measurable ? (
          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">The roster could not be read</h2>
            <p className={`text-sm text-fg-muted ${proseCls}`}>
              Nothing below was measured, so this is not a report that nobody is
              rostered. Reload in a moment; if it persists, the agents or working
              hours tables are not readable and availability itself is at risk.
            </p>
          </section>
        ) : (
          <section className={cardCls}>
            <AvailabilityGridTable grid={grid} />
          </section>
        )}
      </>
    </>
  );
}

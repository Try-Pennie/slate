import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canManageAgents } from "@/lib/auth/roles";
import { oooOnlyFor } from "@/lib/env";
import { AppHeader } from "@/components/AppHeader";
import { cardCls, proseCls } from "@/components/ui/styles";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { loadBucketSupply } from "@/lib/admin/bucket-supply-load";
import { BucketSupplyTable } from "@/components/BucketSupplyTable";
import { PageShell } from "@/components/ui/PageShell";

export const dynamic = "force-dynamic";

/**
 * Open availability per debt bucket per day (#1254).
 *
 * Read only, internal, and fed entirely from the slot cache the booker already
 * serves, so it adds nothing to the hot path and makes no calendar call.
 *
 * Manager or admin only, and org scoped: the caller's own `org_id` bounds the
 * bucket list and the roster read, and every read runs server side through the
 * secret key client. There is no client fetch and no route handler, so there is
 * nothing here an unauthenticated caller can reach.
 */
export default async function BucketAvailabilityPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to view bucket availability.
      </main>
    );
  }
  // Mirror /admin: during the OOO only launch, everyone below super admin is
  // limited to the OOO surfaces.
  if (oooOnlyFor(me.role)) redirect("/admin/ooo");

  const report = await loadBucketSupply(me.org_id);
  const zoneLabel = DateTime.now().setZone(BUSINESS_ZONE).toFormat("ZZZZ");

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
      <PageShell>
        <section className="rounded-xl bg-pennie-navy px-7 py-6 dark:bg-surface">
          <p className="pn-eyebrow text-pennie-sky">Admin</p>
          <h1 className="pn-h3 mt-2 text-pennie-beige">Bucket availability</h1>
          <p className={`mt-2 text-pennie-beige/75 ${proseCls}`}>
            How many appointment times each debt bucket is offering on each day, against how
            many that day could have held. A count on its own cannot tell a thin pool from a
            closed one, so every number is a share of what was possible. All times are{" "}
            {zoneLabel}.
          </p>
        </section>

        {!report.measurable ? (
          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">
              {report.reason === "business-hours"
                ? "The office hours could not be read"
                : report.reason === "booking-horizon"
                  ? "The booking horizon could not be read"
                  : "The slot cache could not be read"}
            </h2>
            <p className={`text-sm text-fg-muted ${proseCls}`}>
              {report.reason === "business-hours"
                ? "Every figure on this page is measured against the office day, so with the week unreadable there is nothing honest to show. Nothing below was measured, and this is not a report that no bucket has availability."
                : report.reason === "booking-horizon"
                  ? "The horizon sets how many days ahead are offered, so it decides both which days appear here and how many times each one could have held. Showing the standard window instead would change what every share on this page means, and nothing about the resulting numbers would look wrong. Reload in a moment."
                  : "Nothing below was measured, so this is not a report that the buckets are empty. Reload in a moment; if it persists, the slot cache is unreadable and the booker itself is at risk."}
            </p>
          </section>
        ) : (
          <section className={cardCls}>
            <BucketSupplyTable
              days={report.days}
              rows={report.rows}
              zone={report.zone}
              depthReadable={report.depthReadable}
              bucketListReadable={report.bucketListReadable}
            />
          </section>
        )}
      </PageShell>
    </>
  );
}

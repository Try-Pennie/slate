import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { currentUser } from "@/lib/auth";
import { canEditOrgSettings, canManageAgents } from "@/lib/auth/roles";
import { consoleHiddenFor } from "@/lib/env";
import { cardCls, proseCls } from "@/components/ui/styles";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { loadBucketSupply } from "@/lib/admin/bucket-supply-load";
import type { BucketSupplyReport } from "@/lib/admin/bucket-supply";
import { BucketSupplyTable } from "@/components/BucketSupplyTable";
import { AdminPageHeader } from "@/components/admin/AdminPageHeader";

export const metadata = { title: "Bucket availability" };

export const dynamic = "force-dynamic";

/**
 * What the page says in place of the table, one entry per reason it could not
 * measure. A record keyed on the reasons, so `tsc` names a reason added without
 * its own words (#3922 added the offered open days).
 */
const UNMEASURABLE_COPY: Record<
  Extract<BucketSupplyReport, { measurable: false }>["reason"],
  { title: string; body: string }
> = {
  "business-hours": {
    title: "The office hours could not be read",
    body: "Every figure on this page is measured against the office day, so with the week unreadable there is nothing honest to show. Nothing below was measured, and this is not a report that no bucket has availability.",
  },
  "booking-horizon": {
    title: "The booking horizon could not be read",
    body: "The horizon sets how many days ahead are offered, so it decides both which days appear here and how many times each one could have held. Showing the standard window instead would change what every share on this page means, and nothing about the resulting numbers would look wrong. Reload in a moment.",
  },
  "offered-open-days": {
    title: "The days offered could not be read",
    body: "How many open days a lead is offered decides which days every pool is judged over and what the page says a lead is shown. Judging them over a guessed number would change what every row means, and nothing about it would look wrong. Reload in a moment.",
  },
  "slot-cache": {
    title: "The slot cache could not be read",
    body: "Nothing below was measured, so this is not a report that the buckets are empty. Reload in a moment; if it persists, the slot cache is unreadable and the booker itself is at risk.",
  },
};

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
  // Mirror /admin: during the OOO only launch, everyone below super admin is
  // limited to the OOO surfaces.
  if (consoleHiddenFor(me.role)) redirect("/admin/ooo");
  if (!canManageAgents(me.role)) {
    return (
      <main className="p-8 text-sm text-fg-muted">
        You need a manager or admin account to view bucket availability.
      </main>
    );
  }
  const report = await loadBucketSupply(me.org_id);
  const zoneLabel = DateTime.now().setZone(BUSINESS_ZONE).toFormat("ZZZZ");

  return (
    <>
      <>
        <AdminPageHeader title="Bucket availability">
            {/* #1938: three lines down to one, and that is the point of the
                change rather than a side effect of it. Dan had the explanatory
                paragraph stripped from the sibling page for the same reason
                (#1898): a page that needs one is a page whose design has not
                been done. What this said is now carried by the table's own
                headers, where a reader meets it first. The zone stays, because
                nothing in the table can say it. */}
            All times are {zoneLabel}.
        </AdminPageHeader>

        {!report.measurable ? (
          <section className={cardCls}>
            <h2 className="mb-1 text-sm font-semibold">{UNMEASURABLE_COPY[report.reason].title}</h2>
            <p className={`text-sm text-fg-muted ${proseCls}`}>{UNMEASURABLE_COPY[report.reason].body}</p>
          </section>
        ) : (
          <section className={cardCls}>
            <BucketSupplyTable
              days={report.days}
              rows={report.rows}
              // Admins configure buckets by code and keep one row per code;
              // managers and team leads read the page by pool, in words.
              showCodes={canEditOrgSettings(me.role)}
              zone={report.zone}
              nowMs={report.nowMs}
              depthReadable={report.depthReadable}
              bucketListReadable={report.bucketListReadable}
              offeredOpenDays={report.offeredOpenDays}
            />
          </section>
        )}
      </>
    </>
  );
}

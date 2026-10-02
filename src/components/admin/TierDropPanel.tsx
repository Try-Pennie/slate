import { OpenBookingLink } from "@/components/OpenBookingLink";
import ViewerTime from "@/components/ViewerTime";
import { proseCls } from "@/components/ui/styles";
import { bucketHeading, bucketShownAs } from "@/lib/availability/pool-label";
import type { TierDropCause, TierDropTally } from "@/lib/routing/tier-drop-counts";
import type { TierDropReport } from "@/lib/admin/tier-drops-load";

/** How many of the recent drops are listed by name; the rest are counted. */
export const TIER_DROP_LISTED = 10;

const CAUSE_LABEL: Record<TierDropCause, string> = {
  "lost-at-confirm": "Their tier's last opening was taken before they confirmed",
  "nothing-on-show": "Their tier had no times to offer",
  "not-recorded": "Not recorded",
};

const CAUSE_SHORT: Record<TierDropCause, string> = {
  "lost-at-confirm": "Opening taken first",
  "nothing-on-show": "No times in their tier",
  "not-recorded": "Not recorded",
};

function share(n: number, of: number): string {
  if (of === 0) return "";
  const pct = (100 * n) / of;
  return ` (${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%)`;
}

function Count({ tally, of, cause }: { tally: TierDropTally; of: number; cause?: TierDropCause }) {
  const n = cause ? tally[cause] : tally.total;
  return (
    <td className="py-1.5 pr-3 text-right tabular-nums">
      {n}
      {!cause && <span className="text-xs text-fg-muted"> of {of}{share(n, of)}</span>}
    </td>
  );
}

/**
 * How often a lead drops a debt tier at confirm, by cause (2026-10-02). A drop
 * no longer pages: sales ops chose that a lead keeps the time they picked and
 * takes the next tier down rather than starting over, so this is where it is seen.
 *
 * `showCodes`: admins read the bucket code, managers read the pool in words
 * (`bucketShownAs`), the same rule as the routing table beside it.
 */
export function TierDropPanel({ report, showCodes }: { report: TierDropReport; showCodes: boolean }) {
  const { counts, booked } = report;
  // The commonest case, a quiet month, is said in words rather than as a table
  // of zeros (L610).
  if (counts.month.total === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No lead has dropped a tier in the last 30 days, out of {booked.month} routed bookings.
      </p>
    );
  }
  // "Not recorded" exists only for bookings made before the shown tier was saved
  // or a failed read, so its row is drawn only when it has something to count.
  const causes: TierDropCause[] = ["lost-at-confirm", "nothing-on-show"];
  if (counts.month["not-recorded"] > 0) causes.push("not-recorded");
  const listed = counts.recent.slice(0, TIER_DROP_LISTED);
  const unlisted = counts.recent.length - listed.length;
  return (
    <div className="space-y-4">
      <p className={`text-xs text-fg-muted ${proseCls}`}>
        When nobody in a lead&apos;s debt tier can take the time they picked, the call
        goes to the next tier down rather than asking them to choose again.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-semibold">
                <span className="sr-only">Cause</span>
              </th>
              <th className="py-1 pr-3 text-right font-semibold">Last 7 days</th>
              <th className="py-1 pr-3 text-right font-semibold">Last 30 days</th>
            </tr>
          </thead>
          <tbody>
            {causes.map((c) => (
              <tr key={c} className="border-t border-border">
                <th scope="row" className="py-1.5 pr-3 font-normal">
                  {CAUSE_LABEL[c]}
                </th>
                <Count tally={counts.week} of={booked.week} cause={c} />
                <Count tally={counts.month} of={booked.month} cause={c} />
              </tr>
            ))}
            <tr className="border-t border-border font-semibold">
              <th scope="row" className="py-1.5 pr-3">
                Dropped a tier
              </th>
              <Count tally={counts.week} of={booked.week} />
              <Count tally={counts.month} of={booked.month} />
            </tr>
          </tbody>
        </table>
      </div>
      {counts.unreadableStamps > 0 && (
        <p className="text-xs text-fg-muted">
          {counts.unreadableStamps} more {counts.unreadableStamps === 1 ? "drop has" : "drops have"} a
          booking time that could not be read, so {counts.unreadableStamps === 1 ? "it is" : "they are"} in
          neither column.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-semibold">Booked</th>
              <th className="py-1 pr-3 font-semibold">Tier</th>
              <th className="py-1 pr-3 font-semibold">{bucketHeading(showCodes)}</th>
              <th className="py-1 pr-3 font-semibold">Cause</th>
              <th className="py-1 font-semibold">
                <span className="sr-only">Open booking</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listed.map((d) => (
              <tr key={d.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap py-1.5 pr-3 text-fg-muted tabular-nums">
                  <ViewerTime iso={d.createdAt} />
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3">
                  {d.requestedLabel} to {d.bookedLabel}
                </td>
                <td className="py-1.5 pr-3 text-fg-muted tabular-nums">
                  {bucketShownAs(d.bucketCode, { showCodes })}
                </td>
                <td className="py-1.5 pr-3 text-fg-muted">{CAUSE_SHORT[d.cause]}</td>
                <td className="py-1.5">
                  <OpenBookingLink bookingId={d.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {unlisted > 0 && (
          <p className="mt-2 text-xs text-fg-muted">
            {unlisted} earlier {unlisted === 1 ? "drop" : "drops"} in the last 30 days.
          </p>
        )}
      </div>
    </div>
  );
}

import { DRAIN_ALERT_AFTER } from "@/lib/booking/drain-backoff";
import { Pill } from "@/components/ui/Pill";
import type { StuckRow } from "@/lib/booking/stuck-drain";

/**
 * The wedged rows of the two drains, as a panel on the Health page (#1960).
 *
 * Dan: "Do we even need this page? can we just stick it somewhere else? feels
 * like this page is meant to be empty so we probably don't need to give it it's
 * own page."
 *
 * It was its own route with a sidebar entry, and it was empty by construction:
 * both reads are filtered to rows that have ALREADY crossed the threshold that
 * fires an alert, so the screen cannot show anything nobody has been paged
 * about. It is also read only, with no controls at all. A screen with no
 * actions, whose content only exists after an alert, reached by a nav entry
 * somebody has to remember, is not carrying its weight: the alert is the real
 * entry point, and `/admin` is where somebody lands after one.
 *
 * Keeping the route without its nav entry was not available: `nav.ts` and
 * `test-admin-nav-reachability.ts` exist precisely so no admin screen can be
 * findable only by somebody hunting for it under pressure (L546). So the content
 * moved and the route went.
 */

/** A stuck row can sit for a long time, so the stamps are absolute rather than
 *  relative (a relative age would need the clock during render). */
function fmt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function StuckDeliveriesPanel({
  rows,
  gaveUp,
  readError,
}: {
  rows: StuckRow[];
  gaveUp: number;
  /** The reason the drains could not be read, or null. */
  readError: string | null;
}) {
  // A FAILED READ RENDERS SOMETHING, always. Folding an empty by design panel
  // means drawing nothing when it is empty, which is right, and it makes this
  // the whole distinction: without it "no panel" would cover both "nothing is
  // stuck" and "we could not tell" (L10). It keeps the loud treatment it had as
  // its own page rather than being demoted to a grey line among many.
  if (readError) {
    return (
      <div
        role="alert"
        className="rounded-md border border-[var(--error)] px-4 py-3 text-sm text-error"
      >
        The drain tables could not be read, so nothing is listed here. That is not
        a report that nothing is stuck. ({readError})
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        No delivery is stuck. A failed side effect or a crash recovered create
        appears here once it has failed {DRAIN_ALERT_AFTER} times.
      </>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-fg">
        {rows.length} stuck {rows.length === 1 ? "delivery" : "deliveries"}, each
        having failed at least {DRAIN_ALERT_AFTER} times and backing off.
        {gaveUp > 0 && (
          <>
            {" "}
            {/* #1954: this count was `text-pennie-beige`, which is the page's own
                background on the light theme: an invisible number. It moved with
                the content rather than being fixed in a file about to be
                deleted. The error tone is right here anyway, since a row that has
                given up is the one that needs a person. */}
            <span className="font-semibold text-error">{gaveUp}</span> of them have
            hit the give up cap and need a human.
          </>
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="py-1 pr-3 font-semibold">Kind</th>
              <th className="py-1 pr-3 font-semibold">Action</th>
              <th className="py-1 pr-3 font-semibold">Reference</th>
              <th className="py-1 pr-3 font-semibold">Attempts</th>
              <th className="py-1 pr-3 font-semibold">Next retry</th>
              <th className="py-1 pr-3 font-semibold">Last error</th>
              <th className="py-1 font-semibold">Last tried</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}-${r.id}`} className="border-t border-border align-top">
                <td className="py-2 pr-3">
                  <Pill variant="outline" alignToColumn>
                    {r.kind}
                  </Pill>
                </td>
                <td className="py-2 pr-3">{r.action}</td>
                <td className="py-2 pr-3 font-mono text-xs break-all">
                  {r.ref ?? <span className="text-fg-muted">none</span>}
                </td>
                <td className="py-2 pr-3">
                  {r.gaveUp ? (
                    <Pill variant="status-error" alignToColumn>
                      {r.attempts} &middot; gave up
                    </Pill>
                  ) : (
                    <span className="tabular-nums">{r.attempts}</span>
                  )}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-fg-muted">
                  {r.gaveUp ? "not retrying" : r.nextAttemptAt ? fmt(r.nextAttemptAt) : "now"}
                </td>
                <td className="py-2 pr-3 text-fg-muted">
                  {r.lastError ?? <span className="italic">no error recorded</span>}
                </td>
                <td className="py-2 whitespace-nowrap tabular-nums text-fg-muted">
                  {fmt(r.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

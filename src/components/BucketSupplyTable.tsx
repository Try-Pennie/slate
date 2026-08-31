import { DateTime } from "luxon";
import {
  backendDigitOf,
  supplyTotals,
  type BucketSupplyRow,
  type SupplyDay,
} from "@/lib/admin/bucket-supply";
import {
  BACKEND_GROUP_LABEL,
  SUPPLY_LEGEND,
  cellStyle,
  depthLabel,
  freshnessLabel,
  sharePercent,
  supplyCellTitle,
} from "@/lib/admin/bucket-supply-copy";

/**
 * The per bucket supply table and its key (#1254).
 *
 * A component rather than markup inside the page so the rendering can be driven
 * by a test. What a cell shows is a number, and the sentence behind that number
 * is the only thing a screen reader gets, so a static check on the copy builder
 * cannot prove the sentence reaches the screen.
 *
 * Rows are grouped by the BACKEND digit of the XBC code, because that is where
 * the pattern lives: on 2026-08-04 every one of the fifteen partially blocked
 * buckets was a Beyond code, and it thinned as the debt tier rose.
 */
export function BucketSupplyTable({
  days,
  rows,
  zone,
  depthReadable,
  bucketListReadable,
}: {
  days: SupplyDay[];
  rows: BucketSupplyRow[];
  zone: string;
  depthReadable: boolean;
  bucketListReadable: boolean;
}) {
  const totals = supplyTotals(rows, 0);
  const todayLabel = days[0]
    ? DateTime.fromISO(days[0].iso, { zone }).toFormat("cccc d LLLL")
    : "today";

  // One `tbody` per backend group, each opening with a `scope="rowgroup"`
  // heading. The table stays ONE table (one caption, one set of column headers a
  // screen reader can associate every cell with) and the group label is a real
  // heading for the rows under it rather than a styled row that happens to look
  // like one.
  const groups: { label: string; rows: BucketSupplyRow[] }[] = [];
  for (const row of rows) {
    const digit = backendDigitOf(row.code);
    const label = digit === null ? "Other codes" : BACKEND_GROUP_LABEL[digit];
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="text-fg-muted">
          <span className="font-semibold tabular-nums text-fg">{totals.fullyOpen}</span> offering
          the whole of today
        </span>
        <span className="text-fg-muted">
          <span className="font-semibold tabular-nums">{totals.partial}</span> partly taken today
        </span>
        <span className={totals.empty > 0 ? "text-error" : "text-fg-muted"}>
          <span className="font-semibold tabular-nums">{totals.empty}</span> offering nothing today
        </span>
        <span className={totals.unmeasured > 0 ? "text-error" : "text-fg-muted"}>
          <span className="font-semibold tabular-nums">{totals.unmeasured}</span> could not be
          measured
        </span>
        <span className={totals.stale > 0 ? "text-error" : "text-fg-muted"}>
          <span className="font-semibold tabular-nums">{totals.stale}</span> stale or never computed
        </span>
      </div>

      {!depthReadable && (
        <p className="mb-4 rounded-md border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg-muted">
          The roster could not be read, so the eligible agents column says unknown throughout.
          That is not a report that no agent can take these bookings. The open counts beside it
          were still measured.
        </p>
      )}
      {!bucketListReadable && (
        <p className="mb-4 rounded-md border border-border bg-[var(--bg-alt)] px-4 py-3 text-sm text-fg-muted">
          The bucket list could not be read, so these rows come from the slot cache alone. A
          bucket that has never been computed will be missing from this table entirely.
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <caption className="sr-only">
            Open appointment starts per debt bucket per day, over what each day could have held.
            Times are {zone}.
          </caption>
          <thead>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-xs text-fg-muted">
              <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                Bucket
              </th>
              <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                Eligible agents
              </th>
              <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                Last computed
              </th>
              {days.map((day) => {
                const d = DateTime.fromISO(day.iso, { zone });
                return (
                  <th key={day.iso} scope="col" className="px-2 py-2.5 font-semibold">
                    <span className="block">{d.toFormat("ccc")}</span>
                    <span className="block font-normal tabular-nums">{d.toFormat("d LLL")}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.label}>
              <tr className="border-b border-border bg-[var(--bg-alt)]">
                <th
                  scope="rowgroup"
                  colSpan={3 + days.length}
                  className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-fg-muted"
                >
                  {group.label}
                </th>
              </tr>
              {group.rows.map((row) => {
                const fresh = freshnessLabel(row.freshness);
                const bucketLabel = `${row.code} ${row.name}`;
                return (
                  <tr key={row.code} className="border-b border-border align-middle last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <span className="block font-semibold tabular-nums text-fg">{row.code}</span>
                      <span className="block text-xs text-fg-muted">{row.name}</span>
                    </th>
                    <td className="px-3 py-2 tabular-nums">
                      <span className={row.depth === null ? "text-fg-muted" : "text-fg"}>
                        {depthLabel(row.depth, row.effectiveDepth)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          row.freshness === "stale" || row.freshness === "unknown"
                            ? "text-error"
                            : "text-fg-muted"
                        }
                        title={fresh.meaning}
                      >
                        {fresh.label}
                      </span>
                    </td>
                    {row.cells.map((cell, i) => {
                      const style = cellStyle(cell);
                      const dayLabel = DateTime.fromISO(days[i].iso, { zone }).toFormat(
                        "cccc d LLLL",
                      );
                      const title = supplyCellTitle(cell, bucketLabel, dayLabel);
                      return (
                        <td key={days[i].iso} className="p-0.5">
                          <span
                            className={`flex h-9 flex-col items-center justify-center rounded text-xs font-semibold tabular-nums ${style.cell}`}
                            title={title}
                          >
                            {cell.kind === "counted" ? (
                              <>
                                <span aria-hidden="true">
                                  {cell.open} / {cell.max}
                                </span>
                                <span aria-hidden="true" className="font-normal">
                                  {sharePercent(cell.share)}%
                                </span>
                              </>
                            ) : (
                              <span aria-hidden="true">{style.mark}</span>
                            )}
                            <span className="sr-only">{title}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
          {groups.length === 0 && (
            <tbody>
              <tr>
                <td
                  colSpan={3 + days.length}
                  className="px-4 py-10 text-center text-sm text-fg-muted"
                >
                  No buckets yet. Create one on the admin page to route bookings.
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
        {SUPPLY_LEGEND.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`flex h-5 w-8 shrink-0 items-center justify-center rounded text-[10px] font-semibold tabular-nums ${t.cell} ${t.swatchExtra ?? ""}`}
            >
              {t.mark}
            </span>
            <span>
              <span className="font-semibold text-fg">{t.label}</span> {t.meaning}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-fg-muted">
        Every number is read from the slot cache the booker itself serves, so this page adds no
        calendar traffic and nothing here is a live check of a calendar. The figure a cell is
        measured against is the same one the booker derives: appointments at the event type&rsquo;s
        interval across the office day, minus anything inside the notice cutoff. Today is{" "}
        {todayLabel}.
      </p>
    </>
  );
}

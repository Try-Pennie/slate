import { DateTime } from "luxon";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { gridTotals, type AvailabilityGrid } from "@/lib/admin/availability-grid";
import { CELL_TREATMENTS, cellTitle, treatmentFor } from "@/lib/admin/availability-grid-copy";

/**
 * The availability grid's table and its key (#1302).
 *
 * A component rather than markup inside the page so the rendering can be driven
 * by a test: the grid's visible content is one letter per cell, so the sentence
 * behind each letter IS the content, and a static check on the builder cannot
 * prove the sentence reaches the screen.
 */
export function AvailabilityGridTable({ grid }: { grid: AvailabilityGrid }) {
  const totals = gridTotals(grid);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="text-fg-muted">
          <span className="font-semibold tabular-nums text-fg">{totals.open}</span> bookable hours
        </span>
        <span className={totals.unrostered > 0 ? "text-error" : "text-fg-muted"}>
          <span className="font-semibold tabular-nums">{totals.unrostered}</span> with nobody rostered
        </span>
        <span className="text-fg-muted">
          <span className="font-semibold tabular-nums">{totals.away}</span> with everyone away
        </span>
        <span className="text-fg-muted">
          <span className="font-semibold tabular-nums">{totals.booked}</span> staffed but full
        </span>
        <span className="text-fg-muted">
          <span className="font-semibold tabular-nums">{totals["beyond-horizon"]}</span> past the horizon
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Bookable availability by day and hour. Each cell says whether a lead could
            book that hour and, if not, why.
          </caption>
          <thead>
            <tr className="border-b border-border bg-[var(--bg-alt)] text-xs text-fg-muted">
              <th scope="col" className="px-3 py-2.5 text-left font-semibold">
                Hour
              </th>
              {grid.days.map((day) => {
                const d = DateTime.fromISO(day.iso, { zone: BUSINESS_ZONE });
                return (
                  <th key={day.iso} scope="col" className="px-2 py-2.5 font-semibold">
                    <span className="block">{d.toFormat("ccc")}</span>
                    <span className="block font-normal tabular-nums">{d.toFormat("d LLL")}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {grid.hours.map((hour, hourIndex) => (
              <tr key={hour} className="border-b border-border last:border-0">
                <th
                  scope="row"
                  className="whitespace-nowrap px-3 py-1.5 text-left font-normal tabular-nums text-fg-muted"
                >
                  {String(hour).padStart(2, "0")}:00
                </th>
                {grid.days.map((day) => {
                  const cell = day.cells[hourIndex];
                  const style = treatmentFor(cell.kind);
                  const dayLabel = DateTime.fromISO(day.iso, { zone: BUSINESS_ZONE }).toFormat(
                    "cccc d LLLL",
                  );
                  const title = cellTitle(cell, dayLabel, hour);
                  return (
                    <td key={day.iso} className="p-0.5">
                      <span
                        className={`flex h-7 items-center justify-center rounded text-xs font-semibold tabular-nums ${style.cell}`}
                        title={title}
                      >
                        <span aria-hidden="true">{style.mark}</span>
                        <span className="sr-only">{title}</span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
        {CELL_TREATMENTS.map((t) => (
          <li key={t.kind} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-semibold ${t.cell} ${t.swatchExtra ?? ""}`}
            >
              {t.mark}
            </span>
            <span>
              <span className="font-semibold text-fg">{t.label}</span> {t.meaning}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

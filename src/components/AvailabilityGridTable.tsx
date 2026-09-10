import { DateTime } from "luxon";
import { formatLongDate } from "@/lib/date/parse";
import { BUSINESS_ZONE } from "@/lib/booking/business-hours";
import { gridTotals, type AvailabilityGrid } from "@/lib/admin/availability-grid";
import { CELL_TREATMENTS, cellTitle, treatmentFor } from "@/lib/admin/availability-grid-copy";
import { LegendList } from "@/components/ui/LegendList";

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
  // The states this grid actually holds, in the treatments' own order. An empty
  // grid leaves this empty, and both the strip and the key then draw nothing,
  // which is right: the grid has its own empty state and a key explaining
  // nothing would sit under it saying so twice.
  const present = CELL_TREATMENTS.filter((t) => totals[t.kind] > 0);

  return (
    <>
      {/* #1928: the strip and the key below are both DERIVED from
          CELL_TREATMENTS, filtered to the states actually present. Dan: "what if
          we only show the values that matter? Like nothing right now is ? or A
          so we don't need to show those at all."

          It also settles something already wrong. These were two hand written
          lists of the same seven states with different words for each, a
          different order, and two kinds missing from the strip whatever their
          count. One of the missing two was `unknown`, the could-not-measure
          state, so a grid whose hours could not be read said nothing about them
          in the summary somebody reads first.

          A key that changes with the data cannot be learned by heart, and that
          does not matter here: a state and its key entry appear together, so
          nobody meets an unexplained letter. The letter arriving is exactly what
          puts its explanation back. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        {present.map((t) => (
          <span key={t.kind} className={t.urgent ? "text-error" : "text-fg-muted"}>
            <span className="font-semibold tabular-nums text-fg">{totals[t.kind]}</span>{" "}
            {t.strip}
          </span>
        ))}
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
                  const dayLabel =
                    formatLongDate(DateTime.fromISO(day.iso, { zone: BUSINESS_ZONE })) ?? day.iso;
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

      <LegendList
        entries={present.map((t) => ({
          id: t.kind,
          mark: t.mark,
          label: t.label,
          meaning: t.meaning,
          cell: t.cell,
          swatchExtra: t.swatchExtra,
        }))}
      />
    </>
  );
}

import { DateTime } from "luxon";

/**
 * One day's column header: the weekday over the date (#2561).
 *
 * The availability grid (`AvailabilityGridTable`) and the bucket supply table
 * both head their day columns this way, and each had written the markup out for
 * itself. Two copies of one header is two chances for one table's dates to start
 * reading differently from the other's, and neither component's own test could
 * ever notice, because each is right about itself (L613).
 *
 * The two tables genuinely differ in their COLUMN SPACING and in their leading
 * border, so `className` is the caller's, and the geometry stays where it is
 * decided. What is shared is what the reader actually reads: the weekday, the
 * date under it, the tabular figures that let a row of dates line up, and the
 * `scope="col"` that ties every cell beneath to the day it belongs to.
 *
 * `iso` is a DATE (`2026-09-18`), not an instant, and `zone` is the zone that
 * date is a date IN: the grid works in the business zone and the supply table in
 * whichever zone it was asked to report. Routing a bare date through the
 * machine's own zone renders the day before whenever the two disagree.
 */
export function DayHeaderCell({
  iso,
  zone,
  className,
}: {
  iso: string;
  zone: string;
  className: string;
}) {
  const d = DateTime.fromISO(iso, { zone });
  return (
    <th scope="col" className={className}>
      <span className="block">{d.toFormat("ccc")}</span>
      <span className="block font-normal tabular-nums">{d.toFormat("d LLL")}</span>
    </th>
  );
}

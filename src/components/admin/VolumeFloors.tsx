/**
 * The low volume floors on /admin/alerts (#1956).
 *
 * The floors are MEASURED, so the section leads with the measurement: where it came
 * from, when, and whose traffic it was fitted to. The number a person used to type
 * is gone as the primary input. What remains is an override, and it reads as one:
 * blank means the measurement, and a value names what it replaced.
 *
 * The short window gets its own table only when it fires at some judged hour. On
 * thin traffic its measured floor is zero everywhere, and a grid of zeros would
 * state one fact thirty times (L605), so that case is one sentence instead.
 */
import type { FloorOverride, VolumeBaseline } from "@/lib/monitor/volume-floors";
import { hourLabel, type FloorTable } from "@/lib/admin/volume-floor-table";
import { inputCls, labelCls } from "@/components/ui/styles";

const SOURCE_NAME: Record<VolumeBaseline["source"], string> = {
  calcom: "cal.com",
  slate: "Slate",
};

/** A YYYY-MM-DD date as "Sep 25, 2026", read as a date rather than as UTC midnight. */
function day(iso: string, withYear = false): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

const ZONE_NAME: Record<string, string> = { "America/New_York": "Eastern time" };

function overrideLine(o: FloorOverride | null): string | null {
  if (!o) return null;
  return o.origin === "stored"
    ? `${o.value} at every hour, in place of the measurement`
    : `${o.value} at every hour, set in the deployment's settings, in place of the measurement`;
}

export function VolumeFloors({
  baseline,
  table,
  weekReadable,
  override30,
  override120,
  stored30,
  stored120,
}: {
  baseline: VolumeBaseline;
  table: FloorTable;
  /** False when the org's week could not be read, so every hour is shown. */
  weekReadable: boolean;
  override30: FloorOverride | null;
  override120: FloorOverride | null;
  stored30: number | null;
  stored120: number | null;
}) {
  const zone = ZONE_NAME[baseline.zone] ?? baseline.zone;
  const share =
    baseline.tierShare === null ? "" : ` (${Math.round(baseline.tierShare * 100)}% of that tier's bookings)`;
  const overrides: [string, string, FloorOverride | null, number | null][] = [
    ["floor_30", "Last 30 minutes", override30, stored30],
    ["floor_120", "Last 2 hours", override120, stored120],
  ];
  return (
    <>
      <h2 className="mb-1 text-sm font-semibold">Low volume floors</h2>
      <p className="text-xs text-fg-muted" data-floor-provenance>
        Measured from {SOURCE_NAME[baseline.source]} on {day(baseline.measuredOn, true)}:{" "}
        <span className="tabular-nums">{baseline.bookings.toLocaleString("en-US")}</span> bookings from{" "}
        {day(baseline.fromDate)} to {day(baseline.toDate)}. {baseline.scope}
        {share}.
      </p>
      {!weekReadable && (
        <p className="mt-2 text-xs text-fg" role="status">
          The business week could not be read, so every day and hour is shown, including ones the
          alarm never judges.
        </p>
      )}

      <FloorGrid
        caption={`Fewest bookings in the last 2 hours before the alarm pages, by the hour it checks (${zone})`}
        hours={table.hours}
        rows={table.rows.map((r) => ({
          weekday: r.weekday,
          label: r.label,
          cells: r.cells.map((c) => ({ hour: c.hour, value: c.floor120, typical: c.typical120 })),
        }))}
        name="120"
      />
      {table.shortRows === null ? (
        <p className="mt-2 text-xs text-fg-muted" data-short-window-silent>
          Over the last 30 minutes this traffic is too thin to judge: its measured floor is 0 at every hour.
        </p>
      ) : (
        <FloorGrid
          caption={`Fewest bookings in the last 30 minutes before the alarm pages (${zone})`}
          hours={table.hours}
          rows={table.shortRows.map((r) => ({
            weekday: r.weekday,
            label: r.label,
            cells: r.floors.map((f, i) => ({ hour: table.hours[i]!, value: f, typical: null })),
          }))}
          name="30"
        />
      )}

      <h3 className="mt-5 text-sm font-semibold text-fg">Override</h3>
      <div className="mt-2 flex flex-wrap gap-6">
        {overrides.map(([name, label, o, stored]) => (
          <div key={name}>
            <label className={labelCls} htmlFor={name}>
              {label}
            </label>
            <input
              id={name}
              name={name}
              type="number"
              min={0}
              inputMode="numeric"
              defaultValue={stored ?? ""}
              placeholder="measured"
              aria-describedby={`${name}_state`}
              className={`${inputCls} w-40 tabular-nums`}
            />
            <p id={`${name}_state`} className="mt-1 text-xs text-fg-muted" data-floor-override={name}>
              {overrideLine(o) ?? "Using the measured floors"}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function FloorGrid({
  caption,
  hours,
  rows,
  name,
}: {
  caption: string;
  hours: number[];
  rows: { weekday: number; label: string; cells: { hour: number; value: number | null; typical: number | null }[] }[];
  name: string;
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[640px] text-xs" data-floor-table={name}>
        <caption className="px-3 pt-2.5 pb-1 text-left text-xs text-fg-muted">{caption}</caption>
        <thead>
          <tr className="border-b border-border bg-[var(--bg-alt)] text-fg-muted">
            <th scope="col" className="px-3 py-2 text-left font-semibold">
              <span className="sr-only">Day</span>
            </th>
            {hours.map((h) => (
              <th key={h} scope="col" className="px-1.5 py-2 text-right font-semibold tabular-nums">
                {hourLabel(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.weekday}>
              <th scope="row" className="px-3 py-1.5 text-left font-semibold text-fg">
                {row.label}
              </th>
              {row.cells.map((c) => (
                <td
                  key={c.hour}
                  className="px-1.5 py-1.5 text-right tabular-nums text-fg"
                  title={c.typical === null ? undefined : `usually ${c.typical}`}
                >
                  {c.value === null ? (
                    <span className="sr-only">closed</span>
                  ) : (
                    <>
                      {c.value}
                      {c.typical !== null && <span className="sr-only">{`, usually ${c.typical}`}</span>}
                    </>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

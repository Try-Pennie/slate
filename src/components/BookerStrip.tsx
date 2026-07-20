"use client";
import { DateTime } from "luxon";
import { stripDayLabel, bookerWeekDays, isStripDayEnabled } from "./booker-strip-labels";

export function BookerStrip({
  today, availableDays, activeDay, zone, onSelect,
}: {
  today: DateTime;
  availableDays: string[];
  activeDay: string | null;
  zone: string;
  onSelect: (iso: string) => void;
}) {
  const week = bookerWeekDays(today);
  const anyEnabled = week.some((iso) => isStripDayEnabled(iso, availableDays, zone));

  // #261: with no bookable day in the window, showing a row of seven greyed,
  // disabled chips plus a message read oddly and duplicated the times panel's own
  // "All times are taken right now. Check back soon." So the strip renders nothing
  // here and lets the times panel own the single empty affordance.
  if (!anyEnabled) return null;

  return (
    <div role="group" aria-label="Available days" className="flex gap-2 overflow-x-auto">
      {week.map((iso) => {
        const d = DateTime.fromISO(iso, { zone });
        const enabled = isStripDayEnabled(iso, availableDays, zone);
        const selected = iso === activeDay;
        return (
          <button
            key={iso}
            type="button"
            disabled={!enabled}
            aria-pressed={enabled ? selected : undefined}
            onClick={enabled ? () => onSelect(iso) : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center rounded-lg border px-3 py-2 tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky motion-reduce:transition-none ${
              !enabled
                ? "cursor-not-allowed border-border opacity-40"
                : selected
                  ? "border-pennie-sky bg-pennie-sky text-pennie-graphite"
                  : "border-border text-fg hover:border-pennie-sky"
            }`}
          >
            <span className="text-[11px] uppercase tracking-wide opacity-70">
              {stripDayLabel(iso, today, zone)}
            </span>
            <span className="text-lg font-semibold">{d.toFormat("d")}</span>
          </button>
        );
      })}
    </div>
  );
}

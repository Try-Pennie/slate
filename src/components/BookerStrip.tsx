"use client";
import { DateTime } from "luxon";
import { stripDayLabel } from "./booker-strip-labels";

export function BookerStrip({
  today, availableDays, activeDay, zone, onSelect,
}: {
  today: DateTime;
  availableDays: string[];
  activeDay: string | null;
  zone: string;
  onSelect: (iso: string) => void;
}) {
  return (
    <div role="group" aria-label="Available days" className="flex gap-2 overflow-x-auto">
      {availableDays.length === 0 ? (
        <p className="text-sm text-fg-muted">No times available in the next few days.</p>
      ) : (
        availableDays.map((iso) => {
          const d = DateTime.fromISO(iso, { zone });
          const selected = iso === activeDay;
          return (
            <button
              key={iso}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(iso)}
              className={`flex min-h-11 flex-1 flex-col items-center rounded-lg border px-3 py-2 tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky motion-reduce:transition-none ${
                selected
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
        })
      )}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * Pennie-branded date picker: a field-styled trigger that opens a month-grid
 * popover (matching the Booker's calendar language — sky-soft days, sky fill on
 * the selected day). Selection is bounded by `min`/`max` (full calendar years);
 * out-of-range days and month navigation past the bounds are disabled. Submits
 * its value through a hidden input named `name`, so it drops into the existing
 * server-action form unchanged. The companion `<input type="time">` stays
 * native — this only replaces the calendar.
 */
export function DateField({
  name,
  defaultValue,
  min,
  max,
  todayISO,
  ariaLabel,
}: {
  name: string;
  defaultValue?: string;
  min: string;
  max: string;
  todayISO: string;
  ariaLabel: string;
}) {
  const minD = DateTime.fromISO(min).startOf("day");
  const maxD = DateTime.fromISO(max).startOf("day");
  const today = DateTime.fromISO(todayISO).startOf("day");

  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const selected = value ? DateTime.fromISO(value).startOf("day") : null;
  const [view, setView] = useState(() =>
    (selected ?? today).startOf("month"),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Move focus into the grid so keyboard users land on the days.
    gridRef.current?.querySelector<HTMLButtonElement>(
      'button[data-current="true"]',
    )?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const inRange = (d: DateTime) => d >= minD && d <= maxD;
  const canPrev = view.startOf("month") > minD.startOf("month");
  const canNext = view.endOf("month") < maxD.endOf("month");

  const start = view.startOf("month");
  const lead = start.weekday % 7; // Luxon: 1=Mon..7=Sun -> Sunday-first column
  const cells: (DateTime | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= start.daysInMonth!; d++) cells.push(start.set({ day: d }));

  const pick = (d: DateTime) => {
    setValue(d.toISODate()!);
    setOpen(false);
  };

  const triggerLabel = selected
    ? selected.toFormat("LLL d, yyyy")
    : "Select a date";

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-[44px] w-44 items-center gap-2 rounded-sm border border-border bg-surface px-3 text-left text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky ${
          selected ? "" : "text-fg-muted"
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-4 w-4 shrink-0 text-fg-muted"
        >
          <rect x="2" y="3" width="12" height="11" rx="2" />
          <path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
        </svg>
        <span className="truncate text-sm tabular-nums">{triggerLabel}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-border bg-surface p-3 shadow-pop"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => setView((v) => v.minus({ months: 1 }))}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-fg-muted hover:bg-pennie-sky-soft hover:text-fg disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M10 4L6 8l4 4" />
              </svg>
            </button>
            <span id={labelId} className="text-sm font-semibold text-fg">
              {view.toFormat("LLLL yyyy")}
            </span>
            <button
              type="button"
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => setView((v) => v.plus({ months: 1 }))}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-fg-muted hover:bg-pennie-sky-soft hover:text-fg disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-semibold text-fg-muted">
            {WEEKDAYS.map((w, i) => (
              <span key={i} className="py-1">
                {w}
              </span>
            ))}
          </div>

          <div ref={gridRef} className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (!d) return <span key={i} />;
              const iso = d.toISODate();
              const isSelected = selected?.hasSame(d, "day") ?? false;
              const isToday = d.hasSame(today, "day");
              const disabled = !inRange(d);
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={disabled}
                  data-current={isSelected || (!selected && isToday) || undefined}
                  aria-pressed={isSelected}
                  aria-label={d.toFormat("cccc, LLLL d, yyyy")}
                  onClick={() => pick(d)}
                  className={`flex h-9 items-center justify-center rounded-full text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-pennie-sky motion-reduce:transition-none ${
                    disabled
                      ? "cursor-not-allowed text-fg-muted opacity-30"
                      : isSelected
                        ? "bg-pennie-sky font-semibold text-pennie-graphite"
                        : isToday
                          ? "font-semibold text-pennie-blue hover:bg-pennie-sky-soft dark:text-pennie-sky"
                          : "text-fg hover:bg-pennie-sky-soft"
                  }`}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

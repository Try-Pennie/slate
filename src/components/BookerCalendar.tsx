"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * The consumer-facing booking calendar (owned by the Booker embed). A copy of
 * the internal `CalendarMonth` on purpose: the booking embed and the internal
 * tools have different futures (brand color, dual theme, the embed contract),
 * so they are decoupled and free to diverge. Presentation + keyboard only — the
 * Booker owns slot availability and passes per-day state. Full keyboard nav
 * (arrows roll across weeks/months, Home/End to week edges, PageUp/PageDown
 * change month) via roving tabindex; days with no slots use `aria-disabled` so
 * they stay focusable but can't be picked. The selected day takes a sky fill,
 * or `selectedStyle` for a host brand color; today shows a dot (`todayDotStyle`
 * for a brand color).
 */
export function BookerCalendar({
  month,
  today,
  onMonthChange,
  canPrev,
  canNext,
  isSelected,
  isDisabled,
  onSelect,
  selectedStyle,
  todayDotStyle,
}: {
  month: DateTime;
  today: DateTime;
  onMonthChange: (m: DateTime) => void;
  canPrev: boolean;
  canNext: boolean;
  isSelected: (d: DateTime) => boolean;
  isDisabled: (d: DateTime) => boolean;
  onSelect: (d: DateTime) => void;
  selectedStyle?: CSSProperties;
  todayDotStyle?: CSSProperties;
}) {
  const start = month.startOf("month");
  const lead = start.weekday % 7; // Luxon: 1=Mon..7=Sun -> Sunday-first column
  const cells: (DateTime | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= start.daysInMonth!; d++) cells.push(start.set({ day: d }));

  // Roving focus: only one day cell is tabbable; arrows move it. `focusKey` is
  // the user's last-arrowed day; when the visible month changes out from under
  // it, derive a valid in-month cell for rendering rather than writing state in
  // an effect.
  const [focusKey, setFocusKey] = useState<string>(
    () => (today.hasSame(start, "month") ? today : start).toISODate()!,
  );
  const wantFocus = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const focusDate = DateTime.fromISO(focusKey);
  const effectiveFocusKey =
    focusDate.isValid && focusDate.hasSame(start, "month")
      ? focusKey
      : (today.hasSame(start, "month") ? today : start).toISODate()!;

  // After an arrow key, move real focus to the newly roving cell.
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-key="${effectiveFocusKey}"]`)
      ?.focus();
  }, [effectiveFocusKey]);

  const moveTo = (next: DateTime) => {
    wantFocus.current = true;
    if (!next.hasSame(start, "month")) onMonthChange(next.startOf("month"));
    setFocusKey(next.toISODate()!);
  };

  const onGridKey = (e: React.KeyboardEvent, d: DateTime) => {
    let next: DateTime | null = null;
    switch (e.key) {
      case "ArrowLeft": next = d.minus({ days: 1 }); break;
      case "ArrowRight": next = d.plus({ days: 1 }); break;
      case "ArrowUp": next = d.minus({ weeks: 1 }); break;
      case "ArrowDown": next = d.plus({ weeks: 1 }); break;
      case "Home": next = d.startOf("week"); break;
      case "End": next = d.endOf("week"); break;
      case "PageUp": next = d.minus({ months: 1 }); break;
      case "PageDown": next = d.plus({ months: 1 }); break;
      default: return;
    }
    e.preventDefault();
    moveTo(next);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!canPrev}
          onClick={() => onMonthChange(month.minus({ months: 1 }))}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-fg-muted hover:bg-pennie-sky-soft hover:text-fg disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M10 4L6 8l4 4" />
          </svg>
        </button>
        <span className="text-sm font-semibold text-fg">
          {month.toFormat("LLLL yyyy")}
        </span>
        <button
          type="button"
          aria-label="Next month"
          disabled={!canNext}
          onClick={() => onMonthChange(month.plus({ months: 1 }))}
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
          if (!d) return <span key={`b${i}`} />;
          const iso = d.toISODate()!;
          const selected = isSelected(d);
          const disabled = isDisabled(d);
          const isToday = d.hasSame(today, "day");
          return (
            <button
              key={iso}
              type="button"
              data-key={iso}
              tabIndex={iso === effectiveFocusKey ? 0 : -1}
              aria-disabled={disabled || undefined}
              aria-pressed={selected}
              aria-current={isToday ? "date" : undefined}
              aria-label={d.toFormat("cccc, LLLL d, yyyy")}
              style={selected ? selectedStyle : undefined}
              onClick={() => {
                if (!disabled) onSelect(d);
              }}
              onKeyDown={(e) => onGridKey(e, d)}
              className={`relative flex min-h-11 items-center justify-center rounded-full text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-pennie-sky motion-reduce:transition-none ${
                disabled
                  ? "cursor-not-allowed text-fg-muted opacity-30"
                  : selected
                    ? "bg-pennie-sky font-semibold text-pennie-graphite"
                    : "text-fg hover:bg-pennie-sky-soft"
              }`}
            >
              {d.day}
              {isToday && !selected && (
                <span
                  aria-hidden="true"
                  style={todayDotStyle}
                  className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-pennie-green"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

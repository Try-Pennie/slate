"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";
import { parseTypedDate } from "@/lib/date/parse";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DISPLAY = "LLL d, yyyy"; // "Jun 20, 2026"

/**
 * Pennie-branded date picker with a typeable text box. Type a date
 * (m/d/yyyy, "Jun 20 2026", or ISO) and the calendar jumps to that month with
 * the day selected; or click the calendar icon and pick. The popover matches
 * the Booker's calendar language (sky-soft days, sky fill on the selected day).
 * Selection is bounded by `min`/`max`; out-of-range days and month navigation
 * past the bounds are disabled. Submits the ISO date through a hidden input, so
 * it drops into the existing server-action form unchanged.
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
  const initial = defaultValue
    ? DateTime.fromISO(defaultValue).startOf("day")
    : null;

  const [value, setValue] = useState(defaultValue ?? ""); // ISO yyyy-MM-dd or ""
  const [text, setText] = useState(initial ? initial.toFormat(DISPLAY) : "");
  const [open, setOpen] = useState(false);
  const selected = value ? DateTime.fromISO(value).startOf("day") : null;
  const [view, setView] = useState(() => (selected ?? today).startOf("month"));

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const dialogId = `${labelId}-dialog`;

  const inRange = (d: DateTime) => d >= minD && d <= maxD;

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
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Pick a day (click or typed-then-Enter): set value + normalize the text box.
  const commit = (d: DateTime) => {
    setValue(d.toISODate()!);
    setText(d.toFormat(DISPLAY));
    setView(d.startOf("month"));
    setOpen(false);
  };

  // Live as the user types: jump the calendar to a valid in-range date.
  const onType = (raw: string) => {
    setText(raw);
    if (raw.trim() === "") {
      setValue("");
      return;
    }
    const d = parseTypedDate(raw);
    if (d && inRange(d)) {
      setValue(d.toISODate()!);
      setView(d.startOf("month"));
      setOpen(true);
    }
  };

  // On blur, settle the text box: canonicalize a valid entry, clear an empty
  // one, or revert garbage back to the last good value.
  const onBlur = () => {
    const d = parseTypedDate(text);
    if (d && inRange(d)) {
      setValue(d.toISODate()!);
      setText(d.toFormat(DISPLAY));
    } else if (text.trim() === "") {
      setValue("");
    } else {
      setText(value ? DateTime.fromISO(value).toFormat(DISPLAY) : "");
    }
  };

  const start = view.startOf("month");
  const lead = start.weekday % 7; // Luxon: 1=Mon..7=Sun -> Sunday-first column
  const cells: (DateTime | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= start.daysInMonth!; d++) cells.push(start.set({ day: d }));

  const canPrev = view.startOf("month") > minD.startOf("month");
  const canNext = view.endOf("month") < maxD.endOf("month");

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={dialogId}
          aria-haspopup="dialog"
          autoComplete="off"
          placeholder="mm/dd/yyyy"
          value={text}
          onChange={(e) => onType(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") {
              const d = parseTypedDate(text);
              if (d && inRange(d)) {
                e.preventDefault();
                commit(d);
              }
            }
          }}
          className="h-[44px] w-44 rounded-sm border border-border bg-surface pl-3 pr-9 text-sm text-fg tabular-nums placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
        />
        <button
          type="button"
          aria-label={open ? "Close calendar" : "Open calendar"}
          onClick={() => {
            setOpen((o) => !o);
            inputRef.current?.focus();
          }}
          className="absolute right-0 top-0 flex h-[44px] w-9 items-center justify-center text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-4 w-4"
          >
            <rect x="2" y="3" width="12" height="11" rx="2" />
            <path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          id={dialogId}
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

          <div className="grid grid-cols-7 gap-0.5">
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
                  aria-pressed={isSelected}
                  aria-label={d.toFormat("cccc, LLLL d, yyyy")}
                  onClick={() => commit(d)}
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

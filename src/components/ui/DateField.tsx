"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";
import { dateFromParts, parseTypedDate } from "@/lib/date/parse";
import { CalendarMonth } from "@/components/ui/CalendarMonth";

const pad = (n: number, len: number) => String(n).padStart(len, "0");

/**
 * Pennie-branded date picker with a segmented MM / DD / YYYY entry. Each segment
 * accepts only digits and a fixed width, auto-advancing (and Tab moves) to the
 * next; so you can't type nonsense and partial input is never lost. The month
 * stays a number while typing (the calendar header carries the month word), and
 * the calendar only highlights a day once all three segments form a real,
 * in-range date. Click the calendar icon to pick instead. Submits the ISO date
 * through a hidden input, so it drops into the existing form unchanged.
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

  const [mm, setMm] = useState(initial ? pad(initial.month, 2) : "");
  const [dd, setDd] = useState(initial ? pad(initial.day, 2) : "");
  const [yyyy, setYyyy] = useState(initial ? String(initial.year) : "");
  const [open, setOpen] = useState(false);

  const inRange = (d: DateTime) => d >= minD && d <= maxD;
  const parsed = dateFromParts(mm, dd, yyyy);
  const value = parsed && inRange(parsed) ? parsed.toISODate()! : "";
  const selected = value ? parsed : null;
  const [view, setView] = useState(() => (selected ?? today).startOf("month"));

  const rootRef = useRef<HTMLDivElement>(null);
  const mmRef = useRef<HTMLInputElement>(null);
  const ddRef = useRef<HTMLInputElement>(null);
  const yyRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const dialogId = `${labelId}-dialog`;

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

  // Fill all three segments at once (calendar click or paste).
  const fillFrom = (d: DateTime) => {
    setMm(pad(d.month, 2));
    setDd(pad(d.day, 2));
    setYyyy(String(d.year));
    setView(d.startOf("month"));
  };
  const commit = (d: DateTime) => {
    fillFrom(d);
    setOpen(false);
  };

  const handleSeg = (
    key: "mm" | "dd" | "yyyy",
    raw: string,
    nextRef: RefObject<HTMLInputElement | null> | null,
  ) => {
    let digits = raw.replace(/\D/g, "").slice(0, key === "yyyy" ? 4 : 2);
    let advance = false;
    if (key === "yyyy") {
      advance = false;
    } else {
      // A leading 2+ (month) or 4+ (day) can only be a single-digit value, so
      // pad it and move on, mirroring native date fields.
      if (digits.length === 1 && Number(digits) >= (key === "mm" ? 2 : 4)) {
        digits = `0${digits}`;
      }
      advance = digits.length === 2;
    }
    const next = { mm, dd, yyyy, [key]: digits };
    if (key === "mm") setMm(digits);
    else if (key === "dd") setDd(digits);
    else setYyyy(digits);

    const d = dateFromParts(next.mm, next.dd, next.yyyy);
    if (d && inRange(d)) setView(d.startOf("month"));
    if (advance) nextRef?.current?.focus();
  };

  const segKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    prevRef: RefObject<HTMLInputElement | null> | null,
    nextRef: RefObject<HTMLInputElement | null> | null,
  ) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "Backspace" && e.currentTarget.value === "" && prevRef) {
      e.preventDefault();
      prevRef.current?.focus();
    } else if (e.key === "/" && nextRef) {
      e.preventDefault();
      nextRef.current?.focus();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const d = parseTypedDate(e.clipboardData.getData("text"));
    if (d && inRange(d)) {
      e.preventDefault();
      fillFrom(d);
    }
  };

  const canPrev = view.startOf("month") > minD.startOf("month");
  const canNext = view.endOf("month") < maxD.endOf("month");

  const segCls =
    "bg-transparent text-center text-sm tabular-nums text-fg outline-none placeholder:text-fg-muted";

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={name} value={value} />
      <div
        role="group"
        aria-label={ariaLabel}
        onPaste={onPaste}
        className="flex h-[44px] w-44 items-center rounded-sm border border-border bg-surface pl-2 pr-1 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-pennie-sky"
      >
        <input
          ref={mmRef}
          inputMode="numeric"
          aria-label={`${ariaLabel}, month`}
          placeholder="MM"
          value={mm}
          onFocus={() => setOpen(true)}
          onChange={(e) => handleSeg("mm", e.target.value, ddRef)}
          onKeyDown={(e) => segKeyDown(e, null, ddRef)}
          className={`w-[2.5ch] ${segCls}`}
        />
        <span className="text-fg-muted">/</span>
        <input
          ref={ddRef}
          inputMode="numeric"
          aria-label={`${ariaLabel}, day`}
          placeholder="DD"
          value={dd}
          onFocus={() => setOpen(true)}
          onChange={(e) => handleSeg("dd", e.target.value, yyRef)}
          onKeyDown={(e) => segKeyDown(e, mmRef, yyRef)}
          className={`w-[2.5ch] ${segCls}`}
        />
        <span className="text-fg-muted">/</span>
        <input
          ref={yyRef}
          inputMode="numeric"
          aria-label={`${ariaLabel}, year`}
          placeholder="YYYY"
          value={yyyy}
          onFocus={() => setOpen(true)}
          onChange={(e) => handleSeg("yyyy", e.target.value, null)}
          onKeyDown={(e) => segKeyDown(e, ddRef, null)}
          className={`w-[4.5ch] ${segCls}`}
        />
        <button
          type="button"
          aria-label={open ? "Close calendar" : "Open calendar"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={dialogId}
          onClick={() => {
            setOpen((o) => !o);
            if (!open) mmRef.current?.focus();
          }}
          className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-pennie-sky"
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
          className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-border bg-surface p-3 shadow-pop"
        >
          <CalendarMonth
            month={view}
            today={today}
            onMonthChange={setView}
            canPrev={canPrev}
            canNext={canNext}
            isSelected={(d) => selected?.hasSame(d, "day") ?? false}
            isDisabled={(d) => !inRange(d)}
            onSelect={commit}
          />
        </div>
      )}
    </div>
  );
}

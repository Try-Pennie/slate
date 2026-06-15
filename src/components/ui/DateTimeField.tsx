"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";
import { dateFromParts } from "@/lib/date/parse";
import { CalendarMonth } from "@/components/ui/CalendarMonth";

const pad = (n: number) => String(n).padStart(2, "0");

function to24(hour12: number, minute: number, ampm: "AM" | "PM"): string {
  if (!hour12) return "";
  let h = hour12 % 12;
  if (ampm === "PM") h += 12;
  return `${pad(h)}:${pad(minute)}`;
}

/**
 * Combined date + time picker (matches the original OOO tool): one field showing
 * "MM / DD / YYYY  h:mm AM" with a calendar icon. The date is typeable in fixed
 * digit segments; the calendar icon opens a popup with the month grid AND the
 * Hour / Minute (quarter-hour) / AM-PM pickers together, plus Cancel / Confirm.
 * Submits the date and time as two hidden inputs (`nameDate` ISO, `nameTime`
 * 24h "HH:MM"), so the existing form/server are unchanged.
 */
export function DateTimeField({
  nameDate,
  nameTime,
  defaultDate,
  defaultTime,
  ariaLabel,
  min,
  max,
  todayISO,
}: {
  nameDate: string;
  nameTime: string;
  defaultDate?: string;
  defaultTime?: string;
  ariaLabel: string;
  min: string;
  max: string;
  todayISO: string;
}) {
  const minD = DateTime.fromISO(min).startOf("day");
  const maxD = DateTime.fromISO(max).startOf("day");
  const today = DateTime.fromISO(todayISO).startOf("day");
  const initDate = defaultDate ? DateTime.fromISO(defaultDate) : null;
  const initTime = defaultTime ? /^(\d{2}):(\d{2})$/.exec(defaultTime) : null;

  const [mm, setMm] = useState(initDate ? pad(initDate.month) : "");
  const [dd, setDd] = useState(initDate ? pad(initDate.day) : "");
  const [yyyy, setYyyy] = useState(initDate ? String(initDate.year) : "");
  const [hour, setHour] = useState(
    initTime ? Number(initTime[1]) % 12 || 12 : 0,
  );
  const [minute, setMinute] = useState(initTime ? Number(initTime[2]) : 0);
  const [ampm, setAmpm] = useState<"AM" | "PM">(
    initTime && Number(initTime[1]) >= 12 ? "PM" : "AM",
  );
  const [open, setOpen] = useState(false);

  const dateObj = dateFromParts(mm, dd, yyyy);
  const dateISO = dateObj ? dateObj.toISODate()! : "";
  const timeHHMM = to24(hour, minute, ampm);
  const inRange = (d: DateTime) => d >= minD && d <= maxD;

  const [view, setView] = useState(() => (dateObj ?? today).startOf("month"));
  const snapshot = useRef<{
    mm: string; dd: string; yyyy: string;
    hour: number; minute: number; ampm: "AM" | "PM";
  } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const mmRef = useRef<HTMLInputElement>(null);
  const ddRef = useRef<HTMLInputElement>(null);
  const yyRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const dialogId = `${labelId}-dialog`;

  const openPopup = () => {
    snapshot.current = { mm, dd, yyyy, hour, minute, ampm };
    if (dateObj) setView(dateObj.startOf("month"));
    setOpen(true);
  };
  const cancel = () => {
    const s = snapshot.current;
    if (s) {
      setMm(s.mm); setDd(s.dd); setYyyy(s.yyyy);
      setHour(s.hour); setMinute(s.minute); setAmpm(s.ampm);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false); // click-away keeps the current selection (like Confirm)
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSeg = (
    key: "mm" | "dd" | "yyyy",
    raw: string,
    nextRef: RefObject<HTMLInputElement | null> | null,
  ) => {
    let digits = raw.replace(/\D/g, "").slice(0, key === "yyyy" ? 4 : 2);
    let advance = false;
    if (key !== "yyyy") {
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
    if (e.key === "Backspace" && e.currentTarget.value === "" && prevRef) {
      e.preventDefault();
      prevRef.current?.focus();
    } else if (e.key === "/" && nextRef) {
      e.preventDefault();
      nextRef.current?.focus();
    }
  };

  const canPrev = view.startOf("month") > minD.startOf("month");
  const canNext = view.endOf("month") < maxD.endOf("month");
  const segCls =
    "bg-transparent text-center text-sm tabular-nums text-fg outline-none placeholder:text-fg-muted";
  const popSel =
    "h-9 rounded-sm border border-border bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky";

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={nameDate} value={dateISO} />
      <input type="hidden" name={nameTime} value={timeHHMM} />

      <div
        role="group"
        aria-label={ariaLabel}
        className="flex h-[44px] w-64 items-center gap-0.5 rounded-sm border border-border bg-surface pl-2 pr-1 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-pennie-sky"
      >
        <input ref={mmRef} inputMode="numeric" aria-label={`${ariaLabel}, month`} placeholder="MM" value={mm}
          onChange={(e) => handleSeg("mm", e.target.value, ddRef)}
          onKeyDown={(e) => segKeyDown(e, null, ddRef)} className={`w-[3ch] ${segCls}`} />
        <span className="text-fg-muted">/</span>
        <input ref={ddRef} inputMode="numeric" aria-label={`${ariaLabel}, day`} placeholder="DD" value={dd}
          onChange={(e) => handleSeg("dd", e.target.value, yyRef)}
          onKeyDown={(e) => segKeyDown(e, mmRef, yyRef)} className={`w-[3ch] ${segCls}`} />
        <span className="text-fg-muted">/</span>
        <input ref={yyRef} inputMode="numeric" aria-label={`${ariaLabel}, year`} placeholder="YYYY" value={yyyy}
          onChange={(e) => handleSeg("yyyy", e.target.value, null)}
          onKeyDown={(e) => segKeyDown(e, ddRef, null)} className={`w-[5ch] ${segCls}`} />

        <button type="button" onClick={open ? cancel : openPopup}
          aria-label={open ? "Close calendar" : "Open calendar and time"}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId}
          className="ml-auto flex items-center gap-1.5 rounded-sm pl-2 pr-1 text-sm text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-pennie-sky">
          <span className={`tabular-nums ${hour ? "text-fg" : "text-fg-muted"}`}>
            {hour ? `${hour}:${pad(minute)} ${ampm}` : "--:-- --"}
          </span>
          <span className="flex h-8 w-7 items-center justify-center text-fg-muted">
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <rect x="2" y="3" width="12" height="11" rx="2" />
              <path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
            </svg>
          </span>
        </button>
      </div>

      {open && (
        <div id={dialogId} role="dialog" aria-label={ariaLabel} aria-modal="true"
          className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-border bg-surface p-3 shadow-pop">
          <CalendarMonth
            month={view}
            today={today}
            onMonthChange={setView}
            canPrev={canPrev}
            canNext={canNext}
            isSelected={(d) => dateObj?.hasSame(d, "day") ?? false}
            isDisabled={(d) => !inRange(d)}
            onSelect={(d) => {
              setMm(pad(d.month));
              setDd(pad(d.day));
              setYyyy(String(d.year));
              setView(d.startOf("month"));
            }}
          />

          <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-3">
            <select aria-label={`${ariaLabel} hour`} value={hour}
              onChange={(e) => setHour(Number(e.target.value))} className={`${popSel} flex-1`}>
              <option value={0}>--</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
            <span aria-hidden="true" className="text-fg-muted">:</span>
            <select aria-label={`${ariaLabel} minute`} value={minute}
              onChange={(e) => setMinute(Number(e.target.value))} className={`${popSel} flex-1`}>
              {[0, 15, 30, 45].map((m) => (
                <option key={m} value={m}>{pad(m)}</option>
              ))}
            </select>
            <select aria-label={`${ariaLabel} AM or PM`} value={ampm}
              onChange={(e) => setAmpm(e.target.value as "AM" | "PM")} className={`${popSel} flex-1`}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={cancel}
              className="rounded-sm border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-fg hover:bg-pennie-sky-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky">
              Cancel
            </button>
            <button type="button" onClick={() => setOpen(false)}
              className="rounded-sm bg-pennie-sky px-3 py-1.5 text-sm font-semibold text-pennie-graphite hover:bg-pennie-sky/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky">
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

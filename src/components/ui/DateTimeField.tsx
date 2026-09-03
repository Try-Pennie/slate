"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { DateTime } from "luxon";
import {
  dateFromParts,
  padTwo as pad,
  snapTimeOfDay,
  timeFrom12Hour,
  twelveHourParts,
} from "@/lib/date/parse";
import { CalendarMonth } from "@/components/ui/CalendarMonth";
import { TimeField } from "@/components/ui/TimeField";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// The conversion, the snapping and the padding used to be written out again here,
// beside their twins in `@/lib/date/parse` (#1765). Two spellings of one rule,
// each tested against itself, is how they came to disagree: the local snap worked
// on a MINUTE, so `ceil(50 / 15)` gave 60, which is not a minute, and it answered
// 45 with the hour left alone. A typed 5:50pm END became 5:45pm.

/**
 * Combined date + time picker (matches the original OOO tool). One field with
 * typeable segments — MM / DD / YYYY  HH : MM AM — and a calendar icon that
 * opens a popup with the month grid AND Hour / Minute / AM-PM pickers plus
 * Cancel / Confirm. Type the time or pick it; minutes snap to a quarter hour.
 * Submits the date and time as two hidden inputs (`nameDate` ISO, `nameTime`
 * 24h "HH:MM"), so the form/server are unchanged.
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
  round = "down",
  hideTime = false,
}: {
  nameDate: string;
  nameTime: string;
  defaultDate?: string;
  defaultTime?: string;
  ariaLabel: string;
  min: string;
  max: string;
  todayISO: string;
  round?: "down" | "up";
  // All-day requests don't need a time — show only the date segments (the
  // hidden time input still submits, but the server overrides it to 00:00/23:59).
  hideTime?: boolean;
}) {
  const minD = DateTime.fromISO(min).startOf("day");
  const maxD = DateTime.fromISO(max).startOf("day");
  const today = DateTime.fromISO(todayISO).startOf("day");
  const initDate = defaultDate ? DateTime.fromISO(defaultDate) : null;
  const initTime = defaultTime ? /^(\d{2}):(\d{2})$/.exec(defaultTime) : null;

  const [mm, setMm] = useState(initDate ? pad(initDate.month) : "");
  const [dd, setDd] = useState(initDate ? pad(initDate.day) : "");
  const [yyyy, setYyyy] = useState(initDate ? String(initDate.year) : "");
  const [hh, setHh] = useState(
    initTime ? pad(Number(initTime[1]) % 12 || 12) : "",
  );
  const [mi, setMi] = useState(initTime ? pad(Number(initTime[2])) : "");
  const [ap, setAp] = useState<"AM" | "PM">(
    initTime && Number(initTime[1]) >= 12 ? "PM" : "AM",
  );
  const [open, setOpen] = useState(false);

  const inRange = (d: DateTime) => d >= minD && d <= maxD;
  const dateObj = dateFromParts(mm, dd, yyyy);
  // Never emit an out-of-range date (e.g. a typed year past the ±2yr cap).
  const dateISO = dateObj && inRange(dateObj) ? dateObj.toISODate()! : "";
  // A non-empty hour of 0 (a lone typed "0", or "00") means 12 o'clock, matching
  // the blur clamp — otherwise to24 would treat it as "no hour" and emit an empty
  // time, so the server rejects "0:MM" until a second digit is typed.
  const hour12 = hh ? Number(hh) || 12 : 0;
  const minute = mi ? Number(mi) : 0;
  const timeHHMM = timeFrom12Hour(hour12, minute, ap);

  const [view, setView] = useState(() => (dateObj ?? today).startOf("month"));
  const snapshot = useRef<{
    mm: string; dd: string; yyyy: string; hh: string; mi: string; ap: "AM" | "PM";
  } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const mmRef = useRef<HTMLInputElement>(null);
  const ddRef = useRef<HTMLInputElement>(null);
  const yyRef = useRef<HTMLInputElement>(null);
  const hhRef = useRef<HTMLInputElement>(null);
  const miRef = useRef<HTMLInputElement>(null);
  const apRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const dialogId = `${labelId}-dialog`;

  const openPopup = () => {
    snapshot.current = { mm, dd, yyyy, hh, mi, ap };
    if (dateObj && inRange(dateObj)) setView(dateObj.startOf("month"));
    setOpen(true);
  };
  const cancel = () => {
    const s = snapshot.current;
    if (s) {
      setMm(s.mm); setDd(s.dd); setYyyy(s.yyyy);
      setHh(s.hh); setMi(s.mi); setAp(s.ap);
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
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

  // High first digit that can only be a single value: pad and move on.
  const HIGH: Record<string, number> = { mm: 2, dd: 4, hh: 2, mi: 6 };
  const setters: Record<string, (v: string) => void> = {
    mm: setMm, dd: setDd, yyyy: setYyyy, hh: setHh, mi: setMi,
  };

  const handleSeg = (
    key: "mm" | "dd" | "yyyy" | "hh" | "mi",
    raw: string,
    nextRef: RefObject<HTMLInputElement | null> | null,
  ) => {
    let digits = raw.replace(/\D/g, "").slice(0, key === "yyyy" ? 4 : 2);
    let advance = false;
    if (key !== "yyyy") {
      if (digits.length === 1 && Number(digits) >= HIGH[key]) digits = `0${digits}`;
      advance = digits.length === 2;
    } else {
      advance = digits.length === 4;
    }
    setters[key](digits);
    if (key === "mm" || key === "dd" || key === "yyyy") {
      const next = { mm, dd, yyyy, [key]: digits };
      const d = dateFromParts(next.mm, next.dd, next.yyyy);
      if (d && inRange(d)) setView(d.startOf("month"));
    }
    if (advance) nextRef?.current?.focus();
  };

  // On blur of any date segment, auto-correct it (the behavior chosen for
  // out-of-range years, extended to the whole date): month → 1..12; year → the
  // ±2yr cap once 4 digits are in; day → the month's real length. When the year
  // isn't a complete 4 digits yet we still clamp the day, using a leap year as
  // the generous bound (so 02/31 → 02/29 immediately), then a non-leap year
  // tightens it to 02/28 once it's typed. A complete-but-out-of-range date is
  // pulled to the nearest bound. The blurred segment is read from the event
  // (fresh) since auto-advance fires blur with stale closure state.
  const normalizeDate = (which: "mm" | "dd" | "yyyy", raw: string) => {
    let m = which === "mm" ? raw : mm;
    let dy = which === "dd" ? raw : dd;
    let y = which === "yyyy" ? raw : yyyy;
    if (m) m = pad(clamp(Number(m) || 1, 1, 12));
    if (y.length === 4) y = String(clamp(Number(y) || minD.year, minD.year, maxD.year));
    else if (y) y = ""; // a 1-3 digit year (e.g. "265") isn't a real year — clear it
    if (m && dy) {
      // Use the typed year if complete, else a leap year (2000) for the max day.
      const yearForDim = y.length === 4 ? Number(y) : 2000;
      const dim = DateTime.fromObject({ year: yearForDim, month: Number(m) }).daysInMonth!;
      dy = pad(clamp(Number(dy) || 1, 1, dim));
    }
    const d = dateFromParts(m, dy, y);
    if (d && !inRange(d)) {
      const c = d < minD ? minD : maxD;
      m = pad(c.month); dy = pad(c.day); y = String(c.year);
    }
    if (m !== mm) setMm(m);
    if (dy !== dd) setDd(dy);
    if (y !== yyyy) setYyyy(y);
    const fd = dateFromParts(m, dy, y);
    if (fd && inRange(fd)) setView(fd.startOf("month"));
  };

  // Up/Down nudges a segment's value (native date-input behavior). The year
  // CLAMPS to the ±2yr cap (never steps onto a bad year); month/day/hour wrap
  // within their range; minute steps by 15. From empty, Up starts at the low
  // end, Down at the high end.
  const bump = (key: "mm" | "dd" | "yyyy" | "hh" | "mi", dir: 1 | -1) => {
    if (key === "yyyy") {
      const next = clamp((yyyy ? Number(yyyy) : today.year) + dir, minD.year, maxD.year);
      setYyyy(String(next));
      const d = dateFromParts(mm, dd, String(next));
      if (d && inRange(d)) setView(d.startOf("month"));
      return;
    }
    if (key === "mi") {
      // Arrow keys step WITHIN the hour on purpose: the segment being nudged is
      // the minute, and carrying into the hour from an arrow press would move a
      // segment the person is not on. Rounding a typed value is the other
      // question, and it is answered by `snapWholeTime` below.
      const steps = [0, 15, 30, 45];
      const idx = (Math.floor((mi ? Number(mi) : 0) / 15) + dir + 4) % 4;
      setMi(pad(steps[idx]));
      return;
    }
    const [lo, hi] = key === "dd" ? [1, 31] : [1, 12]; // mm, hh both 1..12
    const cur = key === "mm" ? mm : key === "dd" ? dd : hh;
    let n = (cur ? Number(cur) : dir > 0 ? lo - 1 : hi + 1) + dir;
    if (n > hi) n = lo;
    if (n < lo) n = hi;
    const val = pad(n);
    setters[key](val);
    if (key === "mm" || key === "dd") {
      const d = dateFromParts(key === "mm" ? val : mm, key === "dd" ? val : dd, yyyy);
      if (d && inRange(d)) setView(d.startOf("month"));
    }
  };

  /** Write a 24 hour "HH:MM" back into the three segments, or clear them. */
  const writeTime = (hhmm: string) => {
    const parts = twelveHourParts(hhmm);
    if (!parts) {
      setHh("");
      setMi("");
      return;
    }
    setHh(pad(parts.hour12));
    setMi(pad(parts.minute));
    setAp(parts.ampm);
  };

  /**
   * Snap what was typed into the minute segment, as a WHOLE time.
   *
   * The minute cannot be snapped on its own: an END time at :50 rounds up to the
   * next hour, and answering :45 shortens a window the person asked for. So the
   * three segments are converted out, rounded by the shared rule, and written
   * back, which is why this can change the hour and the meridiem too.
   */
  const snapWholeTime = (typed: string) => {
    if (!typed) {
      setMi("");
      return;
    }
    const minuteTyped = clamp(Number(typed) || 0, 0, 59);
    const whole = timeFrom12Hour(hour12 || 12, minuteTyped, ap);
    writeTime(snapTimeOfDay(whole, round));
  };

  const segKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    key: "mm" | "dd" | "yyyy" | "hh" | "mi",
    value: string,
    prevRef: RefObject<HTMLInputElement | null> | null,
    nextRef: RefObject<HTMLInputElement | null> | null,
  ) => {
    if (e.key === "Backspace" && value === "" && prevRef) {
      e.preventDefault();
      prevRef.current?.focus();
    } else if (((e.key === "/" || e.key === ":") || e.key === "ArrowRight") && nextRef) {
      e.preventDefault();
      nextRef.current?.focus();
    } else if (e.key === "ArrowLeft" && prevRef) {
      e.preventDefault();
      prevRef.current?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      bump(key, e.key === "ArrowUp" ? 1 : -1);
    }
  };

  // Clicking the field's padding or a separator (not a segment box or the icon
  // button) should still drop the cursor into a segment ready to type, like the
  // original OOO tool. Focus the first empty segment, else the month.
  const focusFirstEmpty = () => {
    const order: Array<[string, RefObject<HTMLInputElement | null>]> = [
      [mm, mmRef], [dd, ddRef], [yyyy, yyRef], [hh, hhRef], [mi, miRef],
    ];
    (order.find(([v]) => !v)?.[1] ?? mmRef).current?.focus();
  };

  // Focusing a filled segment selects its contents, so the next keystroke
  // replaces the whole value (start fresh) instead of editing one digit.
  const selectOnFocus = (e: React.FocusEvent<HTMLInputElement>) =>
    e.currentTarget.select();
  // Keep segments atomic: a click or drag can never select just part of the
  // value — every mouse-up re-selects the whole segment.
  const selectWholeOnMouseUp = (e: React.MouseEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.currentTarget.select();
  };

  const canPrev = view.startOf("month") > minD.startOf("month");
  const canNext = view.endOf("month") < maxD.endOf("month");
  // `dt-seg` suppresses the global per-segment focus ring (globals.css) so only
  // the whole field rings via focus-within; the active segment gets a subtle
  // sky-soft fill instead, like a native date input's highlighted part.
  const segCls =
    "dt-seg rounded-sm bg-transparent text-center text-sm tabular-nums text-fg outline-none placeholder:text-fg-muted focus:bg-[var(--pennie-seg-active)]";

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name={nameDate} value={dateISO} />
      <input type="hidden" name={nameTime} value={timeHHMM} />

      <div role="group" aria-label={ariaLabel}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("input, button")) return;
          e.preventDefault();
          focusFirstEmpty();
        }}
        className={`dt-field flex h-[44px] ${hideTime ? "w-48" : "w-72"} cursor-text items-center rounded-sm border border-border bg-[var(--field)] pl-2 pr-1 text-sm text-fg`}>
        <input ref={mmRef} inputMode="numeric" aria-label={`${ariaLabel}, month`} placeholder="MM" value={mm}
          onChange={(e) => handleSeg("mm", e.target.value, ddRef)} onFocus={selectOnFocus} onMouseUp={selectWholeOnMouseUp}
          onBlur={(e) => normalizeDate("mm", e.currentTarget.value)}
          onKeyDown={(e) => segKeyDown(e, "mm", mm, null, ddRef)} className={`w-[3ch] ${segCls}`} />
        <span className="text-fg-muted">/</span>
        <input ref={ddRef} inputMode="numeric" aria-label={`${ariaLabel}, day`} placeholder="DD" value={dd}
          onChange={(e) => handleSeg("dd", e.target.value, yyRef)} onFocus={selectOnFocus} onMouseUp={selectWholeOnMouseUp}
          onBlur={(e) => normalizeDate("dd", e.currentTarget.value)}
          onKeyDown={(e) => segKeyDown(e, "dd", dd, mmRef, yyRef)} className={`w-[3ch] ${segCls}`} />
        <span className="text-fg-muted">/</span>
        <input ref={yyRef} inputMode="numeric" aria-label={`${ariaLabel}, year`} placeholder="YYYY" value={yyyy}
          onChange={(e) => handleSeg("yyyy", e.target.value, hhRef)} onFocus={selectOnFocus} onMouseUp={selectWholeOnMouseUp}
          onBlur={(e) => normalizeDate("yyyy", e.currentTarget.value)}
          onKeyDown={(e) => segKeyDown(e, "yyyy", yyyy, ddRef, hhRef)} className={`w-[5ch] ${segCls}`} />

        {!hideTime && (
        <>
        <span className="px-1 text-fg-muted" aria-hidden="true">&nbsp;</span>

        <input ref={hhRef} inputMode="numeric" aria-label={`${ariaLabel}, hour`} placeholder="HH" value={hh}
          onChange={(e) => handleSeg("hh", e.target.value, miRef)} onFocus={selectOnFocus} onMouseUp={selectWholeOnMouseUp}
          onBlur={(e) => {
            const v = e.currentTarget.value;
            setHh(v ? pad(clamp(Number(v) || 12, 1, 12)) : "");
            // Once an hour is set, fill an empty minute to 00 so the field never
            // looks half-set (the time already computes as :00 either way).
            if (v && !mi) setMi("00");
          }}
          onKeyDown={(e) => segKeyDown(e, "hh", hh, yyRef, miRef)} className={`w-[3ch] ${segCls}`} />
        <span className="text-fg-muted">:</span>
        <input ref={miRef} inputMode="numeric" aria-label={`${ariaLabel}, minute`} placeholder="MM" value={mi}
          onChange={(e) => handleSeg("mi", e.target.value, apRef)} onFocus={selectOnFocus} onMouseUp={selectWholeOnMouseUp}
          onBlur={(e) => snapWholeTime(e.currentTarget.value)}
          onKeyDown={(e) => segKeyDown(e, "mi", mi, hhRef, apRef)} className={`w-[3ch] ${segCls}`} />
        <input ref={apRef} aria-label={`${ariaLabel}, AM or PM`} placeholder="--" value={hh ? ap : ""}
          onChange={() => {}}
          onKeyDown={(e) => {
            const k = e.key.toLowerCase();
            if (k === "a") { e.preventDefault(); setAp("AM"); }
            else if (k === "p") { e.preventDefault(); setAp("PM"); }
            else if (k === "arrowup" || k === "arrowdown") { e.preventDefault(); setAp(ap === "AM" ? "PM" : "AM"); }
            else if (k === "arrowleft") { e.preventDefault(); miRef.current?.focus(); }
            else if (k === "backspace" && hhRef) { e.preventDefault(); miRef.current?.focus(); }
            else if (e.key.length === 1) e.preventDefault();
          }}
          className={`w-[3.5ch] ${segCls}`} />
        </>
        )}

        <button type="button" onClick={open ? cancel : openPopup}
          aria-label={open ? "Close calendar" : hideTime ? "Open calendar" : "Open calendar and time"}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId}
          className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg">
          <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
            <rect x="2" y="3" width="12" height="11" rx="2" />
            <path d="M2 6h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div id={dialogId} role="dialog" aria-label={ariaLabel} aria-modal="true"
          className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-border bg-surface-elevated p-3 shadow-pop">
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

          {!hideTime && (
          <div className="mt-3 border-t border-border pt-3">
            {/* The same control the hours screens use, rather than a third hour,
                minute and AM or PM trio (#1765). It carries no `name`: this field
                owns the submitted value, and two hidden inputs under one name
                would post the time twice. Mounted only while the popup is open, so
                it always opens on the segments' current value. */}
            <TimeField
              ariaLabel={`${ariaLabel} time`}
              defaultValue={timeHHMM}
              round={round}
              onValueChange={writeTime}
            />
          </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={cancel}
              className="rounded-sm border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-fg hover:bg-pennie-sky-soft">
              Cancel
            </button>
            <button type="button" onClick={() => setOpen(false)}
              className="rounded-sm bg-pennie-sky px-3 py-1.5 text-sm font-semibold text-pennie-graphite hover:bg-pennie-sky/90">
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

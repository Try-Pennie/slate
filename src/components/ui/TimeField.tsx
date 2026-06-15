"use client";

import { useState } from "react";
import {
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "@/lib/date/parse";

const pad = (n: number) => String(n).padStart(2, "0");

// 24h "HH:MM" <-> 12h parts. hour12 0 means "unset".
function to24(hour12: number, minute: number, ampm: "AM" | "PM"): string {
  if (!hour12) return "";
  let h = hour12 % 12;
  if (ampm === "PM") h += 12;
  return `${pad(h)}:${pad(minute)}`;
}
function from24(hhmm: string): { hour12: number; minute: number; ampm: "AM" | "PM" } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const minute = Number(m[2]);
  return { hour12: h % 12 || 12, minute, ampm: h >= 12 ? "PM" : "AM" };
}

/**
 * Time picker as three small dropdowns — Hour (1-12), Minute (only :00/:15/:30/
 * :45), and AM/PM — mirroring the original OOO tool. Far fewer options than one
 * long all-day list, and off-grid is impossible. An existing off-grid default
 * snaps to a valid minute (`round="down"` for START, `round="up"` for END so
 * the window never shrinks). Submits 24h "HH:MM" through a hidden `name`;
 * unset (the leading "--" hour) submits "".
 */
export function TimeField({
  name,
  defaultValue,
  ariaLabel,
  className = "",
  round = "down",
}: {
  name: string;
  defaultValue?: string;
  ariaLabel: string;
  className?: string;
  round?: "down" | "up";
}) {
  const snap = round === "up" ? roundUpToQuarterHour : roundDownToQuarterHour;
  const init = defaultValue ? from24(snap(defaultValue)) : null;
  const [hour, setHour] = useState(init ? init.hour12 : 0);
  const [minute, setMinute] = useState(init ? init.minute : 0);
  const [ampm, setAmpm] = useState<"AM" | "PM">(init ? init.ampm : "AM");

  const value = to24(hour, minute, ampm);
  const sel =
    "h-11 rounded-sm border border-border bg-surface px-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky";

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <input type="hidden" name={name} value={value} />
      <select
        aria-label={`${ariaLabel} hour`}
        value={hour}
        onChange={(e) => setHour(Number(e.target.value))}
        className={sel}
      >
        <option value={0}>--</option>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="text-fg-muted">
        :
      </span>
      <select
        aria-label={`${ariaLabel} minute`}
        value={minute}
        onChange={(e) => setMinute(Number(e.target.value))}
        className={sel}
      >
        {[0, 15, 30, 45].map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </select>
      <select
        aria-label={`${ariaLabel} AM or PM`}
        value={ampm}
        onChange={(e) => setAmpm(e.target.value as "AM" | "PM")}
        className={sel}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}

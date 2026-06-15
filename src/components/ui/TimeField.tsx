"use client";

import { useState } from "react";
import {
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "@/lib/date/parse";

/**
 * A native time input constrained to quarter-hour increments. The picker steps
 * by 15 minutes (`step={900}`), and anything typed off-grid snaps to the
 * nearest quarter hour on blur. `round` direction: `"down"` for START times
 * (17:14 -> 17:00, the default), `"up"` for END times (17:14 -> 17:15) so
 * rounding never shortens the window. Submits an "HH:MM" value through `name`,
 * so it drops into the existing form unchanged; the server rounds again as a
 * safety net.
 */
export function TimeField({
  name,
  defaultValue,
  ariaLabel,
  className,
  round = "down",
}: {
  name: string;
  defaultValue?: string;
  ariaLabel: string;
  className?: string;
  round?: "down" | "up";
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const snap = round === "up" ? roundUpToQuarterHour : roundDownToQuarterHour;
  return (
    <input
      type="time"
      step={900}
      name={name}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => setValue(snap(e.target.value))}
      className={className}
    />
  );
}

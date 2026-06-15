"use client";

import { useState } from "react";
import { roundDownToQuarterHour } from "@/lib/date/parse";

/**
 * A native time input constrained to quarter-hour increments. The picker steps
 * by 15 minutes (`step={900}`), and anything typed off-grid snaps DOWN to the
 * nearest quarter hour on blur (09:01 and 09:14 both become 09:00). Submits an
 * "HH:MM" value through `name`, so it drops into the existing form unchanged;
 * the server rounds again as a safety net.
 */
export function TimeField({
  name,
  defaultValue,
  ariaLabel,
  className,
}: {
  name: string;
  defaultValue?: string;
  ariaLabel: string;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  return (
    <input
      type="time"
      step={900}
      name={name}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => setValue(roundDownToQuarterHour(e.target.value))}
      className={className}
    />
  );
}

import {
  roundDownToQuarterHour,
  roundUpToQuarterHour,
} from "@/lib/date/parse";

// Every quarter-hour of the day, value in 24h "HH:MM" (what the form/server
// expect), label in friendly 12h ("9:15 AM"). Built once at module load.
const QUARTERS: { value: string; label: string }[] = [];
for (let h = 0; h < 24; h++) {
  for (const m of [0, 15, 30, 45]) {
    const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    QUARTERS.push({ value, label: `${h12}:${String(m).padStart(2, "0")} ${period}` });
  }
}

/**
 * A time picker constrained to quarter-hour increments. It's a real dropdown
 * listing only :00/:15/:30/:45 (the native `<input type="time">` ignores its
 * step in the dropdown and lists every minute), so off-grid times are
 * impossible to pick. An existing off-grid default snaps to a valid option:
 * `round="down"` for START times (09:14 -> 09:00), `round="up"` for END times
 * (17:14 -> 17:15) so the window never shrinks. Submits "HH:MM" through `name`.
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
  const snap = round === "up" ? roundUpToQuarterHour : roundDownToQuarterHour;
  const initial = defaultValue ? snap(defaultValue) : "";
  const selected = QUARTERS.some((q) => q.value === initial) ? initial : "";
  return (
    <select
      name={name}
      aria-label={ariaLabel}
      defaultValue={selected}
      className={className}
    >
      <option value="">--</option>
      {QUARTERS.map((q) => (
        <option key={q.value} value={q.value}>
          {q.label}
        </option>
      ))}
    </select>
  );
}

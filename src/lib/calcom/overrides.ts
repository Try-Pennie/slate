import { DateTime } from "luxon";

/**
 * Pure port of the Apps Script's Cal.com "inverse date override" builder
 * (buildDateOverrides_ / mergeOverrides_ / the removal filter): an approved
 * OOO window becomes per-date overrides that shrink the agent's availability
 * to whatever working time falls OUTSIDE the OOO (or 00:00-00:00 to block a
 * whole day). All math happens in the Cal.com schedule's timezone.
 * Exercised by `scripts/test-ooo-calcom-overrides.ts`.
 */

export interface CalcomAvailabilityRule {
  /** Cal.com sends day names ("Monday") or numbers (Sunday=0). */
  days?: (string | number)[];
  startTime?: string; // "HH:mm"
  endTime?: string;
}

export interface DateOverride {
  date: string; // "yyyy-MM-dd" in the schedule tz
  startTime: string; // "HH:mm"
  endTime: string;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Working hours for a local date, from the schedule's weekly availability. */
function workingHoursFor(
  localDate: string,
  zone: string,
  availability: CalcomAvailabilityRule[] | undefined,
): { startTime: string; endTime: string } | null {
  if (!Array.isArray(availability)) return null;
  // Luxon weekday 1=Mon..7=Sun -> Cal.com Sunday=0 numbering.
  const luxonWeekday = DateTime.fromISO(localDate, { zone }).weekday;
  const calcomDay = luxonWeekday % 7;
  const dayName = DAY_NAMES[calcomDay];
  for (const rule of availability) {
    if (!rule.days || !rule.startTime || !rule.endTime) continue;
    if (rule.days.some((d) => d === calcomDay || d === dayName)) {
      return { startTime: rule.startTime, endTime: rule.endTime };
    }
  }
  return null;
}

/** Inverse overrides for one day: what's still available around the OOO. */
function inverseOverridesForDay(
  date: string,
  oooStart: string,
  oooEnd: string,
  work: { startTime: string; endTime: string } | null,
): DateOverride[] {
  // No working hours on file: block the day outright (parity with the legacy
  // tool — an unknown schedule must not stay bookable).
  if (!work) return [{ date, startTime: "00:00", endTime: "00:00" }];

  const workStart = minutesOf(work.startTime);
  const workEnd = minutesOf(work.endTime);
  const start = minutesOf(oooStart);
  const end = minutesOf(oooEnd);

  // OOO covers the whole working day -> full-day block.
  if (start <= workStart && end >= workEnd) {
    return [{ date, startTime: "00:00", endTime: "00:00" }];
  }
  // OOO entirely outside working hours -> nothing changes.
  if (start >= workEnd || end <= workStart) return [];

  const out: DateOverride[] = [];
  if (start > workStart && start < workEnd) {
    out.push({ date, startTime: work.startTime, endTime: oooStart });
  }
  if (end > workStart && end < workEnd) {
    out.push({ date, startTime: oooEnd, endTime: work.endTime });
  }
  return out;
}

export function buildDateOverrides(
  startIso: string,
  endIso: string,
  scheduleTz: string,
  availability: CalcomAvailabilityRule[] | undefined,
): DateOverride[] {
  const zone = DateTime.fromISO(startIso, { zone: scheduleTz }).isValid
    ? scheduleTz
    : "Etc/UTC";
  const s = DateTime.fromISO(startIso, { zone });
  const e = DateTime.fromISO(endIso, { zone });
  const sDate = s.toISODate()!;
  const eDate = e.toISODate()!;
  const sHM = s.toFormat("HH:mm");
  const eHM = e.toFormat("HH:mm");

  if (sDate === eDate) {
    if (sHM === eHM) return [];
    return inverseOverridesForDay(
      sDate,
      sHM,
      eHM,
      workingHoursFor(sDate, zone, availability),
    );
  }

  const out: DateOverride[] = [];
  // First day: OOO from its start time to end of day.
  out.push(
    ...inverseOverridesForDay(
      sDate,
      sHM,
      "23:59",
      workingHoursFor(sDate, zone, availability),
    ),
  );
  // Middle days: fully out.
  let cursor = s.startOf("day").plus({ days: 1 });
  while (cursor.toISODate()! < eDate) {
    const date = cursor.toISODate()!;
    out.push(
      ...inverseOverridesForDay(
        date,
        "00:00",
        "23:59",
        workingHoursFor(date, zone, availability),
      ),
    );
    cursor = cursor.plus({ days: 1 });
  }
  // Last day: out from start of day until the OOO ends.
  out.push(
    ...inverseOverridesForDay(
      eDate,
      "00:00",
      eHM,
      workingHoursFor(eDate, zone, availability),
    ),
  );
  return out;
}

const overrideKey = (o: DateOverride): string =>
  [o.date, o.startTime, o.endTime].join("|");

/** Merge new overrides into existing ones, de-duping exact matches. */
export function mergeOverrides(
  existing: DateOverride[],
  additions: DateOverride[],
): DateOverride[] {
  const map = new Map(existing.map((o) => [overrideKey(o), o]));
  for (const o of additions) map.set(overrideKey(o), o);
  return [...map.values()];
}

/** Removal filter: drop the exact overrides a cancelled OOO had added. */
export function filterOutOverrides(
  existing: DateOverride[],
  toRemove: DateOverride[],
): DateOverride[] {
  const removeKeys = new Set(toRemove.map(overrideKey));
  return existing.filter((o) => !removeKeys.has(overrideKey(o)));
}

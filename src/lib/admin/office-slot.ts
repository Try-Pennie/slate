/**
 * The half hour of the office's day (0 to 47) and its weekday (Luxon, 1 = Monday) at `readAtMs`.
 * The one place either is worked out, so no zone arithmetic happens anywhere else, SQL included.
 * On the night the clocks go back an hour repeats, and both of its readings share a half hour.
 */
import { DateTime } from "luxon";

export function officeSlot(readAtMs: number, zone: string): { slotOfDay: number; weekday: number } {
  const local = DateTime.fromMillis(readAtMs, { zone });
  return { slotOfDay: Math.floor((local.hour * 60 + local.minute) / 30), weekday: local.weekday };
}

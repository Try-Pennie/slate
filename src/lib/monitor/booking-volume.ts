/**
 * Pure logic for the low-booking-volume alert (#370): the cal.com Booking Monitor
 * replacement. Flags time windows whose booking count fell below an expected
 * floor, gated to business hours (Eastern, DST-aware) so normal overnight/weekend
 * quiet doesn't fire it. No `@/` imports so
 * scripts/test-monitor-booking-volume.ts can run it node-native; the IO (booking
 * counts, the arming switch, Slack) lives in the cron route.
 */
import { DateTime } from "luxon";

export interface BusinessHoursConfig {
  zone: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
}

/** True when `nowMs` falls on an active weekday within [startHour, endHour) in
 *  the configured zone. Anchored in Eastern time so the window tracks DST. */
export function isBusinessHours(nowMs: number, cfg: BusinessHoursConfig): boolean {
  const dt = DateTime.fromMillis(nowMs, { zone: cfg.zone });
  if (!cfg.weekdays.includes(dt.weekday)) return false;
  return dt.hour >= cfg.startHour && dt.hour < cfg.endHour;
}

export interface VolumeWindow {
  /** Human label for the window, e.g. "30 min". */
  label: string;
  /** Bookings actually created in the window. */
  count: number;
  /** Expected minimum for this window; below it is a breach. */
  floor: number;
}

/** Windows whose count fell strictly below their floor. A count exactly at the
 *  floor is healthy (not a breach). */
export function lowVolumeBreaches(windows: VolumeWindow[]): VolumeWindow[] {
  return windows.filter((w) => w.count < w.floor);
}

/** Slack body for a low-volume breach. No em/en dashes (the copy lint forbids
 *  them in user-facing strings); colons/semicolons only. */
export function formatLowVolumeAlert(breaches: VolumeWindow[]): string {
  const lines = breaches
    .map((b) => `${b.count} in the last ${b.label} (expected at least ${b.floor})`)
    .join("; ");
  return (
    `Slate booking volume is low: ${lines}. The booker may be down ` +
    `(broken embed, empty availability, or sync wedged); check it.`
  );
}

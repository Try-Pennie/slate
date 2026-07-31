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

/** alert_state row key for the throttle; lives with the feature so the cron and
 *  the settings screen refer to the one constant. */
export const VOLUME_ALERT_KEY = "low_booking_volume";

export type LowVolumeResult =
  | { status: "outside-hours" }
  | { status: "unverified" }
  | { status: "checked"; armed: boolean; windows: VolumeWindow[]; breaches: VolumeWindow[] };

/**
 * The monitor-cron step for #370, extracted from the route (#1158) so the gates
 * that decide a page are pinned by tests. Outside business hours it reads
 * nothing. A breach pages only while armed (the cutover switch, #575); the
 * notify failure is swallowed (fail-soft, matching the other checks): a flaky
 * Slack must never fail the monitor tick.
 *
 * The failure path is the point: `countSince` returns null (or throws) when the
 * bookings read failed, and that is `unverified`, never zero. Before the
 * extraction a failed read became count 0, which is below any real floor, so an
 * unreadable bookings table would have paged "0 bookings" off a query that never
 * ran. The injected reader owns logging its own error detail; the catch here
 * only guarantees the tick survives a reader that throws instead of returning
 * null.
 */
export async function runLowVolumeCheck(deps: {
  nowMs: number;
  businessHours: BusinessHoursConfig;
  /** Bookings created at or after `sinceIso`, or null when the read failed. */
  countSince: (sinceIso: string) => Promise<number | null>;
  floors: { floor30: number; floor120: number };
  armed: boolean;
  cooldownMs: number;
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<LowVolumeResult> {
  if (!isBusinessHours(deps.nowMs, deps.businessHours)) return { status: "outside-hours" };

  const read = (minutes: number) =>
    deps.countSince(new Date(deps.nowMs - minutes * 60_000).toISOString()).catch(() => null);
  const [count30, count120] = await Promise.all([read(30), read(120)]);

  if (count30 === null || count120 === null) {
    deps.log?.({
      count_30m: count30,
      count_120m: count120,
      below_floor: null,
      armed: deps.armed,
      unverified: true,
    });
    return { status: "unverified" };
  }

  const windows: VolumeWindow[] = [
    { label: "30 min", count: count30, floor: deps.floors.floor30 },
    { label: "120 min", count: count120, floor: deps.floors.floor120 },
  ];
  const breaches = lowVolumeBreaches(windows);
  if (breaches.length && deps.armed) {
    await deps.notify(VOLUME_ALERT_KEY, deps.cooldownMs, formatLowVolumeAlert(breaches)).catch(() => {});
  }
  deps.log?.({
    count_30m: count30,
    count_120m: count120,
    below_floor: breaches.length,
    armed: deps.armed,
  });
  return { status: "checked", armed: deps.armed, windows, breaches };
}

/** Slack body for a low-volume breach. No em/en dashes (the copy lint forbids
 *  them in user-facing strings); colons/semicolons only. */
export function formatLowVolumeAlert(breaches: VolumeWindow[]): string {
  const lines = breaches
    .map((b) => `${b.count} in the last ${b.label} (expected at least ${b.floor})`)
    .join("; ");
  return (
    `Booking volume is low: ${lines}. The booker may be down ` +
    `(broken embed, empty availability, or sync wedged); check it.`
  );
}

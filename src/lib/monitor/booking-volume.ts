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

/**
 * alert_state key for a bookings count that could not be read twice (#1288).
 *
 * Deliberately NOT `VOLUME_ALERT_KEY`. A read failure is a database problem, and
 * dressing it as a booking drought sends the reader to the funnel instead of to
 * the query, which is the same reasoning that made a failed read `unverified`
 * rather than zero in the first place (#1158).
 */
export const VOLUME_COUNT_UNREADABLE_KEY = "volume_count_unreadable";

export type LowVolumeResult =
  | { status: "outside-hours" }
  | { status: "unverified" }
  /** Both attempts at the count failed, so nothing about volume was measured. */
  | { status: "count-unreadable" }
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
  /** Page for a count that could not be read TWICE (#1288). Its own key, because
   *  a broken query is not a booking drought. */
  notifyCountUnreadable: (key: string, cooldownMs: number, text: string) => Promise<void>;
  /**
   * Clear every page this tick MEASURED to be over, in one go (#1390).
   *
   * Named for the dispatch helper it is wired to, which is also the seam
   * convention the bare-catch guard derives from. Batched rather than one resolve
   * per key because each resolve costs an `alert_state` read, and this lane shares
   * a subrequest budget with three others. Only conditions actually measured healthy may be passed: clearing a
   * page because a check did not run is the #1152 defect.
   */
  resolveRecovered: (recovered: { key: string; text: string }[]) => Promise<string[]>;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<LowVolumeResult> {
  if (!isBusinessHours(deps.nowMs, deps.businessHours)) return { status: "outside-hours" };

  const read = (minutes: number) =>
    deps.countSince(new Date(deps.nowMs - minutes * 60_000).toISOString()).catch(() => null);
  let [count30, count120] = await Promise.all([read(30), read(120)]);

  // ONE retry, and only for the window that actually failed (#1288). Dan's
  // expectation was to "retry at once and page if the retry fails", so a
  // persistently broken count surfaces inside the tick rather than waiting on the
  // next one. Scoped to the error path and to the failed window because the extra
  // query lands on a subrequest budget four cron lanes share: a healthy tick must
  // cost exactly what it did before.
  if (count30 === null) count30 = await read(30);
  if (count120 === null) count120 = await read(120);

  if (count30 === null || count120 === null) {
    deps.log?.({
      count_30m: count30,
      count_120m: count120,
      below_floor: null,
      armed: deps.armed,
      unverified: true,
      retried: true,
    });
    // Pages regardless of `armed`. That switch exists so the ramp cannot cry wolf
    // about VOLUME, and an unreadable query makes no claim about volume at all.
    await deps
      .notifyCountUnreadable(
        VOLUME_COUNT_UNREADABLE_KEY,
        deps.cooldownMs,
        formatVolumeCountUnreadableAlert(),
      )
      .catch(() => {});
    return { status: "count-unreadable" };
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
  // Both all-clears hang off a count we actually READ, never off "we did not page
  // this run" (#1152). Every path above that could not measure returns before
  // here, so an unreadable tick can never announce a recovery.
  //
  // The volume all-clear is offered whenever the reading sits at or above both
  // floors, and deliberately NOT gated on `armed` (#1390). The arming switch
  // exists so the ramp cannot cry wolf about volume; it is not a reason to leave a
  // page that was delivered while armed hanging forever after someone disarms it.
  // A key with no outstanding page costs nothing to offer: `settle` reads the
  // firing markers once and skips whatever is not there.
  const recovered = [{ key: VOLUME_COUNT_UNREADABLE_KEY, text: formatVolumeCountReadableNotice() }];
  if (breaches.length === 0) {
    recovered.push({ key: VOLUME_ALERT_KEY, text: formatLowVolumeRecoveryNotice(windows) });
  }
  // all-clear-proof: scripts/test-monitor-booking-volume.ts - pins that a tick
  // outside business hours, a count that failed both reads, a reader that threw,
  // and a tick that is itself PAGING a breach each reach this line with nothing to
  // clear about volume (the first three never reach it at all).
  await deps.resolveRecovered(recovered).catch(() => {});
  return { status: "checked", armed: deps.armed, windows, breaches };
}

/**
 * The page for a count that failed twice in one tick.
 *
 * It names the QUERY as the thing to look at, because that is what is broken. A
 * reader who is told "booking volume is low" goes and checks the booker, the
 * embed and the availability cache, and finds nothing wrong with any of them.
 */
export function formatVolumeCountUnreadableAlert(): string {
  return (
    "The booking volume monitor cannot read its own count: two attempts in the same " +
    "minute both failed, so nothing is being measured about whether customers are " +
    "booking. This is a database read problem, not a booking drought. Check the " +
    "bookings table and the monitor lane's logs; the low volume alarm is blind " +
    "until it clears."
  );
}

/** The all-clear, hung off a count that actually came back. */
export function formatVolumeCountReadableNotice(): string {
  return (
    "The booking volume monitor can read its count again, so it is measuring " +
    "whether customers are booking. No action is needed."
  );
}


/**
 * The all-clear for a booking drought (#1390).
 *
 * Quotes the measured counts, because the page quoted them too and the reader's
 * question is "is it back to normal, or just above the line". It names no
 * remediation: the page sent them to look at the booker, the embed and the sync,
 * and repeating that here would send them after a fault that is over.
 */
export function formatLowVolumeRecoveryNotice(windows: VolumeWindow[]): string {
  const lines = windows.map((w) => `${w.count} in the last ${w.label}`).join("; ");
  return (
    `Booking volume is back above the expected minimum: ${lines}. Customers are ` +
    `getting through again, so the earlier low volume page is cleared. No action is needed.`
  );
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

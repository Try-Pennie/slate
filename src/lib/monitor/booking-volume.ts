/**
 * Pure logic for the low-booking-volume alert (#370): the cal.com Booking Monitor
 * replacement. Flags time windows whose booking count fell below an expected
 * floor, gated to business hours (Eastern, DST-aware) so normal overnight/weekend
 * quiet doesn't fire it. No `@/` imports so
 * scripts/test-monitor-booking-volume.ts can run it node-native; the IO (booking
 * counts, the arming switch, Slack) lives in the cron route.
 */
import { DateTime } from "luxon";
import { windowOnDate, type BusinessHoursException } from "../booking/business-hours.ts";
import type { ThrottledNotify } from "./alert-deps";
import { logAllClearFailure } from "../notify/send-failure.ts";

/**
 * When the org is open, in the shape the org's own hours are stored in (#1298).
 *
 * This used to be a SECOND hardcoded copy of when Pennie is open: weekdays 1 to 5,
 * 08:00 to 20:00, written here beside the alert. The org's real window includes
 * SATURDAY, so the volume alarm was blind for a whole open day every week, and
 * nothing would have said so: a Saturday with zero bookings looked exactly like a
 * Saturday the alarm had deliberately ignored.
 *
 * A window that has to agree with another source of truth is derived from it, never
 * maintained beside it (L41). The caller passes the SAME rules the availability
 * gates judge a slot against, so the hours the booker offers and the hours the
 * alarm watches cannot drift apart.
 */
export interface BusinessHoursConfig {
  zone: string;
  /** Per weekday windows (1=Mon..7=Sun), minutes from midnight. */
  rules: { weekday: number; start_minute: number; end_minute: number }[];
  /**
   * The dates that override the weekly pattern (#1363).
   *
   * REQUIRED for the same reason the window itself is passed rather than coded
   * here: an alarm judging "is the org open" from the weekly rules alone would
   * page about bookings drying up on a day the office is deliberately shut, which
   * is the loudest possible way to be wrong about a quiet day. A holiday closure
   * is exactly when the weekly pattern says open and nothing is.
   */
  exceptions: BusinessHoursException[];
}

/**
 * True when `nowMs` falls inside one of the org's stored windows, judged in the
 * org's own zone so the window tracks DST.
 *
 * An EMPTY rules list means shut, which is a legitimate stored answer and is why
 * the caller must never pass an empty list as a fallback for a read it could not
 * make: that would silence the alarm rather than skip it.
 */
export function isBusinessHours(nowMs: number, cfg: BusinessHoursConfig): boolean {
  const dt = DateTime.fromMillis(nowMs, { zone: cfg.zone });
  // Through the org's own date judge (#1363), so a closure the booker refuses can
  // never be an hour this alarm calls open.
  const window = windowOnDate(cfg, dt.toISODate() ?? "", dt.weekday);
  if (!window) return false;
  const minute = dt.hour * 60 + dt.minute;
  return window.start_minute <= minute && minute < window.end_minute;
}

/**
 * The windows the low volume alarm judges, in minutes.
 *
 * Exported because #2366 derives how long public booking may sit STOPPED before
 * anybody is told from the long one: the two alarms report the same silence from
 * opposite ends, and a threshold restated beside one of them would drift the first
 * time the other moved (L41, L401).
 */
export const LOW_VOLUME_WINDOW_MINUTES = { short: 30, long: 120 } as const;

export interface VolumeWindow {
  /** Human label for the window, e.g. "30 min". */
  label: string;
  /** Bookings actually created in the window. */
  count: number;
  /** Expected minimum for this window; below it is a breach. */
  floor: number;
  /** Where the floor came from, in words (#1956), or absent where nothing says. */
  basis?: string;
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

/**
 * alert_state key for this check going an hour of OPEN business time without a
 * verdict (#2049). The page is sent from `volume-verdict-gap.ts`; its all-clear is
 * offered here, by the only thing that can measure it over: a tick that reached a
 * verdict. It lives in this module so that one does not import the other both ways.
 */
export const VOLUME_VERDICT_GAP_KEY = "low_volume_verdict_gap";

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
  /**
   * The floors for THIS tick (#1956): measured per weekday and hour, so the caller
   * resolves them for `nowMs` rather than passing one pair for every hour.
   */
  floors: { floor30: number; floor120: number; basis30?: string; basis120?: string };
  armed: boolean;
  cooldownMs: number;
  notify: ThrottledNotify;
  /** Page for a count that could not be read TWICE (#1288). Its own key, because
   *  a broken query is not a booking drought. */
  notifyCountUnreadable: ThrottledNotify;
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
  /**
   * #2874: a tier judged BESIDE Low, with its own alert key and its name. Absent
   * means Low, which keeps the key it has paged on since #370. A tier's reading
   * clears only its own page: the verdict gap is about Low's verdict, so a tier's
   * breach says nothing about it.
   */
  tier?: { key: string; countUnreadableKey: string; label: string };
}): Promise<LowVolumeResult> {
  if (!isBusinessHours(deps.nowMs, deps.businessHours)) return { status: "outside-hours" };

  const read = (minutes: number) =>
    deps.countSince(new Date(deps.nowMs - minutes * 60_000).toISOString()).catch(() => null);
  let [count30, count120] = await Promise.all([
    read(LOW_VOLUME_WINDOW_MINUTES.short),
    read(LOW_VOLUME_WINDOW_MINUTES.long),
  ]);

  // ONE retry, and only for the window that actually failed (#1288). Dan's
  // expectation was to "retry at once and page if the retry fails", so a
  // persistently broken count surfaces inside the tick rather than waiting on the
  // next one. Scoped to the error path and to the failed window because the extra
  // query lands on a subrequest budget four cron lanes share: a healthy tick must
  // cost exactly what it did before.
  if (count30 === null) count30 = await read(LOW_VOLUME_WINDOW_MINUTES.short);
  if (count120 === null) count120 = await read(LOW_VOLUME_WINDOW_MINUTES.long);

  if (count30 === null || count120 === null) {
    deps.log?.({
      count_30m: count30,
      count_120m: count120,
      below_floor: null,
      armed: deps.armed,
      unverified: true,
      retried: true,
      ...(deps.tier ? { tier: deps.tier.label } : {}),
    });
    // Pages regardless of `armed`. That switch exists so the ramp cannot cry wolf
    // about VOLUME, and an unreadable query makes no claim about volume at all.
    await deps
      .notifyCountUnreadable(
        deps.tier?.countUnreadableKey ?? VOLUME_COUNT_UNREADABLE_KEY,
        deps.cooldownMs,
        deps.tier ? formatTierVolumeCountUnreadableAlert(deps.tier.label) : formatVolumeCountUnreadableAlert(),
      )
      .catch(() => {});
    return { status: "count-unreadable" };
  }

  const windows: VolumeWindow[] = [
    {
      label: `${LOW_VOLUME_WINDOW_MINUTES.short} min`,
      count: count30,
      floor: deps.floors.floor30,
      basis: deps.floors.basis30,
    },
    {
      label: `${LOW_VOLUME_WINDOW_MINUTES.long} min`,
      count: count120,
      floor: deps.floors.floor120,
      basis: deps.floors.basis120,
    },
  ];
  const breaches = lowVolumeBreaches(windows);
  const alertKey = deps.tier?.key ?? VOLUME_ALERT_KEY;
  if (breaches.length && deps.armed) {
    const text = deps.tier ? formatTierVolumeAlert(deps.tier.label, breaches) : formatLowVolumeAlert(breaches);
    await deps.notify(alertKey, deps.cooldownMs, text).catch(() => {});
  }
  deps.log?.({
    count_30m: count30,
    count_120m: count120,
    below_floor: breaches.length,
    armed: deps.armed,
    ...(deps.tier ? { tier: deps.tier.label } : {}),
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
  //
  // The verdict gap (#2049) clears on a breach too: a breach is the check
  // concluding, which is the whole of what that page said was not happening. It
  // rides this settle rather than a read of its own, so the healthy tick costs
  // nothing extra on the budget four cron lanes share.
  // #2874: a tier's readable count answers only ITS OWN unreadable page. Offering
  // Low's key here would clear Low's page from another tier's read on every tick,
  // and Low's own failing read would re-fire it on the next.
  const recovered = [
    deps.tier
      ? { key: deps.tier.countUnreadableKey, text: formatTierVolumeCountReadableNotice(deps.tier.label) }
      : { key: VOLUME_COUNT_UNREADABLE_KEY, text: formatVolumeCountReadableNotice() },
  ];
  if (!deps.tier) recovered.push({ key: VOLUME_VERDICT_GAP_KEY, text: formatVolumeVerdictGapRecoveryNotice() });
  if (breaches.length === 0) {
    recovered.push({
      key: alertKey,
      text: deps.tier ? formatTierVolumeRecoveryNotice(deps.tier.label, windows) : formatLowVolumeRecoveryNotice(windows),
    });
  }
  // all-clear-proof: scripts/test-monitor-booking-volume.ts - pins that a tick
  // outside business hours, a count that failed both reads, a reader that threw,
  // and a tick that is itself PAGING a breach each reach this line with nothing to
  // clear about volume (the first three never reach it at all).
  await deps
    .resolveRecovered(recovered)
    .catch(logAllClearFailure(recovered.map((r) => r.key)));
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

/** A tier's count that failed twice in one tick (#2874): the same fault, named for its tier. */
export function formatTierVolumeCountUnreadableAlert(tierLabel: string): string {
  return (
    `The booking volume monitor cannot read the ${tierLabel} tier's count: two attempts in the same ` +
    `minute both failed, so nothing is being measured about whether ${tierLabel} customers are booking. ` +
    `This is a database read problem, not a booking drought. Check the bookings table and the monitor ` +
    `lane's logs; the ${tierLabel} low volume alarm is blind until it clears.`
  );
}

/**
 * A tier whose check could not run at all this tick (#2874), usually a stored
 * floor record the check could not use. It says what is known: the check did not
 * run, so that tier was not judged. It claims no read failed, because it cannot
 * know that, and points at the log line carrying the error.
 */
export function formatTierVolumeCheckFailedAlert(tierLabel: string): string {
  return (
    `The ${tierLabel} low volume check could not run, so ${tierLabel} bookings were not judged this tick. ` +
    `The other tiers were still checked. The monitor lane's log carries the error ` +
    `(tag=monitor, msg="tier volume check failed").`
  );
}

/** Its all-clear, hung off that tier's check running to an outcome again. */
export function formatTierVolumeCheckRanNotice(tierLabel: string): string {
  return `The ${tierLabel} low volume check is running again, so ${tierLabel} bookings are being judged. No action is needed.`;
}

/** A tier's all-clear for that, hung off its count coming back. */
export function formatTierVolumeCountReadableNotice(tierLabel: string): string {
  return (
    `The booking volume monitor can read the ${tierLabel} tier's count again, so it is measuring ` +
    `whether ${tierLabel} customers are booking. No action is needed.`
  );
}

/** The all-clear, hung off a count that actually came back. */
export function formatVolumeCountReadableNotice(): string {
  return (
    "The booking volume monitor can read its count again, so it is measuring " +
    "whether customers are booking. No action is needed."
  );
}

/** The all-clear for the verdict gap (#2049), hung off a tick that concluded. */
export function formatVolumeVerdictGapRecoveryNotice(): string {
  return (
    "The low booking volume alarm is reaching a verdict again, so it is measuring " +
    "whether customers are booking during open hours. No action is needed."
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
  return (
    `Booking volume is back above the expected minimum: ${describeCounts(windows)}. Customers are ` +
    `getting through again, so the earlier low volume page is cleared. No action is needed.`
  );
}

/** Slack body for a low-volume breach. No em/en dashes (the copy lint forbids
 *  them in user-facing strings); colons/semicolons only. */
export function formatLowVolumeAlert(breaches: VolumeWindow[]): string {
  return (
    `Booking volume is low: ${describeBreaches(breaches)} The booker may be down ` +
    `(broken embed, empty availability, or sync wedged); check it.`
  );
}

/**
 * The page for a tier judged beside Low (#2874). It names the tier, because one
 * tier going quiet while the others book points at that tier's pages or pool
 * rather than at the booker every tier shares.
 */
export function formatTierVolumeAlert(tierLabel: string, breaches: VolumeWindow[]): string {
  return (
    `${tierLabel} booking volume is low: ${describeBreaches(breaches)} Check that ${tierLabel} leads are ` +
    `still reaching Slate (their landing pages and booking links) and that the ${tierLabel} pool is offering times.`
  );
}

/** The all-clear for a tier, hung off counts measured at or above both floors. */
export function formatTierVolumeRecoveryNotice(tierLabel: string, windows: VolumeWindow[]): string {
  return (
    `${tierLabel} bookings are back above the expected minimum: ${describeCounts(windows)}. ` +
    `The earlier page about it is cleared. No action is needed.`
  );
}

/**
 * "0 in the last 30 min (expected at least 3); 4 in the last 120 min (expected at
 * least 12). Both floors were measured for Tuesdays 2pm to 3pm.", ending in a full
 * stop. Shared with the per page alarm (#2738), so the two say a breach the same way.
 */
export function describeBreaches(breaches: VolumeWindow[]): string {
  // Where the floors came from (#1956) is said ONCE when every breached window
  // shares it, rather than repeated inside each bracket (L605).
  const bases = new Set(breaches.map((b) => b.basis ?? ""));
  const shared = bases.size === 1 && breaches.length > 1 ? [...bases][0]! : "";
  const lines = breaches
    .map((b) => {
      const own = !shared && b.basis ? `, ${b.basis}` : "";
      return `${b.count} in the last ${b.label} (expected at least ${b.floor}${own})`;
    })
    .join("; ");
  const provenance = shared ? ` Both floors were ${shared}.` : "";
  return `${lines}.${provenance}`;
}

/** "5 in the last 30 min; 18 in the last 120 min", with no closing stop. */
export function describeCounts(windows: VolumeWindow[]): string {
  return windows.map((w) => `${w.count} in the last ${w.label}`).join("; ");
}

/**
 * Has the low volume alarm gone an hour of OPEN business time without a verdict?
 * (#2049)
 *
 * `verdict:low-booking-volume` is watched by the verdict family against a flat 4
 * day bound (`VERDICT_STALE_BOUNDS_MS`), because this check is properly silent
 * every Sunday and on every holiday the org closes, and a Saturday evening to
 * Tuesday morning holiday weekend is about 60 hours of legitimate silence. A wall
 * clock bound long enough to clear that cannot see ONE open day with no verdict:
 * the check could stop concluding every Saturday for ever, conclude again on
 * Monday, and never page.
 *
 * #2049 was filed as exactly that, and on measurement it was not happening: the
 * stamp it quoted, 2026-09-05 23:56Z, was Saturday 19:56 EDT (the last tick before
 * Saturday's close, read as a Friday), and the logs for Saturday 2026-09-19 show
 * 142 in hours ticks every one of which reached a verdict. What the report DID get
 * right is that nothing would have said so if it had been. This is that something.
 *
 * It counts only the minutes the org was OPEN since the last verdict, through the
 * same `windowOnDate` the check itself and the booker use, so a closed Sunday and
 * a holiday closure count as nothing and a missed Saturday is an hour of
 * blindness by 09:00.
 *
 * What it can and cannot see, so a quiet run is never read as more than it is
 * (L400):
 *  - It reads the STORED stamp, so it sees the whole path end to end: a check that
 *    stops concluding, a step that throws, and a stamp write that fails (which
 *    `recordHeartbeat` swallows into a log line) all leave the stamp aging.
 *  - It runs under the SAME setup gate as the check. A setup read that stands the
 *    check down is paged by the step streak (#2382) naming this alarm, so a second
 *    page here would be one fact twice (L36).
 *  - It shares the open hours predicate with the check (L345). A defect that makes
 *    the check believe the org is shut while it is open would make this believe it
 *    too. That judge is pinned by scripts/test-monitor-booking-volume.ts, and the
 *    4 day wall clock bound is still the backstop that shares nothing.
 *
 * No `@/` imports, so scripts/test-volume-verdict-gap.ts drives it node natively.
 */
import { logAlertSendFailure } from "../notify/send-failure.ts";
import { DateTime } from "luxon";
import { windowOnDate } from "../booking/business-hours.ts";
import { formatClockTime } from "../date/parse.ts";
import {
  isBusinessHours,
  VOLUME_VERDICT_GAP_KEY,
  type BusinessHoursConfig,
  type LowVolumeResult,
} from "./booking-volume.ts";
import type { ThrottledNotify } from "./alert-deps";

/**
 * One open hour: twelve five minute monitor ticks in a row that did not conclude.
 *
 * Long enough that a count read failing for a few ticks (which pages under its own
 * key) or the first tick after opening cannot trip it, and short enough that a lost
 * Saturday is named by mid morning rather than never. It is also well past the step
 * streak (`MONITOR_STEP_FAILING_TICKS`, four ticks), so a step that throws is named
 * by that page first, and this one follows only if the blindness persists.
 */
export const VOLUME_VERDICT_GAP_OPEN_MINUTES = 60;

/**
 * Re-page every four hours while it lasts: three times in a twelve hour open day.
 * It stays true until somebody fixes something, and an hourly repeat of a
 * condition nobody can clear inside the hour trains people to skip it (L36).
 */
export const VOLUME_VERDICT_GAP_COOLDOWN_MS = 4 * 60 * 60_000;

/**
 * How far back the open minutes are counted. An unparseable stamp reads as epoch 0
 * (#1169), and a fortnight of open time is already far past the bound, so the walk
 * is bounded without changing any verdict.
 */
const MAX_LOOKBACK_DAYS = 14;

/**
 * Minutes the org was open between `fromMs` and `toMs`, judged day by day in the
 * org's own zone through the org's own date judge (weekly rules, then closures).
 *
 * Wall clock boundaries are set with `set({ hour, minute })` rather than by adding
 * minutes to midnight, so a clock change on an open day moves the window with the
 * wall clock the way the booker reads it.
 */
export function openMinutesBetween(fromMs: number, toMs: number, hours: BusinessHoursConfig): number {
  const start = Math.max(fromMs, toMs - MAX_LOOKBACK_DAYS * 24 * 60 * 60_000);
  if (!(toMs > start)) return 0;
  let day = DateTime.fromMillis(start, { zone: hours.zone }).startOf("day");
  const lastDay = DateTime.fromMillis(toMs, { zone: hours.zone }).startOf("day");
  let openMs = 0;
  while (day.toMillis() <= lastDay.toMillis()) {
    const window = windowOnDate(hours, day.toISODate() ?? "", day.weekday);
    if (window) {
      const at = (minute: number) =>
        minute >= 24 * 60
          ? day.plus({ days: 1 }).startOf("day").toMillis()
          : day.set({ hour: Math.floor(minute / 60), minute: minute % 60 }).toMillis();
      const overlap = Math.min(at(window.end_minute), toMs) - Math.max(at(window.start_minute), start);
      if (overlap > 0) openMs += overlap;
    }
    day = day.plus({ days: 1 });
  }
  return Math.floor(openMs / 60_000);
}

export type VolumeVerdictGapResult =
  /** The check reached a verdict this tick: nothing to judge and nothing read. */
  | { status: "concluded" }
  /** The org is shut now, which is legitimate silence. */
  | { status: "closed" }
  /** The count could not be read: `volume_count_unreadable` already pages, naming the query. */
  | { status: "covered" }
  /** The lane has never stamped: the verdict family's own grace window owns that. */
  | { status: "never-stamped" }
  | { status: "within"; openMinutes: number }
  | { status: "gap"; openMinutes: number; lastVerdictMs: number };

/**
 * The monitor lane step. Runs AFTER the volume check on the same tick and reads the
 * stamp only when that check did not conclude while the org is open, so a healthy
 * tick costs nothing. The page's all-clear is offered by the check itself on its
 * next verdict (`runLowVolumeCheck`), never from here: this module can only ever
 * see the check NOT concluding.
 *
 * A failed stamp read THROWS, so the step boundary records it and the step streak
 * pages; resolving it to "no gap" would be the silence this exists to end.
 */
export async function runVolumeVerdictGapCheck(deps: {
  nowMs: number;
  businessHours: BusinessHoursConfig;
  /** This tick's result from `runLowVolumeCheck`, or the step's unmeasured fallback. */
  volume: LowVolumeResult;
  /** `verdict:low-booking-volume`'s stamp: null when absent, epoch 0 when unparseable. */
  readLastVerdictMs: () => Promise<number | null>;
  notify: ThrottledNotify;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<VolumeVerdictGapResult> {
  if (deps.volume.status === "checked") return { status: "concluded" };
  if (!isBusinessHours(deps.nowMs, deps.businessHours)) return { status: "closed" };
  if (deps.volume.status === "count-unreadable") return { status: "covered" };

  const lastVerdictMs = await deps.readLastVerdictMs();
  if (lastVerdictMs === null) return { status: "never-stamped" };

  const openMinutes = openMinutesBetween(lastVerdictMs, deps.nowMs, deps.businessHours);
  deps.log?.({ volume_status: deps.volume.status, open_minutes_since_verdict: openMinutes });
  if (openMinutes <= VOLUME_VERDICT_GAP_OPEN_MINUTES) return { status: "within", openMinutes };

  await deps
    .notify(
      VOLUME_VERDICT_GAP_KEY,
      VOLUME_VERDICT_GAP_COOLDOWN_MS,
      formatVolumeVerdictGapAlert(openMinutes, lastVerdictMs, deps.businessHours.zone),
    )
    .catch(logAlertSendFailure(VOLUME_VERDICT_GAP_KEY));
  return { status: "gap", openMinutes, lastVerdictMs };
}

/**
 * The page. It says how much OPEN time went unjudged rather than how long ago the
 * last verdict was, because a wall clock age across a closed Sunday is exactly the
 * number that misled #2049, and it names the last verdict in the org's own zone
 * with its weekday, which is the other half of that misreading.
 */
export function formatVolumeVerdictGapAlert(openMinutes: number, lastVerdictMs: number, zone: string): string {
  const span = openMinutes >= 120 ? `${Math.floor(openMinutes / 60)} hours` : `${openMinutes} minutes`;
  const at = DateTime.fromMillis(lastVerdictMs, { zone });
  const last =
    lastVerdictMs <= 0 || !at.isValid
      ? "and its last verdict cannot be read"
      : `since its last verdict on ${at.toFormat("ccc LLL d")} at ${formatClockTime(at)} ${at.toFormat("ZZZZ")}`;
  return (
    `The low booking volume alarm has reached no verdict for ${span} of open business time, ` +
    `${last}, so nothing is measuring whether customers are booking right now. The monitor ` +
    `lane is running; this check is not concluding. Check the Worker logs for ` +
    `msg="booking volume" and whether its step is failing or being skipped.`
  );
}

/**
 * What the booker offers a lead, as two pure rules both sides share (2026-10-02).
 *
 * `getBucketSlotsWithFallback` (slot-cache.ts) offers the next N open days, N
 * being the stored offered open days (#3922, `days-offered-load.ts`), and, on a
 * rung below a top tier lead's own tier, only the times an advisor without Low is
 * free. The bucket availability page has
 * to say what that produces for each pool, and a second copy of either rule would
 * agree with the booker exactly until one of them changed (L107). So the booker
 * and the page call these, and nothing else decides either question.
 *
 * Pure (luxon and relative imports only), so the node suite drives it directly.
 */
import { DateTime } from "luxon";
import { openDaysWindow, type BusinessWindow, type BusinessHoursException } from "../booking/business-hours.ts";
import { rungExcludesLow } from "../routing/tiers.ts";

/**
 * The wall clock time after which today stops counting toward the offered days
 * (#3438, Dan, 2026-10-06): 6:00pm in New York. Advisors' shifts end before the
 * business closes at 8pm, so in the evening today had no times left and still
 * spent one of the three days, leaving an evening visitor two. Held as a zone and
 * a wall clock minute, never an offset from UTC, so daylight saving moves it
 * with the clock.
 */
export const TODAY_COUNTS_UNTIL = { zone: "America/New_York", minute: 18 * 60 } as const;

/** The cutoff in words, for the admin page that states the rule ("6pm New York
 *  time"), built from the constant so the page cannot drift from it. */
export function todayCountsUntilLabel(): string {
  const h = Math.floor(TODAY_COUNTS_UNTIL.minute / 60);
  const m = TODAY_COUNTS_UNTIL.minute % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const clock = m === 0 ? `${hour12}` : `${hour12}:${String(m).padStart(2, "0")}`;
  const city = TODAY_COUNTS_UNTIL.zone.split("/").pop()!.replace(/_/g, " ");
  return `${clock}${h < 12 ? "am" : "pm"} ${city} time`;
}

/**
 * When the offered window closes (#2840): the end of the `offeredOpenDays`th
 * open day. The count is passed in, never read here, so every caller states which
 * reading of the stored setting it used (#3922). Today counts only before
 * `TODAY_COUNTS_UNTIL` (#3438), and before that only while a booking can still
 * start before it closes (now plus the event's minimum notice). After the cutoff
 * the count starts from tomorrow's start in New York, so a strip opened at 6:30pm
 * offers the next N open days; any time today still holds is still served, since the window bounds
 * only how far ahead the strip reaches. Null when the org's week holds no such
 * day, and then the booker imposes no window at all.
 */
export function offeredWindowEndFor(
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  nowMs: number,
  minNoticeMin: number,
  offeredOpenDays: number,
): number | null {
  return offeredWindowFor(hours, nowMs, minNoticeMin, offeredOpenDays)?.endMs ?? null;
}

/**
 * The offered window with the org local dates it COUNTS (#3559), from the same
 * walk as `offeredWindowEndFor`. The monitor judges a tier and a pool over these
 * days and names them, so what a page says a lead can see is what the booker
 * shows. After the cutoff today is not among them, although any time it still
 * holds is served: those leftovers are not one of the days a lead is offered.
 */
export function offeredWindowFor(
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  nowMs: number,
  minNoticeMin: number,
  offeredOpenDays: number,
): { endMs: number; days: string[] } | null {
  const earliestStartMs = nowMs + minNoticeMin * 60_000;
  const local = DateTime.fromMillis(nowMs, { zone: TODAY_COUNTS_UNTIL.zone });
  const pastCutoff = local.hour * 60 + local.minute >= TODAY_COUNTS_UNTIL.minute;
  const countFromMs = pastCutoff
    ? Math.max(earliestStartMs, local.plus({ days: 1 }).startOf("day").toMillis())
    : earliestStartMs;
  return openDaysWindow(hours, countFromMs, offeredOpenDays);
}

/**
 * The times rung `rungCode` may offer a lead who asked for `requestedCode`
 * (#2842): its whole list, or, on a rung below a top tier lead's own tier, only
 * the times an advisor without Low is free. An unknown second list offers
 * nothing, so the rung is skipped rather than showing the lead advisors the rule
 * keeps away.
 */
export function servedSlotsForRung(
  requestedCode: string,
  rungCode: string,
  row: { slots: string[]; slotsWithoutLow?: string[] },
): string[] {
  if (!rungExcludesLow(requestedCode, rungCode)) return row.slots;
  return row.slotsWithoutLow ?? [];
}

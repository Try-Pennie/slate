/**
 * What the booker offers a lead, as two pure rules both sides share (2026-10-02).
 *
 * `getBucketSlotsWithFallback` (slot-cache.ts) offers the next
 * `OFFERED_OPEN_DAYS` open days and, on a rung below a top tier lead's own tier,
 * only the times an advisor without Low is free. The bucket availability page has
 * to say what that produces for each pool, and a second copy of either rule would
 * agree with the booker exactly until one of them changed (L107). So the booker
 * and the page call these, and nothing else decides either question.
 *
 * Pure (luxon and relative imports only), so the node suite drives it directly.
 */
import { openDaysWindowEndMs, type BusinessWindow, type BusinessHoursException } from "../booking/business-hours.ts";
import { OFFERED_OPEN_DAYS } from "./bookable-days.ts";
import { rungExcludesLow } from "../routing/tiers.ts";

/**
 * When the offered window closes (#2840): the end of the `OFFERED_OPEN_DAYS`th
 * open day, counting today only while a booking can still start before it
 * closes (now plus the event's minimum notice). Null when the org's week holds
 * no such day, and then the booker imposes no window at all.
 */
export function offeredWindowEndFor(
  hours: { zone: string; rules: BusinessWindow[]; exceptions: BusinessHoursException[] },
  nowMs: number,
  minNoticeMin: number,
): number | null {
  return openDaysWindowEndMs(hours, nowMs + minNoticeMin * 60_000, OFFERED_OPEN_DAYS);
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

import { DateTime } from "luxon";
import { formatClockTime } from "../date/parse.ts";

/**
 * Shared slot LABELS (#635). Booker, ManageBooking and AdminBookingActions each
 * rolled their own bare-weekday label ("Thu 2:30 PM"); these are the one time and
 * one day format they all read from.
 *
 * `timeZone` is optional: omit it to use the machine zone, or pass the viewer's
 * selected zone. Grouping slots into days now lives in
 * `@/lib/booking/slot-picker` (`slotsByViewerDay`), which the shared picker
 * (#1336) is built on, so there is one implementation rather than a second copy
 * here that only the reschedule panels used.
 */

/**
 * Time-only label for a slot button, e.g. `2:30pm`.
 *
 * It reads the ONE spelling from `@/lib/date/parse` (#1765). It used to build its
 * own with `Intl.DateTimeFormat`, which answers `2:30 PM`, and that is the label on
 * every slot button in the booker and both reschedule panels. The confirmation
 * sentence beside it has always been lowercase, so a lead met two spellings of one
 * time on the same screen. The issue lists five places that disagreed; this was a
 * sixth, and the only one a customer sees twice at once.
 */
export function formatSlotTime(iso: string, timeZone?: string): string {
  const dt = DateTime.fromISO(iso, timeZone ? { zone: timeZone } : undefined);
  return formatClockTime(dt) ?? "";
}

/** Dated day heading for a slot group, e.g. "Thu, Jul 3". */
export function formatSlotDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}


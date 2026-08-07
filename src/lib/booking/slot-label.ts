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

/** Time-only label for a slot button, e.g. "2:30 PM". */
export function formatSlotTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
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


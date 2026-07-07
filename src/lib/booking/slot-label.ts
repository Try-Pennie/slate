/**
 * Shared slot presentation for the reschedule grids (#635). Booker, ManageBooking
 * and AdminBookingActions each rolled their own bare-weekday label
 * ("Thu 2:30 PM") and silently sliced the list; this centralises the label and
 * groups slots under dated day headings so nothing is ambiguous or dropped.
 *
 * `timeZone` is optional: omit it (AdminBookingActions) to use the machine zone,
 * or pass the viewer's selected zone (ManageBooking). Day boundaries are computed
 * in that same zone so a late-evening slot lands on the right calendar day.
 */

/** One day's worth of slots, headed by its date. */
export interface SlotDay {
  /** Stable YYYY-MM-DD key in the target zone, for React keys + ordering. */
  key: string;
  /** Human day heading, e.g. "Thu, Jul 3". */
  heading: string;
  /** The day's slot ISO strings, in input order. */
  slots: string[];
}

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

/** Stable YYYY-MM-DD key for a slot in the target zone (en-CA yields ISO order). */
function dayKey(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Group availability slots into ordered, dated day sections so every time renders
 * under a heading that carries its date and the whole horizon shows without a
 * silent cap (#635). Slots are assumed already sorted ascending; day order is
 * enforced by the lexical key regardless.
 */
export function groupSlotsByDay(slots: string[], timeZone?: string): SlotDay[] {
  const byKey = new Map<string, SlotDay>();
  for (const iso of slots) {
    const key = dayKey(iso, timeZone);
    let day = byKey.get(key);
    if (!day) {
      day = { key, heading: formatSlotDay(iso, timeZone), slots: [] };
      byKey.set(key, day);
    }
    day.slots.push(iso);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

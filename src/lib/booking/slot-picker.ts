/**
 * The pure rules behind the ONE shared slot picker (#1336).
 *
 * The booker (`/book`), the lead reschedule panel (`/booking/manage/[token]`)
 * and the admin reschedule panel each owned a private copy of "which days are
 * offerable, which times belong to a day, and what to show while that is
 * loading". Nothing forced the four copies to agree, they had drifted, and the
 * drift was what a lead saw. Everything decidable without React lives here so
 * there is one implementation to fix and one to test.
 *
 * Pure on purpose (relative imports only, so `node --experimental-strip-types`
 * can run `scripts/test-slot-picker.ts` against it with no module mocking).
 */
import { DateTime } from "luxon";
import { splitByLeadCallingWindow } from "./lead-calling-window.ts";

/** One day the picker is offering, ready to draw as a chip. */
export interface DayChip {
  /** YYYY-MM-DD in the viewer's zone. The day's identity everywhere. */
  iso: string;
  /** Small uppercase lead label: TODAY on day zero, else the weekday. */
  label: string;
  /** The day number, the large figure on the chip. */
  day: string;
  /** Short uppercase month. Present on EVERY chip, whether or not it is shown,
   *  because the chip RESERVES the line rather than omitting it: a strip that
   *  gains a line on the first of the month grows taller as a lead watches. */
  month: string;
  /** True when one or more offerable-day gaps sit between the previous chip and
   *  this one, so a skipped closed day is visible rather than silently absent.
   *  Never true on the first chip: there is nothing before it to have skipped. */
  gapBefore: boolean;
}

/**
 * The days to draw, in order, from the days the API can actually offer.
 *
 * The strip used to render a fixed seven day window from today and grey out the
 * days that were not bookable. It renders the bookable days themselves now, so
 * there is no greyed remainder to explain, and since #1326 the furthest offered
 * day counts BOOKABLE days and can fall outside any fixed window (#1330).
 */
export function dayChips(days: string[], today: DateTime, zone: string): DayChip[] {
  const todayIso = today.startOf("day").toISODate();
  return days.map((iso, i) => {
    const d = DateTime.fromISO(iso, { zone });
    const prev = i > 0 ? DateTime.fromISO(days[i - 1], { zone }) : null;
    return {
      iso,
      label: iso === todayIso ? "TODAY" : d.toFormat("ccc").toUpperCase(),
      day: d.toFormat("d"),
      month: d.toFormat("LLL").toUpperCase(),
      gapBefore:
        prev !== null &&
        Math.round(d.startOf("day").diff(prev.startOf("day"), "days").days) > 1,
    };
  });
}

/**
 * Slots grouped under their day, keyed in the VIEWER's zone so a late-evening
 * slot lands on the day they see it on, and ordered ascending by day.
 *
 * The one place a slot is turned into a day. The three surfaces did it three
 * different ways before this (Luxon in the selected zone, Intl in the selected
 * zone, Intl in the MACHINE zone), so the same slot could sit under a different
 * day heading depending on which surface a lead was looking at.
 */
export function slotsByViewerDay(slots: string[], zone: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const iso of slots) {
    const key = DateTime.fromISO(iso).setZone(zone).toISODate();
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(iso);
    else map.set(key, [iso]);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The served times, split by the lead's calling window (#2310), and grouped for
 * the strip. The ONE place a picker surface applies the window, so the booker
 * and both reschedule panels cannot filter three different ways.
 *
 * Two zones on purpose. Days are grouped in the VIEWER's zone (what the strip
 * shows); the window is judged in the LEAD's zone. On the booker and the manage
 * page those are the same zone. On the admin panel the viewer is staff and the
 * lead is the person on the booking, and judging the window in the admin's own
 * zone is exactly the mistake this gate exists to prevent.
 *
 * A day stays on the strip when it has ANY served time, including one whose
 * every time is outside the window, so choosing it can say why rather than the
 * day silently vanishing or reading as fully booked.
 *
 * The availability response itself is never filtered per zone: it is served
 * from a shared cache, and a per zone variant would split that cache seven ways.
 * The server refuses an outside start at confirm, so this is the convenience and
 * the refusal is the rule.
 */
export function pickerSlots(
  slots: string[],
  viewerZone: string,
  leadZone: string,
): {
  days: string[];
  offered: string[];
  offeredByDay: Map<string, string[]>;
  outsideByDay: Map<string, string[]>;
} {
  const { offered, outside } = splitByLeadCallingWindow(slots, leadZone);
  const offeredByDay = slotsByViewerDay(offered, viewerZone);
  const outsideByDay = slotsByViewerDay(outside, viewerZone);
  const days = [...new Set([...offeredByDay.keys(), ...outsideByDay.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  return { days, offered, offeredByDay, outsideByDay };
}

/** The distinct days that have at least one slot, ascending. */
export function daysWithSlots(slots: string[], zone: string): string[] {
  return [...slotsByViewerDay(slots, zone).keys()];
}

/**
 * What the times area is showing. One discriminated union rather than a chain of
 * booleans per surface, so a state cannot be handled on one surface and missed
 * on another, and so `pick-a-day` structurally carries no slots.
 */
export type SlotPickerView =
  | { kind: "loading" }
  | { kind: "failed" }
  /** Settled, and nothing at all is bookable. The strip draws nothing (#261). */
  | { kind: "no-days" }
  /** Days are offered and none has been chosen. THE rule this exists to hold. */
  | { kind: "pick-a-day" }
  /** A chosen day whose times have all gone. Names the day so the copy can. */
  | { kind: "day-empty"; day: string }
  /** A chosen day that has free times, every one of them outside the lead's
   *  calling window (#2310). Its own state, because "nothing left" would be
   *  untrue: the times exist, and we will not call the lead at them. */
  | { kind: "outside-calling-hours"; day: string }
  | { kind: "times"; day: string; slots: string[] };

/**
 * Decide the view. Precedence matters and is asserted in the tests:
 *
 *  - loading beats a stale failure, so a retry reads as working, not broken;
 *  - a failure is never reported as an empty week (an error state and an empty
 *    state are different screens);
 *  - a selection that is no longer offered (its last time went while the lead
 *    read the page) returns them to the strip rather than showing a message
 *    about a day the strip no longer draws.
 */
export function slotPickerView(input: {
  loading: boolean;
  failed: boolean;
  /** Days being offered, ascending, as `daysWithSlots` returns them. */
  days: string[];
  selectedDay: string | null;
  /** The selected day's OFFERABLE slots. Empty when nothing is selected. */
  slotsForDay: string[];
  /** How many of the selected day's served times fall outside the lead's
   *  calling window (#2310). Required, so every caller decides it. */
  outsideForDay: number;
}): SlotPickerView {
  if (input.loading) return { kind: "loading" };
  if (input.failed) return { kind: "failed" };
  if (input.days.length === 0) return { kind: "no-days" };
  const day = input.selectedDay;
  if (!day || !input.days.includes(day)) return { kind: "pick-a-day" };
  if (input.slotsForDay.length === 0) {
    return input.outsideForDay > 0 ? { kind: "outside-calling-hours", day } : { kind: "day-empty", day };
  }
  return { kind: "times", day, slots: input.slotsForDay };
}

/**
 * Split a short panel message into its sentences, so each renders on its own
 * line instead of the second starting halfway across (#1336). One helper rather
 * than a hand placed break per surface, which is what drifted before.
 */
export function messageLines(text: string): string[] {
  return text
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

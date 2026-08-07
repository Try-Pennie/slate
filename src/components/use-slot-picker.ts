"use client";

import { useMemo, useState } from "react";

import { useFetchList } from "@/components/AsyncList";
import {
  slotsByViewerDay,
  slotPickerView,
  type SlotPickerView,
} from "@/lib/booking/slot-picker";

/**
 * The one slot picker (#1336).
 *
 * The booker and the two reschedule panels each owned a private copy of the
 * fetch, the race guard, the day grouping and the loading / failed / empty
 * states. Three columns of the same table, and they had drifted: one grouped
 * with Luxon in the viewer's zone, one with Intl in the viewer's zone, one with
 * Intl in the MACHINE zone, so the same slot could sit under a different day
 * heading depending on which surface a lead was looking at.
 *
 * Everything decidable without React lives in `@/lib/booking/slot-picker` and is
 * unit tested there. This hook is the React binding: it reuses `useFetchList`
 * for the abort + supersession guard (rather than adding a fourth copy of it),
 * and owns the chosen day.
 *
 * The rule it holds: **no day is chosen until the viewer chooses one.** The
 * booker used to derive its active day from the first available one, so a lead
 * landed on a list of bare clock faces. A time carries no date, so that let
 * someone pick 10:00 on a day they never looked at.
 */

/** Every surface reads its times out of the same `/api/availability` field. */
const extractSlots = (json: unknown): string[] =>
  (json as { slots?: string[] } | null)?.slots ?? [];

export interface SlotPicker {
  /** What the times area should show. Feed it straight to `SlotTimes`. */
  view: SlotPickerView;
  /** The days on offer, ascending, for the day strip. */
  days: string[];
  /** The chosen day, or null until one is chosen. */
  selectedDay: string | null;
  /** Choose a day (or clear the choice with null). */
  selectDay: (iso: string | null) => void;
  /** Re-run the load after a failure. */
  retry: () => void;
  /** The last availability body that parsed, kept across a later load, for the
   *  surfaces that read the org name / event type out of the same response. */
  payload: unknown;
}

export function useSlotPicker({
  url,
  zone,
}: {
  /** The availability URL, or null to load nothing (an unopened panel, or a
   *  month entirely beyond the booking horizon: both settle as `no-days`
   *  rather than sitting in a loading state that never resolves). */
  url: string | null;
  /** The viewer's zone. Days are grouped in it, so a late-evening slot lands on
   *  the day they see it on. */
  zone: string;
}): SlotPicker {
  const { items: slots, loading, error, retry, payload } = useFetchList(
    url,
    url !== null,
    extractSlots,
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const slotsByDay = useMemo(() => slotsByViewerDay(slots, zone), [slots, zone]);

  const days = useMemo(() => [...slotsByDay.keys()], [slotsByDay]);

  const view = slotPickerView({
    loading,
    failed: error,
    days,
    selectedDay,
    slotsForDay: selectedDay ? (slotsByDay.get(selectedDay) ?? []) : [],
  });

  return { view, days, selectedDay, selectDay: setSelectedDay, retry, payload };
}

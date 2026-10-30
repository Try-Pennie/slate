"use client";

import { useMemo, useState } from "react";

import { testPassHeaders, testPassRefusalSentence } from "@/lib/embed/test-pass-header";
import { agentLinkRefusalSentence } from "@/lib/agent-link/refusal-sentence";
import { rescheduleTimesRefusalSentence } from "@/lib/booking/reschedule-times-refusal";
import { programLeadHeaders, programLeadTimesUrl } from "@/lib/booking/program-lead-header";

import { useFetchList } from "@/components/AsyncList";
import {
  pickerSlots,
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
  /** Every time currently on offer, flat and ungrouped (#1319).
   *
   *  Exposed so a caller can answer "what is the soonest thing still free" without
   *  re-fetching or keeping a second copy of the availability. The day grouping and the
   *  no-times-before-a-day rule stay in this hook; this is the same data underneath it. */
  slots: string[];
  /** The chosen day, or null until one is chosen. */
  selectedDay: string | null;
  /** Choose a day (or clear the choice with null). */
  selectDay: (iso: string | null) => void;
  /** Re-run the load after a failure. */
  retry: () => void;
  /** The last availability body that parsed, kept across a later load, for the
   *  surfaces that read the org name / event type out of the same response. */
  payload: unknown;
  /**
   * The sentence to show INSTEAD of the ordinary "could not load" when the read
   * failed because the public test bucket's pass was refused (#2666), or null. A
   * retry cannot fix that failure, so a surface showing it offers no retry.
   */
  failedMessage: string | null;
}

export function useSlotPicker({
  url,
  zone,
  leadZone,
  slotsOverride = null,
  testPass = null,
  programLeadToken = null,
}: {
  /** The availability URL, or null to load nothing (an unopened panel, or a
   *  month entirely beyond the booking horizon: both settle as `no-days`
   *  rather than sitting in a loading state that never resolves). */
  url: string | null;
  /** The viewer's zone. Days are grouped in it, so a late-evening slot lands on
   *  the day they see it on. */
  zone: string;
  /**
   * The LEAD's zone, which the calling window (#2310) is judged in. The same as
   * `zone` on the booker and the manage page; the booking's own zone on the
   * admin panel, whose viewer is staff. Required, so every surface decides it.
   */
  leadZone: string;
  /**
   * Slots to show INSTEAD of the fetched ones, for a caller that obtained them
   * elsewhere: the far side of a closure comes from `/api/availability/next`
   * (#1329), which is a different, on-demand search.
   *
   * Routed through this hook rather than rendered by a second strip and times
   * panel, so the chosen day, the grouping and the no-times-before-a-day rule stay
   * in ONE place. A private copy for the closure state is exactly the divergence
   * #1336 removed. Null means "use the fetched slots"; an empty array means the
   * caller looked and found nothing, which is a settled answer, not a load.
   */
  slotsOverride?: string[] | null;
  /**
   * The public test bucket's pass (#2666), sent as a header on the read. Null for
   * every other bucket, whose read is sent exactly as it always was. The booker has
   * it from `/book`; the manage page and the admin panel mint one server side for a
   * test booking, because their viewer is already authorised by the token or the
   * staff session.
   */
  testPass?: string | null;
  /**
   * A program lead's token (#4390), sent as a header so the address never carries it,
   * with the lead's zone added to the address so the placeholder's starts are judged in
   * it and a change of zone reads again. Null for every other lead, whose read is sent
   * exactly as it always was.
   */
  programLeadToken?: string | null;
}): SlotPicker {
  // Memoised on the pass and the token, since the headers object is part of the fetch's
  // deps and a new object each render would refetch for ever.
  const headers = useMemo(() => {
    const pass = testPassHeaders(testPass);
    const program = programLeadHeaders(programLeadToken);
    return pass || program ? { ...pass, ...program } : undefined;
  }, [testPass, programLeadToken]);
  const readUrl = url === null ? null : programLeadTimesUrl(url, programLeadToken, leadZone);
  const { items: fetched, loading: fetching, error, retry, payload, errorPayload } = useFetchList(
    readUrl,
    readUrl !== null,
    extractSlots,
    headers,
  );
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // An override is a settled answer the caller already has, so it also settles the
  // loading and failed states: leaving `loading` true would show a working signal
  // over days that are already on screen.
  const overridden = slotsOverride !== null;
  const slots = overridden ? slotsOverride : fetched;
  const loading = overridden ? false : fetching;
  const failed = overridden ? false : error;

  // #2310: split by the lead's calling window HERE, once, for every surface. A
  // change of either zone re-derives it, so a lead switching zone sees the list
  // re-filtered on the same render.
  const split = useMemo(() => pickerSlots(slots, zone, leadZone), [slots, zone, leadZone]);

  const view = slotPickerView({
    loading,
    failed,
    days: split.days,
    selectedDay,
    slotsForDay: selectedDay ? (split.offeredByDay.get(selectedDay) ?? []) : [],
    outsideForDay: selectedDay ? (split.outsideByDay.get(selectedDay)?.length ?? 0) : 0,
  });

  // `slots` is the OFFERABLE list, so "the soonest thing still free" (#1319) can
  // never suggest a time the lead's window refuses.
  return {
    view,
    days: split.days,
    slots: split.offered,
    selectedDay,
    selectDay: setSelectedDay,
    retry,
    payload,
    // #2073: or because an agent's own link stopped booking anybody while the
    // page was open, or (#2827) because a booking keyed move times read found no
    // advisor booking to serve. All are refusals a retry cannot fix.
    failedMessage: failed
      ? (testPassRefusalSentence(errorPayload) ??
        agentLinkRefusalSentence(errorPayload) ??
        rescheduleTimesRefusalSentence(errorPayload))
      : null,
  };
}

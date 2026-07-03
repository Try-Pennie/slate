import { DateTime } from "luxon";
import type { GoogleEvent } from "./calendar.ts";

/**
 * Pure helpers for calendar sync (no IO), so the busy/stale logic is testable.
 */

/**
 * Expand a Google all-day date (date-only, no time) to the UTC instant of local
 * midnight in `timeZone`. Google all-day dates are date-only and its `end.date`
 * is EXCLUSIVE (the day after the last day), so anchoring both ends to the
 * agent's local midnight blocks exactly the agent's all-day OOO/holiday with no
 * bleed into adjacent days. Anchoring to UTC midnight (the old behavior) shifted
 * the block by the agent's offset, leaving the tail of a non-UTC agent's all-day
 * event bookable and wrongly blocking the neighbouring evening (#616). Falls
 * back to UTC midnight if the zone is unusable.
 */
function allDayToUtc(date: string, timeZone: string): string {
  const dt = DateTime.fromISO(`${date}T00:00:00`, { zone: timeZone });
  return dt.isValid ? dt.toUTC().toISO()! : `${date}T00:00:00.000Z`;
}

/**
 * The [start, end) window of an event, or null if it has no usable times.
 * `timeZone` anchors all-day (date-only) events to the agent's local midnight;
 * it has no effect on timed events. Defaults to UTC so callers that only need
 * null-ness (isBusyEvent) can omit it.
 */
export function eventWindow(
  ev: GoogleEvent,
  timeZone = "UTC",
): { start: string; end: string } | null {
  const start = ev.start?.dateTime ?? ev.start?.date;
  const end = ev.end?.dateTime ?? ev.end?.date;
  if (!start || !end) return null;
  return {
    start: ev.start?.dateTime ? start : allDayToUtc(start, timeZone),
    end: ev.end?.dateTime ? end : allDayToUtc(end, timeZone),
  };
}

/** Whether an event should occupy a busy block (not cancelled/free/timeless). */
export function isBusyEvent(ev: GoogleEvent): boolean {
  return (
    ev.status !== "cancelled" &&
    ev.transparency !== "transparent" &&
    eventWindow(ev) !== null
  );
}

export type BusyBlockRow = {
  user_id: string;
  gcal_event_id: string;
  calendar_id: string;
  source: "gcal";
  starts_at: string;
  ends_at: string;
};

/**
 * Split a batch of events into the busy-block rows to upsert and the event ids
 * to delete (cancelled/free/timeless). Pure, so `applyEvents` can persist them
 * in BULK — one batched DB call per chunk instead of one write per event. The
 * old per-event loop made 1,000+ serial writes on a large calendar's bootstrap
 * and tripped the Worker's per-request ceiling, so the sync token never
 * advanced and the login that awaited it hung.
 */
export function partitionBusyWrites(
  userId: string,
  calendarId: string,
  events: GoogleEvent[],
  slateEventIds: Set<string> = new Set(),
  timeZone = "UTC",
): { upserts: BusyBlockRow[]; deletes: string[] } {
  const upserts: BusyBlockRow[] = [];
  const deletes: string[] = [];
  for (const ev of events) {
    if (!ev.id) continue;
    // #166: an event Slate itself created for a booking is already represented by
    // that booking's source=slate block (the single owner of the slot). Skip it
    // entirely — never mirror it into a second source=gcal block (the double-count
    // bug), and never queue it for delete, since the booking flow owns the block's
    // lifecycle (cancel/reschedule remove it by booking_id, not via the sync).
    if (slateEventIds.has(ev.id)) continue;
    if (!isBusyEvent(ev)) {
      deletes.push(ev.id);
      continue;
    }
    const win = eventWindow(ev, timeZone)!;
    upserts.push({
      user_id: userId,
      gcal_event_id: ev.id,
      calendar_id: calendarId,
      source: "gcal",
      starts_at: win.start,
      ends_at: win.end,
    });
  }
  return { upserts, deletes };
}

/**
 * Cached gcal blocks that no longer correspond to a present event — used after
 * a FULL resync to purge events that vanished while the sync token was stale
 * (a full resync returns the current set, with no per-event cancellation delta).
 */
export function staleBlockIds(
  blocks: { id: string; gcal_event_id: string | null }[],
  seenEventIds: Set<string>,
): string[] {
  return blocks
    .filter((b) => b.gcal_event_id !== null && !seenEventIds.has(b.gcal_event_id))
    .map((b) => b.id);
}

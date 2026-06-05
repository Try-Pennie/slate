import type { GoogleEvent } from "./calendar.ts";

/**
 * Pure helpers for calendar sync (no IO), so the busy/stale logic is testable.
 */

/** The [start, end) window of an event, or null if it has no usable times. */
export function eventWindow(
  ev: GoogleEvent,
): { start: string; end: string } | null {
  const start = ev.start?.dateTime ?? ev.start?.date;
  const end = ev.end?.dateTime ?? ev.end?.date;
  if (!start || !end) return null;
  return {
    start: ev.start?.dateTime ? start : `${start}T00:00:00.000Z`,
    end: ev.end?.dateTime ? end : `${end}T00:00:00.000Z`,
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

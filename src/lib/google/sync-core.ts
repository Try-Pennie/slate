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
): { upserts: BusyBlockRow[]; deletes: string[] } {
  const upserts: BusyBlockRow[] = [];
  const deletes: string[] = [];
  for (const ev of events) {
    if (!ev.id) continue;
    if (!isBusyEvent(ev)) {
      deletes.push(ev.id);
      continue;
    }
    const win = eventWindow(ev)!;
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

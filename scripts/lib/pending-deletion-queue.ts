// A stateful `pending_event_deletions` table for the deletion drain suites (#2577,
// #1630), shared so the two suites that drive the drain read the same fake rather
// than two copies that drift.
//
// The read applies the same give up filter the real `loadPendingEventDeletions`
// does (`attempts < PENDING_DELETION_GIVE_UP_AT`), and so does the per calendar
// read, so "never retried again" is measured by running a second pass against the
// rows the first pass wrote, rather than by trusting the attempt count alone.
import {
  PENDING_DELETION_GIVE_UP_AT,
  type BookingDeps,
  type PendingEventDeletion,
} from "../../src/lib/booking/orchestration.ts";
import { GoogleHttpError } from "../../src/lib/google/http-error.ts";
import { makeDeps } from "./booking-fakes.ts";

export function pendingRow(
  id: string,
  email: string,
  eventId: string,
  attempts = 0,
  bookingId: string | null = null,
): PendingEventDeletion {
  return {
    id,
    calendar_email: email,
    gcal_event_id: eventId,
    booking_id: bookingId,
    attempts,
    last_error: attempts > 0 ? "events.delete failed: 503 backendError" : null,
    created_at: "2026-09-21T00:00:00.000Z",
    updated_at: "2026-09-21T00:00:00.000Z",
  };
}

// The same shapes src/lib/google/calendar.test.ts proves `deleteEvent` throws for
// a 403 notACalendarUser, a 401 and a 503 (#2561).
export const NOT_PROVISIONED = () =>
  new GoogleHttpError(
    'events.delete failed: 403 {"error":{"errors":[{"reason":"notACalendarUser"}]}}',
    403,
    "notACalendarUser",
  );
export const GONE = () => new GoogleHttpError("events.delete failed: 401 unauthorized", 401, "unauthorized");
export const TRANSIENT = () => new GoogleHttpError("events.delete failed: 503 backendError", 503, "backendError");

export interface QueueOptions {
  /** Event id to the live booking that holds it (#3215). */
  holders?: Map<string, string>;
  /** Make the per calendar read refuse, the way a failed PostgREST read throws. */
  calendarReadFails?: boolean;
}

/** A pending_event_deletions table the drain reads and writes across passes. */
export function pendingDeletionQueue(
  rows: PendingEventDeletion[],
  failWith: (email: string) => unknown | null,
  opts: QueueOptions = {},
) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const deletes: string[] = [];
  const bumps: { id: string; attempts: number; error: string }[] = [];
  const calendarReads: { email: string; limit: number }[] = [];
  const pending = () => [...table.values()].filter((r) => r.attempts < PENDING_DELETION_GIVE_UP_AT);
  const { deps: base } = makeDeps({});
  const deps: BookingDeps = {
    ...base,
    loadPendingEventDeletions: async (limit) =>
      pending()
        .sort((a, b) => a.attempts - b.attempts)
        .slice(0, limit),
    loadPendingEventDeletionsForCalendar: async (email, limit) => {
      calendarReads.push({ email, limit });
      if (opts.calendarReadFails) throw new Error("loadPendingEventDeletionsForCalendar: canceling statement due to statement timeout");
      return pending()
        .filter((r) => r.calendar_email === email)
        .slice(0, limit);
    },
    liveBookingHoldingEvent: async (eventId) => opts.holders?.get(eventId) ?? null,
    deleteEvent: async (email, eventId) => {
      deletes.push(eventId);
      const err = failWith(email);
      if (err) throw err;
    },
    removePendingEventDeletion: async (id) => {
      table.delete(id);
    },
    bumpPendingEventDeletion: async (id, attempts, error) => {
      const r = table.get(id);
      if (!r) throw new Error(`bump on a row the table does not hold: ${id}`);
      r.attempts = attempts;
      r.last_error = error;
      bumps.push({ id, attempts, error });
    },
  };
  return { deps, table, deletes, bumps, calendarReads };
}

import { DateTime } from "luxon";
import type { GoogleEvent } from "./calendar.ts";
import { parseStampMs } from "@/lib/date/stamp";

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

/** Parse an instant in `timeZone`, falling back to UTC when the zone is unusable
 *  (same tolerance as allDayToUtc). */
function inZone(iso: string, timeZone: string): DateTime {
  const dt = DateTime.fromISO(iso, { zone: timeZone });
  return dt.isValid ? dt : DateTime.fromISO(iso, { zone: "UTC" });
}

/**
 * Read the all-day convention back off an ALREADY-STORED busy block (#744): a
 * block is all-day when both ends land exactly on local midnight in the agent's
 * own timezone, which is precisely what allDayToUtc writes. Used by staffing
 * depth to treat a Google-native all-day OOO as "out today", not just an
 * approved Slate `ooo_requests` row.
 *
 * Anchoring on local midnight (rather than checking for a 24-hour duration) is
 * what makes this DST-correct: a fall-back day is 25 hours long and a
 * spring-forward day 23, yet both are all-day. Reading the block in the WRONG
 * zone correctly yields false, so one agent's all-day event can never discount
 * an agent in another timezone.
 */
export function isAllDayBlock(startsAt: string, endsAt: string, timeZone: string): boolean {
  const start = inZone(startsAt, timeZone);
  const end = inZone(endsAt, timeZone);
  if (!start.isValid || !end.isValid || end <= start) return false;
  return start.equals(start.startOf("day")) && end.equals(end.startOf("day"));
}

/**
 * The agent's OWN answer to an invitation, or undefined when the event carries
 * no entry for them (#2389).
 *
 * Whose entry it is decides, which is why this looks for `self` and nothing
 * else. Google sets `self: true` on the entry belonging to the calendar being
 * read, so under domain-wide delegation it is the impersonated agent's own
 * answer; another guest declining says nothing about whether this agent will be
 * in the room. There is deliberately no fallback to matching the agent's email:
 * a wrong match would read somebody else's answer as theirs, and `self` is the
 * only field that carries the fact without us having to recompute it.
 */
function selfResponseStatus(ev: GoogleEvent): string | undefined {
  return ev.attendees?.find((a) => a.self)?.responseStatus;
}

/**
 * Whether an event should occupy a busy block (not cancelled/free/timeless, and
 * not one the agent has declined).
 *
 * #2389: a declined invitation stays on the calendar with `status: "confirmed"`
 * and the default `transparency: "opaque"`, so every other gate here says
 * "busy". A company wide invite an agent declined in order to keep taking calls
 * blocked their whole hour and the round robin routed past them.
 *
 * The three answers that are NOT a decline are decided here deliberately, rather
 * than left to fall out of the code, because an unstated decision is one nobody
 * can find later:
 *
 * - `tentative` ("maybe") stays BUSY. The agent may well attend, so offering the
 *   slot risks putting a lead against a call the agent then takes.
 * - `needsAction` (invited, not answered) stays BUSY, for the same reason: not
 *   having answered is not saying they will not be there.
 * - a MISSING `self` entry stays BUSY. Google omits it in some payloads, and
 *   treating "we could not find the agent's answer" as a decline would free a
 *   slot on a meeting they are actually in. Withholding a slot is recoverable;
 *   double booking an agent is not (L93: name which way the fallback is wrong).
 *
 * An event with no attendees at all is the agent's own blocked time and is
 * unaffected: it has no `self` entry, so it takes the same busy direction.
 *
 * The other reader AGREES, and that was MEASURED rather than assumed. #2389 was
 * filed with the caveat that no Google page states in words whether free/busy,
 * which verify-on-book uses at confirm time (`hasBlockingBusy` via
 * `freeBusyMany`), also omits a declined event; if it did not, the booker would
 * offer a time the final check then refused. Read live on 2026-09-16 against 11
 * real agent calendars: 6 declined opaque timed events with NOTHING overlapping
 * them (busy periods MERGE, so a neighbouring meeting would have answered for
 * the window) came back FREE from free/busy, 6 of 6. The positive control ran on
 * the same calendars through the same call: an accepted opaque event with
 * nothing overlapping it came back BUSY, 6 of 6, so "free" is a reading and not
 * a read that answers free for everything (L1). So free/busy has been ignoring
 * declines all along and the cache was the only reader that did not.
 */
export function isBusyEvent(ev: GoogleEvent): boolean {
  return (
    ev.status !== "cancelled" &&
    ev.transparency !== "transparent" &&
    selfResponseStatus(ev) !== "declined" &&
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
 * How many of `upserts` MOVE busy time against the rows already stored (#3258): a
 * row with no stored counterpart, or one whose start or end differs. Google
 * redelivers an event for a title or description edit with the same times, and an
 * upsert of it changes nothing any slot compute reads. Compared as instants, never
 * as strings, because the store answers `+00:00` where the event wrote `Z`; an
 * unreadable or missing stamp on either side counts as moved, the side that never
 * under refreshes.
 */
export function movedBusyRows(
  upserts: BusyBlockRow[],
  stored: { gcal_event_id: string | null; starts_at: string | null; ends_at: string | null }[],
): number {
  const byEvent = new Map(stored.map((r) => [r.gcal_event_id, r]));
  let moved = 0;
  for (const u of upserts) {
    const was = byEvent.get(u.gcal_event_id);
    const same =
      was !== undefined &&
      (() => {
        const a = [parseStampMs(u.starts_at), parseStampMs(u.ends_at)];
        const b = [parseStampMs(was.starts_at), parseStampMs(was.ends_at)];
        return a.every((v) => v !== null) && a[0] === b[0] && a[1] === b[1];
      })();
    if (!same) moved += 1;
  }
  return moved;
}

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
    // #166/#586: an event Slate itself created for a booking is already represented
    // by that booking's source=slate block (the single owner of the slot). Never
    // mirror it into a second source=gcal block (the double-count bug). Queue it for
    // delete so a stray source=gcal mirror is cleared (#586): the kind a push-sync
    // caches while racing the booking's create, before the booking committed. The
    // delete matches gcal rows by gcal_event_id; the booking's own slate block has a
    // null gcal_event_id, so it is never touched (its lifecycle stays with the booking).
    if (slateEventIds.has(ev.id)) {
      deletes.push(ev.id);
      continue;
    }
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
 *
 * SCOPED TO WHAT THE FETCH ASKED FOR (#1261). While the bootstrap was unbounded above,
 * judging every cached block for the calendar was correct. The moment the fetch carries a
 * `timeMax`, a block outside that window was never in the answer, so scoring it "not seen"
 * would delete real busy time for a meeting still sitting in the calendar and leave the
 * agent bookable during it. That is the only way this design can over-delete, which is why
 * the window comes from the pass that actually fetched it and is never re-read from
 * `sync_window_to`: a stored value larger than what was sent would extend the reconcile
 * past the fetch.
 *
 * The two bounds apply to two DIFFERENT fields, quoted from Google's events.list reference:
 * `timeMin` is the "Lower bound (exclusive) for an event's END time" and `timeMax` the
 * "Upper bound (exclusive) for an event's START time". So the fetched set is
 * `ends_at > timeMin AND starts_at < timeMax`. Scoping on `starts_at` for both instead
 * would leave an event that began before `timeMin` but ends after it inside the fetch yet
 * outside the judged range, and its block would then survive this reconcile AND the past
 * prune permanently, over-blocking a readable slot with no code path able to clear it.
 *
 * An unreadable stamp means we cannot tell whether the block was fetched, so it is left
 * alone. `Date.parse` yields NaN and every comparison with NaN is false, so this is stated
 * as an explicit readable-check rather than relying on that accident (L50).
 */
export function staleBlockIds(
  blocks: { id: string; gcal_event_id: string | null; starts_at: string; ends_at: string }[],
  seenEventIds: Set<string>,
  window: { timeMinIso: string; timeMaxIso: string },
): string[] {
  const minMs = parseStampMs(window.timeMinIso);
  const maxMs = parseStampMs(window.timeMaxIso);
  // An unreadable WINDOW deletes nothing at all. It can only arrive from a caller bug, and
  // the safe answer to "which blocks did this fetch cover" when the fetch is unknown is
  // none of them.
  if (minMs === null || maxMs === null) return [];
  return blocks
    .filter((b) => {
      if (b.gcal_event_id === null || seenEventIds.has(b.gcal_event_id)) return false;
      const startsMs = parseStampMs(b.starts_at);
      const endsMs = parseStampMs(b.ends_at);
      // null, not NaN: an unreadable stamp means we cannot tell whether this block was
      // fetched, and the fail-safe answer to that is to leave it alone (L50).
      if (startsMs === null || endsMs === null) return false;
      return endsMs > minMs && startsMs < maxMs;
    })
    .map((b) => b.id);
}

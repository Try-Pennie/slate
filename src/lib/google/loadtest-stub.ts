// Synthetic Google Calendar responses for the 200-agent load test (#273
// Increment 5), gated ENTIRELY behind the SLATE_LOADTEST env flag. It is unset
// in production, so `LOADTEST` is false and none of this runs — the calendar
// client takes its normal real-Google path. With the flag on (only in an
// isolated load-test environment), the sync + watch lanes run end-to-end at 200
// simulated agents without needing real Google accounts.
import type { GoogleEvent, Interval } from "@/lib/google/calendar";
import { parseStampMs } from "@/lib/date/stamp";

export const LOADTEST = process.env.SLATE_LOADTEST === "true";

// How many busy events a bootstrap sync returns per calendar (realistic batch
// the sync lane then writes to busy_blocks). Incrementals return ~nothing.
const HORIZON_MS = 4 * 86_400_000;

/**
 * The synthetic calendar's fixed grid of meetings (#1542): every 18 hours from 30 days behind
 * to 60 days ahead. Fixed, and independent of whatever window a fetch asks for, so a narrower
 * fetch genuinely returns fewer events. At the real 22 day bootstrap window this yields about
 * 30, which is the realistic per-calendar batch the soak was built around.
 */
const CALENDAR_GRID_STEP_MS = 18 * 60 * 60_000;
const CALENDAR_GRID_PAST_MS = 30 * 86_400_000;
const CALENDAR_GRID_SLOTS = Math.floor((30 + 60) * 86_400_000 / CALENDAR_GRID_STEP_MS);

/** One owned primary calendar (what listCalendars would surface). */
export function stubCalendarList(): {
  id: string;
  accessRole: string;
  primary: boolean;
  selected: boolean;
  summary: string;
}[] {
  return [
    { id: "primary", accessRole: "owner", primary: true, selected: true, summary: "primary" },
  ];
}

/**
 * A batch of synthetic busy events.
 *
 * It models the two behaviours Google was MEASURED to have (#1252), which are not the same
 * and are the whole reason the hydration rotation exists:
 *
 *   a BOOTSTRAP is SCOPED to the window it asked for, returning `ends_at > timeMin AND
 *   starts_at < timeMax`, which are two DIFFERENT fields: timeMin bounds an event's end,
 *   timeMax its start;
 *
 *   a DELTA is NOT scoped, so an out-of-window event still arrives, exactly once, and
 *   nothing re-adds it later.
 *
 * Modelling both matters because the soak is the only automated path that runs this code at
 * scale (#1542). While the stub ignored the bounds it answered the same way whatever window
 * it was handed, so the soak could not tell a correctly scoped reconcile from one that
 * deletes cached busy time for meetings still in the calendar.
 *
 * The batch deliberately includes an event straddling each bound and one beyond the window,
 * because those are the cases the reconcile predicate exists for and a generator that only
 * produces comfortable interior events would never exercise it.
 */
export function stubSyncEvents(
  syncToken: string | null,
  nowMs: number,
  window: { timeMinIso: string; timeMaxIso: string },
): { events: GoogleEvent[]; nextSyncToken: string | null; truncated: boolean } {
  const minMs = parseStampMs(window.timeMinIso);
  const maxMs = parseStampMs(window.timeMaxIso);
  // An unreadable window returns NOTHING, not everything. Falling back to the unscoped set
  // would put the soak back where it started while looking like it was testing the bound.
  if (minMs === null || maxMs === null) {
    return { events: [], nextSyncToken: `lt-token-${nowMs}`, truncated: false };
  }

  const make = (id: string, startMs: number, durationMs = 30 * 60_000): GoogleEvent => ({
    id,
    status: "confirmed",
    transparency: "opaque",
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(startMs + durationMs).toISOString() },
  });

  if (syncToken) {
    // The delta. One ordinary in-window change, plus one BEYOND the window, because that is
    // what Google really sends and it is the event a later write filter would drop with
    // nothing to re-add it.
    return {
      events: [
        make(`lt-evt-inc-${nowMs}`, nowMs + HORIZON_MS / 2),
        make(`lt-evt-inc-far-${nowMs}`, maxMs + 7 * 86_400_000),
      ],
      nextSyncToken: `lt-token-${nowMs}`,
      truncated: false,
    };
  }

  // The bootstrap. The events sit on a fixed grid around NOW, deliberately NOT derived from
  // the requested window: a calendar's meetings exist at the times they exist, so a narrower
  // fetch must return FEWER of them. Generating the spread across the window instead would
  // return the same count whatever was asked for, which is indistinguishable from ignoring
  // the bound and is the state this replaces.
  const candidates: GoogleEvent[] = [];
  for (let i = 0; i < CALENDAR_GRID_SLOTS; i++) {
    const slotMs = nowMs - CALENDAR_GRID_PAST_MS + i * CALENDAR_GRID_STEP_MS;
    candidates.push(make(`lt-evt-boot-${i}`, slotMs));
  }
  // Straddling each bound: returned by a real fetch, and the cases a reconcile scoped on the
  // wrong field gets wrong.
  candidates.push(make("lt-evt-boot-straddle-lower", minMs - 2 * 60 * 60_000, 4 * 60 * 60_000));
  candidates.push(make("lt-evt-boot-straddle-upper", maxMs - 2 * 60 * 60_000, 4 * 60 * 60_000));
  // Entirely outside, both ways: NOT returned, so a cached block for one must survive the
  // reconcile that follows.
  candidates.push(make("lt-evt-boot-before", minMs - 30 * 86_400_000));
  candidates.push(make("lt-evt-boot-beyond", maxMs + 30 * 86_400_000));

  const events = candidates.filter((e) => {
    const s = parseStampMs(e.start?.dateTime ?? null);
    const en = parseStampMs(e.end?.dateTime ?? null);
    // null, not NaN: an event whose times cannot be read is one we cannot place in or out of
    // the window, and the fail-safe answer is to leave it out of the fetch (L50).
    return s !== null && en !== null && en > minMs && s < maxMs;
  });
  return { events, nextSyncToken: `lt-token-${nowMs}`, truncated: false };
}

/** A watch registration result (no real channel created). */
export function stubWatch(channelId: string, nowMs: number): {
  resourceId: string | null;
  expiration: string | null;
} {
  return {
    resourceId: `lt-res-${channelId}`,
    expiration: new Date(nowMs + 7 * 86_400_000).toISOString(),
  };
}

/** Verify-on-book free/busy: report no live conflicts under load. */
export function stubFreeBusy(): Interval[] {
  return [];
}

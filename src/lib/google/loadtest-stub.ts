// Synthetic Google Calendar responses for the 200-agent load test (#273
// Increment 5), gated ENTIRELY behind the SLATE_LOADTEST env flag. It is unset
// in production, so `LOADTEST` is false and none of this runs — the calendar
// client takes its normal real-Google path. With the flag on (only in an
// isolated load-test environment), the sync + watch lanes run end-to-end at 200
// simulated agents without needing real Google accounts.
import type { GoogleEvent, Interval } from "@/lib/google/calendar";

export const LOADTEST = process.env.SLATE_LOADTEST === "true";

// How many busy events a bootstrap sync returns per calendar (realistic batch
// the sync lane then writes to busy_blocks). Incrementals return ~nothing.
const BOOTSTRAP_EVENTS = 30;
const HORIZON_MS = 4 * 86_400_000;

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

/** A batch of synthetic busy events; bootstrap returns many, incrementals one. */
export function stubSyncEvents(
  syncToken: string | null,
  nowMs: number,
): { events: GoogleEvent[]; nextSyncToken: string | null } {
  const n = syncToken ? 1 : BOOTSTRAP_EVENTS;
  const events: GoogleEvent[] = [];
  for (let i = 0; i < n; i++) {
    const startMs = nowMs + Math.floor((i / Math.max(1, n)) * HORIZON_MS);
    events.push({
      id: `lt-evt-${syncToken ? "inc" : "boot"}-${i}-${startMs}`,
      status: "confirmed",
      transparency: "opaque",
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(startMs + 30 * 60_000).toISOString() },
    });
  }
  return { events, nextSyncToken: `lt-token-${nowMs}` };
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

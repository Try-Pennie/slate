// A hand written fake for the reminder email status read (#4300): send rows by builder,
// and deps whose reads can be made to fail. Shared by scripts/test-reminder-status.ts.
import type { ReminderStatusDeps, StatusSendRow } from "../../src/lib/booking/reminder-status.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
export const iso = (ms: number) => new Date(ms).toISOString();

export function row(over: Partial<StatusSendRow> = {}): StatusSendRow {
  return {
    emailId: "email-day",
    sentForIso: iso(NOW + 2 * HOUR),
    status: "sent",
    reason: null,
    claimedAtIso: iso(NOW - HOUR),
    sentAtIso: iso(NOW - HOUR),
    ...over,
  };
}

export function statusDeps(
  rows: StatusSendRow[],
  lastSent: Record<string, string | null>,
  over: Partial<ReminderStatusDeps> = {},
): { deps: ReminderStatusDeps; since: string[] } {
  const since: string[] = [];
  return {
    since,
    deps: {
      nowMs: NOW,
      loadSends: async (sinceIso) => {
        since.push(sinceIso);
        return rows;
      },
      loadLastSent: async (ids) => Object.fromEntries(ids.map((id) => [id, lastSent[id] ?? null])),
      ...over,
    },
  };
}

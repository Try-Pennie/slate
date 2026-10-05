// #3251: the decisions `pnpm verify:reroute-live` makes, kept pure so
// `scripts/test-reroute-live-check.ts` pins them with no network and no clock.
//
// The live command books three test calls (two in the shared test pool at one start,
// one on the public test bucket an hour later), reroutes them through every outcome
// a reroute can reach on the test advisors, and cancels what it made. Every way it can fail to prove that exits on its OWN code, so a
// shell caller can branch on which one it met and one message never answers for
// another (L11). Finding nothing to check is never a pass (L98).

/** What the run met, worst first, each with the code it exits on. */
export const REROUTE_LIVE_OUTCOMES = {
  proven: { exit: 0, says: "every step landed as expected and everything the run made is gone" },
  notConfigured: { exit: 1, says: "missing credentials, the APPLY flag or the acting admin; nothing was attempted" },
  canaryWindow: { exit: 2, says: "inside the smoke canary's window, where it may be booking the same advisors; nothing was attempted" },
  testWorldDiffers: { exit: 3, says: "the test buckets or advisors are not as this run expects; nothing was attempted" },
  noClearTime: { exit: 4, says: "no time in the next week where both test advisors are clear; nothing was booked" },
  calendarUnreadable: { exit: 8, says: "a test advisor's calendar could not be read, so no time could be judged clear; nothing was booked" },
  bookingRefused: { exit: 5, says: "a test call could not be booked" },
  stepDiffered: { exit: 6, says: "a reroute step did not land as expected" },
  residue: { exit: 7, says: "cleanup found something left behind (a call not cancelled, a live hold, a hold block or a calendar event)" },
  cleanupUnverified: { exit: 9, says: "cleanup could not read whether everything is gone, so nothing is vouched for" },
} as const;

export type RerouteLiveOutcome = keyof typeof REROUTE_LIVE_OUTCOMES;

/**
 * Whether `ms` falls where the smoke canary may be writing. It fires on :00 and :30
 * (the full pass, which books, reschedules and cancels on these same advisors, on
 * :00 every six hours) and runs for a few minutes, so a run starting from three
 * minutes before either mark to eight after could meet it mid flight.
 */
export function inCanaryWindow(ms: number): boolean {
  const m = new Date(ms).getUTCMinutes() % 30;
  return m >= 27 || m < 8;
}

/**
 * How long a run is allowed for, from start to the end of its cleanup. Measured
 * runs took one to two minutes on 2026-10-05; the margin covers a slow Google day.
 */
export const RUN_BUDGET_MS = 5 * 60_000;

/**
 * Whether a run starting at `startMs` could meet the canary before it finishes:
 * starting inside the window, or still running when the next one opens.
 */
export function runMeetsCanary(startMs: number): boolean {
  for (let t = startMs; t <= startMs + RUN_BUDGET_MS; t += 60_000) {
    if (inCanaryWindow(t)) return true;
  }
  return inCanaryWindow(startMs + RUN_BUDGET_MS);
}

/**
 * The starts this run will try, in order: on the twenty minute grid, between
 * 15:00 and 20:40 UTC (inside every org and test advisor window seen so far), two
 * to seven days ahead, so the canary's near term bookings are never the ones met.
 * The run's last call is sixty minutes after the start, so the latest start (20:40)
 * puts it at 21:40 UTC, still inside the same windows.
 */
export function candidateStarts(nowMs: number): number[] {
  const day = 24 * 60 * 60 * 1000;
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const out: number[] = [];
  for (let d = 2; d <= 7; d++) {
    for (let minute = 15 * 60; minute <= 20 * 60 + 40; minute += 20) {
      out.push(today + d * day + minute * 60_000);
    }
  }
  return out;
}

/** One busy period from a free/busy read. */
export interface BusyPeriod {
  startMs: number;
  endMs: number;
}

/**
 * Whether a start is clear for the run: smoketest@ free for a call at T with the
 * shared event type's ten minute buffers and for the public test bucket's call at T+60, and
 * smoketest2@ free for a call at T with its buffers. Judged on what Google says,
 * never on Slate's cache, because the cache is written by the code under test (L58).
 */
export function startIsClear(startMs: number, first: readonly BusyPeriod[], second: readonly BusyPeriod[]): boolean {
  const min = 60_000;
  const overlaps = (busy: readonly BusyPeriod[], from: number, to: number) => busy.some((b) => b.startMs < to && from < b.endMs);
  return !overlaps(first, startMs - 10 * min, startMs + 80 * min) && !overlaps(second, startMs - 10 * min, startMs + 30 * min);
}

/** One thing the cleanup must find gone: a label for the report, and a read returning what is left, or null. */
export interface ResidueCheck {
  label: string;
  leftOver: () => Promise<string | null>;
}

/**
 * What the cleanup found left, and separately what it could not read, each in the
 * order checked. A read that throws is never a crash and never read as gone: by the
 * time this runs the command has written to production, so it must still reach a
 * verdict (L515), and an unreadable record proves nothing was removed (L98). The two
 * stay apart because "something is left" and "could not tell" send somebody to do
 * different things (L11). One failure never stops the checks after it.
 */
export async function residue(checks: readonly ResidueCheck[]): Promise<{ left: string[]; unverified: string[] }> {
  const left: string[] = [];
  const unverified: string[] = [];
  for (const c of checks) {
    try {
      const found = await c.leftOver();
      if (found) left.push(found);
    } catch (err) {
      unverified.push(`${c.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { left, unverified };
}

/**
 * Every calendar event the run's calls hold, with the calendar it is on, noted the
 * moment a booking is seen and before any check on that step, so a step that fails
 * still leaves its event for the cleanup. The cleanup checks these rather than
 * re-reading the bookings afterwards, because a cancel may clear the id or the
 * advisor, and a missing id must never read as a deleted event (L98). An event on
 * an advisor outside `calendars` is noted with no calendar, which the cleanup
 * reports rather than reads.
 */
export function eventLedger(calendars: Readonly<Record<string, string>>) {
  const byEvent = new Map<string, string | null>();
  return {
    note(b: { gcal_event_id: string | null; assigned_user_id: string | null }): void {
      if (!b.gcal_event_id) return;
      byEvent.set(b.gcal_event_id, (b.assigned_user_id && calendars[b.assigned_user_id]) || null);
    },
    events: (): ReadonlyMap<string, string | null> => byEvent,
  };
}

/**
 * Runs every cleanup step in order, each in its own attempt, and names the ones
 * that failed. A release that throws must never stop the cancel after it, or the
 * call itself stays on production.
 */
export async function attemptEach(steps: readonly { what: string; run: () => Promise<unknown> }[]): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failed.push(`could not ${step.what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed;
}

/**
 * The cleanup's own verdict, or null when nothing is left and everything was
 * read. Something left outranks something unread, and the detail names both.
 */
export function cleanupVerdict(found: { left: readonly string[]; unverified: readonly string[] }):
  { outcome: "residue" | "cleanupUnverified"; detail: string } | null {
  const unread = found.unverified.length > 0 ? `could not read: ${found.unverified.join("; ")}` : "";
  if (found.left.length > 0) return { outcome: "residue", detail: [found.left.join("; "), unread].filter(Boolean).join("; ") };
  if (unread) return { outcome: "cleanupUnverified", detail: unread };
  return null;
}

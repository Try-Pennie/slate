// #3251: the decisions `pnpm verify:reroute-live` makes, kept pure so
// `scripts/test-reroute-live-check.ts` pins them with no network and no clock.
//
// The live command books two calls on the public test bucket, reroutes them
// through every outcome a reroute can reach on the test advisors, and cancels
// what it made. Every way it can fail to prove that exits on its OWN code, so a
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
  residue: { exit: 7, says: "cleanup left something behind (an active call, a live hold or a hold block)" },
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
 * The starts this run will try, in order: on the twenty minute grid, between
 * 15:00 and 20:40 UTC (inside every org and test advisor window seen so far), two
 * to seven days ahead, so the canary's near term bookings are never the ones met.
 * Each start leaves room for a second call twenty minutes later.
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
